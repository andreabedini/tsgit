import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";

async function run(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.com",
      GIT_AUTHOR_DATE: "2026-06-01T10:00:00Z",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "author@example.com",
      GIT_COMMITTER_DATE: "2026-06-01T10:00:00Z",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

async function createMergeFixtureRepo(): Promise<{ path: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "tsgit-diff-"));
  try {
    const work = join(root, "work");
    const bare = join(root, "repo.git");

    await run(root, "init", "-q", "-b", "main", work);
    await Bun.write(join(work, "file.txt"), "base\n");
    await run(work, "add", "file.txt");
    await run(work, "commit", "-q", "-m", "Base");

    await run(work, "checkout", "-q", "-b", "feature");
    await Bun.write(join(work, "file.txt"), "feature\n");
    await run(work, "commit", "-q", "-am", "Feature");

    await run(work, "checkout", "-q", "main");
    await Bun.write(join(work, "main.txt"), "main\n");
    await run(work, "add", "main.txt");
    await run(work, "commit", "-q", "-m", "Main");
    await run(work, "merge", "-q", "--no-ff", "feature", "-m", "Merge feature");

    await run(root, "clone", "-q", "--bare", work, bare);
    return { path: bare, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

test("diff() returns text hunks, root additions, and binary markers", async () => {
  const fixture = await createFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const commits = repo.log({ limit: 10 }).commits;
      const headDiff = repo.diff(commits[0]!.oid);
      expect(headDiff).toBeTruthy();
      expect(headDiff!.files.some((file) => file.newPath === "b.txt" && file.hunks.some((hunk) => hunk.lines.some((line) => line.content.includes("second"))))).toBe(true);
      expect(headDiff!.files.some((file) => file.newPath === "logo.bin" && file.binary)).toBe(true);

      const rootDiff = repo.diff(commits.at(-1)!.oid);
      expect(rootDiff).toBeTruthy();
      expect(rootDiff!.files.some((file) => file.newPath === "README.md" && file.status === "added")).toBe(true);
      expect(rootDiff!.files.some((file) => file.newPath === "README.md" && file.hunks.some((hunk) => hunk.lines.some((line) => line.content.includes("# Fixture"))))).toBe(true);
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});

test("diff() compares merge commits to the first parent", async () => {
  const fixture = await createMergeFixtureRepo();
  try {
    const repo = openRepository(fixture.path);
    try {
      const merge = repo.log({ limit: 1 }).commits[0];
      const diff = repo.diff(merge!.oid);
      expect(diff).toBeTruthy();
      expect(diff!.files.map((file) => file.newPath ?? file.oldPath)).toContain("file.txt");
      expect(diff!.files.map((file) => file.newPath ?? file.oldPath)).not.toContain("main.txt");
    } finally {
      repo.free();
    }
  } finally {
    fixture.cleanup();
  }
});
