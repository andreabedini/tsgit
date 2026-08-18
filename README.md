# tsgit

A TypeScript rewrite of [cgit](https://git.zx2c4.com/cgit), the read-only web frontend for
git repositories. Built on [Bun](https://bun.sh) and [Hono](https://hono.dev), it reads
repository data directly through **libgit2** (via Bun's FFI) — no `git` subprocess and no
native build step.

> **Status:** early. The walking skeleton is in place — repository index, per-repo
> summary, log, tree, commit, and diff pages — with refs still to come.

## Git over HTTP

Each repo is also a git remote: `git clone`/`fetch` need no configuration, and
`git push` to a **bare** repo requires Basic auth (see `TSGIT_HTPASSWD_FILE`). Both wire
protocol v0 and v2 are spoken.

### Push to create

With `TSGIT_PUSH_CREATE=1`, pushing to a name that isn't there yet brings the repository
into being — no `git init --bare` on the server first, no shell account:

```sh
git remote add origin https://tsgit.example/newthing.git
git push origin main
```

The repo is created as a bare `newthing.git` directly under `TSGIT_REPO_PATH`, and HEAD is
pointed at the branch you pushed. Only a push can create anything: fetching a repository
that doesn't exist is still a 404, credentials are required before creation (with no
`TSGIT_HTPASSWD_FILE` nothing can be created at all), and a name that isn't a plain
single-segment directory name is refused. If the push then fails — bad pack, hook
declined — the repository it created is removed again rather than left behind empty.

Nested names (`user/project.git`) are not supported yet.

A repo that is *itself* shallow (say a published `--depth 1` clone) is served
correctly: its boundary is advertised, so clients graft it instead of asking for
parents that were never fetched. Asking tsgit to *create* a shallow clone
(`git clone --depth N`) is refused with a clear message — computing a new boundary
isn't implemented.

## Jujutsu

tsgit is jj-aware. jj records a commit's [change id](https://jj-vcs.github.io/jj/latest/glossary/#change-id)
— the identity that survives amends and rebases — as an extra `change-id` header on
the git commit object itself, so tsgit reads it straight out of the object database:
no jj installation, no access to `.jj/`, and nothing to configure. Repos jj has never
touched look exactly as before.

Where a change id is present, tsgit shows it in place of (log: above) the commit hash,
and it works as a revision anywhere a hash does — `/repo/commit/quqpyrzn/`,
`/repo/log/?h=quqpyrzn`. Abbreviations are fine: change ids are spelled in jj's
reverse-hex alphabet (`k`–`z`), so they can never be mistaken for an oid prefix.

**jj workspaces are discovered too.** `TSGIT_REPO_PATH` may hold jj workspaces as well
as plain git repos, colocated or not — including the layout where there is no `.git`
at all and the git dir sits inside `.jj/repo/store/`. tsgit reads the store's
`git_target` to find it and serves the repo under the *workspace* directory's name.
Only that pointer is read from `.jj/`; the operation log and working-copy state are
left alone, so what you see is what jj has exported to git — bookmarks show up as
branches, and commits jj hasn't exported stay reachable (and browsable by change id)
through `refs/jj/keep/*`. Since jj keeps the store's `HEAD` detached, tsgit reports
the branch sitting on that commit, if any, as the default ref.

## Requirements

- [Bun](https://bun.sh)
- **libgit2** as a shared library (`libgit2.so` on Linux, `libgit2.dylib` on macOS).
  Install it via your package manager (e.g. `apt install libgit2-1.9`,
  `brew install libgit2`) or point `LIBGIT2_PATH` at the library file.

## Quick start

```sh
bun install
TSGIT_REPO_PATH=/path/to/your/git/repos bun run dev
# then open http://localhost:3000
```

Set `PORT` to change the listening port (default `3000`).

## Configuration

All configuration comes from `TSGIT_*` environment variables:

| Variable | Default | Description |
|---|---|---|
| `TSGIT_REPO_PATH` | `/srv/git` | Directory scanned for git repositories (bare or non-bare) |
| `TSGIT_CLONE_URL_BASE` | — | If set, shown as the clone-URL base on the summary page |
| `TSGIT_SUMMARY_BRANCHES` | `10` | Branches listed on the summary page |
| `TSGIT_SUMMARY_TAGS` | `10` | Tags listed on the summary page |
| `TSGIT_SUMMARY_LOG` | `10` | Recent commits on the summary page |
| `TSGIT_LOG_PAGE_SIZE` | `50` | Commits per page on the log view |
| `TSGIT_REPOLIST_PAGE_SIZE` | `50` | Repositories per page on the index |
| `TSGIT_HTPASSWD_FILE` | — | htpasswd file whose users may push; without it every push is rejected |
| `TSGIT_PUSH_CREATE` | off | `1`/`true`/`yes`/`on` lets an authenticated push create a repository that doesn't exist yet |

## Docker

```sh
docker build -t tsgit .
docker run -d --name tsgit -p 3000:3000 -v tsgit-repos:/srv/git tsgit
```

Repositories live on the `/srv/git` volume — the value of `TSGIT_REPO_PATH` — so the
image carries no data and anything pushed survives a rebuild. To serve repositories that
already exist on the host, bind-mount them instead: `-v /srv/git:/srv/git`.

The server runs as the unprivileged `bun` user (uid 1000). A named or anonymous volume
inherits that ownership from the image, but a bind mount keeps the host's — so
`chown -R 1000:1000` it if you want push-to-create to be able to write there.

Pushing needs an htpasswd file mounted in:

```sh
docker run -d --name tsgit -p 3000:3000 \
  -v tsgit-repos:/srv/git \
  -v /etc/tsgit/htpasswd:/etc/tsgit/htpasswd:ro \
  -e TSGIT_HTPASSWD_FILE=/etc/tsgit/htpasswd \
  -e TSGIT_PUSH_CREATE=1 \
  -e TSGIT_CLONE_URL_BASE=https://tsgit.example \
  tsgit
```

libgit2 comes from the image's `apk` package and is the only native dependency; tsgit
never shells out to `git`. `HEALTHCHECK` polls `/healthz`.

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
