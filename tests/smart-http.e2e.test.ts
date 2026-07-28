// tests/smart-http.e2e.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo";
import { createShallowFixtureRepo, type ShallowFixtureRepo } from "./fixtures/shallow-repo";
import { createApp } from "../src/server";
import { DEFAULT_MIME_TYPES, type SiteConfig } from "../src/config/config";
import { parseHtpasswd } from "../src/config/htpasswd";

let fixture: FixtureRepo;
let shallowFixture: ShallowFixtureRepo;
let scanRoot: string;
let workRoot: string;
let server: Server<undefined>;
let baseUrl: string;
const PASSWORD = "secret123";

async function git(cwd: string, ...args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["git", "-c", "credential.helper=", ...args], {
    cwd,
    // No controlling tty/credential helper in this test process, so make
    // that explicit rather than depending on it: -c credential.helper=
    // above ignores any ambient (global/system) credential.helper config,
    // and stdin: "ignore" guarantees git can never block waiting on an
    // interactive prompt, on this machine or anyone else's.
    stdin: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pusher", GIT_AUTHOR_EMAIL: "pusher@example.com",
      GIT_COMMITTER_NAME: "Pusher", GIT_COMMITTER_EMAIL: "pusher@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  fixture = await createFixtureRepo();
  scanRoot = mkdtempSync(join(tmpdir(), "tsgit-smarthttp-scan-"));
  workRoot = mkdtempSync(join(tmpdir(), "tsgit-smarthttp-work-"));
  await Bun.spawn(["cp", "-r", fixture.path, join(scanRoot, "project.git")]).exited;
  await Bun.spawn(["git", "init", "-q", "--bare", join(scanRoot, "empty.git")]).exited;
  shallowFixture = await createShallowFixtureRepo();
  await Bun.spawn(["cp", "-r", shallowFixture.path, join(scanRoot, "shallow.git")]).exited;

  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  const cfg: SiteConfig = {
    TSGIT_SCAN_PATH: scanRoot, TSGIT_SUMMARY_BRANCHES: 10, TSGIT_SUMMARY_TAGS: 10,
    TSGIT_SUMMARY_LOG: 10, TSGIT_LOG_PAGE_SIZE: 50, TSGIT_REPOLIST_PAGE_SIZE: 50, TSGIT_PUSH_CREATE: false,
    mimeTypes: DEFAULT_MIME_TYPES, pushCredentials: parseHtpasswd(`alice:${hash}`),
  };
  const app = createApp();
  server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req, cfg) });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  fixture.cleanup();
  shallowFixture?.cleanup();
  rmSync(scanRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

function authedUrl(repo: string): string {
  const u = new URL(`${baseUrl}/${repo}`);
  u.username = "alice";
  u.password = PASSWORD;
  return u.toString();
}

test("git clone fetches a non-empty repo over smart-HTTP", async () => {
  const dest = join(workRoot, "clone1");
  const result = await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  expect(result.code).toBe(0);
  const log = await git(dest, "log", "--oneline");
  expect(log.stdout.trim().split("\n").length).toBe(3); // matches fixture.commitSubjects
});

test("git clone succeeds against an empty repo", async () => {
  const dest = join(workRoot, "clone-empty");
  const result = await git(workRoot, "clone", "-q", `${baseUrl}/empty.git`, dest);
  expect(result.code).toBe(0);
});

// A repo that is itself shallow (here: a `--depth 1` clone someone published).
// The server has to report its boundary, or the client asks for parents that
// were never fetched and index-pack dies with "did not receive expected object".
test("git clone works against a shallow repo, over both protocol versions", async () => {
  for (const version of ["2", "0"]) {
    const dest = join(workRoot, `clone-shallow-v${version}`);
    const result = await git(workRoot, "-c", `protocol.version=${version}`, "clone", "-q", `${baseUrl}/shallow.git`, dest);
    expect({ version, code: result.code, stderr: result.stderr }).toMatchObject({ code: 0 });

    // The clone inherits the boundary rather than believing it has everything.
    expect((await git(dest, "rev-parse", "--is-shallow-repository")).stdout.trim()).toBe("true");
    const log = await git(dest, "log", "--oneline");
    expect(log.stdout.trim().split("\n").length).toBe(1);
    expect(log.stdout).toContain(shallowFixture.tipSubject);
    expect((await Bun.file(join(dest, ".git", "shallow")).text()).trim()).toBe(shallowFixture.boundaryOid);
  }
});

test("a clone of the shallow repo can fetch again afterwards", async () => {
  // The client's own repo is now shallow, which makes it refuse to talk to a
  // server that doesn't advertise the shallow capability at all.
  const dest = join(workRoot, "shallow-refetch");
  expect((await git(workRoot, "clone", "-q", `${baseUrl}/shallow.git`, dest)).code).toBe(0);
  const fetched = await git(dest, "fetch", "-q", "--verbose", `${baseUrl}/shallow.git`);
  expect({ code: fetched.code, stderr: fetched.stderr }).toMatchObject({ code: 0 });
  expect((await git(dest, "fsck", "--connectivity-only")).code).toBe(0);
});

test("a --depth request is refused with a clear message, not a broken pack", async () => {
  for (const version of ["2", "0"]) {
    const dest = join(workRoot, `clone-depth-v${version}`);
    const result = await git(workRoot, "-c", `protocol.version=${version}`, "clone", "-q", "--depth", "1", `${baseUrl}/project.git`, dest);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("shallow");
    expect(result.stderr.toLowerCase()).toContain("tsgit");
  }
});

test("git push rejects without credentials", async () => {
  const dest = join(workRoot, "push-noauth");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  await Bun.write(join(dest, "new-file.txt"), "hello\n");
  await git(dest, "add", "new-file.txt");
  await git(dest, "commit", "-q", "-m", "add new-file.txt");
  const result = await git(dest, "push", `${baseUrl}/project.git`, "HEAD:refs/heads/rejected");
  expect(result.code).not.toBe(0);
  // Real git never surfaces the literal "401" status text for a Basic-auth
  // challenge: on receiving 401 + WWW-Authenticate it always routes through
  // its credential subsystem before reporting failure. With no controlling
  // tty available to prompt on (true in this sandbox, and in effectively
  // any CI runner), that subsystem gives up before ever retrying the
  // request, so the client-visible error names the credential failure
  // rather than the HTTP status code. Confirmed by driving this exact
  // request by hand with GIT_TRACE_PACKET=1/GIT_CURL_VERBOSE=1 and via
  // `git credential fill` in isolation: every path (no askpass, working
  // askpass returning blank/wrong creds, failing askpass) ends in one of
  // the messages below, never in the digits "401".
  expect(result.stderr.toLowerCase()).toMatch(/401|terminal prompts disabled|authentication (required|failed)/);
});

test("git push accepts a new branch with correct credentials", async () => {
  const dest = join(workRoot, "push-newbranch");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  await Bun.write(join(dest, "pushed.txt"), "hello\n");
  await git(dest, "add", "pushed.txt");
  await git(dest, "commit", "-q", "-m", "add pushed.txt");
  const result = await git(dest, "push", authedUrl("project.git"), "HEAD:refs/heads/pushed");
  expect(result.code).toBe(0);

  // Prove it actually landed: clone fresh and look for the branch.
  const verify = join(workRoot, "verify-newbranch");
  await git(workRoot, "clone", "-q", "-b", "pushed", `${baseUrl}/project.git`, verify);
  const log = await git(verify, "log", "--oneline", "-1");
  expect(log.stdout).toContain("add pushed.txt");
});

test("git push accepts a fast-forward update to an existing branch", async () => {
  const dest = join(workRoot, "push-ff");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  await Bun.write(join(dest, "ff.txt"), "hello\n");
  await git(dest, "add", "ff.txt");
  await git(dest, "commit", "-q", "-m", "fast-forward commit");
  const result = await git(dest, "push", authedUrl("project.git"), "HEAD:refs/heads/main");
  expect(result.code).toBe(0);

  const verify = join(workRoot, "verify-ff");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, verify);
  const log = await git(verify, "log", "--oneline", "-1");
  expect(log.stdout).toContain("fast-forward commit");
});

test("git push rejects a non-fast-forward update without --force", async () => {
  const distinct1 = join(workRoot, "nonff-1");
  const distinct2 = join(workRoot, "nonff-2");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, distinct1);
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, distinct2);

  await Bun.write(join(distinct1, "diverge1.txt"), "a\n");
  await git(distinct1, "add", "diverge1.txt");
  await git(distinct1, "commit", "-q", "-m", "diverge 1");
  const first = await git(distinct1, "push", authedUrl("project.git"), "HEAD:refs/heads/diverge");
  expect(first.code).toBe(0);

  await Bun.write(join(distinct2, "diverge2.txt"), "b\n");
  await git(distinct2, "add", "diverge2.txt");
  await git(distinct2, "commit", "-q", "-m", "diverge 2");
  // distinct2's HEAD does not descend from what refs/heads/diverge now points
  // at, so pushing onto it (as a same-name update, not creation) is a
  // non-fast-forward that our server-side CAS should reject.
  await git(distinct2, "fetch", authedUrl("project.git"), "refs/heads/diverge:refs/remotes/origin/diverge");
  const second = await git(distinct2, "push", authedUrl("project.git"), "HEAD:refs/heads/diverge");
  expect(second.code).not.toBe(0);
  expect(second.stderr.toLowerCase()).toMatch(/stale info|rejected|fetch first/);
});

test("git clone over protocol v2 fetches a non-empty repo", async () => {
  const dest = join(workRoot, "clone-v2");
  const result = await git(workRoot, "-c", "protocol.version=2", "clone", "-q", `${baseUrl}/project.git`, dest);
  expect(result.code).toBe(0);
  // main has picked up extra commits from earlier tests in this file (it's
  // the same shared fixture repo) — check the original fixture history
  // rather than an exact count, which would be order-dependent.
  const log = await git(dest, "log", "--oneline");
  for (const subject of fixture.commitSubjects) expect(log.stdout).toContain(subject);
});

test("git clone over protocol v2 succeeds against an empty repo", async () => {
  const dest = join(workRoot, "clone-v2-empty");
  const result = await git(workRoot, "-c", "protocol.version=2", "clone", "-q", `${baseUrl}/empty.git`, dest);
  expect(result.code).toBe(0);
});

test("git fetch over protocol v2 (using haves) picks up a new commit pushed after the initial clone", async () => {
  const dest = join(workRoot, "fetch-v2");
  await git(workRoot, "-c", "protocol.version=2", "clone", "-q", `${baseUrl}/project.git`, dest);

  // Push a new commit from a second clone so `dest` has to negotiate with
  // haves (its own history) rather than fetching from scratch.
  const pusher = join(workRoot, "fetch-v2-pusher");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, pusher);
  await Bun.write(join(pusher, "v2-fetch.txt"), "hello\n");
  await git(pusher, "add", "v2-fetch.txt");
  await git(pusher, "commit", "-q", "-m", "add v2-fetch.txt");
  const push = await git(pusher, "push", authedUrl("project.git"), "HEAD:refs/heads/main");
  expect(push.code).toBe(0);

  const fetch = await git(dest, "-c", "protocol.version=2", "fetch", "origin", "main");
  expect(fetch.code).toBe(0);
  const log = await git(dest, "log", "--oneline", "-1", "FETCH_HEAD");
  expect(log.stdout).toContain("add v2-fetch.txt");
});

test("git ls-remote over protocol v2 lists branches and tags", async () => {
  const result = await git(workRoot, "-c", "protocol.version=2", "ls-remote", `${baseUrl}/project.git`);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("refs/heads/main");
  expect(result.stdout).toContain("refs/tags/v1.0");
  expect(result.stdout).toContain("refs/tags/v2.0");
});

test("git push (unaffected by protocol v2) still works when the client requests v2", async () => {
  const dest = join(workRoot, "push-v2-client");
  await git(workRoot, "-c", "protocol.version=2", "clone", "-q", `${baseUrl}/project.git`, dest);
  await Bun.write(join(dest, "pushed-v2.txt"), "hello\n");
  await git(dest, "add", "pushed-v2.txt");
  await git(dest, "commit", "-q", "-m", "add pushed-v2.txt");
  const result = await git(
    dest, "-c", "protocol.version=2", "push", authedUrl("project.git"), "HEAD:refs/heads/pushed-v2",
  );
  expect(result.code).toBe(0);
});

test("git push rejected to a non-bare repository is reported to the client", async () => {
  // Publish the fixture's own non-bare working tree under the scan root.
  const nonBareTarget = join(scanRoot, "nonbare.git");
  await Bun.spawn(["cp", "-r", fixture.workPath, nonBareTarget]).exited;

  const dest = join(workRoot, "push-nonbare-source");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  const result = await git(dest, "push", authedUrl("nonbare.git"), "HEAD:refs/heads/whatever");
  expect(result.code).not.toBe(0);
});

async function writeHook(repoPath: string, name: string, script: string): Promise<void> {
  const path = join(repoPath, "hooks", name);
  await Bun.write(path, `#!/bin/sh\n${script}\n`);
  await Bun.spawn(["chmod", "+x", path]).exited;
}

test("a pre-receive hook rejecting the push surfaces its message to the git client", async () => {
  const target = join(scanRoot, "hook-prereceive.git");
  await Bun.spawn(["cp", "-r", fixture.path, target]).exited;
  await writeHook(target, "pre-receive", 'echo "no direct pushes to this mirror" >&2\nexit 1');

  const dest = join(workRoot, "push-prereceive");
  await git(workRoot, "clone", "-q", `${baseUrl}/hook-prereceive.git`, dest);
  await Bun.write(join(dest, "blocked.txt"), "hello\n");
  await git(dest, "add", "blocked.txt");
  await git(dest, "commit", "-q", "-m", "add blocked.txt");
  const result = await git(dest, "push", authedUrl("hook-prereceive.git"), "HEAD:refs/heads/main");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("no direct pushes to this mirror");
});

test("an update hook rejects only the ref it names; other refs in the same push still land", async () => {
  const target = join(scanRoot, "hook-update.git");
  await Bun.spawn(["cp", "-r", fixture.path, target]).exited;
  await writeHook(target, "update", 'if [ "$1" = "refs/heads/locked" ]; then echo "locked branch" >&2; exit 1; fi\nexit 0');

  const dest = join(workRoot, "push-update-hook");
  await git(workRoot, "clone", "-q", `${baseUrl}/hook-update.git`, dest);
  await git(dest, "branch", "locked");
  await git(dest, "branch", "open");

  const result = await git(
    dest, "push", authedUrl("hook-update.git"), "refs/heads/locked:refs/heads/locked", "refs/heads/open:refs/heads/open",
  );
  expect(result.code).not.toBe(0); // git exits non-zero when any ref in the push is rejected
  expect(result.stderr).toContain("locked branch");

  const branches = await git(target, "branch");
  expect(branches.stdout).toContain("open");
  expect(branches.stdout).not.toContain("locked");
});

test("a post-receive hook runs after a successful push", async () => {
  const target = join(scanRoot, "hook-postreceive.git");
  await Bun.spawn(["cp", "-r", fixture.path, target]).exited;
  const marker = join(scanRoot, "post-receive-marker.txt");
  await writeHook(target, "post-receive", `cat > ${marker}`);

  const dest = join(workRoot, "push-postreceive");
  await git(workRoot, "clone", "-q", `${baseUrl}/hook-postreceive.git`, dest);
  await Bun.write(join(dest, "notified.txt"), "hello\n");
  await git(dest, "add", "notified.txt");
  await git(dest, "commit", "-q", "-m", "add notified.txt");
  const result = await git(dest, "push", authedUrl("hook-postreceive.git"), "HEAD:refs/heads/main");
  expect(result.code).toBe(0);

  const markerContent = await Bun.file(marker).text();
  expect(markerContent).toContain("refs/heads/main");
});
