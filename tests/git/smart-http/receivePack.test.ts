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
    const result = await applyReceivePack(target, [{ oldOid: ZERO, newOid: headOid, name: "refs/heads/main" }], pack);
    expect(result.unpackOk).toBe(true);
    expect(result.refResults).toEqual([{ name: "refs/heads/main", ok: true }]);
    expect(target.commit("refs/heads/main")?.oid).toBe(headOid);
  } finally {
    target.free();
  }
});

test("applyReceivePack succeeds for a delete-only push with an empty pack", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-applyreceive-delete-"));
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
    // First create the branch (needs the real pack)...
    const created = await applyReceivePack(target, [{ oldOid: "0".repeat(40), newOid: headOid, name: "refs/heads/main" }], pack);
    expect(created.unpackOk).toBe(true);
    expect(target.commit("refs/heads/main")?.oid).toBe(headOid);

    // ...then delete it with an EMPTY pack (as a real git delete-only push sends).
    const deleted = await applyReceivePack(target, [{ oldOid: headOid, newOid: "0".repeat(40), name: "refs/heads/main" }], new Uint8Array(0));
    expect(deleted.unpackOk).toBe(true);
    expect(deleted.refResults).toEqual([{ name: "refs/heads/main", ok: true }]);
    expect(target.commit("refs/heads/main")).toBeNull();
  } finally {
    target.free();
  }
});

async function writeHook(repoPath: string, name: string, script: string): Promise<void> {
  const path = join(repoPath, "hooks", name);
  await Bun.write(path, `#!/bin/sh\n${script}\n`);
  await Bun.spawn(["chmod", "+x", path]).exited;
}

test("applyReceivePack: a pre-receive hook that exits non-zero rejects the whole push, untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-applyreceive-prereceive-"));
  roots.push(root);
  const targetPath = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", targetPath]).exited;
  await writeHook(targetPath, "pre-receive", 'echo "no pushes today" >&2\nexit 1');

  const headOid = (() => {
    const r = openRepository(fixture.path);
    try { return r.commit(r.headRef())!.oid; } finally { r.free(); }
  })();
  const pack = await buildPack(fixture.path);

  const target = openRepository(targetPath);
  try {
    const result = await applyReceivePack(target, [{ oldOid: ZERO, newOid: headOid, name: "refs/heads/main" }], pack);
    expect(result.unpackOk).toBe(true); // pack still indexes; only the ref update is blocked
    expect(result.refResults).toEqual([{ name: "refs/heads/main", ok: false, reason: "no pushes today" }]);
    expect(target.commit("refs/heads/main")).toBeNull();
  } finally {
    target.free();
  }
});

test("applyReceivePack: an update hook rejects only the ref it names, others still apply", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-applyreceive-update-"));
  roots.push(root);
  const targetPath = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", targetPath]).exited;
  // update gets (refname, oldrev, newrev) as $1 $2 $3 — reject only "blocked".
  await writeHook(targetPath, "update", 'if [ "$1" = "refs/heads/blocked" ]; then echo "branch is locked" >&2; exit 1; fi\nexit 0');

  const headOid = (() => {
    const r = openRepository(fixture.path);
    try { return r.commit(r.headRef())!.oid; } finally { r.free(); }
  })();
  const pack = await buildPack(fixture.path);

  const target = openRepository(targetPath);
  try {
    const result = await applyReceivePack(target, [
      { oldOid: ZERO, newOid: headOid, name: "refs/heads/allowed" },
      { oldOid: ZERO, newOid: headOid, name: "refs/heads/blocked" },
    ], pack);
    expect(result.refResults).toEqual([
      { name: "refs/heads/allowed", ok: true },
      { name: "refs/heads/blocked", ok: false, reason: "branch is locked" },
    ]);
    expect(target.commit("refs/heads/allowed")?.oid).toBe(headOid);
    expect(target.commit("refs/heads/blocked")).toBeNull();
  } finally {
    target.free();
  }
});

test("applyReceivePack runs post-receive after refs are updated, with the applied commands on stdin", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-applyreceive-postreceive-"));
  roots.push(root);
  const targetPath = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", targetPath]).exited;
  const marker = join(root, "post-receive-ran.txt");
  await writeHook(targetPath, "post-receive", `cat > ${marker}`);

  const headOid = (() => {
    const r = openRepository(fixture.path);
    try { return r.commit(r.headRef())!.oid; } finally { r.free(); }
  })();
  const pack = await buildPack(fixture.path);

  const target = openRepository(targetPath);
  try {
    const result = await applyReceivePack(target, [{ oldOid: ZERO, newOid: headOid, name: "refs/heads/main" }], pack);
    expect(result.refResults).toEqual([{ name: "refs/heads/main", ok: true }]);
    const markerContent = await Bun.file(marker).text();
    expect(markerContent).toBe(`${ZERO} ${headOid} refs/heads/main\n`);
  } finally {
    target.free();
  }
});

test("applyReceivePack ignores a hooks/pre-receive file that isn't executable", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-applyreceive-nonexec-"));
  roots.push(root);
  const targetPath = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", targetPath]).exited;
  await Bun.write(join(targetPath, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n"); // not chmod +x

  const headOid = (() => {
    const r = openRepository(fixture.path);
    try { return r.commit(r.headRef())!.oid; } finally { r.free(); }
  })();
  const pack = await buildPack(fixture.path);

  const target = openRepository(targetPath);
  try {
    const result = await applyReceivePack(target, [{ oldOid: ZERO, newOid: headOid, name: "refs/heads/main" }], pack);
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
    const result = await applyReceivePack(target, [{ oldOid: badOldOid, newOid: headOid, name: "refs/heads/main" }], pack);
    expect(result.unpackOk).toBe(true); // the pack itself indexed fine
    expect(result.refResults[0].ok).toBe(false);
    expect(target.commit("refs/heads/main")).toBeNull();
  } finally {
    target.free();
  }
});
