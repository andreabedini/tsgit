import { test, expect, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";

const fixture: FixtureRepo = await createFixtureRepo();
afterAll(() => fixture.cleanup());

test("isBare() is true for a bare repository", () => {
  const repo = openRepository(fixture.path);
  try {
    expect(repo.isBare()).toBe(true);
  } finally {
    repo.free();
  }
});

test("isBare() is false for a non-bare (working-tree) repository", () => {
  const repo = openRepository(fixture.workPath);
  try {
    expect(repo.isBare()).toBe(false);
  } finally {
    repo.free();
  }
});
