export interface Signature {
  name: string;
  email: string;
  when: Date;
}

export interface Commit {
  oid: string;
  abbrevOid: string;
  author: Signature;
  committer: Signature;
  summary: string;
  message: string;
  parents: string[];
  /** jj change id from the commit's `change-id` header; null for plain git commits. */
  changeId: string | null;
}

export type DiffStatus = "added" | "deleted" | "modified" | "renamed" | "copied" | "typechange";

export interface DiffLine {
  type: "context" | "add" | "delete";
  oldLineNo: number | null;
  newLineNo: number | null;
  content: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffFile {
  status: DiffStatus;
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

export interface CommitDiff {
  files: DiffFile[];
}

export type RefKind = "branch" | "tag";

export interface Reference {
  name: string;       // shorthand, e.g. "main", "v1.0"
  fullName: string;   // e.g. "refs/heads/main"
  kind: RefKind;
  targetOid: string;  // oid the ref points at directly
  commitOid: string;  // peeled commit oid (annotated tag -> its commit)
}

export interface TreeEntry {
  name: string;
  mode: number;                       // raw git filemode (octal when displayed)
  type: "blob" | "tree" | "commit";   // "commit" == submodule gitlink
  oid: string;
  size?: number;                      // present for blobs
}

export interface LogOptions {
  ref?: string;       // shorthand or full ref; defaults to HEAD
  offset?: number;
  limit: number;
}

export interface LogPage {
  commits: Commit[];
  hasMore: boolean;   // true if more commits exist past offset+limit
}

export interface Repository {
  readonly path: string;
  headRef(): string;
  references(): Reference[];
  /** Groups references by the commit they point at, for decorating log rows. */
  decorations(): Map<string, Reference[]>;
  log(opts: LogOptions): LogPage;
  /** Resolves a revision (ref, oid, or jj change id) to a single commit, or null if missing. */
  commit(rev: string): Commit | null;
  /** Finds the commit whose jj change id starts with `prefix`. Null if none (or if
   *  the search hit its scan cap without a match). Newest-first, so when a change
   *  has several git commits (jj rewrote it) the latest one wins. */
  commitByChangeId(prefix: string): Commit | null;
  /** Diffs a commit against its first parent, or the empty tree for root commits. */
  diff(rev: string): CommitDiff | null;
  /** Returns null if the path (or ref) was not found in the tree. */
  readFileAtRef(ref: string, path: string): Uint8Array | null;
  /** Lists a tree at `ref`/`path`. Returns null if the path is not a tree
   *  (e.g. it is a blob) or does not exist. `path` "" means the root tree. */
  tree(ref: string, path: string): TreeEntry[] | null;
  free(): void;
}

// Write primitives used only by the smart-HTTP module (src/git/smart-http/).
// Kept off `Repository` so the read-only facade the HTML views depend on stays
// untouched; `openRepository` returns this wider type, so `Repository`-typed
// call sites are unaffected (structural subtyping) while smart-http code can
// use the extra methods.
export interface WritableRepository extends Repository {
  /** True for bare repositories (no checked-out working tree) — push targets must be bare. */
  isBare(): boolean;
  /**
   * Atomically create (`oldOidHex` all zeros), update, or delete
   * (`newOidHex` all zeros) a ref. Throws `GitError` if the ref's current
   * value does not match `oldOidHex`.
   */
  updateRef(name: string, oldOidHex: string, newOidHex: string): void;
  /** Writes a raw packfile's objects into this repo's object database. */
  indexPack(data: Uint8Array): void;
  /** Builds a packfile containing everything reachable from `wants` that isn't reachable from `haves`. */
  packObjects(wants: string[], haves: string[]): Uint8Array;
}
