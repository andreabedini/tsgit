import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../../fixtures/repo";
import { openRepository } from "../../../src/git";
import { parseReceiveCommands, applyReceivePack, encodeReportStatus } from "../../../src/git/smart-http/receivePack";
import { decodePktLine } from "../../../src/git/smart-http/pktline";

const ZERO = "0".repeat(40);
const encoder = new TextEncoder();

test("parseReceiveCommands reads capabilities off the first line only", () => {
  const oid = "a".repeat(40);
  const { commands, capabilities } = parseReceiveCommands([
    encoder.encode(`${ZERO} ${oid} refs/heads/main\0report-status delete-refs\n`),
    encoder.encode(`${oid} ${ZERO} refs/heads/old\n`),
  ]);
  expect(capabilities).toEqual(["report-status", "delete-refs"]);
  expect(commands).toEqual([
    { oldOid: ZERO, newOid: oid, name: "refs/heads/main" },
    { oldOid: oid, newOid: ZERO, name: "refs/heads/old" },
  ]);
});

test("parseReceiveCommands throws on a malformed command line", () => {
  expect(() => parseReceiveCommands([encoder.encode("not a command line\n")])).toThrow();
});

test("encodeReportStatus frames unpack-ok and per-ref results, terminated by a flush", () => {
  const body = encodeReportStatus({
    unpackOk: true,
    refResults: [
      { name: "refs/heads/main", ok: true },
      { name: "refs/heads/other", ok: false, reason: "stale info" },
    ],
  });
  const lines: string[] = [];
  let offset = 0;
  while (true) {
    const { line, next } = decodePktLine(body, offset);
    offset = next;
    if (line.type === "flush") break;
    lines.push(new TextDecoder().decode(line.payload));
  }
  expect(lines).toEqual(["unpack ok\n", "ok refs/heads/main\n", "ng refs/heads/other stale info\n"]);
  expect(offset).toBe(body.length);
});

test("encodeReportStatus reports the unpack error and skips ref updates", () => {
  const body = encodeReportStatus({ unpackOk: false, unpackError: "bad pack", refResults: [{ name: "refs/heads/main", ok: false, reason: "unpacker error" }] });
  const { line } = decodePktLine(body, 0);
  expect(new TextDecoder().decode(line.payload)).toBe("unpack bad pack\n");
});

const fixture: FixtureRepo = await createFixtureRepo();
const roots: string[] = [];
afterAll(() => {
  fixture.cleanup();
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

async function buildPack(repoPath: string): Promise<Uint8Array> {
  const revList = Bun.spawn(["git", "-C", repoPath, "rev-list", "--objects", "--all"], { stdout: "pipe" });
  const packObjects = Bun.spawn(["git", "-C", repoPath, "pack-objects", "--stdout"], { stdin: revList.stdout, stdout: "pipe" });
  const bytes = new Uint8Array(await new Response(packObjects.stdout).arrayBuffer());
  await revList.exited;
  await packObjects.exited;
  return bytes;
}

test("applyReceivePack indexes the pack and creates the requested ref", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-applyreceive-"));
  roots.push(root);
  const targetPath = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", targetPath]).exited;

  const headOid = (() => {
    const r = openRepository(fixture.path);
    try { return r.commit(r.headRef())!.oid; } finally { r.free(); }
  })();
  const pack = await buildPack(fixture.path);

  const target = openRepository(targetPath);
  try {
    const result = applyReceivePack(target, [{ oldOid: ZERO, newOid: headOid, name: "refs/heads/main" }], pack);
    expect(result.unpackOk).toBe(true);
    expect(result.refResults).toEqual([{ name: "refs/heads/main", ok: true }]);
    expect(target.commit("refs/heads/main")?.oid).toBe(headOid);
  } finally {
    target.free();
  }
});

test("applyReceivePack reports a CAS failure without touching the ref", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-applyreceive-cas-"));
  roots.push(root);
  const targetPath = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", targetPath]).exited;

  const headOid = (() => {
    const r = openRepository(fixture.path);
    try { return r.commit(r.headRef())!.oid; } finally { r.free(); }
  })();
  const pack = await buildPack(fixture.path);

  const target = openRepository(targetPath);
  try {
    const badOldOid = "1".repeat(40);
    const result = applyReceivePack(target, [{ oldOid: badOldOid, newOid: headOid, name: "refs/heads/main" }], pack);
    expect(result.unpackOk).toBe(true); // the pack itself indexed fine
    expect(result.refResults[0].ok).toBe(false);
    expect(target.commit("refs/heads/main")).toBeNull();
  } finally {
    target.free();
  }
});
