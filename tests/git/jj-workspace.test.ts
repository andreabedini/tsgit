import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJjWorkspace } from "../fixtures/jj-repo";
import { resolveJjGitDir } from "../../src/git/jj";
import { scanRepos } from "../../src/git/scan";
import { findRepo, openRepository } from "../../src/git";

test("resolveJjGitDir finds the git dir inside the store (older jj layout)", async () => {
  const ws = await createJjWorkspace("store");
  try {
    expect(resolveJjGitDir(ws.workspace)).toBe(join(ws.workspace, ".jj", "repo", "store", "git"));
  } finally {
    ws.cleanup();
  }
});

test("resolveJjGitDir follows git_target to <ws>/.git (jj >= 0.43 and colocated)", async () => {
  const ws = await createJjWorkspace("dotgit");
  try {
    expect(resolveJjGitDir(ws.workspace)).toBe(join(ws.workspace, ".git"));
  } finally {
    ws.cleanup();
  }
});

test("resolveJjGitDir follows a `.jj/repo` file to a shared repo (jj workspace add)", async () => {
  const ws = await createJjWorkspace("workspace");
  try {
    expect(resolveJjGitDir(ws.workspace)).toBe(join(ws.root, ".shared", "repo", "store", "git"));
  } finally {
    ws.cleanup();
  }
});

test("resolveJjGitDir ignores a non-git backend and non-jj directories", async () => {
  const ws = await createJjWorkspace("native");
  try {
    expect(resolveJjGitDir(ws.workspace)).toBeNull();
  } finally {
    ws.cleanup();
  }
  const plain = mkdtempSync(join(tmpdir(), "tsgit-plain-"));
  try {
    expect(resolveJjGitDir(plain)).toBeNull();
    // A `.jj` with nothing usable inside must not throw either.
    mkdirSync(join(plain, ".jj"));
    expect(resolveJjGitDir(plain)).toBeNull();
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

test("scanRepos discovers a jj workspace under its own name, in every layout", async () => {
  for (const layout of ["store", "dotgit", "workspace"] as const) {
    const ws = await createJjWorkspace(layout, "myproject");
    try {
      const found = scanRepos(ws.root);
      expect(found.map((r) => r.name)).toEqual(["myproject"]);
      // The workspace dir itself for a `.git` layout; the backing store otherwise.
      const expected = layout === "dotgit" ? ws.workspace : ws.path;
      expect(found[0]!.path).toBe(expected);

      // …and the discovered path really opens, with history and change ids intact.
      const repo = openRepository(findRepo(ws.root, "myproject").path);
      try {
        const commits = repo.log({ limit: 10 }).commits;
        expect(commits.map((c) => c.summary)).toEqual(ws.commitSubjects);
        expect(commits[0]!.changeId).toBe(ws.changeIds[0]!);
        expect(repo.commitByChangeId(ws.changeIds[1]!.slice(0, 8))?.summary).toBe("Add a.txt");
      } finally {
        repo.free();
      }
    } finally {
      ws.cleanup();
    }
  }
});

test("scanRepos skips a jj workspace with a non-git backend", async () => {
  const ws = await createJjWorkspace("native");
  try {
    expect(scanRepos(ws.root)).toEqual([]);
  } finally {
    ws.cleanup();
  }
});

test("a detached HEAD (as jj's store always has) reports the branch on that commit", async () => {
  const ws = await createJjWorkspace("store");
  try {
    const gitDir = ws.path;
    const tip = await Bun.file(join(gitDir, "refs", "heads", "main")).text();
    // jj writes a bare oid into the store's HEAD rather than a symbolic ref.
    await Bun.write(join(gitDir, "HEAD"), tip);

    const repo = openRepository(gitDir);
    try {
      expect(repo.headRef()).toBe("main");
      expect(repo.log({ limit: 1 }).commits[0]!.summary).toBe("Add b.txt");
    } finally {
      repo.free();
    }

    // With no branch on that commit there is nothing better to report.
    await Bun.write(join(gitDir, "HEAD"), tip);
    rmSync(join(gitDir, "refs", "heads", "main"));
    const detached = openRepository(gitDir);
    try {
      expect(detached.headRef()).toBe("HEAD");
    } finally {
      detached.free();
    }
  } finally {
    ws.cleanup();
  }
});
