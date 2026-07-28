import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../../fixtures/repo";
import { openRepository } from "../../../src/git";
import {
  buildFetchV2Response, buildLsRefsResponse, buildV2Advertisement,
  isV2Request, parseFetchV2Args, parseV2Request,
} from "../../../src/git/smart-http/protocolV2";
import { concatBytes, decodePktLine, encodePktLine, DELIM_PKT, FLUSH_PKT } from "../../../src/git/smart-http/pktline";

const decoder = new TextDecoder();

function linesOf(buf: Uint8Array): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { line, next } = decodePktLine(buf, offset);
    offset = next;
    if (line.type === "data") lines.push(decoder.decode(line.payload).replace(/\n$/, ""));
  }
  return lines;
}

test("buildV2Advertisement opens with 'version 2' (no '# service=' line) and lists ls-refs/fetch", () => {
  const body = buildV2Advertisement();
  const lines = linesOf(body);
  expect(lines[0]).toBe("version 2");
  expect(lines).toContain("ls-refs");
  // `shallow` is the one fetch feature implemented, so it rides on the fetch line.
  expect(lines).toContain("fetch=shallow");
  expect(lines.some((l) => l.startsWith("agent="))).toBe(true);
});

test("isV2Request distinguishes a v2 command-request from a v0 want/have body", () => {
  const v2Body = concatBytes([encodePktLine("command=ls-refs\n"), DELIM_PKT, FLUSH_PKT]);
  const v0Body = concatBytes([encodePktLine(`want ${"a".repeat(40)}\n`), FLUSH_PKT]);
  expect(isV2Request(v2Body)).toBe(true);
  expect(isV2Request(v0Body)).toBe(false);
  expect(isV2Request(new Uint8Array(0))).toBe(false);
});

test("parseV2Request splits capabilities (before delim) from args (before flush)", () => {
  const body = concatBytes([
    encodePktLine("command=fetch\n"),
    encodePktLine("agent=git/2.40\n"),
    DELIM_PKT,
    encodePktLine(`want ${"a".repeat(40)}\n`),
    encodePktLine("done\n"),
    FLUSH_PKT,
  ]);
  const parsed = parseV2Request(body);
  expect(parsed.command).toBe("fetch");
  expect(parsed.capabilities).toEqual(["agent=git/2.40"]);
  expect(parsed.args).toEqual([`want ${"a".repeat(40)}`, "done"]);
});

test("parseV2Request tolerates an empty-request shape (flush before any delim)", () => {
  const body = concatBytes([encodePktLine("command=ls-refs\n"), FLUSH_PKT]);
  const parsed = parseV2Request(body);
  expect(parsed.command).toBe("ls-refs");
  expect(parsed.args).toEqual([]);
});

test("parseFetchV2Args collects want/have oids and the done flag", () => {
  const oid1 = "a".repeat(40);
  const oid2 = "b".repeat(40);
  const have = "c".repeat(40);
  const parsed = parseFetchV2Args([`want ${oid1}`, `want ${oid2}`, `have ${have}`, "thin-pack", "done"]);
  expect(parsed.wants).toEqual([oid1, oid2]);
  expect(parsed.haves).toEqual([have]);
  expect(parsed.done).toBe(true);
});

const fixture: FixtureRepo = await createFixtureRepo();
afterAll(() => fixture.cleanup());

test("buildLsRefsResponse lists HEAD (with symrefs), branches and tags, peeling annotated tags on request", () => {
  const repo = openRepository(fixture.path);
  try {
    const body = buildLsRefsResponse(repo, ["symrefs", "peel"]);
    const lines = linesOf(body);
    expect(lines[0]).toMatch(/^[0-9a-f]{40} HEAD symref-target:refs\/heads\/main$/);
    expect(lines.some((l) => l.endsWith(" refs/heads/main"))).toBe(true);
    expect(lines.some((l) => l.endsWith(" refs/tags/v1.0"))).toBe(true);
    const v2Line = lines.find((l) => l.includes("refs/tags/v2.0"));
    expect(v2Line).toMatch(/ peeled:[0-9a-f]{40}$/); // annotated tag: peeled attr, not a separate ^{} line
  } finally {
    repo.free();
  }
});

test("buildLsRefsResponse honors ref-prefix filtering", () => {
  const repo = openRepository(fixture.path);
  try {
    const body = buildLsRefsResponse(repo, ["ref-prefix refs/tags/"]);
    const lines = linesOf(body);
    expect(lines.some((l) => l.includes("refs/heads/main"))).toBe(false);
    expect(lines.some((l) => l.includes("refs/tags/v1.0"))).toBe(true);
  } finally {
    repo.free();
  }
});

test("buildLsRefsResponse reports HEAD as unborn only when the 'unborn' arg is sent", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-v2-empty-"));
  await Bun.spawn(["git", "init", "-q", "--bare", join(root, "empty.git")]).exited;
  const repo = openRepository(join(root, "empty.git"));
  try {
    expect(linesOf(buildLsRefsResponse(repo, ["symrefs"]))).toEqual([]);
    const lines = linesOf(buildLsRefsResponse(repo, ["symrefs", "unborn"]));
    expect(lines).toEqual(["unborn HEAD symref-target:refs/heads/main"]);
  } finally {
    repo.free();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildFetchV2Response omits acknowledgments when the client already sent 'done'", () => {
  const repo = openRepository(fixture.path);
  try {
    const headOid = repo.commit(repo.headRef())!.oid;
    const response = buildFetchV2Response(repo, { wants: [headOid], haves: [], done: true });
    const { line: first, next } = decodePktLine(response, 0);
    expect(decoder.decode(first.payload)).toBe("packfile\n");
    const { line: second } = decodePktLine(response, next);
    expect(Array.from(second.payload.subarray(0, 5))).toEqual([1, ...Array.from(new TextEncoder().encode("PACK"))]);
  } finally {
    repo.free();
  }
});

test("buildFetchV2Response sends a bare 'ready' acknowledgment when 'done' wasn't sent", () => {
  const repo = openRepository(fixture.path);
  try {
    const headOid = repo.commit(repo.headRef())!.oid;
    const response = buildFetchV2Response(repo, { wants: [headOid], haves: [], done: false });
    const { line: l1, next: n1 } = decodePktLine(response, 0);
    expect(decoder.decode(l1.payload)).toBe("acknowledgments\n");
    const { line: l2, next: n2 } = decodePktLine(response, n1);
    expect(decoder.decode(l2.payload)).toBe("ready\n");
    const { line: l3, next: n3 } = decodePktLine(response, n2);
    expect(l3.type).toBe("delim");
    const { line: l4 } = decodePktLine(response, n3);
    expect(decoder.decode(l4.payload)).toBe("packfile\n");
  } finally {
    repo.free();
  }
});
