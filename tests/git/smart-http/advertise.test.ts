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
