import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureRepo, type FixtureRepo } from "./fixtures/repo";
import { createApp } from "../src/server";
import type { SiteConfig } from "../src/config/config";
import { DEFAULT_MIME_TYPES } from "../src/config/config";
import { openRepository } from "../src/git";

let fixture: FixtureRepo;
let root: string;
let app: ReturnType<typeof createApp>;
let cfg: SiteConfig;
let commitOids: string[];

// Config rides on the request as Bindings (c.env); inject it on every request.
const req = (path: string) => app.request(path, undefined, cfg);

beforeAll(async () => {
  fixture = await createFixtureRepo();
  root = mkdtempSync(join(tmpdir(), "tsgit-e2e-"));
  await Bun.spawn(["cp", "-r", fixture.path, join(root, "project.git")]).exited;
  app = createApp();
  cfg = {
    TSGIT_SCAN_PATH: root, TSGIT_SUMMARY_BRANCHES: 10, TSGIT_SUMMARY_TAGS: 10,
    TSGIT_SUMMARY_LOG: 10, TSGIT_LOG_PAGE_SIZE: 2, TSGIT_REPOLIST_PAGE_SIZE: 50,
    mimeTypes: DEFAULT_MIME_TYPES, pushCredentials: [],
  };
  const repo = openRepository(join(root, "project.git"));
  try {
    commitOids = repo.log({ limit: 10 }).commits.map((commit) => commit.oid);
  } finally {
    repo.free();
  }
});

afterAll(() => { fixture?.cleanup(); rmSync(root, { recursive: true, force: true }); });

test("GET / lists the repo", async () => {
  const html = await (await req("/")).text();
  expect(html).toContain("project");
  expect(html).toContain('href="/project/"');
});

test("GET /project/ shows refs and about", async () => {
  const res = await req("/project/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("main");
  expect(html).toContain("v1.0");
  expect(html).toContain("Fixture"); // README text present
  expect(html).toContain("shiki"); // README highlighted like the blob view
});

test("the summary page shows a clone command", async () => {
  // No TSGIT_CLONE_URL_BASE configured: the URL comes from the request itself.
  const html = await (await app.request("http://tsgit.test/project/", undefined, cfg)).text();
  expect(html).toContain("git clone http://tsgit.test/project");
  expect(html).not.toContain("jj git clone"); // plain git fixture

  // …and the configured public base wins when there is one, trailing slash or not.
  const configured = await app.request("http://tsgit.test/project/", undefined, {
    ...cfg,
    TSGIT_CLONE_URL_BASE: "https://git.example.com/",
  });
  expect(await configured.text()).toContain("git clone https://git.example.com/project");
});

test("GET /project/log/ paginates", async () => {
  const html = await (await req("/project/log/")).text();
  expect(html).toContain("Add b.txt");
  expect(html).toContain("/project/commit/");
  expect(html).toContain("older"); // hasNext pager (page size 2, 3 commits)
});

test("GET /project/commit/:oid/ renders commit metadata", async () => {
  const logHtml = await (await req("/project/log/")).text();
  const href = logHtml.match(/href="(\/project\/commit\/[0-9a-f]{40}\/)"/)?.[1];
  expect(href).toBeTruthy();

  const html = await (await req(href!)).text();
  expect(html).toContain("Add b.txt");
  expect(html).toContain("author@example.com");
  expect(html).toContain("/project/tree/");
});

test("GET /project/commit/:oid/ renders the commit diff inline", async () => {
  const html = await (await req(`/project/commit/${commitOids[0]}/`)).text();
  expect(html).toContain("b.txt");
  expect(html).toContain("second");
  expect(html).toContain("Binary file changed.");
});

test("GET /project/commit/:oid/ renders root-commit additions", async () => {
  const html = await (await req(`/project/commit/${commitOids.at(-1)!}/`)).text();
  expect(html).toContain("README.md");
  expect(html).toContain("Fixture");
});

test("GET /project/commit/v1.0/ resolves a tag revision", async () => {
  const html = await (await req("/project/commit/v1.0/")).text();
  expect(html).toContain("a.txt");
});

test("GET /missing/ 404s", async () => {
  const res = await req("/missing/");
  expect(res.status).toBe(404);
});

test("GET /project redirects to the trailing-slash form", async () => {
  const res = await req("/project");
  expect(res.status).toBe(301);
  // appendTrailingSlash() emits an absolute Location; compare the path only.
  expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/project/");
});

test("GET /project/log redirects to the trailing-slash form", async () => {
  const res = await req("/project/log");
  expect(res.status).toBe(301);
  expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/project/log/");
});

test("GET /project/tree/ lists the root tree", async () => {
  const res = await req("/project/tree/");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("README.md");
  expect(html).toContain("src/");
});

test("GET /project/tree/main/src lists a subdirectory", async () => {
  const html = await (await req("/project/tree/main/src")).text();
  expect(html).toContain("hello.txt");
});

test("GET /project/tree/main/README.md highlights the file with a raw link", async () => {
  const html = await (await req("/project/tree/main/README.md")).text();
  expect(html).toContain('class="shiki'); // syntax-highlighted
  expect(html).toContain("Fixture");        // content present (may be tokenized)
  expect(html).toContain('href="/project/raw/main/README.md"');
});

test("GET /project/tree/main/logo.bin shows a binary notice", async () => {
  const html = await (await req("/project/tree/main/logo.bin")).text();
  expect(html).toContain("Binary file not shown.");
});

test("GET /project/raw/main/README.md serves text/plain", async () => {
  const res = await req("/project/raw/main/README.md");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(await res.text()).toContain("# Fixture");
});

test("raw responses carry hardening headers (no sniffing, sandboxed)", async () => {
  const res = await req("/project/raw/main/README.md");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toBe("sandbox");
});

test("GET /project/raw/main/logo.bin serves octet-stream", async () => {
  const res = await req("/project/raw/main/logo.bin");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/octet-stream");
});

test("GET /project/tree/main/missing 404s without a redirect", async () => {
  const res = await req("/project/tree/main/missing");
  expect(res.status).toBe(404);
});

test("GET /project/tree redirects to the trailing-slash form", async () => {
  const res = await req("/project/tree");
  expect(res.status).toBe(301);
  expect(new URL(res.headers.get("location")!, "http://localhost").pathname).toBe("/project/tree/");
});

test("GET /project/tree/main/icon.gif renders an inline image", async () => {
  const html = await (await req("/project/tree/main/icon.gif")).text();
  expect(html).toContain("<img");
  expect(html).toContain('src="/project/raw/main/icon.gif"');
});

test("GET /project/raw/main/icon.gif serves image/gif", async () => {
  const res = await req("/project/raw/main/icon.gif");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/gif");
});

test("GET /tsgit.css serves the stylesheet", async () => {
  const res = await req("/tsgit.css");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/css");
});
