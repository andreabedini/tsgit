import { notFound } from "../errors";
import { DiscoveredRepo, scanRepos } from "./scan";

export * from "./facade";
export { openRepository } from "./binding/repository";

export function findRepo(scanPath: string, name: string): DiscoveredRepo {
  // scanRepos() strips a trailing ".git" from directory names (so a
  // `project.git` bare repo is discovered as "project"). Smart-HTTP clients
  // request the on-disk name verbatim (`GET /project.git/info/refs`), so
  // strip it here too rather than requiring browsing and smart-HTTP URLs to
  // disagree about repo naming.
  const wanted = name.replace(/\.git$/, "");
  const repo = scanRepos(scanPath).find((r) => r.name === wanted);
  if (!repo) throw notFound(`Repository not found: ${name}`);
  return repo;
}
  