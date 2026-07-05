import { verifyHtpasswd, type HtpasswdEntry } from "../../config/htpasswd";

function parseBasicAuthHeader(header: string | undefined): { user: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx === -1) return null;
  return { user: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
}

// Returns null when the request is authorized, otherwise the 401 Response the
// caller should return as-is.
export async function checkBasicAuth(
  authHeader: string | undefined,
  credentials: HtpasswdEntry[],
): Promise<Response | null> {
  const parsed = parseBasicAuthHeader(authHeader);
  if (parsed && (await verifyHtpasswd(credentials, parsed.user, parsed.password))) {
    return null;
  }
  return new Response("Authentication required\n", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="tsgit push"' },
  });
}
