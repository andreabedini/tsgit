import type { Repository } from "../facade";
import { GitError } from "../binding/libgit2";
import { encodePktLine, FLUSH_PKT, concatBytes } from "./pktline";

const ZERO_OID = "0".repeat(40);

export function buildAdvertisement(
  repo: Repository,
  service: "git-upload-pack" | "git-receive-pack",
): Uint8Array {
  // `shallow` says only that we speak the shallow part of the protocol: we
  // report our own boundary (below) and accept a client's `shallow` lines. A
  // client asking to *create* a shallow clone (`deepen`) is refused explicitly
  // — see routes.ts. Without this capability a client whose own repo is shallow
  // refuses to fetch at all, so cloning our shallow repo would be a dead end.
  const capabilities =
    service === "git-receive-pack"
      ? "report-status delete-refs agent=git/tsgit"
      : "shallow agent=git/tsgit";

  const entries: { oid: string; name: string }[] = [];
  try {
    const headRef = repo.headRef();
    const headCommit = repo.commit(headRef);
    if (headCommit) entries.push({ oid: headCommit.oid, name: "HEAD" });
  } catch (e) {
    // Empty repo: git_repository_head() throws GIT_EUNBORNBRANCH (-9) when HEAD
    // points at a branch with no commits yet. Any other failure should surface.
    if (!(e instanceof GitError && e.code === -9 /* GIT_EUNBORNBRANCH */)) throw e;
  }

  for (const ref of repo.references()) {
    entries.push({ oid: ref.targetOid, name: ref.fullName });
    if (ref.kind === "tag" && ref.targetOid !== ref.commitOid) {
      entries.push({ oid: ref.commitOid, name: `${ref.fullName}^{}` });
    }
  }

  const pktLines: Uint8Array[] = [
    encodePktLine(`# service=${service}\n`),
    FLUSH_PKT,
  ];

  if (entries.length === 0) {
    pktLines.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    entries.forEach((entry, i) => {
      const suffix = i === 0 ? `\0${capabilities}` : "";
      pktLines.push(encodePktLine(`${entry.oid} ${entry.name}${suffix}\n`));
    });
  }

  // advertised-refs = ... *shallow flush-pkt (gitprotocol-pack): the boundary
  // goes after the refs, and is how a cloning client learns not to ask for the
  // parents of these commits. Only upload-pack — push doesn't use it.
  if (service === "git-upload-pack") {
    for (const oid of repo.shallowRoots()) {
      pktLines.push(encodePktLine(`shallow ${oid}\n`));
    }
  }
  pktLines.push(FLUSH_PKT);

  return concatBytes(pktLines);
}
