import { test, expect } from "bun:test";
import { createFixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";

test("commit() resolves branches, tags, and oids", async () => {
  const fixture = await createFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const head = repo.commit("main");
      expect(head?.summary).toBe("Add b.txt");

      const tag = repo.commit("v1.0");
      expect(tag?.summary).toBe("Add a.txt");

      const byOid = repo.commit(head!.oid);
      expect(byOid?.message).toContain("Add b.txt");

      // treeOid is the commit's own tree, not its oid.
      expect(head!.treeOid).toMatch(/^[0-9a-f]{40}$/);
      expect(head!.treeOid).not.toBe(head!.oid);
      expect(repo.tree(head!.treeOid, "")?.map((e) => e.name)).toContain("README.md");
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});

test("commit() returns null for a missing revision", async () => {
  const fixture = await createFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      expect(repo.commit("does-not-exist")).toBeNull();
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});
