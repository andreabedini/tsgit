import { serveStatic } from "hono/bun";
import { appendTrailingSlash } from "hono/trailing-slash";
import { factory } from "./app/env";
import { loadConfig } from "./config/config";
import { notFound, statusForError } from "./errors";
import { openRepository } from "./git";
import { scanRepos } from "./git/scan";
import { isBinary, classifyBlob } from "./blob";
import { highlightBlob } from "./highlight";
import { mimeForPath } from "./mime";
import { splitRefPath } from "./git/refpath";
import { BlobPage } from "./views/default/BlobPage";
import { DiffFileCard } from "./views/default/DiffFileCard";
import { TreePage } from "./views/default/TreePage";
import { useRepository } from "./middlewares";
import { ErrorPage } from "./views/default/ErrorPage";
import { LogPage } from "./views/default/LogPage";
import { renderer, repoLayout } from "./views/default/renderer";
import { RepolistPage, type RepoListEntry } from "./views/default/RepolistPage";
import { SummaryPage } from "./views/default/SummaryPage";
import { CommitCard } from "./views/default/CommitCard";

export function createApp() {
  const app = factory.createApp();

  app.use(renderer);

  // Infra routes are registered before the repo sub-app so requests like
  // `/healthz` or `/tsgit.css` never match the `/:repo` redirect.
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/tsgit.css", serveStatic({ path: "./src/public/tsgit.css" }));

  app.get("/", (c) => {
    // Optional `?q=` filters the index by repo name or description.
    const q = (c.req.query("q") ?? "").trim();
    const needle = q.toLowerCase();
    const matched = scanRepos(c.env.TSGIT_SCAN_PATH).filter(
      (r) =>
        !needle ||
        r.name.toLowerCase().includes(needle) ||
        (r.description ?? "").toLowerCase().includes(needle),
    );
    // Numbered pagination UI is a later milestone; cap to the first page for now.
    const repos = matched.slice(0, c.env.TSGIT_REPOLIST_PAGE_SIZE);
    const entries: RepoListEntry[] = repos.map((repo) => {
      const handle = openRepository(repo.path);
      try {
        const last = handle.log({ limit: 1 }).commits[0];
        return { repo, lastCommit: last?.author.when };
      } finally {
        handle.free();
      }
    });
    let host: string | undefined;
    if (c.env.TSGIT_CLONE_URL_BASE) {
      try {
        host = new URL(c.env.TSGIT_CLONE_URL_BASE).host;
      } catch {
        host = undefined;
      }
    }
    return c.render(<RepolistPage entries={entries} now={new Date()} host={host} query={q || undefined} />);
  });

  // appendTrailingSlash is a 404 fallback: it sends slash-less paths to their
  // slash form only when the response is 404. Exclude tree/raw so a genuine
  // missing-path 404 there is returned as-is rather than bounced to a slash URL.
  app.use(
    appendTrailingSlash({
      skip: (p) => p.includes("/tree/") || p.includes("/raw/"),
    }),
  );

  // Nested layout adds the per-repo menu; useRepository opens the repo and
  // exposes it (and its discovered metadata) on the context.
  app.use("/:repo/*", repoLayout);
  app.use("/:repo/*", useRepository);

  app.get("/:repo/", async (c) => {
    const repo = c.get("repo");
    const refs = repo.references();
    const branches = refs.filter((r) => r.kind === "branch");
    const tags = refs.filter((r) => r.kind === "tag");
    const recentCommits = repo.log({ limit: c.env.TSGIT_SUMMARY_LOG }).commits;

    const disc = c.get("disc");
    const readme = repo.readFileAtRef(repo.headRef(), "README.md");
    const aboutHtml = readme
      ? await highlightBlob(new TextDecoder().decode(readme), "README.md", readme.length)
      : undefined;
    const decorations = repo.decorations();

    return c.render(
      <SummaryPage
        name={disc.name}
        description={disc.description}
        branches={branches.slice(0, c.env.TSGIT_SUMMARY_BRANCHES)}
        tags={tags.slice(0, c.env.TSGIT_SUMMARY_TAGS)}
        recentCommits={recentCommits}
        decorations={decorations}
        aboutHtml={aboutHtml}
        headRef={repo.headRef()}
        owner={disc.owner}
        now={new Date()}
      />,
    );
  });

  app.get("/:repo/log/", (c) => {
    const disc = c.get("disc");

    const repo = c.get("repo");
    const ref = c.req.query("h") || repo.headRef();
    const offset = Math.max(0, Number(c.req.query("ofs") ?? 0) | 0);
    const limit = c.env.TSGIT_LOG_PAGE_SIZE;
    const page = repo.log({ ref, offset, limit });
    const decorations = repo.decorations();

    return c.render(
      <LogPage
        name={disc.name}
        ref={ref}
        commits={page.commits}
        decorations={decorations}
        offset={offset}
        limit={limit}
        hasMore={page.hasMore}
        now={new Date()}
      />,
    );
  });

  app.use("/:repo/commit/:rev/", async (c, next) => {
    const repo = c.get("repo");

    const commit = repo.commit(c.req.param("rev"));
    if (!commit) throw notFound(`Commit not found: ${c.req.param("rev")}`);
    c.set("commit", commit);

    const diff = repo.diff(commit.oid);
    if (!diff) throw notFound(`Commit not found: ${c.req.param("rev")}`);
    c.set("diff", diff);

    return next();
  });

  app.get("/:repo/commit/:rev/", (c) => {
    const name = c.get("disc")?.name;
    const commit = c.get("commit");
    const diff = c.get("diff");
    return c.render(
      <>
        <title>{`${name}: commit ${commit.abbrevOid}`}</title>
        <CommitCard />
        {diff.files.length ? (
          diff.files.map((file) => <DiffFileCard file={file} />)
        ) : (
          <p class="cg-empty">No changes.</p>
        )}
      </>
    );
  });

  app.get("/:repo/tree/*", async (c) => {
    const repo = c.get("repo");
    const disc = c.get("disc");
    // A slash-less stub like `/repo/tree` matches this route with an empty
    // wildcard, but useRepository hasn't opened the repo for it. Returning 404
    // lets appendTrailingSlash redirect it to the canonical `/repo/tree/`.
    if (!disc || !repo) throw notFound("Not found");
    const tail = c.req.path.slice(`/${c.req.param("repo")}/tree/`.length);
    const refNames = repo.references().map((r) => r.name);
    const { ref, path } = splitRefPath(tail, refNames, repo.headRef());

    const entries = repo.tree(ref, path);
    if (entries) {
      const head = repo.commit(ref);
      return c.render(
        <TreePage name={disc.name} ref={ref} path={path} entries={entries} headCommit={head ?? undefined} now={new Date()} />,
      );
    }
    const bytes = repo.readFileAtRef(ref, path);
    if (bytes !== null) {
      const { kind, text } = classifyBlob(bytes, mimeForPath(path, c.env.mimeTypes));
      const highlighted =
        kind === "text" ? await highlightBlob(text ?? "", path, bytes.length) : undefined;
      return c.render(
        <BlobPage name={disc.name} ref={ref} path={path} kind={kind} highlighted={highlighted} size={bytes.length} />,
      );
    }
    throw notFound(`Path not found: ${path}`);
  });

  app.get("/:repo/raw/*", (c) => {
    const repo = c.get("repo");
    const disc = c.get("disc");
    // A slash-less stub like `/repo/tree` matches this route with an empty
    // wildcard, but useRepository hasn't opened the repo for it. Returning 404
    // lets appendTrailingSlash redirect it to the canonical `/repo/tree/`.
    if (!disc || !repo) throw notFound("Not found");
    const tail = c.req.path.slice(`/${c.req.param("repo")}/raw/`.length);
    const refNames = repo.references().map((r) => r.name);
    const { ref, path } = splitRefPath(tail, refNames, repo.headRef());

    const bytes = repo.readFileAtRef(ref, path);
    if (bytes === null) throw notFound(`Path not found: ${path}`);
    const contentType =
      mimeForPath(path, c.env.mimeTypes) ??
      (isBinary(bytes) ? "application/octet-stream" : "text/plain; charset=utf-8");
    // Raw blobs are untrusted repo content. `nosniff` stops the browser from
    // re-interpreting them (e.g. a text file as HTML); `sandbox` neutralises
    // script in a directly-navigated SVG/HTML blob. Inline <img> previews are
    // unaffected (SVG loaded via <img> can't script regardless).
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  });

  app.notFound((c) => {
    c.status(404);
    return c.render(<ErrorPage status={404} message="Not found" />);
  });

  app.onError((err, c) => {
    const status = statusForError(err);
    const message = err instanceof Error ? err.message : "Internal error";
    if (status === 500) console.error(err);
    c.status(status as 400 | 404 | 500);
    return c.render(<ErrorPage status={status} message={message} />);
  });

  return app;
}

// Load config once at startup (it now reads a file); a malformed config fails
// fast here rather than per request.
const config = loadConfig();

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: (req: Request) => createApp().fetch(req, config),
};
