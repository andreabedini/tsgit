import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface JjFixtureRepo {
  path: string;                 // path to the bare repo
  changeIds: string[];          // newest-first, aligned with commitSubjects
  commitSubjects: string[];     // newest-first
  plainSubject: string;         // subject of the commit written *without* a change-id header
  /** A change with two git commits (an undescribed snapshot and the described
   *  rewrite, same timestamp), reachable only via refs/jj/keep/* — what a
   *  colocated jj repo looks like after an amend. */
  divergent: { changeId: string; subject: string };
  /** A change id that a branch points at, which also has a *newer* rewrite
   *  parked under refs/jj/keep/*: the branch version must win. */
  supersededOnBranch: { changeId: string; branchSubject: string; keepSubject: string };
  cleanup: () => void;
}

async function git(cwd: string, args: string[], stdin?: string): Promise<string> {
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
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
  return out.trim();
}

/**
 * A bare repo whose commits carry jj's `change-id` header, built with git
 * plumbing so the suite doesn't need jj installed: extra commit headers are
 * legal git, and `hash-object -t commit -w` writes them verbatim.
 *
 * History (oldest first): "Add README" (plain git, no header), then two commits
 * with change ids.
 */
export async function createJjFixtureRepo(): Promise<JjFixtureRepo> {
  const root = mkdtempSync(join(tmpdir(), "tsgit-jj-fixture-"));
  try {
    const bare = join(root, "repo.git");
    await git(root, ["init", "-q", "--bare", "-b", "main", bare]);

    const write = async (path: string, content: string): Promise<string> => {
      await Bun.write(join(root, path), content);
      return git(bare, ["hash-object", "-w", "--path", path, join(root, path)]);
    };
    // Build each commit's tree with a temporary index, then hand-write the
    // commit object so we control its headers.
    const tree = async (entries: [name: string, blob: string][]): Promise<string> => {
      const spec = entries.map(([name, blob]) => `100644 blob ${blob}\t${name}`).join("\n") + "\n";
      return git(bare, ["mktree"], spec);
    };
    const commit = async (
      treeOid: string,
      parent: string | null,
      message: string,
      changeId: string | null,
      timestamp: number,
    ): Promise<string> => {
      const lines = [`tree ${treeOid}`];
      if (parent) lines.push(`parent ${parent}`);
      lines.push(`author Test Author <author@example.com> ${timestamp} +0000`);
      lines.push(`committer Test Author <author@example.com> ${timestamp} +0000`);
      if (changeId) lines.push(`change-id ${changeId}`);
      return git(bare, ["hash-object", "-t", "commit", "-w", "--stdin"], `${lines.join("\n")}\n\n${message}\n`);
    };

    const readme = await write("README.md", "# Fixture\n");
    const a = await write("a.txt", "first\n");
    const b = await write("b.txt", "second\n");

    const changeIds = [
      "vvvvvvvvpqrstuvwxyzklmnopqrstuvw", // newest
      "zzzzzzzzpqrstuvwxyzklmnopqrstuvw",
    ];
    const base = await commit(await tree([["README.md", readme]]), null, "Add README", null, 1780000000);
    const middle = await commit(
      await tree([["README.md", readme], ["a.txt", a]]),
      base,
      "Add a.txt",
      changeIds[1]!,
      1780000100,
    );
    const tip = await commit(
      await tree([["README.md", readme], ["a.txt", a], ["b.txt", b]]),
      middle,
      "Add b.txt",
      changeIds[0]!,
      1780000200,
    );
    await git(bare, ["update-ref", "refs/heads/main", tip]);

    // Two commits for one change, same second, one still undescribed — what jj
    // leaves behind after `jj describe`. Only refs/jj/keep/* keeps them alive.
    const divergentChangeId = "wwwwwwwwpqrstuvwxyzklmnopqrstuvw";
    const snapshotTree = await tree([["README.md", readme], ["a.txt", a]]);
    for (const message of ["", "Amended work"]) {
      const oid = await commit(snapshotTree, tip, message, divergentChangeId, 1780000300);
      await git(bare, ["update-ref", `refs/jj/keep/${oid}`, oid]);
    }

    // A newer rewrite of the tip's change, parked outside refs/heads.
    const keptRewrite = await commit(
      await tree([["README.md", readme], ["b.txt", b]]),
      middle,
      "Rewritten b.txt",
      changeIds[0]!,
      1780000400,
    );
    await git(bare, ["update-ref", `refs/jj/keep/${keptRewrite}`, keptRewrite]);

    return {
      path: bare,
      changeIds,
      commitSubjects: ["Add b.txt", "Add a.txt", "Add README"],
      plainSubject: "Add README",
      divergent: { changeId: divergentChangeId, subject: "Amended work" },
      supersededOnBranch: {
        changeId: changeIds[0]!,
        branchSubject: "Add b.txt",
        keepSubject: "Rewritten b.txt",
      },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

/** Which on-disk shape of jj workspace to build. */
export type JjLayout =
  | "store"     // older jj: git dir inside the store, no `.git` anywhere
  | "dotgit"    // jj >= 0.43 and colocated workspaces: git dir at `<ws>/.git`
  | "workspace" // `jj workspace add`: `.jj/repo` is a *file* pointing elsewhere
  | "native";   // jj's non-git backend — nothing for tsgit to serve

export interface JjWorkspace extends JjFixtureRepo {
  root: string;       // directory to point TSGIT_REPO_PATH at
  workspace: string;  // the workspace directory inside it
  name: string;       // repo name tsgit should report (the workspace dir name)
}

/**
 * A jj *workspace* wrapping the change-id fixture history, laid out the way jj
 * itself does. Built by hand rather than by running jj so the suite has no jj
 * dependency: the git dir is a real repo, and `.jj/` holds only the two files
 * tsgit reads (`store/type`, `store/git_target`).
 */
export async function createJjWorkspace(layout: JjLayout, name = "project"): Promise<JjWorkspace> {
  const inner = await createJjFixtureRepo();
  try {
    const root = mkdtempSync(join(tmpdir(), "tsgit-jj-ws-"));
    const workspace = join(root, name);
    // A secondary workspace shares the repo of a main one that lives elsewhere.
    const repoDir = layout === "workspace" ? join(root, ".shared", "repo") : join(workspace, ".jj", "repo");
    const store = join(repoDir, "store");
    mkdirSync(store, { recursive: true });
    mkdirSync(join(workspace, ".jj"), { recursive: true });

    let gitDir: string;
    if (layout === "dotgit") {
      gitDir = join(workspace, ".git");
      await Bun.write(join(store, "git_target"), "../../../.git");
    } else {
      gitDir = join(store, "git");
      await Bun.write(join(store, "git_target"), "git");
    }
    cpSync(inner.path, gitDir, { recursive: true });
    await Bun.write(join(store, "type"), layout === "native" ? "local" : "git");
    if (layout === "workspace") {
      // `.jj/repo` as a file, holding a path relative to `.jj/` — exactly what
      // `jj workspace add` writes (e.g. "../../main/.jj/repo").
      await Bun.write(join(workspace, ".jj", "repo"), "../../.shared/repo");
    }

    return {
      ...inner,
      root,
      workspace,
      name,
      path: gitDir,
      cleanup: () => {
        inner.cleanup();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (err) {
    inner.cleanup();
    throw err;
  }
}
