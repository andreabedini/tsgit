import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";

const fixture: FixtureRepo = await createFixtureRepo();
const emptyRoots: string[] = [];
afterAll(() => {
  fixture.cleanup();
  emptyRoots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

async function buildPack(repoPath: string): Promise<Uint8Array> {
  const revList = Bun.spawn(["git", "-C", repoPath, "rev-list", "--objects", "--all"], { stdout: "pipe" });
  const packObjects = Bun.spawn(["git", "-C", repoPath, "pack-objects", "--stdout"], {
    stdin: revList.stdout,
    stdout: "pipe",
  });
  const bytes = new Uint8Array(await new Response(packObjects.stdout).arrayBuffer());
  await revList.exited;
  await packObjects.exited;
  return bytes;
}

async function emptyBareRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "tsgit-indexpack-"));
  emptyRoots.push(root);
  const path = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", path]).exited;
  return path;
}

test("indexPack writes objects from a real packfile into a fresh bare repo", async () => {
  const headOid = (() => {
    const repo = openRepository(fixture.path);
    try {
      return repo.commit(repo.headRef())!.oid;
    } finally {
      repo.free();
    }
  })();

  const pack = await buildPack(fixture.path);
  expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");

  const targetPath = await emptyBareRepo();
  const target = openRepository(targetPath);
  try {
    expect(target.commit(headOid)).toBeNull(); // not present yet
    target.indexPack(pack);
    expect(target.commit(headOid)?.oid).toBe(headOid);
  } finally {
    target.free();
  }
});

test("indexPack throws GitError on garbage input", () => {
  const repo = openRepository(fixture.path);
  try {
    expect(() => repo.indexPack(new TextEncoder().encode("not a pack"))).toThrow();
  } finally {
    repo.free();
  }
});
