import { test, expect } from "bun:test";
import { SummaryPage } from "../../src/views/default/SummaryPage";
import { LogPage } from "../../src/views/default/LogPage";
import type { Commit, Reference } from "../../src/git/facade";

const now = new Date("2026-06-05T12:00:00Z");
const when = new Date("2026-06-04T12:00:00Z"); // 1 day before `now`
const OID = "a".repeat(40);

function ref(name: string, kind: "branch" | "tag", oid: string): Reference {
  return { name, kind, fullName: `refs/${kind === "branch" ? "heads" : "tags"}/${name}`, targetOid: oid, commitOid: oid };
}

function commit(oid: string, summary: string, changeId: string | null = null): Commit {
  return {
    oid, abbrevOid: oid.slice(0, 10),
    author: { name: "Ann", email: "a@x.io", when },
    committer: { name: "Ann", email: "a@x.io", when },
    summary, message: summary + "\n", parents: [], treeOid: "c".repeat(40), changeId,
  };
}

test("SummaryPage renders branches, tags, recent log and highlighted about", () => {
  const html = SummaryPage({
    name: "alpha",
    description: "the alpha repo",
    branches: [ref("main", "branch", OID)],
    tags: [ref("v1.0", "tag", OID)],
    recentCommits: [commit(OID, "Add <x>")],
    aboutHtml: '<pre class="shiki"><code>README</code></pre>',
    now,
  }).toString();
  expect(html).toContain("main");
  expect(html).toContain("v1.0");
  expect(html).toContain("Add &lt;x&gt;");
  expect(html).toContain(`/alpha/commit/${OID}/`);
  expect(html).toContain('class="cg-readme"'); // README rendered inside its card container
  expect(html).toContain('<pre class="shiki"><code>README</code></pre>'); // highlighted HTML injected verbatim
  expect(html).toContain("1 day ago");
});

test("LogPage renders rows, decorations and pager links", () => {
  const html = LogPage({
    name: "alpha",
    ref: "main",
    commits: [commit(OID, "Add a")],
    decorations: new Map([[OID, [ref("main", "branch", OID)]]]),
    offset: 50,
    limit: 50,
    hasMore: true,
    now,
  }).toString();
  expect(html).toContain("Add a");
  expect(html).toContain(`/alpha/commit/${OID}/`);
  expect(html).toContain("main");
  expect(html).toContain("/alpha/log/");
  expect(html).toContain("ofs=0");
  expect(html).toContain("ofs=100");
});
