import { readFileSync } from "node:fs";
import { YAML } from "bun";
import type { Env } from "../app/env";
import { parseHtpasswd, type HtpasswdEntry } from "./htpasswd";

// Config is carried on the request as Bindings (c.env). This is the TSGIT_*
// shape, so loadConfig() reads straight from a process.env-like record.
export type SiteConfig = Env["Bindings"];

// Sensible built-in MIME types, overridden/extended by the YAML `mimetype:`
// section. Keep this modest; unknown extensions fall back to the isBinary
// heuristic at render time.
export const DEFAULT_MIME_TYPES: Record<string, string> = {
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
  pdf: "application/pdf",
};

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Built-in defaults, merged with the file's `mimetype:` section (file wins).
// Missing file -> defaults only. A present-but-unreadable/malformed file throws
// (config is loaded once at startup, so this fails fast).
function loadMimeTypes(env: Record<string, string | undefined>): Record<string, string> {
  const path = env.TSGIT_CONFIG ?? "./tsgit.yaml";
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return { ...DEFAULT_MIME_TYPES };
    throw e;
  }
  const doc = YAML.parse(text) as { mimetype?: unknown } | null;
  const raw = doc?.mimetype;
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new TypeError("tsgit config: 'mimetype' must be a mapping of extension to MIME type");
  }
  const merged: Record<string, string> = { ...DEFAULT_MIME_TYPES };
  for (const [ext, type] of Object.entries((raw as Record<string, string>) ?? {})) {
    merged[ext.toLowerCase()] = type;
  }
  return merged;
}

// Missing file -> no credentials (every push request will then 401, since no
// user can match). A present-but-unreadable/malformed-permissions file throws,
// consistent with loadMimeTypes' fail-fast-at-startup behavior.
function loadHtpasswd(env: Record<string, string | undefined>): HtpasswdEntry[] {
  const path = env.TSGIT_HTPASSWD_FILE;
  if (!path) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }
  return parseHtpasswd(text);
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): SiteConfig {
  return {
    TSGIT_SCAN_PATH: env.TSGIT_SCAN_PATH ?? "/srv/git",
    TSGIT_CLONE_URL_BASE: env.TSGIT_CLONE_URL_BASE,
    TSGIT_SUMMARY_BRANCHES: num(env.TSGIT_SUMMARY_BRANCHES, 10),
    TSGIT_SUMMARY_TAGS: num(env.TSGIT_SUMMARY_TAGS, 10),
    TSGIT_SUMMARY_LOG: num(env.TSGIT_SUMMARY_LOG, 10),
    TSGIT_LOG_PAGE_SIZE: num(env.TSGIT_LOG_PAGE_SIZE, 50),
    TSGIT_REPOLIST_PAGE_SIZE: num(env.TSGIT_REPOLIST_PAGE_SIZE, 50),
    TSGIT_HTPASSWD_FILE: env.TSGIT_HTPASSWD_FILE,
    mimeTypes: loadMimeTypes(env),
    pushCredentials: loadHtpasswd(env),
  };
}
