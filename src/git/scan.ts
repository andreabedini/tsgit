import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { resolveJjGitDir } from "./jj";

export interface DiscoveredRepo {
  name: string;
  /** Directory to open with libgit2 — the git dir itself for a bare repo, the
   *  work tree for a non-bare one, and the backing store for a jj workspace
   *  that has no `.git` of its own. */
  path: string;
  description?: string;
  owner?: string;
}

/** Where the git data for `dir` lives, or null if `dir` isn't a repository. */
function locateRepo(dir: string): string | null {
  // Non-bare (including colocated and jj >= 0.43 workspaces, which keep their
  // git dir at `<ws>/.git`): hand libgit2 the directory and let it discover.
  if (existsSync(join(dir, ".git", "HEAD"))) return dir;
  // Bare repo: HEAD + objects/ directly inside.
  if (existsSync(join(dir, "HEAD")) && existsSync(join(dir, "objects"))) return dir;
  // A jj workspace whose git dir lives inside `.jj/` — no `.git` to find.
  return resolveJjGitDir(dir);
}

function readDescription(dir: string): string | undefined {
  const path = join(dir, "description");
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8").trim();
  if (!text || text.startsWith("Unnamed repository")) return undefined;
  return text;
}

export function scanRepos(root: string): DiscoveredRepo[] {
  if (!existsSync(root)) return [];
  const repos: DiscoveredRepo[] = [];
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const path = locateRepo(dir);
    if (!path) continue;
    repos.push({
      // Always named after the directory in the scan path, never the resolved
      // git dir — a jj workspace must not show up as "git".
      name: basename(entry).replace(/\.git$/, ""),
      path,
      description: readDescription(path),
    });
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}
