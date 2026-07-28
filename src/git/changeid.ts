// Jujutsu (jj) support.
//
// jj gives every commit a *change id* — a stable identity that survives rewrites
// (amend, rebase, describe), while the git commit oid changes each time. With
// `git.write-change-id-header = true` (the default since jj 0.31) jj records it
// as an extra `change-id` header on the git commit object itself:
//
//     tree c977b9fe…
//     parent eeaba3e2…
//     author  Andrea Bedini <andrea@bedini.au> 1785219214 +0800
//     committer Andrea Bedini <andrea@bedini.au> 1785221208 +0800
//     change-id quqpyrznkwqmrttpoowqwtlnmqnvosms
//
// so a plain git server (or tsgit) can read it with no jj-specific storage: the
// `.jj/` directory is never touched. Repos whose commits predate the header —
// or that were never touched by jj — simply have `changeId: null` everywhere and
// render exactly as before.
//
// jj prints change ids in "reverse hex": the digits 0-f are rendered as the
// letters z-k. So a change id is always 32 characters drawn from k..z, which
// cannot collide with a git oid prefix (0-9a-f) — that disjointness is what lets
// `commit()` route a revision string to change-id lookup unambiguously.

export const CHANGE_ID_LENGTH = 32;

/** True for a (possibly abbreviated) jj change id: 1–32 chars, all in k..z. */
export function looksLikeChangeId(rev: string): boolean {
  return rev.length > 0 && rev.length <= CHANGE_ID_LENGTH && /^[k-z]+$/.test(rev);
}
