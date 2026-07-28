import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config/config";

test("loadConfig uses default MIME types when the config file is missing", () => {
  const cfg = loadConfig({ TSGIT_CONFIG: "/nonexistent/tsgit.yaml" });
  expect(cfg.mimeTypes.gif).toBe("image/gif");
  expect(cfg.mimeTypes.pdf).toBe("application/pdf");
});

test("loadConfig merges the YAML mimetype section over the defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsgit-cfg-"));
  try {
    const file = join(dir, "tsgit.yaml");
    writeFileSync(file, "mimetype:\n  gif: image/x-custom\n  rs: text/rust\n");
    const cfg = loadConfig({ TSGIT_CONFIG: file });
    expect(cfg.mimeTypes.gif).toBe("image/x-custom"); // overridden
    expect(cfg.mimeTypes.rs).toBe("text/rust");        // extended
    expect(cfg.mimeTypes.pdf).toBe("application/pdf");  // default kept
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws on a malformed YAML config", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsgit-cfg-"));
  try {
    const file = join(dir, "tsgit.yaml");
    writeFileSync(file, 'mimetype:\n  gif: "unterminated\n');
    expect(() => loadConfig({ TSGIT_CONFIG: file })).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig throws when the mimetype section is not a mapping", () => {
  const dir = mkdtempSync(join(tmpdir(), "tsgit-cfg-"));
  try {
    const file = join(dir, "tsgit.yaml");
    writeFileSync(file, "mimetype: not-a-mapping\n");
    expect(() => loadConfig({ TSGIT_CONFIG: file })).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig leaves push-to-create off unless it is explicitly switched on", () => {
  const off = { TSGIT_CONFIG: "/nonexistent/tsgit.yaml" };
  expect(loadConfig(off).TSGIT_PUSH_CREATE).toBe(false);
  for (const value of ["0", "false", "no", "off", "", "maybe"]) {
    expect(loadConfig({ ...off, TSGIT_PUSH_CREATE: value }).TSGIT_PUSH_CREATE).toBe(false);
  }
  for (const value of ["1", "true", "TRUE", "yes", "on", " true "]) {
    expect(loadConfig({ ...off, TSGIT_PUSH_CREATE: value }).TSGIT_PUSH_CREATE).toBe(true);
  }
});
