# Git Smart-HTTP (fetch + push) — Design

**Date:** 2026-07-05
**Status:** Approved, pending implementation plan

## Goal

cgit is read-only: real clone/push traffic is handled by a separate process
(typically `git-http-backend`, wired up alongside cgit by the webserver).
tsgit currently doesn't serve git's wire protocol at all — `TSGIT_CLONE_URL_BASE`
just labels a clone URL that some other mechanism serves.

This adds git's smart-HTTP protocol directly to tsgit, implemented natively
against libgit2 (no `git` subprocess, consistent with the rest of the app):
`git clone`/`fetch`/`push` work against the same server and port as the
browsing UI. Push is gated by HTTP Basic Auth; fetch stays open, matching
today's public read-only browsing.

## Scope

In scope:

- `git-upload-pack` (fetch/clone) and `git-receive-pack` (push), protocol v0
  only (`multi_ack` basic negotiation — no protocol v2, no shallow/partial
  clone).
- HTTP Basic Auth on `git-receive-pack` only, checked against an htpasswd
  file. Any authenticated user may push to any repo tsgit serves.
- Push restricted to bare repos (git's normal server-side rule — pushing into
  a repo with a checked-out working tree is refused).
- Ref create/update/delete via the standard `<old-oid> <new-oid> <ref>`
  command triplet (all-zero old/new oid signals create/delete).

Out of scope (explicitly deferred):

- pre-receive / update / post-receive hooks.
- Protocol v2 (see Roadmap — planned as a follow-up, not abandoned).
- Shallow clone, partial clone (filters), `git archive` (`upload-archive`).
- SSH transport — HTTP(S) only.
- Side-band progress/error messages beyond what `report-status` requires.
- Per-repo push authorization (opt-in/opt-out) — a repo is pushable iff it's
  bare and the pusher authenticates.

## Roadmap

This spec covers protocol v0 only — v0 and v2 negotiate independently (a v2
client sends a `Git-Protocol: version=2` request header; absent that header,
a server just speaks v0), so v2 support can land as a separate follow-up
without reworking what's built here:

1. **This spec** — v0 fetch + push.
2. **Done** (`src/git/smart-http/protocolV2.ts`) — protocol v2: `ls-refs` and
   `fetch` commands replacing the v0 ref advertisement + `want`/`have`
   negotiation, capability advertisement via key=value pairs. `receive-pack`
   is unchanged by v2, as planned — push always gets the v0/v1 advertisement
   and command list regardless of the client's `Git-Protocol` header. `fetch`
   keeps this codebase's v0 simplification of skipping real ACK/NAK
   negotiation rounds (always answers immediately; sends a bare `ready` line
   when the client hasn't said `done` yet, per the spec's server-decides-early
   allowance). Base features only — no shallow/filter/ref-in-want/
   sideband-all/packfile-uris/wait-for-done, matching v0's scope.

## Routes

Mounted under the existing `/:repo/*` sub-app, alongside (not replacing) the
browsing routes:

- `GET /:repo/info/refs?service=git-upload-pack` — ref advertisement for fetch.
- `GET /:repo/info/refs?service=git-receive-pack` — ref advertisement for
  push (Basic Auth required).
- `POST /:repo/git-upload-pack` — negotiation + packfile response.
- `POST /:repo/git-receive-pack` — receive command list + packfile, apply ref
  updates (Basic Auth required).

These sit next to `/:repo/log/`, `/:repo/tree/*`, etc. — same `useRepository`
middleware opens/frees the libgit2 handle around the handler.

## New module: `src/git/smart-http/`

Kept alongside (not inside) `src/views/`, since this is wire-protocol logic,
not a page:

- `pktline.ts` — pkt-line encode/decode (length-prefixed framing, flush-pkt).
  Pure, no libgit2 — unit-testable standalone.
- `advertise.ts` — builds the ref-advertisement body (capabilities line +
  refs, `^{}` peeled entries for annotated tags) from `Repository.references()`
  / `headRef()`.
- `uploadPack.ts` — parses `want`/`have` lines from the request, drives
  negotiation, builds the packfile response via `Repo.packObjects`.
- `receivePack.ts` — parses the ref-update command list and capabilities,
  hands the raw pack bytes to `Repo.indexPack`, applies ref updates via
  `Repo.updateRef`, writes the `report-status` response (per-ref `ok`/`ng`).
- `auth.ts` — Basic Auth Hono middleware, checked against a parsed htpasswd
  file (bcrypt via `Bun.password.verify`). Applied only to the two
  `git-receive-pack` routes.

## Facade/binding additions

`Repository` (`src/git/facade.ts`) stays read-only and untouched — it's the
type views depend on. Smart-http needs write primitives that don't belong on
that interface, so `Repo` (`src/git/binding/repository.ts`) gains extra
methods used only by `src/git/smart-http/`:

- `isBare(): boolean` — new binding `git_repository_is_bare`.
- `indexPack(data: Uint8Array): void` — wraps `git_indexer_new` /
  `git_indexer_append` / `git_indexer_commit` to write the incoming pack into
  the repo's odb as a new `.pack`/`.idx`.
- `updateRef(name: string, oldOid: string, newOid: string): void` — atomic
  compare-and-swap via `git_reference_create_matching`; `git_reference_remove`
  when `newOid` is all-zero.
- `packObjects(wants: string[], haves: string[]): Uint8Array` — wraps
  `git_packbuilder_new` / `git_packbuilder_insert_recursively` (per want,
  after hiding `haves` via `git_revwalk`) / `git_packbuilder_write_buf`.

New `SYMBOLS` entries in `src/git/binding/libgit2.ts` for all of the above
(`git_repository_is_bare`, `git_indexer_*`, `git_reference_create_matching`,
`git_reference_remove`, `git_packbuilder_*`), following the file's existing
symbol-map + pointer-slot conventions.

## Config

New binding, loaded once at startup like `mimeTypes`:

- `TSGIT_HTPASSWD_FILE` — path to an Apache-style htpasswd file (bcrypt
  entries). Missing file → push always 401s (no credentials can match).

## Data flow

```
GET  info/refs?service=git-upload-pack
  → useRepository opens repo → advertise.ts builds ref list → pkt-line response

GET  info/refs?service=git-receive-pack
  → auth.ts (Basic Auth) → useRepository → advertise.ts (receive-pack caps) → response

POST git-upload-pack
  → useRepository → uploadPack.ts parses wants/haves → Repo.packObjects → packfile response

POST git-receive-pack
  → auth.ts (Basic Auth) → useRepository → reject if !repo.isBare()
  → receivePack.ts parses command list + pack body
  → Repo.indexPack(packBytes)
  → for each command: Repo.updateRef(name, old, new) → collect ok/ng
  → report-status pkt-line response
```

## Error handling

- Malformed pkt-line / unknown `service` param → `400`.
- Auth failure on receive-pack → `401` + `WWW-Authenticate: Basic`.
- Push to a non-bare repo → `403`.
- Non-fast-forward / CAS mismatch on a ref → reported per-ref inside
  `report-status` (`ng <ref> <reason>`), not an HTTP error — other refs in
  the same push still apply.
- Pack indexing failure (corrupt pack) → `unpack <reason>` in `report-status`,
  no refs updated.

## Testing

- `tests/git/smart-http/pktline.test.ts` — framing round-trips, flush-pkt,
  oversized/short reads.
- `tests/git/smart-http/*.test.ts` — advertisement content, upload-pack and
  receive-pack parsing against hand-built pkt-line fixtures.
- e2e (`tests/e2e.test.ts` or a new `tests/smart-http.e2e.test.ts`): spin up
  `createApp()` on a real port, then shell out to the real `git` CLI
  (`git clone`, `git push`) against it, same pattern
  `tests/fixtures/repo.ts` already uses to build fixtures — this is test-only
  tooling and doesn't touch the app's own "no git subprocess" runtime rule.
  Covers: clone from empty and non-empty repos, push a new branch, push a
  fast-forward update, push rejected (non-bare target, no auth, bad
  credentials, non-fast-forward without force).
</content>
