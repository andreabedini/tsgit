# tsgit — read-only git web frontend and smart-HTTP git server.
FROM oven/bun:1-alpine

# libgit2 is the only native dependency: tsgit reads git data through it over
# Bun's FFI and never shells out to `git`. The package installs the versioned
# soname only, while the binding looks for "libgit2.so" first, so link the two.
RUN apk add --no-cache libgit2 \
 && ln -sf "$(ls -1 /usr/lib/libgit2.so.* | head -n1)" /usr/lib/libgit2.so

WORKDIR /app

# Dependencies first: a source-only change then doesn't re-resolve them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Bun runs the TypeScript as-is — there is no build step.
COPY src ./src

ENV TSGIT_REPO_PATH=/srv/git \
    PORT=3000

# Repositories live on a volume, so the image carries no data and anything
# pushed survives `docker rm`. Created owned by the unprivileged `bun` user
# (uid 1000) that the server runs as, which an anonymous volume inherits — a
# bind mount keeps the host's ownership instead, so make it writable by uid
# 1000 yourself if you use one and want TSGIT_PUSH_CREATE to work.
RUN mkdir -p "$TSGIT_REPO_PATH" && chown bun:bun "$TSGIT_REPO_PATH"
VOLUME ["/srv/git"]

EXPOSE 3000
USER bun

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e 'process.exit((await fetch(`http://127.0.0.1:${process.env.PORT}/healthz`)).ok ? 0 : 1)'

CMD ["bun", "run", "src/server.tsx"]
