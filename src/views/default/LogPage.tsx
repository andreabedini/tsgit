import type { Commit, Reference } from "../../git/facade";
import { abbrevChangeId, formatAge, initials } from "../../format";

/** For jj repos the change id is the identity that survives rewrites, so it leads
 *  and the commit oid sits under it; plain git repos show the oid alone. */
function IdCell(props: { commit: Commit }) {
  const { commit } = props;
  if (!commit.changeId) return <span class="cg-hash">{commit.abbrevOid}</span>;
  return (
    <span class="idcell">
      <span class="cg-changeid" title={`change ${commit.changeId}`}>{abbrevChangeId(commit.changeId)}</span>
      <span class="cg-oid-sub" title={`commit ${commit.oid}`}>{commit.abbrevOid}</span>
    </span>
  );
}

function Pager(props: { name: string; ref: string; offset: number; limit: number; hasPrev: boolean; hasNext: boolean }) {
  const base = `/${props.name}/log/?h=${props.ref}`;
  const prevOfs = Math.max(0, props.offset - props.limit);
  const nextOfs = props.offset + props.limit;
  return (
    <nav class="cg-pager">
      {props.hasPrev ? (
        <a class="cg-btn" href={`${base}&ofs=${prevOfs}`}>
          &laquo; newer
        </a>
      ) : null}
      {props.hasNext ? (
        <a class="cg-btn" href={`${base}&ofs=${nextOfs}`}>
          older &raquo;
        </a>
      ) : null}
    </nav>
  );
}

export interface LogProps {
  name: string;
  ref: string;
  commits: Commit[];
  decorations: Map<string, Reference[]>;
  offset: number;
  limit: number;
  hasMore: boolean;
  now: Date;
}

export function LogPage(props: LogProps) {
  const anyChangeIds = props.commits.some((c) => c.changeId);
  return (
    <>
      <title>{`${props.name}: log`}</title>
      <div class="cg-logcard">
        <div class="cg-loghead">
          <span>{anyChangeIds ? "change" : "commit"}</span>
          <span>subject</span>
          <span>author</span>
        </div>
        {props.commits.map((commit) => (
          <a class="cg-logrow" href={`/${encodeURIComponent(props.name)}/commit/${encodeURIComponent(commit.oid)}/`}>
            <IdCell commit={commit} />
            <span class="subjcell">
              <span class="subject">{commit.summary}</span>
              {(props.decorations.get(commit.oid) ?? []).map((d) => (
                <span class={`ref ${d.kind}`}>{d.name}</span>
              ))}
            </span>
            <span class="cg-author">
              <span class="cg-avatar">{initials(commit.author.name)}</span>
              <span class="who">
                <span class="nm">{commit.author.name}</span>
                <span class="ts">{formatAge(commit.author.when, props.now)}</span>
              </span>
            </span>
          </a>
        ))}
      </div>
      <Pager
        name={props.name}
        ref={props.ref}
        offset={props.offset}
        limit={props.limit}
        hasPrev={props.offset > 0}
        hasNext={props.hasMore}
      />
    </>
  );
}
