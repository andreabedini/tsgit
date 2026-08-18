// tests/push-create.e2e.test.ts — push-to-create over smart HTTP, driven by the
// real `git` binary. The oracle for TSGIT_PUSH_CREATE: what a push may bring into
// existence, what it may not, and what is left behind when a push fails.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createApp } from "../src/server";
import { DEFAULT_MIME_TYPES, type SiteConfig } from "../src/config/config";
import { parseHtpasswd } from "../src/config/htpasswd";
import { concatBytes, encodePktLine, FLUSH_PKT } from "../src/git/smart-http/pktline";

const PASSWORD = "secret123";
const ZERO = "0".repeat(40);

let scanRoot: string;      // scan path of the push-create-enabled server
let closedScanRoot: string; // scan path of the server with the flag off
let workRoot: string;
let server: Server<undefined>;
let closedServer: Server<undefined>;
let baseUrl: string;
let closedBaseUrl: string;

async function git(cwd: string, ...args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["git", "-c", "credential.helper=", ...args], {
    cwd,
    // No credential helper and no stdin, so git can never block on a prompt.
    stdin: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pusher", GIT_AUTHOR_EMAIL: "pusher@example.com",
      GIT_COMMITTER_NAME: "Pusher", GIT_COMMITTER_EMAIL: "pusher@example.com",
      GIT_TERMINAL_PROMPT: "0",
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

// A one-commit repo to push from, on branch `branch`.
async function seedWorkRepo(name: string, branch = "main"): Promise<string> {
  const dir = join(workRoot, name);
  await git(workRoot, "init", "-q", "-b", branch, dir);
  await Bun.write(join(dir, `${name}.txt`), `contents of ${name}\n`);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", `add ${name}.txt`);
  return dir;
}

function authedUrl(base: string, repo: string, password = PASSWORD): string {
  const u = new URL(`${base}/${repo}`);
  u.username = "alice";
  u.password = password;
  return u.toString();
}

function basicAuth(password = PASSWORD): Record<string, string> {
  return { Authorization: `Basic ${btoa(`alice:${password}`)}` };
}

beforeAll(async () => {
  scanRoot = mkdtempSync(join(tmpdir(), "tsgit-pushcreate-scan-"));
  closedScanRoot = mkdtempSync(join(tmpdir(), "tsgit-pushcreate-closed-"));
  workRoot = mkdtempSync(join(tmpdir(), "tsgit-pushcreate-work-"));
  // An existing empty bare repo whose HEAD names a branch nobody will push.
  await Bun.spawn(["git", "init", "-q", "--bare", "-b", "master", join(scanRoot, "preexisting.git")]).exited;

  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  const base: Omit<SiteConfig, "TSGIT_REPO_PATH" | "TSGIT_PUSH_CREATE"> = {
    TSGIT_SUMMARY_BRANCHES: 10, TSGIT_SUMMARY_TAGS: 10, TSGIT_SUMMARY_LOG: 10,
    TSGIT_LOG_PAGE_SIZE: 50, TSGIT_REPOLIST_PAGE_SIZE: 50,
    mimeTypes: DEFAULT_MIME_TYPES, pushCredentials: parseHtpasswd(`alice:${hash}`),
  };

  const app = createApp();
  server = Bun.serve({
    port: 0,
    fetch: (req) => app.fetch(req, { ...base, TSGIT_REPO_PATH: scanRoot, TSGIT_PUSH_CREATE: true }),
  });
  baseUrl = `http://127.0.0.1:${server.port}`;

  const closedApp = createApp();
  closedServer = Bun.serve({
    port: 0,
    fetch: (req) => closedApp.fetch(req, { ...base, TSGIT_REPO_PATH: closedScanRoot, TSGIT_PUSH_CREATE: false }),
  });
  closedBaseUrl = `http://127.0.0.1:${closedServer.port}`;
});

afterAll(() => {
  server.stop(true);
  closedServer.stop(true);
  rmSync(scanRoot, { recursive: true, force: true });
  rmSync(closedScanRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

test("git push creates the repository and the pushed history clones back", async () => {
  const src = await seedWorkRepo("fresh");
  const push = await git(src, "push", authedUrl(baseUrl, "fresh.git"), "HEAD:refs/heads/main");
  expect(push.code).toBe(0);

  expect(existsSync(join(scanRoot, "fresh.git", "objects"))).toBe(true);

  const clone = join(workRoot, "fresh-clone");
  const cloned = await git(workRoot, "clone", "-q", `${baseUrl}/fresh.git`, clone);
  expect(cloned.code).toBe(0);
  const log = await git(clone, "log", "--oneline");
  expect(log.stdout).toContain("add fresh.txt");
  // Cloned with a checked-out branch, not the "empty repository" warning path.
  expect((await git(clone, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim()).toBe("main");
});

test("a created repository gets HEAD pointed at the branch that was pushed", async () => {
  const src = await seedWorkRepo("headed", "trunk");
  const push = await git(src, "push", authedUrl(baseUrl, "headed.git"), "HEAD:refs/heads/trunk");
  expect(push.code).toBe(0);

  // libgit2 inits HEAD at refs/heads/master; nobody pushed master.
  const head = await git(join(scanRoot, "headed.git"), "symbolic-ref", "HEAD");
  expect(head.stdout.trim()).toBe("refs/heads/trunk");
});

test("a created repository shows up on the index page", async () => {
  const src = await seedWorkRepo("listed");
  await git(src, "push", authedUrl(baseUrl, "listed.git"), "HEAD:refs/heads/main");

  const res = await fetch(`${baseUrl}/`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("listed");
});

test("git push without credentials creates nothing", async () => {
  const src = await seedWorkRepo("noauth");
  const push = await git(src, "push", `${baseUrl}/noauth.git`, "HEAD:refs/heads/main");

  expect(push.code).not.toBe(0);
  expect(existsSync(join(scanRoot, "noauth.git"))).toBe(false);
});

test("git push with a wrong password creates nothing", async () => {
  const src = await seedWorkRepo("badpass");
  const push = await git(src, "push", authedUrl(baseUrl, "badpass.git", "wrong"), "HEAD:refs/heads/main");

  expect(push.code).not.toBe(0);
  expect(existsSync(join(scanRoot, "badpass.git"))).toBe(false);
});

test("the receive-pack advertisement 401s before revealing whether the repo exists", async () => {
  const missing = await fetch(`${baseUrl}/nothing-here.git/info/refs?service=git-receive-pack`);
  const existing = await fetch(`${baseUrl}/preexisting.git/info/refs?service=git-receive-pack`);

  expect(missing.status).toBe(401);
  expect(existing.status).toBe(401);
  expect(existsSync(join(scanRoot, "nothing-here.git"))).toBe(false);
});

test("advertising a push at a repo that doesn't exist yet writes nothing to disk", async () => {
  const res = await fetch(`${baseUrl}/probe-only.git/info/refs?service=git-receive-pack`, {
    headers: basicAuth(),
  });

  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/x-git-receive-pack-advertisement");
  const body = await res.text();
  expect(body).toContain("# service=git-receive-pack");
  expect(body).toContain(`${ZERO} capabilities^{}`);
  expect(body).toContain("report-status");
  // A client that advertises and then walks away leaves no empty repo behind.
  expect(existsSync(join(scanRoot, "probe-only.git"))).toBe(false);
});

test("fetching a repository that doesn't exist is still a 404, credentials or not", async () => {
  const anon = await fetch(`${baseUrl}/absent.git/info/refs?service=git-upload-pack`);
  const authed = await fetch(`${baseUrl}/absent.git/info/refs?service=git-upload-pack`, {
    headers: basicAuth(),
  });
  expect(anon.status).toBe(404);
  expect(authed.status).toBe(404);

  const clone = await git(workRoot, "clone", "-q", `${baseUrl}/absent.git`, join(workRoot, "absent-clone"));
  expect(clone.code).not.toBe(0);
  expect(existsSync(join(scanRoot, "absent.git"))).toBe(false);
});

test("a repository name that would escape the scan path is refused", async () => {
  for (const name of ["..%2fescaped", "sub%2fnested", ".hidden"]) {
    const res = await fetch(`${baseUrl}/${name}/info/refs?service=git-receive-pack`, {
      headers: basicAuth(),
    });
    // Rejected either as an unroutable/unknown repo (404) or an invalid name (400) —
    // never as a repo we create.
    expect([400, 404]).toContain(res.status);
  }
  // Nothing was created anywhere: neither beside the scan root nor inside it.
  expect(existsSync(join(scanRoot, "..", "escaped.git"))).toBe(false);
  expect(readdirSync(scanRoot).filter((e) => e.includes("escaped") || e.includes("hidden"))).toEqual([]);
});

test("push-to-create is off unless TSGIT_PUSH_CREATE says otherwise", async () => {
  const src = await seedWorkRepo("closed");
  const push = await git(src, "push", authedUrl(closedBaseUrl, "closed.git"), "HEAD:refs/heads/main");

  expect(push.code).not.toBe(0);
  expect(push.stderr).toContain("not found");
  expect(existsSync(join(closedScanRoot, "closed.git"))).toBe(false);
  expect(readdirSync(closedScanRoot)).toEqual([]);
});

test("a push whose pack is unusable takes the repository it created back out", async () => {
  const name = "rollback.git";
  // A well-formed command line followed by bytes that are not a packfile.
  const body = concatBytes([
    encodePktLine(`${ZERO} ${"a".repeat(40)} refs/heads/main\0report-status\n`),
    FLUSH_PKT,
    new TextEncoder().encode("PACK this is not a packfile at all"),
  ]);

  const res = await fetch(`${baseUrl}/${name}/git-receive-pack`, {
    method: "POST",
    headers: { ...basicAuth(), "Content-Type": "application/x-git-receive-pack-request" },
    body: body as BodyInit,
  });

  expect(res.status).toBe(200);
  const report = await res.text();
  expect(report).toContain("unpack ");
  expect(report).not.toContain("unpack ok");
  // Created for this push, received nothing, so it does not survive it.
  expect(existsSync(join(scanRoot, name))).toBe(false);
});

test("a push into an existing empty repository also fixes its dangling HEAD", async () => {
  const src = await seedWorkRepo("intoempty", "release");
  const push = await git(src, "push", authedUrl(baseUrl, "preexisting.git"), "HEAD:refs/heads/release");
  expect(push.code).toBe(0);

  // The repo was created with `-b master`, but only "release" exists.
  const head = await git(join(scanRoot, "preexisting.git"), "symbolic-ref", "HEAD");
  expect(head.stdout.trim()).toBe("refs/heads/release");
});

test("a failed push into a repository that already existed leaves it alone", async () => {
  const body = concatBytes([
    encodePktLine(`${ZERO} ${"a".repeat(40)} refs/heads/nope\0report-status\n`),
    FLUSH_PKT,
    new TextEncoder().encode("PACK not a packfile"),
  ]);

  const res = await fetch(`${baseUrl}/preexisting.git/git-receive-pack`, {
    method: "POST",
    headers: { ...basicAuth(), "Content-Type": "application/x-git-receive-pack-request" },
    body: body as BodyInit,
  });

  expect(res.status).toBe(200);
  // Rollback only ever applies to a repo the request itself created.
  expect(existsSync(join(scanRoot, "preexisting.git", "objects"))).toBe(true);
});
