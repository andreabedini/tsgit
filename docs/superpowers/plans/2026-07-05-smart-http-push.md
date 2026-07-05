# Git Smart-HTTP (fetch + push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement git's smart-HTTP protocol (v0) directly in tsgit against libgit2, so `git clone`/`fetch`/`push` work over HTTP against the same server as the browsing UI, with push gated by HTTP Basic Auth.

**Architecture:** A new `src/git/smart-http/` module holds pure protocol logic (pkt-line codec, ref advertisement, upload-pack/receive-pack parsing and response building) that depends only on the existing read-only `Repository` facade plus a new `WritableRepository` type carrying four write primitives (`isBare`, `updateRef`, `indexPack`, `packObjects`) implemented as new libgit2 FFI bindings on the existing `Repo` class. Four new Hono routes are mounted alongside the existing browsing routes and reuse the existing `useRepository` middleware.

**Tech Stack:** TypeScript, Bun (`bun:ffi`), Hono, libgit2 1.9 (via `bun:ffi` `dlopen`), `Bun.password` (bcrypt) for htpasswd verification.

## Global Constraints

- No `git` subprocess in application runtime code — everything goes through libgit2 FFI. Tests MAY shell out to the real `git` CLI to build fixtures/packs and to drive the server as a real client (existing project convention, see `tests/fixtures/repo.ts`).
- Keep FFI symbol signatures in `src/git/binding/libgit2.ts` exact — every new `SYMBOLS` entry below has been spiked and verified against the system's libgit2 1.9.4 headers (`/usr/include/git2/*.h`) and a real `dlopen` call; do not "simplify" a signature.
- The existing `Repository` interface (`src/git/facade.ts`) must NOT be modified — it is what the HTML views depend on. All new write capability goes on a new `WritableRepository` interface that extends it.
- Only bcrypt (`$2a$`/`$2b$`/`$2y$`) htpasswd entries are supported. Other hash formats (MD5 apr1, crypt) are parsed but always fail verification — this is documented behavior, not a bug.
- Follow existing FFI conventions documented at the bottom of `src/git/binding/libgit2.ts` (`ptrSlot`/`oidSlot`/`readPtr`/`cstr`, `cstring`-returning symbols auto-coerce to JS strings, `Type **out` params via `ptr(ptrSlot())` + `readPtr`).
- TDD: write the failing test first for every step that has one.

---

## Task 1: pkt-line codec

**Files:**
- Create: `src/git/smart-http/pktline.ts`
- Test: `tests/git/smart-http/pktline.test.ts`

**Interfaces:**
- Produces: `encodePktLine(payload: string | Uint8Array): Uint8Array`, `FLUSH_PKT: Uint8Array`, `concatBytes(chunks: Uint8Array[]): Uint8Array`, `type DecodedPktLine = { type: "flush" | "data"; payload: Uint8Array }`, `decodePktLine(data: Uint8Array, offset: number): { line: DecodedPktLine; next: number }`, `readUntilFlush(data: Uint8Array, offset?: number): { lines: Uint8Array[]; next: number }`.

This is the only file in the feature with zero dependencies on libgit2 or Hono — pure byte-framing logic per git's `pkt-line` format (4 hex-digit length prefix, `"0000"` flush marker).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/git/smart-http/pktline.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/git/smart-http/pktline.test.ts`
Expected: FAIL — `src/git/smart-http/pktline.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement the pkt-line codec**

```typescript
// src/git/smart-http/pktline.ts
export const FLUSH_PKT: Uint8Array = new TextEncoder().encode("0000");

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
  type: "flush" | "data";
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/git/smart-http/pktline.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: add pkt-line codec for git smart-HTTP"
```

---

## Task 2: htpasswd credential store + Basic Auth check

**Files:**
- Create: `src/config/htpasswd.ts`
- Create: `src/git/smart-http/auth.ts`
- Modify: `src/config/config.ts`
- Modify: `src/app/env.ts`
- Test: `tests/htpasswd.test.ts`
- Test: `tests/git/smart-http/auth.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `interface HtpasswdEntry { user: string; hash: string }`, `parseHtpasswd(text: string): HtpasswdEntry[]`, `verifyHtpasswd(entries: HtpasswdEntry[], user: string, password: string): Promise<boolean>`, `checkBasicAuth(authHeader: string | undefined, credentials: HtpasswdEntry[]): Promise<Response | null>` (returns `null` when authorized, else a 401 `Response`). `SiteConfig.pushCredentials: HtpasswdEntry[]` and `SiteConfig.TSGIT_HTPASSWD_FILE?: string` become available on `c.env` for Task 10's routes.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/htpasswd.test.ts
import { test, expect } from "bun:test";
import { parseHtpasswd, verifyHtpasswd } from "../src/config/htpasswd";
import { loadConfig } from "../src/config/config";

test("parseHtpasswd parses user:hash lines", () => {
  const text = "alice:$2y$05$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUV\nbob:$2y$05$zzzzzzzzzzzzzzzzzzzzzzAAAAAAAAAAAAAAAAAAAAAA\n";
  expect(parseHtpasswd(text)).toEqual([
    { user: "alice", hash: "$2y$05$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUV" },
    { user: "bob", hash: "$2y$05$zzzzzzzzzzzzzzzzzzzzzzAAAAAAAAAAAAAAAAAAAAAA" },
  ]);
});

test("parseHtpasswd skips blank lines and comments", () => {
  const text = "\n# a comment\nalice:$2y$05$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUV\n\n";
  expect(parseHtpasswd(text)).toEqual([
    { user: "alice", hash: "$2y$05$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUV" },
  ]);
});

test("parseHtpasswd skips malformed lines with no colon", () => {
  expect(parseHtpasswd("not-a-valid-line\n")).toEqual([]);
});

test("verifyHtpasswd accepts the correct password for a bcrypt entry", async () => {
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  expect(await verifyHtpasswd([{ user: "alice", hash }], "alice", "secret123")).toBe(true);
});

test("verifyHtpasswd rejects the wrong password", async () => {
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  expect(await verifyHtpasswd([{ user: "alice", hash }], "alice", "wrong")).toBe(false);
});

test("verifyHtpasswd rejects an unknown user", async () => {
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  expect(await verifyHtpasswd([{ user: "alice", hash }], "mallory", "secret123")).toBe(false);
});

test("verifyHtpasswd rejects (not throws) an unsupported hash format", async () => {
  expect(await verifyHtpasswd([{ user: "alice", hash: "$apr1$notbcrypt$xxxxxxxxxxxxxxxxxxxxx" }], "alice", "secret123")).toBe(false);
});

test("loadConfig defaults pushCredentials to an empty list when TSGIT_HTPASSWD_FILE is unset", () => {
  const cfg = loadConfig({});
  expect(cfg.pushCredentials).toEqual([]);
});

test("loadConfig returns an empty list when TSGIT_HTPASSWD_FILE points at a missing file", () => {
  const cfg = loadConfig({ TSGIT_HTPASSWD_FILE: "/nonexistent/htpasswd" });
  expect(cfg.pushCredentials).toEqual([]);
});
```

```typescript
// tests/git/smart-http/auth.test.ts
import { test, expect } from "bun:test";
import { checkBasicAuth } from "../../../src/git/smart-http/auth";
import type { HtpasswdEntry } from "../../../src/config/htpasswd";

async function credentials(): Promise<HtpasswdEntry[]> {
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  return [{ user: "alice", hash }];
}

test("checkBasicAuth returns null (authorized) for correct credentials", async () => {
  const header = `Basic ${btoa("alice:secret123")}`;
  expect(await checkBasicAuth(header, await credentials())).toBeNull();
});

test("checkBasicAuth returns a 401 when the Authorization header is missing", async () => {
  const res = await checkBasicAuth(undefined, await credentials());
  expect(res).not.toBeNull();
  expect(res!.status).toBe(401);
  expect(res!.headers.get("WWW-Authenticate")).toContain("Basic");
});

test("checkBasicAuth returns a 401 for the wrong password", async () => {
  const header = `Basic ${btoa("alice:wrong")}`;
  const res = await checkBasicAuth(header, await credentials());
  expect(res!.status).toBe(401);
});

test("checkBasicAuth returns a 401 for a malformed Authorization header", async () => {
  const res = await checkBasicAuth("Bearer sometoken", await credentials());
  expect(res!.status).toBe(401);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/htpasswd.test.ts tests/git/smart-http/auth.test.ts`
Expected: FAIL — `src/config/htpasswd.ts` and `src/git/smart-http/auth.ts` do not exist; `loadConfig`/`SiteConfig` don't have `pushCredentials` yet.

- [ ] **Step 3: Implement htpasswd parsing + verification**

```typescript
// src/config/htpasswd.ts
export interface HtpasswdEntry {
  user: string;
  hash: string;
}

export function parseHtpasswd(text: string): HtpasswdEntry[] {
  const entries: HtpasswdEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    entries.push({ user: line.slice(0, idx), hash: line.slice(idx + 1) });
  }
  return entries;
}

// Only bcrypt hashes ($2a$/$2b$/$2y$, e.g. from `htpasswd -B`) are supported.
// Other htpasswd formats (MD5 apr1, crypt) parse fine but always fail
// verification here rather than throwing.
export async function verifyHtpasswd(
  entries: HtpasswdEntry[],
  user: string,
  password: string,
): Promise<boolean> {
  const entry = entries.find((e) => e.user === user);
  if (!entry) return false;
  try {
    return await Bun.password.verify(password, entry.hash);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Wire `TSGIT_HTPASSWD_FILE` into config + env**

```typescript
// src/app/env.ts (full file)
import { createFactory } from 'hono/factory'

import { Commit, CommitDiff, Repository } from "../git";
import { DiscoveredRepo } from "../git/scan";
import type { HtpasswdEntry } from "../config/htpasswd";

export type Env = {
  Bindings: {
    TSGIT_SCAN_PATH: string;
    TSGIT_CLONE_URL_BASE?: string;
    TSGIT_SUMMARY_BRANCHES: number;
    TSGIT_SUMMARY_TAGS: number;
    TSGIT_SUMMARY_LOG: number;
    TSGIT_LOG_PAGE_SIZE: number;
    TSGIT_REPOLIST_PAGE_SIZE: number;
    TSGIT_HTPASSWD_FILE?: string;
    mimeTypes: Record<string, string>;
    pushCredentials: HtpasswdEntry[];
  };
  Variables: {
    disc: DiscoveredRepo;
    repo: Repository;
    commit: Commit;
    diff: CommitDiff;
  }
};

export const factory = createFactory<Env>();
```

(`Variables.repo` is widened to `WritableRepository` in Task 4, once that type exists — leave it as `Repository` for now.)

```typescript
// src/config/config.ts — add near the top, alongside the existing imports
import { parseHtpasswd, type HtpasswdEntry } from "./htpasswd";
```

```typescript
// src/config/config.ts — add this function near loadMimeTypes
// Missing file -> no credentials (every push request will then 401, since no
// user can match). A present-but-unreadable/malformed-permissions file throws,
// consistent with loadMimeTypes' fail-fast-at-startup behavior.
function loadHtpasswd(env: Record<string, string | undefined>): HtpasswdEntry[] {
  const path = env.TSGIT_HTPASSWD_FILE;
  if (!path) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }
  return parseHtpasswd(text);
}
```

```typescript
// src/config/config.ts — inside loadConfig()'s returned object, add:
    TSGIT_HTPASSWD_FILE: env.TSGIT_HTPASSWD_FILE,
    pushCredentials: loadHtpasswd(env),
```

- [ ] **Step 5: Implement the Basic Auth check**

```typescript
// src/git/smart-http/auth.ts
import { verifyHtpasswd, type HtpasswdEntry } from "../../config/htpasswd";

function parseBasicAuthHeader(header: string | undefined): { user: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx === -1) return null;
  return { user: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

// Returns null when the request is authorized, otherwise the 401 Response the
// caller should return as-is.
export async function checkBasicAuth(
  authHeader: string | undefined,
  credentials: HtpasswdEntry[],
): Promise<Response | null> {
  const parsed = parseBasicAuthHeader(authHeader);
  if (parsed && (await verifyHtpasswd(credentials, parsed.user, parsed.password))) {
    return null;
  }
  return new Response("Authentication required\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="tsgit push"' },
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/htpasswd.test.ts tests/git/smart-http/auth.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: add htpasswd credential store and Basic Auth check for push"
```

---

## Task 3: Ref advertisement (`info/refs`)

**Files:**
- Create: `src/git/smart-http/advertise.ts`
- Test: `tests/git/smart-http/advertise.test.ts`

**Interfaces:**
- Consumes: `encodePktLine`, `FLUSH_PKT`, `concatBytes` from `../../../src/git/smart-http/pktline` (Task 1); `Repository` from `../facade` (existing, unchanged).
- Produces: `buildAdvertisement(repo: Repository, service: "git-upload-pack" | "git-receive-pack"): Uint8Array`.

This depends only on the read-only `Repository` facade — no write bindings needed yet.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/git/smart-http/advertise.test.ts
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../../fixtures/repo";
import { openRepository } from "../../../src/git";
import { buildAdvertisement } from "../../../src/git/smart-http/advertise";
import { decodePktLine, readUntilFlush } from "../../../src/git/smart-http/pktline";

const fixture: FixtureRepo = await createFixtureRepo();
afterAll(() => fixture.cleanup());

function linesOf(buf: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { line, next } = decodePktLine(buf, offset);
    offset = next;
    if (line.type === "data") lines.push(decoder.decode(line.payload));
  }
  return lines;
}

test("buildAdvertisement starts with the service announcement pkt-line and a flush", () => {
  const repo = openRepository(fixture.path);
  try {
    const body = buildAdvertisement(repo, "git-upload-pack");
    const { line: first, next } = decodePktLine(body, 0);
    expect(new TextDecoder().decode(first.payload)).toBe("# service=git-upload-pack\n");
    const { line: second } = decodePktLine(body, next);
    expect(second.type).toBe("flush");
  } finally {
    repo.free();
  }
});

test("buildAdvertisement lists HEAD, branches and tags, with capabilities on the first ref line", () => {
  const repo = openRepository(fixture.path);
  try {
    const body = buildAdvertisement(repo, "git-upload-pack");
    const lines = linesOf(body).slice(1); // drop "# service=..." announcement
    expect(lines[0]).toContain(" HEAD\0");
    expect(lines[0]).toContain("agent=git/tsgit");
    const joined = lines.join("");
    expect(joined).toContain(" refs/heads/main\n");
    expect(joined).toContain(" refs/tags/v1.0\n");
    // v2.0 is annotated -> both the tag object oid and a peeled `^{}` commit line.
    expect(joined).toContain(" refs/tags/v2.0\n");
    expect(joined).toContain(" refs/tags/v2.0^{}\n");
  } finally {
    repo.free();
  }
});

test("buildAdvertisement advertises receive-pack capabilities", () => {
  const repo = openRepository(fixture.path);
  try {
    const body = buildAdvertisement(repo, "git-receive-pack");
    const lines = linesOf(body).slice(1);
    expect(lines[0]).toContain("report-status");
    expect(lines[0]).toContain("delete-refs");
  } finally {
    repo.free();
  }
});

test("buildAdvertisement emits the capabilities^{} placeholder for an empty repo", async () => {
  const root = mkdtempSync(join(tmpdir(), "tsgit-empty-"));
  await Bun.spawn(["git", "init", "-q", "--bare", join(root, "empty.git")]).exited;
  const repo = openRepository(join(root, "empty.git"));
  try {
    const body = buildAdvertisement(repo, "git-upload-pack");
    const { lines } = readUntilFlush(body, decodePktLine(body, 0).next);
    expect(lines.length).toBe(1);
    const text = new TextDecoder().decode(lines[0]);
    expect(text.startsWith("0000000000000000000000000000000000000000 capabilities^{}\0")).toBe(true);
  } finally {
    repo.free();
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/git/smart-http/advertise.test.ts`
Expected: FAIL — `src/git/smart-http/advertise.ts` does not exist.

- [ ] **Step 3: Implement `buildAdvertisement`**

```typescript
// src/git/smart-http/advertise.ts
import type { Repository } from "../facade";
import { encodePktLine, FLUSH_PKT, concatBytes } from "./pktline";

const ZERO_OID = "0".repeat(40);

export function buildAdvertisement(
  repo: Repository,
  service: "git-upload-pack" | "git-receive-pack",
): Uint8Array {
  const capabilities =
    service === "git-receive-pack"
      ? "report-status delete-refs agent=git/tsgit"
      : "agent=git/tsgit";

  const entries: { oid: string; name: string }[] = [];
  const headCommit = repo.commit(repo.headRef());
  if (headCommit) entries.push({ oid: headCommit.oid, name: "HEAD" });

  for (const ref of repo.references()) {
    entries.push({ oid: ref.targetOid, name: ref.fullName });
    if (ref.kind === "tag" && ref.targetOid !== ref.commitOid) {
      entries.push({ oid: ref.commitOid, name: `${ref.fullName}^{}` });
    }
  }

  const pktLines: Uint8Array[] = [
    encodePktLine(`# service=${service}\n`),
    FLUSH_PKT,
  ];

  if (entries.length === 0) {
    pktLines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    entries.forEach((entry, i) => {
      const suffix = i === 0 ? `\0${capabilities}` : "";
      pktLines.push(encodePktLine(`${entry.oid} ${entry.name}${suffix}\n`));
    });
  }
  pktLines.push(FLUSH_PKT);

  return concatBytes(pktLines);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/git/smart-http/advertise.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: build git smart-HTTP ref advertisement"
```

---

## Task 4: `WritableRepository` type + `isBare()` binding

**Files:**
- Modify: `src/git/facade.ts`
- Modify: `src/git/binding/libgit2.ts`
- Modify: `src/git/binding/repository.ts`
- Modify: `src/app/env.ts`
- Modify: `tests/fixtures/repo.ts`
- Test: `tests/git/is-bare.test.ts`

**Interfaces:**
- Produces: `interface WritableRepository extends Repository { isBare(): boolean }` (exported from `src/git/facade.ts`, and therefore from `src/git/index.ts` via its existing `export * from "./facade"`). `openRepository(path: string): WritableRepository`. `FixtureRepo.workPath: string` (the non-bare working-tree clone the bare fixture repo is published from — needed here to test the `isBare() === false` case).

This introduces the type Tasks 5-6 extend with `updateRef`/`indexPack`/`packObjects`.

- [ ] **Step 1: Extend the fixture with the non-bare working path**

```typescript
// tests/fixtures/repo.ts — add to the FixtureRepo interface
export interface FixtureRepo {
  path: string;             // path to the bare repo
  workPath: string;         // path to the non-bare working-tree repo the bare repo is cloned from
  commitSubjects: string[]; // newest-first
  branches: string[];
  tags: string[];
  subdir: string;           // "src"
  subdirFile: string;       // "src/hello.txt"
  binaryFile: string;       // "logo.bin"
  imageFile: string;        // "icon.gif"
  cleanup: () => void;
}
```

```typescript
// tests/fixtures/repo.ts — in the returned object of createFixtureRepo(), add:
    return {
      path: bare,
      workPath: work,
      commitSubjects: ["Add b.txt", "Add a.txt", "Add README"],
      ...
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/git/is-bare.test.ts
import { test, expect, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";

const fixture: FixtureRepo = await createFixtureRepo();
afterAll(() => fixture.cleanup());

test("isBare() is true for a bare repository", () => {
  const repo = openRepository(fixture.path);
  try {
    expect(repo.isBare()).toBe(true);
  } finally {
    repo.free();
  }
});

test("isBare() is false for a non-bare (working-tree) repository", () => {
  const repo = openRepository(fixture.workPath);
  try {
    expect(repo.isBare()).toBe(false);
  } finally {
    repo.free();
  }
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test tests/git/is-bare.test.ts`
Expected: FAIL — `openRepository(...).isBare` is not a function.

- [ ] **Step 4: Add the `WritableRepository` type**

```typescript
// src/git/facade.ts — append at the end of the file
// Write primitives used only by the smart-HTTP module (src/git/smart-http/).
// Kept off `Repository` so the read-only facade the HTML views depend on stays
// untouched; `openRepository` returns this wider type, so `Repository`-typed
// call sites are unaffected (structural subtyping) while smart-http code can
// use the extra methods.
export interface WritableRepository extends Repository {
  /** True for bare repositories (no checked-out working tree) — push targets must be bare. */
  isBare(): boolean;
}
```

- [ ] **Step 5: Add the `git_repository_is_bare` binding**

```typescript
// src/git/binding/libgit2.ts — add to SYMBOLS, next to git_repository_head
  git_repository_is_bare: { args: [FFIType.ptr], returns: FFIType.i32 },
```

- [ ] **Step 6: Implement `isBare()` and widen `openRepository`'s return type**

```typescript
// src/git/binding/repository.ts — update the type-only import at the top
import type {
  Repository, WritableRepository, Reference, Commit, Signature, LogOptions, LogPage, TreeEntry, CommitDiff, DiffFile, DiffHunk, DiffLine, DiffStatus,
} from "../facade";
```

```typescript
// src/git/binding/repository.ts — change the class declaration
class Repo implements WritableRepository {
```

```typescript
// src/git/binding/repository.ts — add a method (e.g. right after headRef())
  isBare(): boolean {
    return lib.git_repository_is_bare(toPtr(this.handle)) === 1;
  }
```

```typescript
// src/git/binding/repository.ts — widen the exported function's return type
export function openRepository(path: string): WritableRepository {
  ensureInit();
  const slot = ptrSlot();
  check(lib.git_repository_open(toPtr(ptr(slot)), cstr(path)));
  return new Repo(path, readPtr(slot));
}
```

- [ ] **Step 7: Widen `Variables.repo` in the app Env**

```typescript
// src/app/env.ts — update the import and the Variables.repo field
import { Commit, CommitDiff, WritableRepository } from "../git";
...
  Variables: {
    disc: DiscoveredRepo;
    repo: WritableRepository;
    commit: Commit;
    diff: CommitDiff;
  }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun test tests/git/is-bare.test.ts && bun test`
Expected: PASS. The full suite (`bun test`) must also stay green — this step widens a type used across the whole app, so it's the checkpoint that confirms nothing else broke.

- [ ] **Step 9: Commit**

```bash
jj commit -m "feat: add WritableRepository type and isBare() binding"
```

---

## Task 5: `updateRef()` binding (atomic ref create/update/delete)

**Files:**
- Modify: `src/git/facade.ts`
- Modify: `src/git/binding/libgit2.ts`
- Modify: `src/git/binding/repository.ts`
- Test: `tests/git/update-ref.test.ts`

**Interfaces:**
- Consumes: `WritableRepository` (Task 4).
- Produces: `WritableRepository.updateRef(name: string, oldOidHex: string, newOidHex: string): void` — throws `GitError` if the ref's current value doesn't match `oldOidHex` (create: `oldOidHex` is 40 zeros and the ref must not already exist; delete: `newOidHex` is 40 zeros).

Verified by spike against a real repo: `git_reference_create_matching`'s `current_id` parameter, when `NULL`, **skips the comparison entirely** (does not mean "must not exist") — so the "does the caller's expected old value match reality" check must be done in JS before calling it, using `git_reference_lookup`. `git_reference_create_matching` then still provides real CAS at the moment of write, since we pass it the same value we just verified.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/git/update-ref.test.ts
import { test, expect, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";
import { GitError } from "../../src/git/binding/libgit2";

const ZERO = "0".repeat(40);

const fixture: FixtureRepo = await createFixtureRepo();
afterAll(() => fixture.cleanup());

function headOid(): string {
  const repo = openRepository(fixture.path);
  try {
    return repo.commit(repo.headRef())!.oid;
  } finally {
    repo.free();
  }
}

test("updateRef creates a new ref when oldOid is all zeros", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/created", ZERO, oid);
    expect(repo.commit("refs/heads/created")?.oid).toBe(oid);
  } finally {
    repo.free();
  }
});

test("updateRef rejects creating a ref that already exists", () => {
  const repo = openRepository(fixture.path);
  try {
    expect(() => repo.updateRef("refs/heads/main", ZERO, headOid())).toThrow(GitError);
  } finally {
    repo.free();
  }
});

test("updateRef updates an existing ref when oldOid matches", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/movable", ZERO, oid);
    // "Move" it back onto itself (a same-value CAS is still a valid update).
    repo.updateRef("refs/heads/movable", oid, oid);
    expect(repo.commit("refs/heads/movable")?.oid).toBe(oid);
  } finally {
    repo.free();
  }
});

test("updateRef rejects a stale oldOid (CAS failure)", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/guarded", ZERO, oid);
    expect(() => repo.updateRef("refs/heads/guarded", "1".repeat(40), oid)).toThrow(GitError);
  } finally {
    repo.free();
  }
});

test("updateRef deletes a ref when newOid is all zeros", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/temp", ZERO, oid);
    repo.updateRef("refs/heads/temp", oid, ZERO);
    expect(repo.commit("refs/heads/temp")).toBeNull();
    expect(repo.references().some((r) => r.fullName === "refs/heads/temp")).toBe(false);
  } finally {
    repo.free();
  }
});

test("updateRef rejects deleting with a stale oldOid", () => {
  const repo = openRepository(fixture.path);
  try {
    const oid = headOid();
    repo.updateRef("refs/heads/temp2", ZERO, oid);
    expect(() => repo.updateRef("refs/heads/temp2", "1".repeat(40), ZERO)).toThrow(GitError);
    expect(repo.commit("refs/heads/temp2")?.oid).toBe(oid); // untouched
  } finally {
    repo.free();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/git/update-ref.test.ts`
Expected: FAIL — `repo.updateRef` is not a function.

- [ ] **Step 3: Extend `WritableRepository`**

```typescript
// src/git/facade.ts — add to the WritableRepository interface
export interface WritableRepository extends Repository {
  isBare(): boolean;
  /**
   * Atomically create (`oldOidHex` all zeros), update, or delete
   * (`newOidHex` all zeros) a ref. Throws `GitError` if the ref's current
   * value does not match `oldOidHex`.
   */
  updateRef(name: string, oldOidHex: string, newOidHex: string): void;
}
```

- [ ] **Step 4: Add the new libgit2 bindings**

```typescript
// src/git/binding/libgit2.ts — add to SYMBOLS
  git_reference_lookup: { args: [FFIType.ptr, FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
  git_reference_create_matching: { args: [FFIType.ptr, FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
  git_reference_remove: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.i32 },
```

- [ ] **Step 5: Implement `updateRef()`**

```typescript
// src/git/binding/repository.ts — update the value import at the top to include GitError
import {
  lib, ensureInit, ptrSlot, oidSlot, readPtr, cstr, check, toPtr,
  ptr, read, toArrayBuffer, CString, GitError,
} from "./libgit2";
```

```typescript
// src/git/binding/repository.ts — add to the Repo class
  updateRef(name: string, oldOidHex: string, newOidHex: string): void {
    const isCreate = oldOidHex === "0".repeat(40);
    const isDelete = newOidHex === "0".repeat(40);
    const current = this.lookupDirectTargetOid(name);
    const expected = isCreate ? null : oldOidHex;
    if (current !== expected) {
      throw new GitError(`ref ${name}: stale info`, -15 /* GIT_EMODIFIED */);
    }

    if (isDelete) {
      check(lib.git_reference_remove(toPtr(this.handle), cstr(name)));
      return;
    }

    const newOidBytes = Buffer.from(newOidHex, "hex");
    const currentIdBytes = current ? Buffer.from(current, "hex") : null;
    const outSlot = ptrSlot();
    check(
      lib.git_reference_create_matching(
        toPtr(ptr(outSlot)),
        toPtr(this.handle),
        cstr(name),
        toPtr(ptr(newOidBytes)),
        1, // force: overwrite is fine, current_id below still enforces the CAS
        currentIdBytes ? toPtr(ptr(currentIdBytes)) : toPtr(0),
        toPtr(0),
      ),
    );
    lib.git_reference_free(toPtr(readPtr(outSlot)));
  }

  // Looks up a ref by exact name and returns its direct target oid (hex), or
  // null if the ref does not exist. Used by updateRef's CAS check.
  private lookupDirectTargetOid(name: string): string | null {
    const slot = ptrSlot();
    const rc = lib.git_reference_lookup(toPtr(ptr(slot)), toPtr(this.handle), cstr(name));
    if (rc === -3 /* GIT_ENOTFOUND */) return null;
    check(rc);
    const refPtr = readPtr(slot);
    try {
      return this.directTargetOid(refPtr);
    } finally {
      lib.git_reference_free(toPtr(refPtr));
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/git/update-ref.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: add atomic updateRef() binding for receive-pack"
```

---

## Task 6: `indexPack()` binding (write an incoming packfile into the odb)

**Files:**
- Modify: `src/git/facade.ts`
- Modify: `src/git/binding/libgit2.ts`
- Modify: `src/git/binding/repository.ts`
- Test: `tests/git/index-pack.test.ts`

**Interfaces:**
- Consumes: `WritableRepository` (Task 4).
- Produces: `WritableRepository.indexPack(data: Uint8Array): void` — throws `GitError` on a corrupt/incomplete pack.

Verified by spike: `git_indexer_new`'s non-experimental signature is `(out, path, mode, odb, opts)` — 5 args, `opts` may be `NULL`. The target repo's own odb MUST be passed (not `NULL`) so libgit2 can resolve thin-pack deltas against objects the pusher assumed the server already has (the normal case for an incremental push).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/git/index-pack.test.ts
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";

const fixture: FixtureRepo = await createFixtureRepo();
const emptyRoots: string[] = [];
afterAll(() => {
  fixture.cleanup();
  emptyRoots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

async function buildPack(repoPath: string): Promise<Uint8Array> {
  const revList = Bun.spawn(["git", "-C", repoPath, "rev-list", "--objects", "--all"], { stdout: "pipe" });
  const packObjects = Bun.spawn(["git", "-C", repoPath, "pack-objects", "--stdout"], {
    stdin: revList.stdout,
    stdout: "pipe",
  });
  const bytes = new Uint8Array(await new Response(packObjects.stdout).arrayBuffer());
  await revList.exited;
  await packObjects.exited;
  return bytes;
}

async function emptyBareRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "tsgit-indexpack-"));
  emptyRoots.push(root);
  const path = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", path]).exited;
  return path;
}

test("indexPack writes objects from a real packfile into a fresh bare repo", async () => {
  const headOid = (() => {
    const repo = openRepository(fixture.path);
    try {
      return repo.commit(repo.headRef())!.oid;
    } finally {
      repo.free();
    }
  })();

  const pack = await buildPack(fixture.path);
  expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");

  const targetPath = await emptyBareRepo();
  const target = openRepository(targetPath);
  try {
    expect(target.commit(headOid)).toBeNull(); // not present yet
    target.indexPack(pack);
    expect(target.commit(headOid)?.oid).toBe(headOid);
  } finally {
    target.free();
  }
});

test("indexPack throws GitError on garbage input", () => {
  const repo = openRepository(fixture.path);
  try {
    expect(() => repo.indexPack(new TextEncoder().encode("not a pack"))).toThrow();
  } finally {
    repo.free();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/git/index-pack.test.ts`
Expected: FAIL — `repo.indexPack` is not a function.

- [ ] **Step 3: Extend `WritableRepository`**

```typescript
// src/git/facade.ts — add to the WritableRepository interface
  /** Writes a raw packfile's objects into this repo's object database. */
  indexPack(data: Uint8Array): void;
```

- [ ] **Step 4: Add the new libgit2 bindings**

```typescript
// src/git/binding/libgit2.ts — add to SYMBOLS
  git_repository_odb: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  git_odb_free: { args: [FFIType.ptr], returns: FFIType.void },
  git_indexer_new: { args: [FFIType.ptr, FFIType.cstring, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  git_indexer_append: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  git_indexer_commit: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  git_indexer_free: { args: [FFIType.ptr], returns: FFIType.void },
```

- [ ] **Step 5: Implement `indexPack()`**

```typescript
// src/git/binding/repository.ts — add to the top-level imports
import { join } from "node:path";
```

```typescript
// src/git/binding/repository.ts — add to the Repo class
  // `git_indexer_progress` is a required (non-nullable) out-param struct:
  // 6x uint32 + a size_t, with no padding on 64-bit (24 bytes align to 8
  // already) -> 32 bytes total. We don't read it back (no progress reporting).
  indexPack(data: Uint8Array): void {
    const odbSlot = ptrSlot();
    check(lib.git_repository_odb(toPtr(ptr(odbSlot)), toPtr(this.handle)));
    const odb = readPtr(odbSlot);
    try {
      const idxSlot = ptrSlot();
      const packDir = join(this.path, "objects", "pack");
      check(lib.git_indexer_new(toPtr(ptr(idxSlot)), cstr(packDir), 0, toPtr(odb), toPtr(0)));
      const idx = readPtr(idxSlot);
      try {
        const stats = new Uint8Array(32);
        check(lib.git_indexer_append(toPtr(idx), toPtr(ptr(data)), data.length, toPtr(ptr(stats))));
        check(lib.git_indexer_commit(toPtr(idx), toPtr(ptr(stats))));
      } finally {
        lib.git_indexer_free(toPtr(idx));
      }
    } finally {
      lib.git_odb_free(toPtr(odb));
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/git/index-pack.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: add indexPack() binding for receiving pushed packfiles"
```

---

## Task 7: `packObjects()` binding (build a packfile for upload-pack)

**Files:**
- Modify: `src/git/facade.ts`
- Modify: `src/git/binding/libgit2.ts`
- Modify: `src/git/binding/repository.ts`
- Test: `tests/git/pack-objects.test.ts`

**Interfaces:**
- Consumes: `WritableRepository` (Task 4), `indexPack` (Task 6, reused in the round-trip test).
- Produces: `WritableRepository.packObjects(wants: string[], haves: string[]): Uint8Array` — returns a valid packfile containing everything reachable from `wants` that isn't reachable from `haves`.

Verified by spike: `git_packbuilder_insert_walk` + a `git_revwalk` with `wants` pushed and `haves` hidden gives exactly this closure. `git_buf` is `{ ptr: void*, reserved: size_t, size: size_t }` (24 bytes, all 8-byte fields — `ptr` at offset 0, `size` at offset 16); `git_buf_dispose` frees it after the bytes are copied out.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/git/pack-objects.test.ts
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";

const fixture: FixtureRepo = await createFixtureRepo();
const roots: string[] = [];
afterAll(() => {
  fixture.cleanup();
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});

test("packObjects returns a valid, non-empty packfile for a want with no haves", () => {
  const repo = openRepository(fixture.path);
  try {
    const headOid = repo.commit(repo.headRef())!.oid;
    const pack = repo.packObjects([headOid], []);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe("PACK");
    expect(pack.length).toBeGreaterThan(12); // more than just the header+trailer
  } finally {
    repo.free();
  }
});

test("packObjects output can be indexed into a fresh repo (round-trip)", async () => {
  const repo = openRepository(fixture.path);
  const headOid = repo.commit(repo.headRef())!.oid;
  const pack = repo.packObjects([headOid], []);
  repo.free();

  const root = mkdtempSync(join(tmpdir(), "tsgit-packobjects-"));
  roots.push(root);
  const targetPath = join(root, "target.git");
  await Bun.spawn(["git", "init", "-q", "--bare", targetPath]).exited;

  const target = openRepository(targetPath);
  try {
    expect(target.commit(headOid)).toBeNull();
    target.indexPack(pack);
    expect(target.commit(headOid)?.oid).toBe(headOid);
  } finally {
    target.free();
  }
});

test("packObjects ignores haves that don't exist locally instead of throwing", () => {
  const repo = openRepository(fixture.path);
  try {
    const headOid = repo.commit(repo.headRef())!.oid;
    const bogusHave = "f".repeat(40);
    expect(() => repo.packObjects([headOid], [bogusHave])).not.toThrow();
  } finally {
    repo.free();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/git/pack-objects.test.ts`
Expected: FAIL — `repo.packObjects` is not a function.

- [ ] **Step 3: Extend `WritableRepository`**

```typescript
// src/git/facade.ts — add to the WritableRepository interface
  /** Builds a packfile containing everything reachable from `wants` that isn't reachable from `haves`. */
  packObjects(wants: string[], haves: string[]): Uint8Array;
```

- [ ] **Step 4: Add the new libgit2 bindings**

```typescript
// src/git/binding/libgit2.ts — add to SYMBOLS
  git_revwalk_hide: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  git_packbuilder_new: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  git_packbuilder_insert_walk: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  git_packbuilder_write_buf: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  git_packbuilder_free: { args: [FFIType.ptr], returns: FFIType.void },
  git_buf_dispose: { args: [FFIType.ptr], returns: FFIType.void },
```

- [ ] **Step 5: Implement `packObjects()`**

```typescript
// src/git/binding/repository.ts — add to the Repo class
  packObjects(wants: string[], haves: string[]): Uint8Array {
    const walkSlot = ptrSlot();
    check(lib.git_revwalk_new(toPtr(ptr(walkSlot)), toPtr(this.handle)));
    const walk = readPtr(walkSlot);
    try {
      for (const want of wants) {
        check(lib.git_revwalk_push(toPtr(walk), toPtr(ptr(Buffer.from(want, "hex")))));
      }
      for (const have of haves) {
        try {
          check(lib.git_revwalk_hide(toPtr(walk), toPtr(ptr(Buffer.from(have, "hex")))));
        } catch {
          // Client-declared "have" not present in our history (e.g. an
          // unrelated fork) -- fine to ignore for negotiation purposes.
        }
      }

      const pbSlot = ptrSlot();
      check(lib.git_packbuilder_new(toPtr(ptr(pbSlot)), toPtr(this.handle)));
      const pb = readPtr(pbSlot);
      try {
        check(lib.git_packbuilder_insert_walk(toPtr(pb), toPtr(walk)));

        const gitBuf = new Uint8Array(24); // { ptr: void*, reserved: size_t, size: size_t }
        check(lib.git_packbuilder_write_buf(toPtr(ptr(gitBuf)), toPtr(pb)));
        try {
          const dataPtr = Number(read.ptr(toPtr(ptr(gitBuf)), 0));
          const size = readU64At(ptr(gitBuf), 16);
          return new Uint8Array(toArrayBuffer(toPtr(dataPtr), 0, size)).slice();
        } finally {
          lib.git_buf_dispose(toPtr(ptr(gitBuf)));
        }
      } finally {
        lib.git_packbuilder_free(toPtr(pb));
      }
    } finally {
      lib.git_revwalk_free(toPtr(walk));
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/git/pack-objects.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
jj commit -m "feat: add packObjects() binding for upload-pack"
```

---

## Task 8: `receivePack.ts` (parse commands, apply, report-status)

**Files:**
- Create: `src/git/smart-http/receivePack.ts`
- Test: `tests/git/smart-http/receivePack.test.ts`

**Interfaces:**
- Consumes: `encodePktLine`, `FLUSH_PKT`, `concatBytes` (Task 1); `WritableRepository.indexPack`/`updateRef` (Tasks 5-6).
- Produces: `interface ReceiveCommand { oldOid: string; newOid: string; name: string }`, `parseReceiveCommands(lines: Uint8Array[]): { commands: ReceiveCommand[]; capabilities: string[] }`, `interface ReceiveResult { unpackOk: boolean; unpackError?: string; refResults: { name: string; ok: boolean; reason?: string }[] }`, `applyReceivePack(repo: WritableRepository, commands: ReceiveCommand[], packBytes: Uint8Array): ReceiveResult`, `encodeReportStatus(result: ReceiveResult): Uint8Array`.

`parseReceiveCommands` operates on already-`readUntilFlush`-decoded line payloads (Task 1's job), so it has no pkt-line framing concerns of its own.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/git/smart-http/receivePack.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/git/smart-http/receivePack.test.ts`
Expected: FAIL — `src/git/smart-http/receivePack.ts` does not exist.

- [ ] **Step 3: Implement `receivePack.ts`**

```typescript
// src/git/smart-http/receivePack.ts
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
  try {
    repo.indexPack(packBytes);
  } catch (err) {
    return {
      unpackOk: false,
      unpackError: err instanceof Error ? err.message : String(err),
      refResults: commands.map((c) => ({ name: c.name, ok: false, reason: "unpacker error" })),
    };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/git/smart-http/receivePack.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: add receive-pack command parsing, apply, and report-status"
```

---

## Task 9: `uploadPack.ts` (parse wants/haves, build response)

**Files:**
- Create: `src/git/smart-http/uploadPack.ts`
- Test: `tests/git/smart-http/uploadPack.test.ts`

**Interfaces:**
- Consumes: `decodePktLine` (Task 1); `WritableRepository.packObjects` (Task 7).
- Produces: `interface UploadPackRequest { wants: string[]; haves: string[]; capabilities: string[] }`, `parseUploadPackRequest(data: Uint8Array): UploadPackRequest`, `buildUploadPackResponse(repo: { packObjects(wants: string[], haves: string[]): Uint8Array }, wants: string[], haves: string[]): Uint8Array`.

No `multi_ack` capability is advertised (Task 3), so the negotiation is always the simplest legal form: the client sends every `want`/`have` it has in one shot followed by `done`, and the server always replies with a single `NAK` before the packfile (never an early `ACK` — see the design spec's Roadmap for why this is deferred, not incorrect).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/git/smart-http/uploadPack.test.ts
import { test, expect, afterAll } from "bun:test";
import { createFixtureRepo, type FixtureRepo } from "../../fixtures/repo";
import { openRepository } from "../../../src/git";
import { parseUploadPackRequest, buildUploadPackResponse } from "../../../src/git/smart-http/uploadPack";
import { encodePktLine, FLUSH_PKT, concatBytes, decodePktLine } from "../../../src/git/smart-http/pktline";

test("parseUploadPackRequest reads capabilities off the first want line", () => {
  const oid = "a".repeat(40);
  const body = concatBytes([
    encodePktLine(`want ${oid} multi_ack side-band-64k\n`),
    FLUSH_PKT,
    encodePktLine("done\n"),
  ]);
  const parsed = parseUploadPackRequest(body);
  expect(parsed.wants).toEqual([oid]);
  expect(parsed.haves).toEqual([]);
  expect(parsed.capabilities).toEqual(["multi_ack", "side-band-64k"]);
});

test("parseUploadPackRequest collects multiple wants and haves", () => {
  const oid1 = "a".repeat(40);
  const oid2 = "b".repeat(40);
  const have1 = "c".repeat(40);
  const body = concatBytes([
    encodePktLine(`want ${oid1} agent=git/2.40\n`),
    encodePktLine(`want ${oid2}\n`),
    FLUSH_PKT,
    encodePktLine(`have ${have1}\n`),
    encodePktLine("done\n"),
  ]);
  const parsed = parseUploadPackRequest(body);
  expect(parsed.wants).toEqual([oid1, oid2]);
  expect(parsed.haves).toEqual([have1]);
});

test("parseUploadPackRequest tolerates a missing trailing done (truncated request)", () => {
  const oid = "a".repeat(40);
  const body = concatBytes([encodePktLine(`want ${oid}\n`), FLUSH_PKT]);
  expect(parseUploadPackRequest(body).wants).toEqual([oid]);
});

const fixture: FixtureRepo = await createFixtureRepo();
afterAll(() => fixture.cleanup());

test("buildUploadPackResponse prefixes a NAK pkt-line before the packfile", () => {
  const repo = openRepository(fixture.path);
  try {
    const headOid = repo.commit(repo.headRef())!.oid;
    const response = buildUploadPackResponse(repo, [headOid], []);
    const { line, next } = decodePktLine(response, 0);
    expect(new TextDecoder().decode(line.payload)).toBe("NAK\n");
    expect(new TextDecoder().decode(response.subarray(next, next + 4))).toBe("PACK");
  } finally {
    repo.free();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/git/smart-http/uploadPack.test.ts`
Expected: FAIL — `src/git/smart-http/uploadPack.ts` does not exist.

- [ ] **Step 3: Implement `uploadPack.ts`**

```typescript
// src/git/smart-http/uploadPack.ts
import { decodePktLine, encodePktLine, concatBytes } from "./pktline";

export interface UploadPackRequest {
  wants: string[];
  haves: string[];
  capabilities: string[];
}

const decoder = new TextDecoder();

export function parseUploadPackRequest(data: Uint8Array): UploadPackRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const capabilities: string[] = [];
  let offset = 0;
  let sawWant = false;

  while (offset < data.length) {
    const { line, next } = decodePktLine(data, offset);
    offset = next;
    if (line.type === "flush") continue; // separates the want block from the have block

    let text = decoder.decode(line.payload).replace(/\n$/, "");
    if (text.startsWith("want ")) {
      if (!sawWant) {
        const nul = text.indexOf("\0");
        if (nul !== -1) {
          capabilities.push(...text.slice(nul + 1).split(" ").filter(Boolean));
          text = text.slice(0, nul);
        }
        sawWant = true;
      }
      wants.push(text.slice(5, 45));
    } else if (text.startsWith("have ")) {
      haves.push(text.slice(5, 45));
    } else if (text === "done") {
      break;
    }
  }

  return { wants, haves, capabilities };
}

export function buildUploadPackResponse(
  repo: { packObjects(wants: string[], haves: string[]): Uint8Array },
  wants: string[],
  haves: string[],
): Uint8Array {
  const packBytes = repo.packObjects(wants, haves);
  return concatBytes([encodePktLine("NAK\n"), packBytes]);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/git/smart-http/uploadPack.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
jj commit -m "feat: add upload-pack negotiation parsing and response building"
```

---

## Task 10: Wire the routes into the app

**Files:**
- Create: `src/git/smart-http/routes.ts`
- Modify: `src/middlewares.ts`
- Modify: `src/server.tsx`
- Test: `tests/git/smart-http/routes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-9.
- Produces: `registerSmartHttpRoutes(app: ReturnType<typeof factory.createApp>): void`, mounted once from `createApp()`.

This is the glue task: no new protocol logic, just Hono routing, the auth/bare-repo gates from the design spec, and the `useRepository` middleware fix so it actually opens the repo for these new paths.

- [ ] **Step 1: Write the failing tests**

These drive the routes directly with `app.request(...)` (finer-grained than the full `git`-subprocess e2e tests in Task 11, which exercise the same code through a real client).

```typescript
// tests/git/smart-http/routes.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "../../fixtures/repo";
import { createApp } from "../../../src/server";
import { DEFAULT_MIME_TYPES, type SiteConfig } from "../../../src/config/config";
import { parseHtpasswd } from "../../../src/config/htpasswd";

let fixture: FixtureRepo;
let root: string;
let app: ReturnType<typeof createApp>;
let cfg: SiteConfig;

beforeAll(async () => {
  fixture = await createFixtureRepo();
  root = mkdtempSync(join(tmpdir(), "tsgit-smarthttp-routes-"));
  await Bun.spawn(["cp", "-r", fixture.path, join(root, "project.git")]).exited;
  await Bun.spawn(["cp", "-r", fixture.workPath, join(root, "nonbare.git")]).exited;
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  app = createApp();
  cfg = {
    TSGIT_SCAN_PATH: root, TSGIT_SUMMARY_BRANCHES: 10, TSGIT_SUMMARY_TAGS: 10,
    TSGIT_SUMMARY_LOG: 10, TSGIT_LOG_PAGE_SIZE: 2, TSGIT_REPOLIST_PAGE_SIZE: 50,
    mimeTypes: DEFAULT_MIME_TYPES, pushCredentials: parseHtpasswd(`alice:${hash}`),
  };
});

afterAll(() => { fixture?.cleanup(); rmSync(root, { recursive: true, force: true }); });

const req = (path: string, init?: RequestInit) => app.request(path, init, cfg);

test("GET info/refs?service=git-upload-pack returns the advertisement", async () => {
  const res = await req("/project.git/info/refs?service=git-upload-pack");
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/x-git-upload-pack-advertisement");
  const text = await res.text();
  expect(text.startsWith("001e# service=git-upload-pack\n")).toBe(true);
});

test("GET info/refs with an unsupported service is a 400", async () => {
  const res = await req("/project.git/info/refs?service=bogus");
  expect(res.status).toBe(400);
});

test("GET info/refs?service=git-receive-pack requires auth", async () => {
  const res = await req("/project.git/info/refs?service=git-receive-pack");
  expect(res.status).toBe(401);
});

test("GET info/refs?service=git-receive-pack succeeds with correct credentials", async () => {
  const res = await req("/project.git/info/refs?service=git-receive-pack", {
    headers: { Authorization: `Basic ${btoa("alice:secret123")}` },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/x-git-receive-pack-advertisement");
});

test("POST git-receive-pack on a non-bare repo is a 403 even with correct credentials", async () => {
  const res = await req("/nonbare.git/git-receive-pack", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa("alice:secret123")}` },
    body: new Uint8Array(0),
  });
  expect(res.status).toBe(403);
});

test("POST git-receive-pack without auth is a 401", async () => {
  const res = await req("/project.git/git-receive-pack", { method: "POST", body: new Uint8Array(0) });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/git/smart-http/routes.test.ts`
Expected: FAIL — routes don't exist yet (404s / no `pushCredentials` on `SiteConfig` usage errors).

- [ ] **Step 3: Fix `useRepository` to open the repo for smart-HTTP paths**

```typescript
// src/middlewares.ts (full file)
import { factory } from "./app/env";
import { findRepo, openRepository } from "./git";

// Resolve `/:repo/` to a discovered repo + an open libgit2 handle, exposed to
// downstream handlers via context. Owns the repo's lifecycle: it frees the
// handle once the handler has run, so handlers never open or free repos
// themselves.
export const useRepository = factory.createMiddleware(async (c, next) => {
  // Redirect-only stubs (`/repo`, `/repo/log`) lack a trailing slash and get sent
  // to their slash form by appendTrailingSlash — don't open a repo we'd discard.
  // tree/raw and the smart-HTTP endpoints are genuine slash-less content paths,
  // so open the repo for those.
  const p = c.req.path;
  const isSmartHttp = p.endsWith("/info/refs") || p.endsWith("/git-upload-pack") || p.endsWith("/git-receive-pack");
  if (!p.endsWith("/") && !p.includes("/tree/") && !p.includes("/raw/") && !isSmartHttp) return next();

  const disc = findRepo(c.env.TSGIT_SCAN_PATH, c.req.param("repo")!); // present: matched by /:repo/*
  c.set("disc", disc);

  const repo = openRepository(disc.path);
  c.set("repo", repo);

  try {
    await next();
  } finally {
    repo.free();
  }
});
```

- [ ] **Step 4: Implement the routes**

```typescript
// src/git/smart-http/routes.ts
import type { factory } from "../../app/env";
import { badRequest, HttpError } from "../../errors";
import { buildAdvertisement } from "./advertise";
import { checkBasicAuth } from "./auth";
import { applyReceivePack, encodeReportStatus, parseReceiveCommands } from "./receivePack";
import { buildUploadPackResponse, parseUploadPackRequest } from "./uploadPack";
import { readUntilFlush } from "./pktline";

type App = ReturnType<typeof factory.createApp>;

export function registerSmartHttpRoutes(app: App): void {
  app.get("/:repo/info/refs", async (c) => {
    const service = c.req.query("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      throw badRequest(`Unsupported or missing service parameter: ${JSON.stringify(service)}`);
    }
    if (service === "git-receive-pack") {
      const rejection = await checkBasicAuth(c.req.header("Authorization"), c.env.pushCredentials);
      if (rejection) return rejection;
    }
    const repo = c.get("repo");
    const body = buildAdvertisement(repo, service);
    return new Response(body, {
      headers: {
        "Content-Type": `application/x-${service}-advertisement`,
        "Cache-Control": "no-cache",
      },
    });
  });

  app.post("/:repo/git-upload-pack", async (c) => {
    const repo = c.get("repo");
    const body = new Uint8Array(await c.req.arrayBuffer());
    const { wants, haves } = parseUploadPackRequest(body);
    const response = buildUploadPackResponse(repo, wants, haves);
    return new Response(response, {
      headers: { "Content-Type": "application/x-git-upload-pack-result" },
    });
  });

  app.post("/:repo/git-receive-pack", async (c) => {
    const repo = c.get("repo");
    const rejection = await checkBasicAuth(c.req.header("Authorization"), c.env.pushCredentials);
    if (rejection) return rejection;
    if (!repo.isBare()) throw new HttpError(403, "push is only allowed to bare repositories");

    const body = new Uint8Array(await c.req.arrayBuffer());
    const { lines, next } = readUntilFlush(body, 0);
    const { commands } = parseReceiveCommands(lines);
    const packBytes = body.subarray(next);
    const result = applyReceivePack(repo, commands, packBytes);
    return new Response(encodeReportStatus(result), {
      headers: { "Content-Type": "application/x-git-receive-pack-result" },
    });
  });
}
```

- [ ] **Step 5: Mount the routes from `createApp()`**

```typescript
// src/server.tsx — add the import near the other local imports
import { registerSmartHttpRoutes } from "./git/smart-http/routes";
```

```typescript
// src/server.tsx — inside createApp(), right after:
//   app.use("/:repo/*", useRepository);
// add:
  registerSmartHttpRoutes(app);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/git/smart-http/routes.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Run the full test suite**

Run: `bun test`
Expected: PASS — every existing test (views, e2e browsing, git bindings) plus everything from Tasks 1-10.

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat: wire smart-HTTP routes into the app"
```

---

## Task 11: End-to-end tests with a real `git` client

**Files:**
- Create: `tests/smart-http.e2e.test.ts`

**Interfaces:**
- Consumes: `createApp()` (existing), `createFixtureRepo()` (Task 4's `workPath` addition).

This is the credibility check for the whole feature: a real `git` binary, talking real smart-HTTP, against `createApp()` served on a real TCP port (Bun's `Bun.serve`) — not `app.request(...)` in-process calls. Confirms the byte-level protocol work in Tasks 1-10 actually interoperates with git, not just with our own hand-built test fixtures.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/smart-http.e2e.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo";
import { createApp } from "../src/server";
import { DEFAULT_MIME_TYPES, type SiteConfig } from "../src/config/config";
import { parseHtpasswd } from "../src/config/htpasswd";

let fixture: FixtureRepo;
let scanRoot: string;
let workRoot: string;
let server: Server;
let baseUrl: string;
const PASSWORD = "secret123";

async function git(cwd: string, ...args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Pusher", GIT_AUTHOR_EMAIL: "pusher@example.com",
      GIT_COMMITTER_NAME: "Pusher", GIT_COMMITTER_EMAIL: "pusher@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  fixture = await createFixtureRepo();
  scanRoot = mkdtempSync(join(tmpdir(), "tsgit-smarthttp-scan-"));
  workRoot = mkdtempSync(join(tmpdir(), "tsgit-smarthttp-work-"));
  await Bun.spawn(["cp", "-r", fixture.path, join(scanRoot, "project.git")]).exited;
  await Bun.spawn(["git", "init", "-q", "--bare", join(scanRoot, "empty.git")]).exited;

  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  const cfg: SiteConfig = {
    TSGIT_SCAN_PATH: scanRoot, TSGIT_SUMMARY_BRANCHES: 10, TSGIT_SUMMARY_TAGS: 10,
    TSGIT_SUMMARY_LOG: 10, TSGIT_LOG_PAGE_SIZE: 50, TSGIT_REPOLIST_PAGE_SIZE: 50,
    mimeTypes: DEFAULT_MIME_TYPES, pushCredentials: parseHtpasswd(`alice:${hash}`),
  };
  const app = createApp();
  server = Bun.serve({ port: 0, fetch: (req) => app.fetch(req, cfg) });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  fixture.cleanup();
  rmSync(scanRoot, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

function authedUrl(repo: string): string {
  const u = new URL(`${baseUrl}/${repo}`);
  u.username = "alice";
  u.password = PASSWORD;
  return u.toString();
}

test("git clone fetches a non-empty repo over smart-HTTP", async () => {
  const dest = join(workRoot, "clone1");
  const result = await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  expect(result.code).toBe(0);
  const log = await git(dest, "log", "--oneline");
  expect(log.stdout.trim().split("\n").length).toBe(3); // matches fixture.commitSubjects
});

test("git clone succeeds against an empty repo", async () => {
  const dest = join(workRoot, "clone-empty");
  const result = await git(workRoot, "clone", "-q", `${baseUrl}/empty.git`, dest);
  expect(result.code).toBe(0);
});

test("git push rejects without credentials", async () => {
  const dest = join(workRoot, "push-noauth");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  await Bun.write(join(dest, "new-file.txt"), "hello\n");
  await git(dest, "add", "new-file.txt");
  await git(dest, "commit", "-q", "-m", "add new-file.txt");
  const result = await git(dest, "push", `${baseUrl}/project.git`, "HEAD:refs/heads/rejected");
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("401");
});

test("git push accepts a new branch with correct credentials", async () => {
  const dest = join(workRoot, "push-newbranch");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  await Bun.write(join(dest, "pushed.txt"), "hello\n");
  await git(dest, "add", "pushed.txt");
  await git(dest, "commit", "-q", "-m", "add pushed.txt");
  const result = await git(dest, "push", authedUrl("project.git"), "HEAD:refs/heads/pushed");
  expect(result.code).toBe(0);

  // Prove it actually landed: clone fresh and look for the branch.
  const verify = join(workRoot, "verify-newbranch");
  await git(workRoot, "clone", "-q", "-b", "pushed", `${baseUrl}/project.git`, verify);
  const log = await git(verify, "log", "--oneline", "-1");
  expect(log.stdout).toContain("add pushed.txt");
});

test("git push accepts a fast-forward update to an existing branch", async () => {
  const dest = join(workRoot, "push-ff");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  await Bun.write(join(dest, "ff.txt"), "hello\n");
  await git(dest, "add", "ff.txt");
  await git(dest, "commit", "-q", "-m", "fast-forward commit");
  const result = await git(dest, "push", authedUrl("project.git"), "HEAD:refs/heads/main");
  expect(result.code).toBe(0);

  const verify = join(workRoot, "verify-ff");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, verify);
  const log = await git(verify, "log", "--oneline", "-1");
  expect(log.stdout).toContain("fast-forward commit");
});

test("git push rejects a non-fast-forward update without --force", async () => {
  const distinct1 = join(workRoot, "nonff-1");
  const distinct2 = join(workRoot, "nonff-2");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, distinct1);
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, distinct2);

  await Bun.write(join(distinct1, "diverge1.txt"), "a\n");
  await git(distinct1, "add", "diverge1.txt");
  await git(distinct1, "commit", "-q", "-m", "diverge 1");
  const first = await git(distinct1, "push", authedUrl("project.git"), "HEAD:refs/heads/diverge");
  expect(first.code).toBe(0);

  await Bun.write(join(distinct2, "diverge2.txt"), "b\n");
  await git(distinct2, "add", "diverge2.txt");
  await git(distinct2, "commit", "-q", "-m", "diverge 2");
  // distinct2's HEAD does not descend from what refs/heads/diverge now points
  // at, so pushing onto it (as a same-name update, not creation) is a
  // non-fast-forward that our server-side CAS should reject.
  await git(distinct2, "fetch", authedUrl("project.git"), "refs/heads/diverge:refs/remotes/origin/diverge");
  const second = await git(distinct2, "push", authedUrl("project.git"), "HEAD:refs/heads/diverge");
  expect(second.code).not.toBe(0);
  expect(second.stderr.toLowerCase()).toMatch(/stale info|rejected|fetch first/);
});

test("git push rejected to a non-bare repository is reported to the client", async () => {
  // Publish the fixture's own non-bare working tree under the scan root.
  const nonBareTarget = join(scanRoot, "nonbare.git");
  await Bun.spawn(["cp", "-r", fixture.workPath, nonBareTarget]).exited;

  const dest = join(workRoot, "push-nonbare-source");
  await git(workRoot, "clone", "-q", `${baseUrl}/project.git`, dest);
  const result = await git(dest, "push", authedUrl("nonbare.git"), "HEAD:refs/heads/whatever");
  expect(result.code).not.toBe(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/smart-http.e2e.test.ts`
Expected: FAIL if any earlier task is incomplete; if Tasks 1-10 are all done correctly, these should largely PASS already — this task's real job is to catch anything the unit tests missed (protocol framing details real `git` is stricter about than our own hand-built test fixtures). Treat any failure here as a bug in Tasks 1-10, not something to special-case in the test.

- [ ] **Step 3: Debug against real `git` as needed**

If a test fails, run the same `git` command manually with `GIT_TRACE_PACKET=1 GIT_CURL_VERBOSE=1` prefixed and compare the byte-level exchange against `pack-protocol.txt`/`http-protocol.txt` semantics described in Tasks 3, 8, and 9. Common culprits at this stage: a missing/incorrect `Content-Type` header (git silently falls back to "dumb HTTP" and every test above fails in a confusing way), or a missing flush-pkt.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/smart-http.e2e.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the entire suite one more time**

Run: `bun test`
Expected: PASS, full suite green.

- [ ] **Step 6: Commit**

```bash
jj commit -m "test: add end-to-end smart-HTTP fetch/push coverage with a real git client"
```

---

## Self-Review Notes

- **Spec coverage:** routes (Task 10), both services protocol v0 (Tasks 3, 8, 9), Basic Auth on receive-pack only (Task 2, wired in Task 10), bare-repo push restriction (Task 10), ref create/update/delete via CAS (Task 5), `WritableRepository` split from `Repository` (Task 4), all error-handling cases from the spec (400/401/403/per-ref `ng`/`unpack` error — Tasks 8, 10), htpasswd config (Task 2), e2e coverage matching the spec's exact test list (Task 11) are all covered.
- **Deferred by the spec, correctly not implemented:** hooks, protocol v2, shallow/partial clone, SSH, side-band, per-repo push opt-in — none of these appear anywhere above.
- **Type consistency:** `WritableRepository` is introduced once (Task 4) and only ever extended (Tasks 5-7), never redefined; `ReceiveCommand`/`ReceiveResult` (Task 8) and `UploadPackRequest` (Task 9) are each defined once and reused as-is in Task 10's routes.
</content>
