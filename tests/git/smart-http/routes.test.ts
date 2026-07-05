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
