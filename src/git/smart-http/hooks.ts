import { access, constants } from "node:fs/promises";
import { join } from "node:path";

export type HookName = "pre-receive" | "update" | "post-receive";

export interface HookOutcome {
  ran: boolean;    // false when no executable hook file was found — always treated as success
  ok: boolean;
  output: string;  // combined stdout+stderr, trimmed; surfaced as the report-status rejection reason
}

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false; // missing, or present but not executable — git silently skips both
  }
}

// Runs `<repo>/hooks/<name>` the way real git does: cwd and GIT_DIR set to the
// repo, args/stdin per hook (see encodeHookStdin), a non-zero exit rejecting
// whatever the caller is guarding. A hook that's missing or not marked
// executable is treated as "not configured" (ok: true), matching git.
export async function runHook(
  repoPath: string,
  hook: HookName,
  opts: { args?: string[]; stdin?: string; timeoutMs?: number } = {},
): Promise<HookOutcome> {
  const hookPath = join(repoPath, "hooks", hook);
  if (!(await isExecutable(hookPath))) return { ran: false, ok: true, output: "" };

  try {
    const proc = Bun.spawn([hookPath, ...(opts.args ?? [])], {
      cwd: repoPath,
      env: { ...process.env, GIT_DIR: repoPath },
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // A hook is typically a shebang script, so its direct child is really
      // a shell that may fork further children (e.g. a trailing `sleep`,
      // `curl`, ...). Killing just the shell on timeout doesn't close those
      // grandchildren's inherited stdout/stderr fds, so reading the streams
      // hangs until they exit on their own. Running detached (own process
      // group) lets a timeout kill the *whole* group via `-pid`.
      detached: true,
    });
    const timer = setTimeout(
      () => process.kill(-proc.pid, "SIGKILL"),
      opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    );
    let stdout: string, stderr: string, exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      clearTimeout(timer);
    }
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();
    return { ran: true, ok: exitCode === 0, output };
  } catch (err) {
    // Hook file is executable but failed to exec (bad interpreter, etc.) —
    // unlike a missing/non-executable file, this is a real misconfiguration
    // and should block the push rather than be silently skipped.
    return { ran: true, ok: false, output: err instanceof Error ? err.message : String(err) };
  }
}

// pre-receive/post-receive read one "<old-oid> <new-oid> <ref-name>" line per
// command from stdin — the `update` hook instead gets these as three argv args.
export function encodeHookStdin(commands: { oldOid: string; newOid: string; name: string }[]): string {
  return commands.map((c) => `${c.oldOid} ${c.newOid} ${c.name}\n`).join("");
}
