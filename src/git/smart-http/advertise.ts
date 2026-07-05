import type { Repository } from "../facade";
import { encodePktLine, FLUSH_PKT, concatBytes } from "./pktline";

const ZERO_OID = "0".repeat(40);

export function buildAdvertisement(
  repo: Repository,
  service: "git-upload-pack" | "git-receive-pack",
): Uint8Array {
  const capabilities =
    service === "git-receive-pack"
      ? "report-status delete-refs agent=git/tsgit"
      : "agent=git/tsgit";

  const entries: { oid: string; name: string }[] = [];
  try {
    const headRef = repo.headRef();
    const headCommit = repo.commit(headRef);
    if (headCommit) entries.push({ oid: headCommit.oid, name: "HEAD" });
  } catch {
    // Empty repo - no HEAD exists
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
  pktLines.push(FLUSH_PKT);

  return concatBytes(pktLines);
}
