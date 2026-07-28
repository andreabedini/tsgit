import { test, expect } from "bun:test";
import { Hono } from "hono";
import { renderer } from "../../src/views/default/renderer";
import { CommitCard } from "../../src/views/default/CommitCard";
import type { Env } from "../../src/app/env";
import type { Commit, Reference } from "../../src/git/facade";

const commit: Commit = {
  oid: "a".repeat(40),
  abbrevOid: "a".repeat(10),
  author: { name: "Ann", email: "ann@example.com", when: new Date("2026-06-04T12:00:00Z") },
  committer: { name: "Ann", email: "ann@example.com", when: new Date("2026-06-04T12:00:00Z") },
  summary: "Add a.txt",
  message: "Add a.txt\n\nBody line\n",
  parents: ["b".repeat(40)],
  treeOid: "c".repeat(40),
  changeId: null,
};

const refs: Reference[] = [
  { name: "main", kind: "branch", fullName: "refs/heads/main", targetOid: commit.oid, commitOid: commit.oid },
];

// CommitCard reads commit/disc/repo off the request context, so seed them in a
// middleware before rendering (mirrors what useRepository + the route do).
async function render(): Promise<string> {
  const app = new Hono<Env>();
  app.use(renderer);
  app.use("*", async (c, next) => {
    c.set("commit", commit);
    c.set("disc", { name: "proj", path: "/proj", description: undefined } as any);
    c.set("repo", { decorations: () => new Map([[commit.oid, refs]]) } as any);
    await next();
  });
  app.get("/", (c) => c.render(<CommitCard />));
  return (await app.request("/")).text();
}

test("CommitCard renders metadata, refs and parent/tree links", async () => {
  const html = await render();
  expect(html).toContain("Add a.txt");
  expect(html).toContain("ann@example.com");
  expect(html).toContain('href="/proj/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/"');
  expect(html).toContain('href="/proj/tree/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"');
  // The tree link is labelled with the tree's own oid, like commit and parent.
  expect(html).toContain(">cccccccccc</a>");
  expect(html).toContain('class="ref branch"');
  expect(html).toContain("Body line"); // full message body, not just the summary
});
