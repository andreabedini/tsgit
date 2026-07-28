import { test, expect } from "bun:test";
import { createShallowFixtureRepo } from "../fixtures/shallow-repo";
import { createFixtureRepo } from "../fixtures/repo";
import { openRepository } from "../../src/git";
import { buildAdvertisement } from "../../src/git/smart-http/advertise";
import { buildFetchV2Response, parseFetchV2Args } from "../../src/git/smart-http/protocolV2";
import { parseUploadPackRequest } from "../../src/git/smart-http/uploadPack";
import { encodePktLine, concatBytes, FLUSH_PKT } from "../../src/git/smart-http/pktline";

const decoder = new TextDecoder();

/** pkt-line payloads of a response, ignoring flush/delim and raw pack bytes. */
function textLines(body: Uint8Array): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = decoder.decode(body.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const len = parseInt(header, 16);
    if (len <= 1) { offset += 4; continue; }
    lines.push(decoder.decode(body.subarray(offset + 4, offset + len)).replace(/\n$/, ""));
    offset += len;
  }
  return lines;
}

test("shallowRoots reports the boundary commit, and nothing for a normal repo", async () => {
  const shallow = await createShallowFixtureRepo();
  try {
    const repo = openRepository(shallow.path);
    try {
      expect(repo.shallowRoots()).toEqual([shallow.boundaryOid]);
    } finally {
      repo.free();
    }
  } finally {
    shallow.cleanup();
  }

  const normal = await createFixtureRepo();
  try {
    const repo = openRepository(normal.path);
    try {
      expect(repo.shallowRoots()).toEqual([]);
    } finally {
      repo.free();
    }
  } finally {
    normal.cleanup();
  }
});

test("the v0 advertisement carries the shallow capability and boundary lines", async () => {
  const shallow = await createShallowFixtureRepo();
  try {
    const repo = openRepository(shallow.path);
    try {
      const lines = textLines(buildAdvertisement(repo, "git-upload-pack"));
      expect(lines.some((l) => l.includes("\0") && l.includes("shallow "))).toBe(true); // capability
      expect(lines).toContain(`shallow ${shallow.boundaryOid}`);
      // The boundary goes after the refs (advertised-refs = ... *shallow flush).
      const lastRef = lines.findLastIndex((l) => / refs\//.test(l));
      expect(lines.indexOf(`shallow ${shallow.boundaryOid}`)).toBeGreaterThan(lastRef);

      // Push doesn't use the boundary, and must not claim the capability.
      const push = textLines(buildAdvertisement(repo, "git-receive-pack"));
      expect(push.some((l) => l === `shallow ${shallow.boundaryOid}`)).toBe(false);
    } finally {
      repo.free();
    }
  } finally {
    shallow.cleanup();
  }
});

test("the v2 fetch response includes a shallow-info section, omitted when not shallow", async () => {
  const shallow = await createShallowFixtureRepo();
  try {
    const repo = openRepository(shallow.path);
    try {
      const args = parseFetchV2Args([`want ${shallow.boundaryOid}`, "done"]);
      const lines = textLines(buildFetchV2Response(repo, args));
      expect(lines).toContain("shallow-info");
      expect(lines).toContain(`shallow ${shallow.boundaryOid}`);
      // shallow-info precedes the packfile section.
      expect(lines.indexOf("shallow-info")).toBeLessThan(lines.indexOf("packfile"));
    } finally {
      repo.free();
    }
  } finally {
    shallow.cleanup();
  }

  const normal = await createFixtureRepo();
  try {
    const repo = openRepository(normal.path);
    try {
      const head = repo.commit("main")!;
      const lines = textLines(buildFetchV2Response(repo, parseFetchV2Args([`want ${head.oid}`, "done"])));
      expect(lines).not.toContain("shallow-info");
    } finally {
      repo.free();
    }
  } finally {
    normal.cleanup();
  }
});

test("client shallow lines are recorded and deepen requests are flagged", () => {
  const oid = "a".repeat(40);
  const body = concatBytes([
    encodePktLine(`want ${oid} multi_ack_detailed shallow agent=git/2.55\n`),
    encodePktLine(`shallow ${"b".repeat(40)}\n`),
    FLUSH_PKT,
    encodePktLine("done\n"),
  ]);
  const plain = parseUploadPackRequest(body);
  expect(plain.wants).toEqual([oid]);
  expect(plain.shallows).toEqual(["b".repeat(40)]);
  expect(plain.deepen).toBe(false);

  for (const line of ["deepen 1", "deepen-since 1780000000", "deepen-not refs/tags/v1.0"]) {
    const withDeepen = parseUploadPackRequest(
      concatBytes([encodePktLine(`want ${oid}\n`), encodePktLine(`${line}\n`), FLUSH_PKT]),
    );
    expect(withDeepen.deepen).toBe(true);
  }

  // Same for v2 fetch args.
  expect(parseFetchV2Args([`want ${oid}`, `shallow ${"c".repeat(40)}`]).shallows).toEqual(["c".repeat(40)]);
  expect(parseFetchV2Args([`want ${oid}`, "deepen 1"]).deepen).toBe(true);
  expect(parseFetchV2Args([`want ${oid}`, "deepen-relative"]).deepen).toBe(true);
  expect(parseFetchV2Args([`want ${oid}`]).deepen).toBe(false);
});
