# tsgit

A TypeScript/Bun rewrite of [cgit](https://git.zx2c4.com/cgit) — a fast, read-only web
frontend for browsing git repositories. Reads git data through **libgit2 via Bun FFI**
(no `git` subprocess, no native addons).

## Commands

- `bun install` — install dependencies (Hono)
- `bun run dev` — start the server (port `PORT`, default `3000`)
- `bun test` — run the test suite

Requires **libgit2** on the system (`libgit2.so` on Linux, `libgit2.dylib` on macOS;
override the path with `LIBGIT2_PATH`).

## Architecture

Entry point is `src/server.tsx`: `createApp()` builds a Hono app, and the default export
is a Bun server object (`{ port, fetch }`) that calls `app.fetch(req, loadConfig())`.

- **`src/app/env.ts`** — the Hono `Env`. `Bindings` is the `TSGIT_*` config (carried on
  `c.env`); `Variables` are the per-request `disc` (discovered repo) and `repo` (open
  handle). `factory = createFactory<Env>()`.
- **`src/config/config.ts`** — `loadConfig()` reads `TSGIT_*` from `process.env` into the
  Bindings shape. Config is **passed as `c.env`**, not imported as a singleton.
- **`src/middlewares.ts`** — `useRepository` resolves `/:repo/` to an open libgit2 handle
  on the context and **frees it after the handler runs** (handlers never open/free repos).
  `buildDecorationMap` groups refs by commit for log decorations.
- **`src/git/`** — the git facade, the app's seam over libgit2:
  - `facade.ts` — pure TS interfaces (`Repository`, `Commit`, `Reference`, `LogPage`).
    Everything outside `binding/` depends only on these types.
  - `binding/libgit2.ts` — `bun:ffi` `dlopen` of libgit2: symbol map, library resolution
    (`LIBGIT2_PATH` → unversioned → versioned fallback), init, error handling, and
    pointer-slot helpers. **The FFI conventions are documented at the bottom of this
    file — read them before touching bindings.**
  - `binding/repository.ts` — `openRepository()` + the `Repo` class implementing
    `Repository` over the FFI symbols (head, references, revwalk log, `readFileAtRef`).
  - `scan.ts` — `scanRepos(root)` discovers bare/non-bare repos and reads `description`.
  - `index.ts` — re-exports the facade and `openRepository`, plus `findRepo`.
- **`src/views/default/`** — Hono JSX pages (`RepolistPage`, `SummaryPage`, `LogPage`,
  `ErrorPage`) plus `renderer.tsx`: a root `jsxRenderer` document layout (`renderer`) and
  a nested `repoLayout` that prepends the per-repo menu, reading state via
  `useRequestContext`.
- **`src/errors.ts`** — `HttpError` + `statusForError`/`notFound`/`badRequest`.
- **`src/format.ts`** — `abbrevOid`, `formatAge`.
- **`src/public/`** — `tsgit.css`, the sole stylesheet. A dark-only, Rose Pine–derived
  skin (the "Bedini Homelab" design): vendored design tokens followed by `.cg-*`
  component classes. No CSS framework.

## Conventions

- **Request context over ViewModels/providers.** Handlers read repo/config off the
  context (`c.get("repo")`, `c.env.TSGIT_*`); don't thread state through render props or
  add provider layers.
- **Helpers take explicit args, never `Context`** — taking `Context` in a controller
  kills Hono's path-param type inference.
- **Keep libgit2 behind `src/git/binding/`.** The rest of the app imports from
  `facade.ts` (types) / `git/index.ts` only. Keep FFI symbol signatures exact.
- **Repo lifecycle is the middleware's job** — `useRepository` opens and frees; handlers
  just use `c.get("repo")`.
- **TDD.** Tests in `tests/` mirror `src/`. `tests/e2e.test.ts` is the behavioral oracle
  (routes, redirects, 404, content types) — keep it green. `tests/fixtures/repo.ts`
  builds deterministic fixture repos.

## Config (`TSGIT_*` environment variables)

| Variable | Default | Notes |
|---|---|---|
| `TSGIT_SCAN_PATH` | `/srv/git` | directory scanned for repositories |
| `TSGIT_CLONE_URL_BASE` | — | base for displayed clone URLs |
| `TSGIT_SUMMARY_BRANCHES` | `10` | branches on the summary page |
| `TSGIT_SUMMARY_TAGS` | `10` | tags on the summary page |
| `TSGIT_SUMMARY_LOG` | `10` | recent commits on the summary page |
| `TSGIT_LOG_PAGE_SIZE` | `50` | commits per log page |
| `TSGIT_REPOLIST_PAGE_SIZE` | `50` | repositories per index page |

## Design docs

`docs/superpowers/specs/` (designs) and `docs/superpowers/plans/` (implementation plans)
record the walking-skeleton (M1) and the Hono best-practices refactor (M2). The current
code reflects the refactor — when a doc and the code disagree, the code wins.
