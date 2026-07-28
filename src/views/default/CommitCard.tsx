import { useRequestContext } from "hono/jsx-renderer";
import { initials, formatAge } from "../../format";
import { treeHref, commitHref } from "./utils";
import { Env } from "../../app/env";

export function CommitCard() {
  const c = useRequestContext<Env>();
  const name = c.get("disc")?.name;

  const commit = c.get("commit");
  const refs = c.get("repo").decorations().get(commit.oid) ?? [];

  const tree = treeHref(name, commit.oid);

  return (
    <>
    <div class="cg-commitcard">
      <h2>{commit.summary}</h2>
      <div class="cg-commit-author">
        <span class="cg-avatar">{initials(commit.author.name)}</span>
        <span class="nm">{commit.author.name}</span>
        <span class="email">&lt;{commit.author.email}&gt;</span>
        <span class="when">authored {formatAge(commit.author.when)}</span>
        {refs.map((ref) => (
          <span class={`ref ${ref.kind}`}>{ref.name}</span>
        ))}
      </div>
      <div class="cg-commit-meta">
        {commit.changeId ? (
          <span>
            change <span class="cg-changeid">{commit.changeId}</span>
          </span>
        ) : null}
        <span>
          commit <span class="cg-hash">{commit.abbrevOid}</span>
        </span>
        {commit.parents.length ? (
          <span>
            parent{" "}
            {commit.parents.map((parent, i) => (
              <>
                {i ? " " : null}
                <a class="cg-hash" href={commitHref(name, parent)}>
                  {parent.slice(0, 10)}
                </a>
              </>
            ))}
          </span>
        ) : null}
        <span>
          tree <a class="cg-hash" href={tree}>browse files</a>
        </span>
      </div>
    </div>
    <pre class="cg-commit-msg">{commit.message}</pre>
    </>
  );
}
