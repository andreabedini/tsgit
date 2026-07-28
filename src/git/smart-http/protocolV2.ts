import type { Repository } from "../facade";
import { DELIM_PKT, FLUSH_PKT, concatBytes, decodePktLine, encodePktLine, encodeSidebandChunks } from "./pktline";

const decoder = new TextDecoder();

// Only `ls-refs` and `fetch`, base features only (no shallow/filter/
// ref-in-want/sideband-all/packfile-uris/wait-for-done) — matches this app's
// v0 upload-pack, which doesn't implement those either. `receive-pack` (push)
// is untouched by protocol v2, so there's no v2 advertisement for it.
export function buildV2Advertisement(): Uint8Array {
  const lines = [
    encodePktLine("version 2\n"),
    encodePktLine("agent=git/tsgit\n"),
    encodePktLine("ls-refs\n"),
    encodePktLine("fetch\n"),
    FLUSH_PKT,
  ];
  return concatBytes(lines);
}

// True when the POST body opens with a v2 `command=...` line, as opposed to a
// v0/v1 request (which starts directly with `want `/`have ` lines).
export function isV2Request(body: Uint8Array): boolean {
  if (body.length === 0) return false;
  try {
    const { line } = decodePktLine(body, 0);
    if (line.type !== "data") return false;
    return decoder.decode(line.payload).replace(/\n$/, "").startsWith("command=");
  } catch {
    return false;
  }
}

export interface V2Request {
  command: string;
  capabilities: string[];
  args: string[];
}

// command-request = command capability-list delim-pkt command-args flush-pkt
export function parseV2Request(body: Uint8Array): V2Request {
  const { line: commandLine, next: afterCommand } = decodePktLine(body, 0);
  const commandText = decoder.decode(commandLine.payload).replace(/\n$/, "");
  const prefix = "command=";
  if (!commandText.startsWith(prefix)) {
    throw new Error(`expected a "command=" line, got ${JSON.stringify(commandText)}`);
  }
  const command = commandText.slice(prefix.length);

  const capabilities: string[] = [];
  let offset = afterCommand;
  while (true) {
    const { line, next } = decodePktLine(body, offset);
    offset = next;
    if (line.type === "delim") break;
    if (line.type === "flush") return { command, capabilities, args: [] }; // empty-request shape; tolerate it
    capabilities.push(decoder.decode(line.payload).replace(/\n$/, ""));
  }

  const args: string[] = [];
  while (true) {
    const { line, next } = decodePktLine(body, offset);
    offset = next;
    if (line.type === "flush") break;
    args.push(decoder.decode(line.payload).replace(/\n$/, ""));
  }

  return { command, capabilities, args };
}

export function buildLsRefsResponse(repo: Repository, args: string[]): Uint8Array {
  let symrefs = false;
  let unborn = false;
  let peel = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === "symrefs") symrefs = true;
    else if (arg === "peel") peel = true;
    else if (arg === "unborn") unborn = true;
    else if (arg.startsWith("ref-prefix ")) prefixes.push(arg.slice("ref-prefix ".length));
  }
  const matches = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const lines: string[] = [];

  if (matches("HEAD")) {
    const headBranch = repo.headRef();
    const headCommit = repo.commit(headBranch);
    let headLine: string | null = null;
    if (headCommit) headLine = `${headCommit.oid} HEAD`;
    else if (unborn) headLine = `unborn HEAD`;
    if (headLine) {
      if (symrefs) headLine += ` symref-target:refs/heads/${headBranch}`;
      lines.push(headLine);
    }
  }

  for (const ref of repo.references()) {
    if (!matches(ref.fullName)) continue;
    let line = `${ref.targetOid} ${ref.fullName}`;
    if (peel && ref.kind === "tag" && ref.targetOid !== ref.commitOid) {
      line += ` peeled:${ref.commitOid}`;
    }
    lines.push(line);
  }

  const pktLines = lines.map((l) => encodePktLine(`${l}\n`));
  pktLines.push(FLUSH_PKT);
  return concatBytes(pktLines);
}

export interface FetchV2Args {
  wants: string[];
  haves: string[];
  done: boolean;
}

export function parseFetchV2Args(args: string[]): FetchV2Args {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  for (const arg of args) {
    if (arg.startsWith("want ")) wants.push(arg.slice(5, 45));
    else if (arg.startsWith("have ")) haves.push(arg.slice(5, 45));
    else if (arg === "done") done = true;
    // thin-pack / no-progress / include-tag / ofs-delta and other base fetch
    // args are accepted but not acted on — not implemented, same as v0.
  }
  return { wants, haves, done };
}

// A real negotiation loop (ACK/NAK rounds) isn't implemented, mirroring this
// app's v0 upload-pack: the full pack answering `wants`/`haves` is always
// computed immediately. Per the v2 spec this is a legal "server decided it
// has enough to answer" optimization — it's only the acknowledgments section
// that changes shape: omitted if the client already said "done", otherwise a
// bare "ready" line stands in for the ACK/NAK round we're skipping.
export function buildFetchV2Response(
  repo: { packObjects(wants: string[], haves: string[]): Uint8Array },
  fetchArgs: FetchV2Args,
): Uint8Array {
  const packBytes = repo.packObjects(fetchArgs.wants, fetchArgs.haves);
  const sections: Uint8Array[] = [];
  if (!fetchArgs.done) {
    sections.push(encodePktLine("acknowledgments\n"), encodePktLine("ready\n"), DELIM_PKT);
  }
  sections.push(encodePktLine("packfile\n"), ...encodeSidebandChunks(1, packBytes), FLUSH_PKT);
  return concatBytes(sections);
}
