import { test, expect } from "bun:test";
import { encodePktLine, decodePktLine, readUntilFlush, concatBytes, FLUSH_PKT } from "../../../src/git/smart-http/pktline";

test("encodePktLine frames a short string with a 4-hex-digit length prefix", () => {
  const encoded = encodePktLine("done\n");
  // length = 4 (header) + 5 (payload) = 9 = 0x0009
  expect(new TextDecoder().decode(encoded)).toBe("0009done\n");
});

test("encodePktLine handles binary payloads", () => {
  const payload = new Uint8Array([1, 2, 3]);
  const encoded = encodePktLine(payload);
  expect(encoded.length).toBe(7); // 4 header + 3 payload
  expect(new TextDecoder().decode(encoded.subarray(0, 4))).toBe("0007");
  expect(encoded.subarray(4)).toEqual(payload);
});

test("encodePktLine rejects oversized payloads", () => {
  const huge = new Uint8Array(0x10000);
  expect(() => encodePktLine(huge)).toThrow();
});

test("FLUSH_PKT is the literal 4-byte flush marker", () => {
  expect(new TextDecoder().decode(FLUSH_PKT)).toBe("0000");
});

test("decodePktLine round-trips an encoded line", () => {
  const encoded = encodePktLine("want abc\n");
  const { line, next } = decodePktLine(encoded, 0);
  expect(line.type).toBe("data");
  expect(new TextDecoder().decode(line.payload)).toBe("want abc\n");
  expect(next).toBe(encoded.length);
});

test("decodePktLine recognizes a flush-pkt", () => {
  const { line, next } = decodePktLine(FLUSH_PKT, 0);
  expect(line.type).toBe("flush");
  expect(line.payload.length).toBe(0);
  expect(next).toBe(4);
});

test("decodePktLine rejects a truncated length header", () => {
  expect(() => decodePktLine(new Uint8Array([0x30, 0x30]), 0)).toThrow();
});

test("decodePktLine rejects a non-hex length header", () => {
  const bad = new TextEncoder().encode("zzzzdata");
  expect(() => decodePktLine(bad, 0)).toThrow();
});

test("decodePktLine rejects a truncated payload", () => {
  // Claims a 20-byte pkt-line but only provides the 4-byte header.
  const bad = new TextEncoder().encode("0014");
  expect(() => decodePktLine(bad, 0)).toThrow();
});

test("readUntilFlush collects data lines up to (and past) the flush-pkt", () => {
  const buf = concatBytes([
    encodePktLine("want aaa\n"),
    encodePktLine("want bbb\n"),
    FLUSH_PKT,
    new TextEncoder().encode("PACK-DATA-FOLLOWS"),
  ]);
  const { lines, next } = readUntilFlush(buf, 0);
  expect(lines.map((l) => new TextDecoder().decode(l))).toEqual(["want aaa\n", "want bbb\n"]);
  expect(new TextDecoder().decode(buf.subarray(next))).toBe("PACK-DATA-FOLLOWS");
});

test("concatBytes joins chunks in order", () => {
  const result = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]);
  expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
});
