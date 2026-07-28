import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { HttpError, notFound } from "../errors";
import { initBareRepository } from "./binding/repository";
import { repoDir, sanitizeRepoName } from "./reponame";
import { DiscoveredRepo, scanRepos } from "./scan";

export * from "./facade";
export { openRepository } from "./binding/repository";

// The discovered repo `name` refers to, or null if there is no such repo.
// scanRepos() strips a trailing ".git" from directory names (so a `project.git`
// bare repo is discovered as "project"). Smart-HTTP clients request the on-disk
// name verbatim (`GET /project.git/info/refs`), so strip it here too rather than
// requiring browsing and smart-HTTP URLs to disagree about repo naming.
export function lookupRepo(scanPath: string, name: string): DiscoveredRepo | null {
  const wanted = sanitizeRepoName(name);
  return scanRepos(scanPath).find((r) => r.name === wanted) ?? null;
}

export function findRepo(scanPath: string, name: string): DiscoveredRepo {
  const repo = lookupRepo(scanPath, name);
  if (!repo) throw notFound(`Repository not found: ${name}`);
  return repo;
}

// Initializes a new bare repo under the scan path — the push-to-create path, so
// `name` is straight off the wire and repoDir() is what keeps it inside the scan
// root. Refuses a directory that already holds something, so the caller's
// rollback can only ever remove a directory this function created.
export function createBareRepo(scanPath: string, name: string): DiscoveredRepo {
  const repoName = sanitizeRepoName(name);
  const dir = repoDir(scanPath, repoName);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new HttpError(409, `Cannot create repository ${repoName}: ${dir} is not empty`);
  }
  mkdirSync(scanPath, { recursive: true });
  initBareRepository(dir);
  return { name: repoName, path: dir };
}

// Removes a repo created by createBareRepo(). Recomputes the directory from the
// scan path and the name so a delete can only ever target a validated path
// inside the scan root, never whatever a DiscoveredRepo happens to carry.
export function removeBareRepo(scanPath: string, name: string): void {
  rmSync(repoDir(scanPath, sanitizeRepoName(name)), { recursive: true, force: true });
}
  