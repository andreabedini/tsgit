// Which smart-HTTP endpoint a request path is, and whether it is a push. Kept
// apart from routes.ts so useRepository can ask the same question without
// importing the route table.

export function isSmartHttpPath(path: string): boolean {
  return (
    path.endsWith("/info/refs") ||
    path.endsWith("/git-upload-pack") ||
    path.endsWith("/git-receive-pack")
  );
}

/**
 * "advertise" for the `GET /info/refs?service=git-receive-pack` half of a push,
 * "receive" for the `POST /git-receive-pack` that follows it, null for anything
 * that isn't a push. The service on the advertisement is a query parameter, so
 * it is the client's word for what it is about to do — which is exactly what
 * needs authenticating, since the POST it precedes is a write.
 */
export function pushIntent(path: string, service: string | undefined): "advertise" | "receive" | null {
  if (path.endsWith("/git-receive-pack")) return "receive";
  if (path.endsWith("/info/refs") && service === "git-receive-pack") return "advertise";
  return null;
}
