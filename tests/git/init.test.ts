import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initBareRepository } from "../../src/git/binding/repository";
import { createBareRepo, lookupRepo, openRepository, removeBareRepo } from "../../src/git";
import { HttpError } from "../../src/errors";

const root = mkdtempSync(join(tmpdir(), "tsgit-init-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.trim();
}

test("initBareRepository creates a bare repo git itself recognizes", async () => {
  const dir = join(root, "plain.git");
  initBareRepository(dir);

  expect(existsSync(join(dir, "HEAD"))).toBe(true);
  expect(existsSync(join(dir, "objects"))).toBe(true);
  expect(await git(dir, "rev-parse", "--is-bare-repository")).toBe("true");

  const repo = openRepository(dir);
  try {
    expect(repo.isBare()).toBe(true);
    // No commits yet, so HEAD names a branch that doesn't exist.
    expect(repo.headIsUnborn()).toBe(true);
    expect(repo.references()).toEqual([]);
  } finally {
    repo.free();
  }
});

test("createBareRepo makes a repo scanRepos then discovers by name", () => {
  const scan = mkdtempSync(join(root, "scan-"));
  const disc = createBareRepo(scan, "newthing");

  expect(disc.name).toBe("newthing");
  expect(disc.path).toBe(join(scan, "newthing.git"));
  expect(lookupRepo(scan, "newthing")?.path).toBe(disc.path);
  // The name as smart-HTTP clients spell it resolves to the same repo.
  expect(lookupRepo(scan, "newthing.git")?.path).toBe(disc.path);
});

test("createBareRepo accepts the .git spelling without doubling the suffix", () => {
  const scan = mkdtempSync(join(root, "scan-"));
  const disc = createBareRepo(scan, "dotted.git");

  expect(disc.name).toBe("dotted");
  expect(disc.path).toBe(join(scan, "dotted.git"));
});

test("createBareRepo refuses a name that would escape the scan path", () => {
  const scan = mkdtempSync(join(root, "scan-"));
  expect(() => createBareRepo(scan, "../escaped")).toThrow(HttpError);
  expect(existsSync(join(scan, "..", "escaped.git"))).toBe(false);
});

test("createBareRepo refuses a directory that already holds something", async () => {
  const scan = mkdtempSync(join(root, "scan-"));
  await Bun.write(join(scan, "occupied.git", "keepme.txt"), "precious\n");

  expect(() => createBareRepo(scan, "occupied")).toThrow(HttpError);
  // The bystander survives: nothing may be deleted through a path we didn't make.
  expect(existsSync(join(scan, "occupied.git", "keepme.txt"))).toBe(true);
});

test("removeBareRepo deletes only what is under the scan path", () => {
  const scan = mkdtempSync(join(root, "scan-"));
  const disc = createBareRepo(scan, "throwaway");
  expect(existsSync(disc.path)).toBe(true);

  removeBareRepo(scan, "throwaway");
  expect(existsSync(disc.path)).toBe(false);
  expect(lookupRepo(scan, "throwaway")).toBeNull();

  expect(() => removeBareRepo(scan, "../..")).toThrow(HttpError);
  expect(existsSync(scan)).toBe(true);
});
