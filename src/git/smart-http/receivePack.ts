import type { WritableRepository } from "../facade";
import { encodeHookStdin, runHook } from "./hooks";
import { encodePktLine, FLUSH_PKT, concatBytes } from "./pktline";

export interface ReceiveCommand {
  oldOid: string;
  newOid: string;
  name: string;
}

const COMMAND_LINE = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/;
const decoder = new TextDecoder();

export function parseReceiveCommands(
  lines: Uint8Array[],
): { commands: ReceiveCommand[]; capabilities: string[] } {
  const capabilities: string[] = [];
  const commands: ReceiveCommand[] = [];
  lines.forEach((lineBytes, i) => {
    let text = decoder.decode(lineBytes).replace(/\n$/, "");
    if (i === 0) {
      const nul = text.indexOf("\0");
      if (nul !== -1) {
        capabilities.push(...text.slice(nul + 1).split(" ").filter(Boolean));
        text = text.slice(0, nul);
      }
    }
    const match = COMMAND_LINE.exec(text);
    if (!match) throw new Error(`malformed receive-pack command line: ${JSON.stringify(text)}`);
    commands.push({ oldOid: match[1], newOid: match[2], name: match[3] });
  });
  return { commands, capabilities };
}

export interface ReceiveResult {
  unpackOk: boolean;
  unpackError?: string;
  refResults: { name: string; ok: boolean; reason?: string }[];
}

export async function applyReceivePack(
  repo: WritableRepository,
  commands: ReceiveCommand[],
  packBytes: Uint8Array,
): Promise<ReceiveResult> {
  if (packBytes.length > 0) {
    try {
      repo.indexPack(packBytes);
    } catch (err) {
      return {
        unpackOk: false,
        unpackError: err instanceof Error ? err.message : String(err),
        refResults: commands.map((c) => ({ name: c.name, ok: false, reason: "unpacker error" })),
      };
    }
  }

  if (commands.length === 0) return { unpackOk: true, refResults: [] };

  // pre-receive sees the whole batch and can reject it outright, before any
  // ref is touched — same all-or-nothing semantics as real git.
  const preReceive = await runHook(repo.path, "pre-receive", { stdin: encodeHookStdin(commands) });
  if (!preReceive.ok) {
    const reason = preReceive.output || "pre-receive hook declined";
    return { unpackOk: true, refResults: commands.map((c) => ({ name: c.name, ok: false, reason })) };
  }

  const applied: ReceiveCommand[] = [];
  const refResults: ReceiveResult["refResults"] = [];
  for (const cmd of commands) {
    // update runs per ref and can reject just that one, letting the rest of
    // the push proceed.
    const update = await runHook(repo.path, "update", { args: [cmd.name, cmd.oldOid, cmd.newOid] });
    if (!update.ok) {
      refResults.push({ name: cmd.name, ok: false, reason: update.output || "update hook declined" });
      continue;
    }
    try {
      repo.updateRef(cmd.name, cmd.oldOid, cmd.newOid);
      refResults.push({ name: cmd.name, ok: true });
      applied.push(cmd);
    } catch (err) {
      refResults.push({ name: cmd.name, ok: false, reason: err instanceof Error ? err.message : "failed to update ref" });
    }
  }

  // A bare repo's HEAD is written at init time, before any branch exists, so it
  // routinely names a branch nobody pushed — `git init --bare` says "master",
  // the client pushes "main". Left dangling, the repo browses as empty and
  // clones warn about a nonexistent remote HEAD, so adopt a real branch here.
  // Every push, not just a creating one: a repo that was empty before this push
  // has the same dangling HEAD.
  ensureDefaultBranch(repo);

  // post-receive is a fire-and-forget notification: refs are already updated,
  // so its outcome can't change the response.
  if (applied.length > 0) {
    await runHook(repo.path, "post-receive", { stdin: encodeHookStdin(applied) });
  }

  return { unpackOk: true, refResults };
}

export function encodeReportStatus(result: ReceiveResult): Uint8Array {
  const lines: Uint8Array[] = [
    encodePktLine(result.unpackOk ? "unpack ok\n" : `unpack ${result.unpackError}\n`),
  ];
  for (const r of result.refResults) {
    lines.push(encodePktLine(r.ok ? `ok ${r.name}\n` : `ng ${r.name} ${r.reason}\n`));
  }
  lines.push(FLUSH_PKT);
  return concatBytes(lines);
}

// Points HEAD at a branch that exists, if it doesn't already. A HEAD that
// resolves (including a detached one, as in a jj-backed repo) is left alone.
export function ensureDefaultBranch(repo: WritableRepository): void {
  if (!repo.headIsUnborn()) return;
  const branches = repo.references().filter((r) => r.kind === "branch");
  if (branches.length === 0) return;
  const chosen =
    branches.find((b) => b.name === "main") ??
    branches.find((b) => b.name === "master") ??
    branches[0]!;
  repo.setHead(chosen.fullName);
}
