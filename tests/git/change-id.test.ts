import { test, expect } from "bun:test";
import { createJjFixtureRepo } from "../fixtures/jj-repo";
import { createFixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";
import { looksLikeChangeId } from "../../src/git/changeid";

test("looksLikeChangeId accepts jj's reverse-hex alphabet only", () => {
  expect(looksLikeChangeId("quqpyrzn")).toBe(true);
  expect(looksLikeChangeId("quqpyrznkwqmrttpoowqwtlnmqnvosms")).toBe(true);
  expect(looksLikeChangeId("a4e3909e")).toBe(false); // git oid prefix
  expect(looksLikeChangeId("main")).toBe(false);     // 'a', 'i' are outside k-z
  expect(looksLikeChangeId("")).toBe(false);
  expect(looksLikeChangeId("q".repeat(33))).toBe(false);
});

test("log() and commit() expose the change-id header, null when absent", async () => {
  const fixture = await createJjFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const commits = repo.log({ limit: 10 }).commits;
      expect(commits.map((c) => c.summary)).toEqual(fixture.commitSubjects);
      expect(commits.map((c) => c.changeId)).toEqual([...fixture.changeIds, null]);

      const tip = repo.commit("main");
      expect(tip?.changeId).toBe(fixture.changeIds[0]!);
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});

test("plain git repos report changeId: null", async () => {
  const fixture = await createFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      expect(repo.log({ limit: 10 }).commits.every((c) => c.changeId === null)).toBe(true);
      expect(repo.commit("main")?.changeId).toBeNull();
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});

test("commitByChangeId resolves a full id and an abbreviated prefix", async () => {
  const fixture = await createJjFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const full = fixture.changeIds[1]!;
      expect(repo.commitByChangeId(full)?.summary).toBe("Add a.txt");
      expect(repo.commitByChangeId(full.slice(0, 8))?.summary).toBe("Add a.txt");
      expect(repo.commitByChangeId("kkkkkkkk")).toBeNull();
      expect(repo.commitByChangeId("not-a-change-id")).toBeNull();
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});

test("a change with two commits resolves to the described rewrite", async () => {
  const fixture = await createJjFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const { changeId, subject } = fixture.divergent;
      expect(repo.commitByChangeId(changeId)?.summary).toBe(subject);
      expect(repo.commitByChangeId(changeId.slice(0, 8))?.summary).toBe(subject);
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});

test("a branch's version of a change beats a newer rewrite under refs/jj/keep", async () => {
  const fixture = await createJjFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const { changeId, branchSubject } = fixture.supersededOnBranch;
      expect(repo.commitByChangeId(changeId)?.summary).toBe(branchSubject);
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});

test("log() can start from a change id", async () => {
  const fixture = await createJjFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const page = repo.log({ ref: fixture.changeIds[1]!.slice(0, 8), limit: 10 });
      expect(page.commits.map((c) => c.summary)).toEqual(["Add a.txt", "Add README"]);
      // An unknown change id walks nothing rather than throwing.
      expect(repo.log({ ref: "kkkkkkkk", limit: 10 }).commits).toEqual([]);
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});

test("commit() accepts a change id as a revision, oids and refs still win", async () => {
  const fixture = await createJjFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const byChange = repo.commit(fixture.changeIds[0]!.slice(0, 8));
      expect(byChange?.summary).toBe("Add b.txt");

      // A change-id-shaped string that matches nothing must not resolve.
      expect(repo.commit("kkkkkkkk")).toBeNull();

      // Ordinary revisions are unaffected.
      expect(repo.commit("main")?.summary).toBe("Add b.txt");
      expect(repo.commit(byChange!.oid)?.summary).toBe("Add b.txt");
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});
