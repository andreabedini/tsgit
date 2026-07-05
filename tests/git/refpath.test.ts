import { test, expect } from "bun:test";
import { splitRefPath } from "../../src/git/refpath";

const refs = ["main", "feature/login", "v1.0"];

test("simple branch ref splits off the path", () => {
  expect(splitRefPath("main/src/a.ts", refs, "main")).toEqual({ ref: "main", path: "src/a.ts" });
});

test("ref containing slashes wins by longest match", () => {
  expect(splitRefPath("feature/login/src/a.ts", refs, "main")).toEqual({
    ref: "feature/login",
    path: "src/a.ts",
  });
});

test("ref with no trailing path yields an empty path", () => {
  expect(splitRefPath("main", refs, "main")).toEqual({ ref: "main", path: "" });
});

test("hex-looking first segment is treated as an oid", () => {
  expect(splitRefPath("a1b2c3d4/src", refs, "main")).toEqual({ ref: "a1b2c3d4", path: "src" });
});

test("empty tail defaults to the head ref and empty path", () => {
  expect(splitRefPath("", refs, "main")).toEqual({ ref: "main", path: "" });
});

test("unknown non-oid first segment falls back to default ref with the whole tail as path", () => {
  expect(splitRefPath("docs/readme.md", refs, "main")).toEqual({
    ref: "main",
    path: "docs/readme.md",
  });
});

test("a trailing slash on a directory tail is trimmed", () => {
  expect(splitRefPath("main/src/", refs, "main")).toEqual({ ref: "main", path: "src" });
});

test("HEAD is recognized as a ref (tsgit's canonical tree URLs use it)", () => {
  expect(splitRefPath("HEAD/man", refs, "main")).toEqual({ ref: "HEAD", path: "man" });
});

test("HEAD with no trailing path yields an empty path", () => {
  expect(splitRefPath("HEAD", refs, "main")).toEqual({ ref: "HEAD", path: "" });
});
