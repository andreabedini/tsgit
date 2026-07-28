import type { Commit, Reference } from "../../git/facade";
import { abbrevChangeId, abbrevOid, formatAge } from "../../format";

function commitHref(name: string, oid: string): string {
  return `/${encodeURIComponent(name)}/commit/${encodeURIComponent(oid)}/`;
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="6" cy="6" r="3"></circle>
      <circle cx="6" cy="18" r="3"></circle>
      <path d="M6 9v6"></path>
      <path d="M21 6a9 9 0 0 1-9 9"></path>
      <circle cx="18" cy="6" r="3"></circle>
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="var(--brand-gold)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"></path>
      <circle cx="7.5" cy="7.5" r="1.2" fill="var(--brand-gold)"></circle>
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2"></rect>
      <path d="M5 15V5a2 2 0 0 1 2-2h10"></path>
    </svg>
  );
}

/** Ready-to-paste clone commands. jj's own clone is offered as well when the
 *  repo's commits carry change ids, i.e. jj is what's on the other end. */
function CloneBox(props: { url: string; jj?: boolean }) {
  const commands = [`git clone ${props.url}`];
  if (props.jj) commands.push(`jj git clone ${props.url}`);
  return (
    <div>
      <div class="cg-eyebrow cg-rail-label">Clone</div>
      <div class="cg-clone">
        {commands.map((command) => (
          <div class="cg-clone-row">
            <code>{command}</code>
            <button class="cg-copy" type="button" data-copy={command} aria-label={`Copy: ${command}`} title="Copy to clipboard">
              <CopyIcon />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface SummaryProps {
  name: string;
  description?: string;
  /** Base URL this repo can be cloned from; omitted only if unknown. */
  cloneUrl?: string;
  /** True when the repo's history carries jj change ids. */
  jj?: boolean;
  branches: Reference[];
  tags: Reference[];
  recentCommits: Commit[];
  decorations?: Map<string, Reference[]>;
  aboutHtml?: string; // Shiki HTML for README.md, present when the repo has one
  headRef?: string;
  owner?: string;
  now: Date;
}

export function SummaryPage(props: SummaryProps) {
  const decorations = props.decorations ?? new Map<string, Reference[]>();
  return (
    <>
      <title>{props.name}</title>
      <div class="cg-summary">
        <div class="main">
          <div class="cg-section-head">
            <h2>Recent activity</h2>
            <a class="more" href={`/${encodeURIComponent(props.name)}/log/`}>
              view log &rarr;
            </a>
          </div>
          <div class="cg-card cg-rowlist">
            {props.recentCommits.map((commit) => {
              const refs = decorations.get(commit.oid) ?? [];
              return (
                <a class="cg-row" href={commitHref(props.name, commit.oid)}>
                  {commit.changeId ? (
                    <span class="cg-changeid" title={`commit ${commit.oid}`}>{abbrevChangeId(commit.changeId)}</span>
                  ) : (
                    <span class="cg-hash">{commit.abbrevOid}</span>
                  )}
                  <span class="subject">{commit.summary}</span>
                  {refs.map((r) => (
                    <span class={`ref ${r.kind}`}>{r.name}</span>
                  ))}
                  <span class="age">{formatAge(commit.author.when, props.now)}</span>
                </a>
              );
            })}
          </div>

          {props.aboutHtml ? (
            <>
              <h2 class="cg-readme-head">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--text-faint)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                </svg>
                README.md
              </h2>
              <div class="cg-readme" dangerouslySetInnerHTML={{ __html: props.aboutHtml }} />
            </>
          ) : null}
        </div>

        <aside class="cg-rail">
          {props.cloneUrl ? <CloneBox url={props.cloneUrl} jj={props.jj} /> : null}

          {props.branches.length ? (
            <div>
              <div class="cg-eyebrow cg-rail-label">Branches</div>
              <div class="cg-reflist">
                {props.branches.map((b) => (
                  <div class="cg-refrow">
                    <span class="label branch">
                      <BranchIcon />
                      <span class="nm">{b.name}</span>
                      {b.name === props.headRef ? <span class="cg-head-pill">HEAD</span> : null}
                    </span>
                    <a class="cg-hash" href={commitHref(props.name, b.commitOid)}>
                      {abbrevOid(b.commitOid)}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {props.tags.length ? (
            <div>
              <div class="cg-eyebrow cg-rail-label">Tags</div>
              <div class="cg-reflist">
                {props.tags.map((t) => (
                  <div class="cg-refrow">
                    <span class="label tag">
                      <TagIcon />
                      <span class="nm">{t.name}</span>
                    </span>
                    <a class="cg-hash" href={commitHref(props.name, t.commitOid)}>
                      {abbrevOid(t.commitOid)}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {props.owner ? (
            <div class="cg-infocard">
              <dl>
                <div class="cg-inforow">
                  <dt>owner</dt>
                  <dd>{props.owner}</dd>
                </div>
              </dl>
            </div>
          ) : null}
        </aside>
      </div>
    </>
  );
}
