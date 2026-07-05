import { factory } from "./app/env";
import { findRepo, openRepository } from "./git";

// Resolve `/:repo/` to a discovered repo + an open libgit2 handle, exposed to
// downstream handlers via context. Owns the repo's lifecycle: it frees the
// handle once the handler has run, so handlers never open or free repos
// themselves.
export const useRepository = factory.createMiddleware(async (c, next) => {
  // Redirect-only stubs (`/repo`, `/repo/log`) lack a trailing slash and get sent
  // to their slash form by appendTrailingSlash — don't open a repo we'd discard.
  // tree/raw and the smart-HTTP endpoints are genuine slash-less content paths,
  // so open the repo for those.
  const p = c.req.path;
  const isSmartHttp = p.endsWith("/info/refs") || p.endsWith("/git-upload-pack") || p.endsWith("/git-receive-pack");
  if (!p.endsWith("/") && !p.includes("/tree/") && !p.includes("/raw/") && !isSmartHttp) return next();

  const disc = findRepo(c.env.TSGIT_SCAN_PATH, c.req.param("repo")!); // present: matched by /:repo/*
  c.set("disc", disc);

  const repo = openRepository(disc.path);
  c.set("repo", repo);

  try {
    await next();
  } finally {
    repo.free();
  }
});
