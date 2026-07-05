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
