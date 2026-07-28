import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Discovering jj workspaces.
//
// A jj workspace is a directory with a `.jj/`. Its commits live in a real git
// repository — jj's "git backend" — whose location has moved between versions,
// so it has to be read out of the store rather than guessed:
//
//   <ws>/.jj/repo/store/type        "git" (jj also has a native backend)
//   <ws>/.jj/repo/store/git_target  path to the git dir, relative to store/
//
// Older jj keeps the git dir *inside* the store (`git_target` = "git", and there
// is no `.git` anywhere), while jj 0.43 points it at `<ws>/.git` — as does a
// colocated workspace. Only the first case needs help: a workspace with a `.git`
// is already discoverable as an ordinary git repo.
//
// Reading the git dir is all tsgit does with `.jj/`. What's visible is therefore
// what jj has exported to git — the same contract `git clone` gets: bookmarks
// appear as branches, and `refs/jj/keep/*` keeps unexported commits reachable.
// jj's operation log, working-copy state, and change metadata are never touched.

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function looksLikeGitDir(dir: string): boolean {
  return existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"));
}

/** Resolves a jj workspace directory to the git directory backing its store,
 *  or null if `dir` is not a jj workspace (or uses a non-git backend). */
export function resolveJjGitDir(dir: string): string | null {
  const dotJj = join(dir, ".jj");
  if (!existsSync(dotJj)) return null;

  // `.jj/repo` is a directory in the main workspace; in one created by
  // `jj workspace add` it's a file holding the path to the shared repo.
  let repoDir = join(dotJj, "repo");
  if (!existsSync(repoDir)) return null;
  if (statSync(repoDir).isFile()) {
    const shared = readFileSync(repoDir, "utf8").trim();
    if (!shared) return null;
    repoDir = resolve(dotJj, shared);
  }

  const store = join(repoDir, "store");
  const type = readIfExists(join(store, "type"))?.trim();
  if (type && type !== "git") return null; // native backend: nothing git to serve

  const target = readIfExists(join(store, "git_target"))?.trim();
  const gitDir = target ? resolve(store, target) : join(store, "git");
  return looksLikeGitDir(gitDir) ? gitDir : null;
}
