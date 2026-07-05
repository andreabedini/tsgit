export interface HtpasswdEntry {
  user: string;
  hash: string;
}

export function parseHtpasswd(text: string): HtpasswdEntry[] {
  const entries: HtpasswdEntry[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    entries.push({ user: line.slice(0, idx), hash: line.slice(idx + 1) });
  }
  return entries;
}

// Only bcrypt hashes ($2a$/$2b$/$2y$, e.g. from `htpasswd -B`) are supported.
// Other htpasswd formats (MD5 apr1, crypt) parse fine but always fail
// verification here rather than throwing.
export async function verifyHtpasswd(
  entries: HtpasswdEntry[],
  user: string,
  password: string,
): Promise<boolean> {
  const entry = entries.find((e) => e.user === user);
  if (!entry) return false;
  try {
    return await Bun.password.verify(password, entry.hash);
  } catch {
    return false;
  }
}
