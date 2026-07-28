import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJjFixtureRepo, createJjWorkspace, type JjFixtureRepo } from "./fixtures/jj-repo";
import { createApp } from "../src/server";
import type { SiteConfig } from "../src/config/config";
import { DEFAULT_MIME_TYPES } from "../src/config/config";

let fixture: JjFixtureRepo;
let root: string;
let app: ReturnType<typeof createApp>;
let cfg: SiteConfig;

const req = (path: string) => app.request(path, undefined, cfg);

beforeAll(async () => {
  fixture = await createJjFixtureRepo();
  root = mkdtempSync(join(tmpdir(), "tsgit-jj-e2e-"));
  await Bun.spawn(["cp", "-r", fixture.path, join(root, "project.git")]).exited;
  app = createApp();
  cfg = {
    TSGIT_SCAN_PATH: root, TSGIT_SUMMARY_BRANCHES: 10, TSGIT_SUMMARY_TAGS: 10,
    TSGIT_SUMMARY_LOG: 10, TSGIT_LOG_PAGE_SIZE: 10, TSGIT_REPOLIST_PAGE_SIZE: 50,
    mimeTypes: DEFAULT_MIME_TYPES, pushCredentials: [],
  };
});

afterAll(() => { fixture?.cleanup(); rmSync(root, { recursive: true, force: true }); });

test("log page shows change ids and labels the column 'change'", async () => {
  const res = await req("/project/log/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain(">change<");
  for (const changeId of fixture.changeIds) {
    expect(html).toContain(changeId.slice(0, 8));
    expect(html).toContain(`change ${changeId}`); // title attribute on the pill
  }
});

test("commit page reached by change id shows the full change id", async () => {
  const short = fixture.changeIds[1]!.slice(0, 8);
  const res = await req(`/project/commit/${short}/`);
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Add a.txt");
  expect(html).toContain(fixture.changeIds[1]!);
});

test("an unknown change id 404s", async () => {
  const res = await req("/project/commit/kkkkkkkk/");
  expect(res.status).toBe(404);
});

test("a non-colocated jj workspace is served under its directory name", async () => {
  // No `.git` anywhere: the git dir lives inside `.jj/repo/store/`.
  const ws = await createJjWorkspace("store", "notebook");
  try {
    const wsCfg = { ...cfg, TSGIT_SCAN_PATH: ws.root };
    const index = await app.request("/", undefined, wsCfg);
    expect(await index.text()).toContain("notebook");

    const log = await app.request("/notebook/log/", undefined, wsCfg);
    expect(log.status).toBe(200);
    const html = await log.text();
    expect(html).toContain("Add b.txt");
    expect(html).toContain(ws.changeIds[0]!.slice(0, 8));

    const byChangeId = await app.request(
      `/notebook/commit/${ws.changeIds[1]!.slice(0, 8)}/`,
      undefined,
      wsCfg,
    );
    expect(byChangeId.status).toBe(200);
    expect(await byChangeId.text()).toContain("Add a.txt");
  } finally {
    ws.cleanup();
  }
});

test("the commit without a change-id header renders as plain git", async () => {
  const res = await req("/project/log/");
  const html = await res.text();
  // "Add README" has no change id; its row falls back to the oid pill only.
  expect(html).toContain("Add README");
});
