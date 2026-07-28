import { test, expect, describe } from "bun:test";
import { repoDir, sanitizeRepoName, validateRepoName } from "../../src/git/reponame";
import { HttpError } from "../../src/errors";

describe("sanitizeRepoName", () => {
  test("strips the .git suffix smart-HTTP clients send", () => {
    expect(sanitizeRepoName("project.git")).toBe("project");
    expect(sanitizeRepoName("project")).toBe("project");
    // Only the trailing suffix — a repo may legitimately be called "dot.git.files".
    expect(sanitizeRepoName("dot.git.files")).toBe("dot.git.files");
  });
});

describe("validateRepoName", () => {
  test("accepts plain names", () => {
    for (const name of ["project", "my-repo", "my_repo", "repo.2", "a", "A1"]) {
      expect(() => validateRepoName(name)).not.toThrow();
    }
  });

  test("rejects path separators and traversal", () => {
    for (const name of ["..", ".", "../evil", "a/b", "a\\b", "/etc/passwd", "a/../../b"]) {
      expect(() => validateRepoName(name)).toThrow(HttpError);
    }
  });

  test("rejects a leading dot or dash, which would hide the repo or read as a flag", () => {
    for (const name of [".hidden", "-flag"]) {
      expect(() => validateRepoName(name)).toThrow(HttpError);
    }
  });

  test("rejects the empty name, whitespace, control characters and NUL", () => {
    const ESC = String.fromCharCode(27);
    const NUL = String.fromCharCode(0);
    for (const name of ["", " ", "a b", "a\nb", `a${NUL}b`, `a${ESC}[31m`, "café"]) {
      expect(() => validateRepoName(name)).toThrow(HttpError);
    }
  });

  test("rejects an absurdly long name", () => {
    expect(() => validateRepoName("a".repeat(101))).toThrow(HttpError);
    expect(() => validateRepoName("a".repeat(100))).not.toThrow();
  });

  test("reports a 400, not a 500", () => {
    try {
      validateRepoName("../evil");
      throw new Error("expected validateRepoName to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(400);
    }
  });
});

describe("repoDir", () => {
  test("is the bare `<name>.git` directory under the scan path", () => {
    expect(repoDir("/srv/git", "project")).toBe("/srv/git/project.git");
  });

  test("stays inside the scan path", () => {
    expect(() => repoDir("/srv/git", "../../etc")).toThrow(HttpError);
    // A sibling directory sharing the scan path's prefix is still outside it.
    expect(() => repoDir("/srv/git", "../gitevil")).toThrow(HttpError);
  });
});
