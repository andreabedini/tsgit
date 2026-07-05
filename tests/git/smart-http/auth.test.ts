import { test, expect } from "bun:test";
import { checkBasicAuth } from "../../../src/git/smart-http/auth";
import type { HtpasswdEntry } from "../../../src/config/htpasswd";

async function credentials(): Promise<HtpasswdEntry[]> {
  const hash = await Bun.password.hash("secret123", { algorithm: "bcrypt", cost: 4 });
  return [{ user: "alice", hash }];
}

test("checkBasicAuth returns null (authorized) for correct credentials", async () => {
  const header = `Basic ${btoa("alice:secret123")}`;
  expect(await checkBasicAuth(header, await credentials())).toBeNull();
});

test("checkBasicAuth returns a 401 when the Authorization header is missing", async () => {
  const res = await checkBasicAuth(undefined, await credentials());
  expect(res).not.toBeNull();
  expect(res!.status).toBe(401);
  expect(res!.headers.get("WWW-Authenticate")).toContain("Basic");
});

test("checkBasicAuth returns a 401 for the wrong password", async () => {
  const header = `Basic ${btoa("alice:wrong")}`;
  const res = await checkBasicAuth(header, await credentials());
  expect(res!.status).toBe(401);
});

test("checkBasicAuth returns a 401 for a malformed Authorization header", async () => {
  const res = await checkBasicAuth("Bearer sometoken", await credentials());
  expect(res!.status).toBe(401);
});
