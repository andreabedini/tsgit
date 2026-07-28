import { test, expect, afterAll } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { initBareRepository } from "../../src/git/binding/repository";
import { openRepository } from "../../src/git";
import { ensureDefaultBranch } from "../../src/git/smart-http/receivePack";

const fixture: FixtureRepo = await createFixtureRepo();
const root = mkdtempSync(join(tmpdir(), "tsgit-head-"));
afterAll(() => {
  fixture.cleanup();
  rmSync(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.trim();
}

// A copy of the fixture bare repo (branch "main", tags v1.0/v2.0) whose HEAD has
// been pointed somewhere, standing in for a repo whose HEAD was written before
// any branch existed.
function repoWithHead(name: string, headTarget: string): string {
  const dir = join(root, `${name}.git`);
  cpSync(fixture.path, dir, { recursive: true });
  Bun.spawnSync(["git", "symbolic-ref", "HEAD", headTarget], { cwd: dir });
  return dir;
}

test("ensureDefaultBranch adopts a real branch when HEAD names one that doesn't exist", async () => {
  const dir = repoWithHead("dangling", "refs/heads/nobody-pushed-this");
  const repo = openRepository(dir);
  try {
    expect(repo.headIsUnborn()).toBe(true);
    ensureDefaultBranch(repo);
    expect(repo.headIsUnborn()).toBe(false);
  } finally {
    repo.free();
  }
  expect(await git(dir, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

test("ensureDefaultBranch leaves a HEAD that already resolves alone", async () => {
  const dir = repoWithHead("resolves", "refs/heads/main");
  const repo = openRepository(dir);
  try {
    ensureDefaultBranch(repo);
  } finally {
    repo.free();
  }
  expect(await git(dir, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

test("ensureDefaultBranch leaves a detached HEAD alone", async () => {
  const dir = join(root, "detached.git");
  cpSync(fixture.path, dir, { recursive: true });
  const oid = await git(dir, "rev-parse", "refs/heads/main");
  await git(dir, "update-ref", "--no-deref", "HEAD", oid);

  const repo = openRepository(dir);
  try {
    // Detached but resolvable — as in a jj-backed repo, which tsgit must not rewrite.
    expect(repo.headIsUnborn()).toBe(false);
    ensureDefaultBranch(repo);
  } finally {
    repo.free();
  }
  expect(await git(dir, "rev-parse", "HEAD")).toBe(oid);
  expect(Bun.spawnSync(["git", "symbolic-ref", "-q", "HEAD"], { cwd: dir }).exitCode).not.toBe(0);
});

test("ensureDefaultBranch is a no-op on a repo with no branches at all", async () => {
  const dir = join(root, "empty.git");
  initBareRepository(dir);
  const before = await git(dir, "symbolic-ref", "HEAD");

  const repo = openRepository(dir);
  try {
    ensureDefaultBranch(repo);
  } finally {
    repo.free();
  }
  expect(await git(dir, "symbolic-ref", "HEAD")).toBe(before);
});

test("ensureDefaultBranch prefers main, then master, then whatever is there", async () => {
  const cases: [string[], string][] = [
    [["develop", "main", "master"], "refs/heads/main"],
    [["develop", "master"], "refs/heads/master"],
    [["develop", "zeta"], "refs/heads/develop"],
  ];
  for (const [branches, expected] of cases) {
    const dir = repoWithHead(`pref-${branches.join("-")}`, "refs/heads/nobody-pushed-this");
    const oid = await git(dir, "rev-parse", "refs/heads/main");
    await git(dir, "update-ref", "-d", "refs/heads/main");
    for (const b of branches) await git(dir, "update-ref", `refs/heads/${b}`, oid);

    const repo = openRepository(dir);
    try {
      ensureDefaultBranch(repo);
    } finally {
      repo.free();
    }
    expect(await git(dir, "symbolic-ref", "HEAD")).toBe(expected);
  }
});
