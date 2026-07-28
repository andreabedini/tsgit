import { join, resolve, sep } from "node:path";
import { badRequest } from "../errors";

// Clients address the same bare repo either way — `/project` while browsing,
// `/project.git` from git itself — and scanRepos() strips the suffix from
// directory names, so strip it here too rather than treating them as two repos.
export function sanitizeRepoName(name: string): string {
  return name.replace(/\.git$/, "");
}

const VALID_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_LENGTH = 100;

// findRepo() only ever compares this string against names read off disk, so it
// can never escape the scan path. Creating a repo makes it a directory name,
// which is the first time a client-supplied string reaches the filesystem — so
// require a single plain segment: no separators, no traversal, and no leading
// dot (which would hide the repo from both scanRepos and `ls`).
export function validateRepoName(name: string): void {
  if (!name) throw badRequest("Repository name cannot be empty");
  if (name.length > MAX_NAME_LENGTH) {
    throw badRequest(`Repository name is longer than ${MAX_NAME_LENGTH} characters`);
  }
  if (!VALID_NAME.test(name)) {
    throw badRequest(
      `Invalid repository name: ${JSON.stringify(name)} — use letters, digits, ".", "_" and "-", starting with a letter or digit`,
    );
  }
}

// The bare directory a repo named `name` lives in. Validates the name, then
// re-checks containment on the resolved path: belt and braces, so a later change
// to the charset can't quietly become a path traversal.
export function repoDir(scanPath: string, name: string): string {
  validateRepoName(name);
  const root = resolve(scanPath);
  const dir = resolve(join(root, `${name}.git`));
  if (!dir.startsWith(root + sep)) {
    throw badRequest(`Invalid repository name: ${JSON.stringify(name)}`);
  }
  return dir;
}
