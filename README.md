# tsgit

A TypeScript rewrite of [cgit](https://git.zx2c4.com/cgit), the read-only web frontend for
git repositories. Built on [Bun](https://bun.sh) and [Hono](https://hono.dev), it reads
repository data directly through **libgit2** (via Bun's FFI) — no `git` subprocess and no
native build step.

> **Status:** early. The walking skeleton is in place — repository index, per-repo
> summary, log, tree, commit, and diff pages — with refs still to come.

## Requirements

- [Bun](https://bun.sh)
- **libgit2** as a shared library (`libgit2.so` on Linux, `libgit2.dylib` on macOS).
  Install it via your package manager (e.g. `apt install libgit2-1.9`,
  `brew install libgit2`) or point `LIBGIT2_PATH` at the library file.

## Quick start

```sh
bun install
TSGIT_SCAN_PATH=/path/to/your/git/repos bun run dev
# then open http://localhost:3000
```

Set `PORT` to change the listening port (default `3000`).

## Configuration

All configuration comes from `TSGIT_*` environment variables:

| Variable | Default | Description |
|---|---|---|
| `TSGIT_SCAN_PATH` | `/srv/git` | Directory scanned for git repositories (bare or non-bare) |
| `TSGIT_CLONE_URL_BASE` | — | If set, shown as the clone-URL base on the summary page |
| `TSGIT_SUMMARY_BRANCHES` | `10` | Branches listed on the summary page |
| `TSGIT_SUMMARY_TAGS` | `10` | Tags listed on the summary page |
| `TSGIT_SUMMARY_LOG` | `10` | Recent commits on the summary page |
| `TSGIT_LOG_PAGE_SIZE` | `50` | Commits per page on the log view |
| `TSGIT_REPOLIST_PAGE_SIZE` | `50` | Repositories per page on the index |

## Development

```sh
bun test        # run the test suite
bun run dev     # run the server against your local code
```

All libgit2 access lives behind a small facade (`src/git/`), so the rest of the app is
plain typed TypeScript. See [`CLAUDE.md`](./CLAUDE.md) for architecture and conventions,
and [`docs/`](./docs) for the design specs and implementation plans.

## Project layout

```
src/
  server.tsx        # Hono app + Bun server entry
  app/env.ts        # typed Env (config bindings + request vars)
  config/           # TSGIT_* config loader
  middlewares.ts    # repo resolution + lifecycle
  git/              # libgit2 facade (binding/ = bun:ffi)
  views/default/    # JSX pages + layouts
  public/           # CSS (Terminal.css)
tests/              # bun test, mirrors src/
docs/               # design specs + implementation plans
```

## License

tsgit is a rewrite of cgit, which is distributed under the GNU GPL v2. Add a `LICENSE`
file to make the license of this project explicit before distributing it.
