import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";

const fixture: FixtureRepo = await createFixtureRepo();
const roots: string[] = [];
afterAll(() => {
  fixture.cleanup();
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

test("packObjects returns a valid, non-empty packfile for a want with no haves", () => {
  const repo = openRepository(fixture.path);
  try {
    const headOid = repo.commit(repo.headRef())!.oid;
    const pack = repo.packObjects([headOid], []);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");
    expect(pack.length).toBeGreaterThan(12); // more than just the header+trailer
  } finally {
    repo.free();
  }
});

test("packObjects output can be indexed into a fresh repo (round-trip)", async () => {
  const repo = openRepository(fixture.path);
  const headOid = repo.commit(repo.headRef())!.oid;
  const pack = repo.packObjects([headOid], []);
  repo.free();

  const root = mkdtempSync(join(tmpdir(), "tsgit-packobjects-"));
  roots.push(root);
  const targetPath = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", targetPath]).exited;

  const target = openRepository(targetPath);
  try {
    expect(target.commit(headOid)).toBeNull();
    target.indexPack(pack);
    expect(target.commit(headOid)?.oid).toBe(headOid);
  } finally {
    target.free();
  }
});

test("packObjects ignores haves that don't exist locally instead of throwing", () => {
  const repo = openRepository(fixture.path);
  try {
    const headOid = repo.commit(repo.headRef())!.oid;
    const bogusHave = "f".repeat(40);
    expect(() => repo.packObjects([headOid], [bogusHave])).not.toThrow();
  } finally {
    repo.free();
  }
});
