import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo } from "./repo";

export interface ShallowFixtureRepo {
  path: string;          // bare, shallow repo — what the server serves
  boundaryOid: string;   // the one commit in `shallow`: its parents are absent
  tipSubject: string;    // subject of the (single) commit it has
  cleanup: () => void;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "credential.helper=", ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
  return out.trim();
}

/**
 * A genuinely shallow bare repo, made the way one shows up in real life: a
 * `--depth 1` clone of a deeper repo. Its tip commit records a parent that was
 * never fetched, and `<gitdir>/shallow` names the tip as the boundary.
 */
export async function createShallowFixtureRepo(): Promise<ShallowFixtureRepo> {
  const source = await createFixtureRepo();
  try {
    const root = mkdtempSync(join(tmpdir(), "tsgit-shallow-fixture-"));
    try {
      const bare = join(root, "shallow.git");
      await git(root, "clone", "-q", "--bare", "--depth", "1", `file://${source.path}`, bare);
      const boundaryOid = await git(bare, "rev-parse", "HEAD");
      const shallowContents = await Bun.file(join(bare, "shallow")).text();
      if (shallowContents.trim() !== boundaryOid) {
        throw new Error(`unexpected shallow file: ${JSON.stringify(shallowContents)}`);
      }
      return {
        path: bare,
        boundaryOid,
        tipSubject: source.commitSubjects[0]!,
        cleanup: () => {
          rmSync(root, { recursive: true, force: true });
          source.cleanup();
        },
      };
    } catch (err) {
      rmSync(root, { recursive: true, force: true });
      throw err;
    }
  } catch (err) {
    source.cleanup();
    throw err;
  }
}
