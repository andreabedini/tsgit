export function abbrevOid(oid: string): string {
  return oid.slice(0, 10);
}

/** Short form of a jj change id. jj itself shows the shortest unique prefix;
 *  8 characters matches its usual output and is plenty to be unique in practice. */
export function abbrevChangeId(changeId: string): string {
  return changeId.slice(0, 8);
}

/** Up to two uppercase initials from a display name, for avatar chips. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (!parts.length) return "?";
  return parts.map((p) => p[0]!.toUpperCase()).join("");
}

const UNITS: [label: string, seconds: number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
  ["second", 1],
];

export function formatAge(when: Date, now: Date = new Date()): string {
  const secs = Math.max(0, Math.floor((now.getTime() - when.getTime()) / 1000));
  for (const [label, unitSecs] of UNITS) {
    const n = Math.floor(secs / unitSecs);
    if (n >= 1) return `${n} ${label}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}
