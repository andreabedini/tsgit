import type { DiscoveredRepo } from "../../git/scan";
import { formatAge } from "../../format";

export interface RepoListEntry {
  repo: DiscoveredRepo;
  lastCommit?: Date;
}

export function RepolistPage(props: { entries: RepoListEntry[]; now: Date; host?: string; query?: string }) {
  const n = props.entries.length;
  return (
    <>
      <title>Repositories</title>
      <div class="cg-index-head">
        <div>
          <h1>Repositories</h1>
        </div>
        <span class="cg-index-meta">
          <span data-repo-count>
            {n} {n === 1 ? "repo" : "repos"}
          </span>
          {props.host ? ` · ${props.host}` : ""}
        </span>
      </div>
      {n === 0 ? (
        <p class="cg-empty">
          {props.query ? `No repositories match “${props.query}”.` : "No repositories found."}
        </p>
      ) : (
        <>
          <p class="cg-empty" data-search-empty style="display:none">
            No repositories match your search.
          </p>
          <div class="cg-repogrid" data-search-grid>
            {props.entries.map(({ repo, lastCommit }) => (
              <a class="cg-repocard" href={`/${repo.name}/`}>
                <span class="name">{repo.name}</span>
                {repo.description ? <p class="desc">{repo.description}</p> : <p class="desc">&nbsp;</p>}
                <div class="meta">
                  {lastCommit ? <span>updated {formatAge(lastCommit, props.now)}</span> : <span>no commits yet</span>}
                  {repo.owner ? (
                    <>
                      <span>&#8226;</span>
                      <span>{repo.owner}</span>
                    </>
                  ) : null}
                </div>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}
