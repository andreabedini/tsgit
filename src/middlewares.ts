import { factory } from "./app/env";
import { notFound } from "./errors";
import { createBareRepo, lookupRepo, openRepository, removeBareRepo, type WritableRepository } from "./git";
import { sanitizeRepoName, validateRepoName } from "./git/reponame";
import { checkBasicAuth } from "./git/smart-http/auth";
import { isSmartHttpPath, pushIntent } from "./git/smart-http/service";

// Resolve `/:repo/` to a discovered repo + an open libgit2 handle, exposed to
// downstream handlers via context. Owns the repo's lifecycle: it frees the
// handle once the handler has run, so handlers never open or free repos
// themselves. With TSGIT_PUSH_CREATE it also owns creation, so a push is the one
// request that may be aimed at a repo that isn't there yet.
export const useRepository = factory.createMiddleware(async (c, next) => {
  // Redirect-only stubs (`/repo`, `/repo/log`) lack a trailing slash and get sent
  // to their slash form by appendTrailingSlash — don't open a repo we'd discard.
  // tree/raw and the smart-HTTP endpoints are genuine slash-less content paths,
  // so open the repo for those.
  const p = c.req.path;
  if (!p.endsWith("/") && !p.includes("/tree/") && !p.includes("/raw/") && !isSmartHttpPath(p)) {
    return next();
  }

  const name = c.req.param("repo")!; // present: matched by /:repo/*

  // Push is the only write path, and it authenticates before anything else looks
  // at the repo — so a client can neither create a repo nor learn whether one
  // exists without credentials.
  const push = pushIntent(p, c.req.query("service"));
  if (push) {
    const rejection = await checkBasicAuth(c.req.header("Authorization"), c.env.pushCredentials);
    if (rejection) return rejection;
  }

  let disc = lookupRepo(c.env.TSGIT_SCAN_PATH, name);
  let created = false;

  if (!disc) {
    if (!push || !c.env.TSGIT_PUSH_CREATE) throw notFound(`Repository not found: ${name}`);
    // Check the name here, not just where the directory is made: otherwise a
    // name we will refuse gets a ref advertisement promising the push will work.
    validateRepoName(sanitizeRepoName(name));
    // The ref advertisement for a repo that doesn't exist is the same one an
    // empty repo gives, and needs nothing on disk to answer — so hold off until
    // the client actually sends a pack. A client that advertises and then walks
    // away leaves no empty repo behind.
    if (push === "advertise") {
      c.set("pushCreatePending", true);
      return next();
    }
    disc = createBareRepo(c.env.TSGIT_SCAN_PATH, name);
    created = true;
  }

  c.set("disc", disc);
  const repo = openRepository(disc.path);
  c.set("repo", repo);

  try {
    await next();
  } finally {
    // A repo created for this push with no ref to show for it never received
    // anything — bad pack, hook declined, handler threw. Take it back out
    // instead of leaving an empty repo on the index page.
    const abandoned = created && !hasAnyRef(repo);
    repo.free();
    if (abandoned) removeBareRepo(c.env.TSGIT_SCAN_PATH, disc.name);
  }
});

function hasAnyRef(repo: WritableRepository): boolean {
  try {
    return repo.references().length > 0;
  } catch {
    // Can't even read the refdb of the repo we just made: nothing worth keeping.
    return false;
  }
}
