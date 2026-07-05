import { test, expect } from "bun:test";
import { parseHtpasswd, verifyHtpasswd } from "../src/config/htpasswd";
import { loadConfig } from "../src/config/config";

test("parseHtpasswd parses user:hash lines", () => {
  const text = "alice:$2y$05$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUV\nbob:$2y$05$zzzzzzzzzzzzzzzzzzzzzzAAAAAAAAAAAAAAAAAAAAAA\n";
  expect(parseHtpasswd(text)).toEqual([
    { user: "alice", hash: "$2y$05$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUV" },
    { user: "bob", hash: "$2y$05$zzzzzzzzzzzzzzzzzzzzzzAAAAAAAAAAAAAAAAAAAAAA" },
  ]);
});

test("parseHtpasswd skips blank lines and comments", () => {
  const text = "\n# a comment\nalice:$2y$05$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUV\n\n";
  expect(parseHtpasswd(text)).toEqual([
    { user: "alice", hash: "$2y$05$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUV" },
  ]);
});

test("parseHtpasswd skips malformed lines with no colon", () => {
  expect(parseHtpasswd("not-a-valid-line\n")).toEqual([]);
});

test("verifyHtpasswd accepts the correct password for a bcrypt entry", async () => {
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  expect(await verifyHtpasswd([{ user: "alice", hash }], "alice", "secret123")).toBe(true);
});

test("verifyHtpasswd rejects the wrong password", async () => {
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  expect(await verifyHtpasswd([{ user: "alice", hash }], "alice", "wrong")).toBe(false);
});

test("verifyHtpasswd rejects an unknown user", async () => {
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  expect(await verifyHtpasswd([{ user: "alice", hash }], "mallory", "secret123")).toBe(false);
});

test("verifyHtpasswd rejects (not throws) an unsupported hash format", async () => {
  expect(await verifyHtpasswd([{ user: "alice", hash: "$apr1$notbcrypt$xxxxxxxxxxxxxxxxxxxxx" }], "alice", "secret123")).toBe(false);
});

test("loadConfig defaults pushCredentials to an empty list when TSGIT_HTPASSWD_FILE is unset", () => {
  const cfg = loadConfig({});
  expect(cfg.pushCredentials).toEqual([]);
});

test("loadConfig returns an empty list when TSGIT_HTPASSWD_FILE points at a missing file", () => {
  const cfg = loadConfig({ TSGIT_HTPASSWD_FILE: "/nonexistent/htpasswd" });
  expect(cfg.pushCredentials).toEqual([]);
});
