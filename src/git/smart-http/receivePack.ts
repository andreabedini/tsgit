import type { WritableRepository } from "../facade";
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

export function applyReceivePack(
  repo: WritableRepository,
  commands: ReceiveCommand[],
  packBytes: Uint8Array,
): ReceiveResult {
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

  const refResults = commands.map((cmd) => {
    try {
      repo.updateRef(cmd.name, cmd.oldOid, cmd.newOid);
      return { name: cmd.name, ok: true };
    } catch (err) {
      return { name: cmd.name, ok: false, reason: err instanceof Error ? err.message : "failed to update ref" };
    }
  });
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
