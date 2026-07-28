export const FLUSH_PKT: Uint8Array = new TextEncoder().encode("0000");
// Protocol v2 section separator inside a single request/response (RFC: "delim-pkt").
// Unlike flush-pkt (which ends a message), delim-pkt separates sections within one.
export const DELIM_PKT: Uint8Array = new TextEncoder().encode("0001");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodePktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const len = bytes.length + 4;
  if (len > 0xffff) throw new Error(`pkt-line payload too large: ${bytes.length} bytes`);
  const out = new Uint8Array(len);
  out.set(encoder.encode(len.toString(16).padStart(4, "0")), 0);
  out.set(bytes, 4);
  return out;
}

export interface DecodedPktLine {
  type: "flush" | "delim" | "data";
  payload: Uint8Array;
}

export function decodePktLine(data: Uint8Array, offset: number): { line: DecodedPktLine; next: number } {
  if (offset + 4 > data.length) throw new Error("truncated pkt-line length header");
  const header = decoder.decode(data.subarray(offset, offset + 4));
  if (!/^[0-9a-fA-F]{4}$/.test(header)) {
    throw new Error(`invalid pkt-line length header: ${JSON.stringify(header)}`);
  }
  const len = parseInt(header, 16);
  if (len === 0) return { line: { type: "flush", payload: new Uint8Array(0) }, next: offset + 4 };
  if (len === 1) return { line: { type: "delim", payload: new Uint8Array(0) }, next: offset + 4 };
  if (len < 4) throw new Error(`invalid pkt-line length: ${len}`);
  if (offset + len > data.length) throw new Error("truncated pkt-line payload");
  return { line: { type: "data", payload: data.subarray(offset + 4, offset + len) }, next: offset + len };
}

// Reads data pkt-lines from `offset` up to (and past) the next flush-pkt.
// `next` points just after the flush-pkt, so callers can slice any raw bytes
// that follow it (e.g. a packfile, which is not itself pkt-line framed).
export function readUntilFlush(data: Uint8Array, offset = 0): { lines: Uint8Array[]; next: number } {
  const lines: Uint8Array[] = [];
  let pos = offset;
  while (true) {
    const { line, next } = decodePktLine(data, pos);
    pos = next;
    if (line.type === "flush") break;
    lines.push(line.payload);
  }
  return { lines, next: pos };
}

// Protocol v2's `fetch` packfile section is always multiplexed (side-band-64k
// semantics, unconditionally — no capability negotiation): each pkt-line
// payload is a 1-byte stream code (1 = pack data) followed by a chunk of the
// packfile. Chunk size stays comfortably under the 0xffff pkt-line cap.
const SIDEBAND_CHUNK_SIZE = 65515;

export function encodeSidebandChunks(streamCode: 1 | 2 | 3, data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK_SIZE) {
    const slice = data.subarray(offset, offset + SIDEBAND_CHUNK_SIZE);
    const framed = new Uint8Array(slice.length + 1);
    framed[0] = streamCode;
    framed.set(slice, 1);
    chunks.push(encodePktLine(framed));
  }
  return chunks;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
