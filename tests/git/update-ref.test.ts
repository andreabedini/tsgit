import { test, expect, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";
import { GitError } from "../../src/git/binding/libgit2";

const ZERO = "0".repeat(40);

const fixture: FixtureRepo = await createFixtureRepo();
afterAll(() => fixture.cleanup());

function headOid(): string {
  const repo = openRepository(fixture.path);
  try {
    return repo.commit(repo.headRef())!.oid;
  } finally {
    repo.free();
  }
}

test("updateRef creates a new ref when oldOid is all zeros", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/created", ZERO, oid);
    expect(repo.commit("refs/heads/created")?.oid).toBe(oid);
  } finally {
    repo.free();
  }
});

test("updateRef rejects creating a ref that already exists", () => {
  const repo = openRepository(fixture.path);
  try {
    expect(() => repo.updateRef("refs/heads/main", ZERO, headOid())).toThrow(GitError);
  } finally {
    repo.free();
  }
});

test("updateRef updates an existing ref when oldOid matches", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/movable", ZERO, oid);
    // "Move" it back onto itself (a same-value CAS is still a valid update).
    repo.updateRef("refs/heads/movable", oid, oid);
    expect(repo.commit("refs/heads/movable")?.oid).toBe(oid);
  } finally {
    repo.free();
  }
});

test("updateRef rejects a stale oldOid (CAS failure)", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/guarded", ZERO, oid);
    expect(() => repo.updateRef("refs/heads/guarded", "1".repeat(40), oid)).toThrow(GitError);
  } finally {
    repo.free();
  }
});

test("updateRef deletes a ref when newOid is all zeros", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/temp", ZERO, oid);
    repo.updateRef("refs/heads/temp", oid, ZERO);
    expect(repo.commit("refs/heads/temp")).toBeNull();
    expect(repo.references().some((r) => r.fullName === "refs/heads/temp")).toBe(false);
  } finally {
    repo.free();
  }
});

test("updateRef rejects deleting with a stale oldOid", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/temp2", ZERO, oid);
    expect(() => repo.updateRef("refs/heads/temp2", "1".repeat(40), ZERO)).toThrow(GitError);
    expect(repo.commit("refs/heads/temp2")?.oid).toBe(oid); // untouched
  } finally {
    repo.free();
  }
});
