import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeHookStdin, runHook } from "../../../src/git/smart-http/hooks";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function newRepoDir(): string {
  const root = mkdtempSync(join(tmpdir(), "tsgit-hooks-"));
  roots.push(root);
  Bun.spawnSync(["mkdir", "-p", join(root, "hooks")]);
  return root;
}

async function writeHook(repoPath: string, name: string, script: string): Promise<void> {
  const path = join(repoPath, "hooks", name);
  await Bun.write(path, `#!/bin/sh\n${script}\n`);
  await Bun.spawn(["chmod", "+x", path]).exited;
}

test("encodeHookStdin frames one '<old> <new> <name>' line per command", () => {
  const oid1 = "a".repeat(40);
  const oid2 = "b".repeat(40);
  const stdin = encodeHookStdin([
    { oldOid: "0".repeat(40), newOid: oid1, name: "refs/heads/main" },
    { oldOid: oid1, newOid: oid2, name: "refs/heads/other" },
  ]);
  expect(stdin).toBe(`${"0".repeat(40)} ${oid1} refs/heads/main\n${oid1} ${oid2} refs/heads/other\n`);
});

test("runHook treats a missing hook file as success without running anything", async () => {
  const repo = newRepoDir();
  const result = await runHook(repo, "pre-receive", {});
  expect(result).toEqual({ ran: false, ok: true, output: "" });
});

test("runHook treats a present-but-not-executable hook file as success (matches git)", async () => {
  const repo = newRepoDir();
  await Bun.write(join(repo, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n");
  const result = await runHook(repo, "pre-receive", {});
  expect(result).toEqual({ ran: false, ok: true, output: "" });
});

test("runHook reports ok:true for a zero exit code", async () => {
  const repo = newRepoDir();
  await writeHook(repo, "update", "exit 0");
  const result = await runHook(repo, "update", { args: ["refs/heads/main", "a", "b"] });
  expect(result.ran).toBe(true);
  expect(result.ok).toBe(true);
});

test("runHook reports ok:false and captures stderr for a non-zero exit code", async () => {
  const repo = newRepoDir();
  await writeHook(repo, "update", 'echo "rejected: $1" >&2\nexit 1');
  const result = await runHook(repo, "update", { args: ["refs/heads/locked"] });
  expect(result.ok).toBe(false);
  expect(result.output).toBe("rejected: refs/heads/locked");
});

test("runHook passes argv to the hook", async () => {
  const repo = newRepoDir();
  await writeHook(repo, "update", 'echo "$1|$2|$3"');
  const result = await runHook(repo, "update", { args: ["refs/heads/main", "old-oid", "new-oid"] });
  expect(result.output).toBe("refs/heads/main|old-oid|new-oid");
});

test("runHook feeds stdin to the hook", async () => {
  const repo = newRepoDir();
  await writeHook(repo, "pre-receive", "cat");
  const stdin = encodeHookStdin([{ oldOid: "0".repeat(40), newOid: "a".repeat(40), name: "refs/heads/main" }]);
  const result = await runHook(repo, "pre-receive", { stdin });
  expect(result.output).toBe(stdin.trim());
});

test("runHook sets GIT_DIR and cwd to the repo path", async () => {
  const repo = newRepoDir();
  await writeHook(repo, "post-receive", 'echo "$GIT_DIR|$(pwd)"');
  const result = await runHook(repo, "post-receive", {});
  expect(result.output).toBe(`${repo}|${repo}`);
});

test("runHook kills a hook that runs past its timeout and reports failure", async () => {
  const repo = newRepoDir();
  await writeHook(repo, "pre-receive", "sleep 5");
  const result = await runHook(repo, "pre-receive", { timeoutMs: 100 });
  expect(result.ok).toBe(false);
});
