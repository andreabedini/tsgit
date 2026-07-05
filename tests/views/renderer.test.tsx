import { test, expect } from "bun:test";
import { Hono, type Handler } from "hono";
import { renderer, repoLayout } from "../../src/views/default/renderer";
import type { Env } from "../../src/app/env";

function appWith(body: Handler) {
  const app = new Hono();
  app.use(renderer);
  app.get("/", body);
  return app;
}

// Mount the nested repo layout with a stub `disc` in context, the way
// useRepository would provide it in the real app.
function repoApp() {
  const app = new Hono<Env>();
  app.use(renderer);
  app.use("/:repo/*", repoLayout);
  app.use("/:repo/*", async (c, next) => {
    c.set("disc", { name: c.req.param("repo")!, path: "" });
    await next();
  });
  app.get("/:repo/", (c) => c.render(<p>x</p>));
  app.get("/:repo/log/", (c) => c.render(<p>x</p>));
  app.get("/:repo/diff/:rev/", (c) => c.render(<p>x</p>));
  return app;
}

test("renderer wraps content in a full HTML document with the stylesheet", async () => {
  const app = appWith((c) => c.render(<p>hello</p>));
  const html = await (await app.request("/")).text();
  expect(html).toContain("<!DOCTYPE html>");
  expect(html).toContain('href="/tsgit.css"');
  expect(html).toContain("<p>hello</p>");
});

test("renderer hoists a page <title> into <head>", async () => {
  const app = appWith((c) =>
    c.render(
      <>
        <title>My Title</title>
        <p>x</p>
      </>,
    ),
  );
  const html = await (await app.request("/")).text();
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).toContain("<title>My Title</title>");
});

test("repo layout nests the tabs inside the root chrome, marking the active tab", async () => {
  const html = await (await repoApp().request("/alpha/log/")).text();
  expect(html).toContain("<!DOCTYPE html>"); // wrapped by the parent layout
  expect(html).toContain('href="/alpha/"');
  expect(html).toContain('href="/alpha/log/"');
  // The log link is the active one on /alpha/log/.
  expect(html).toContain('class="cg-tab active" href="/alpha/log/"');
});

test("repo layout marks summary active on the repo index", async () => {
  const html = await (await repoApp().request("/alpha/")).text();
  expect(html).toContain('class="cg-tab active" href="/alpha/"');
});

test("repo layout keeps summary active on the diff view", async () => {
  const html = await (await repoApp().request("/alpha/diff/main/")).text();
  expect(html).toContain('class="cg-tab active" href="/alpha/"');
});

test("root renderer omits the repo tabs", async () => {
  const app = appWith((c) => c.render(<p>x</p>));
  const html = await (await app.request("/")).text();
  expect(html).not.toContain("cg-tabs");
});
