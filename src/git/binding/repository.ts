import { join } from "node:path";
import type {
  Repository, WritableRepository, Reference, Commit, Signature, LogOptions, LogPage, TreeEntry, CommitDiff, DiffFile, DiffHunk, DiffLine, DiffStatus,
} from "../facade";
import {
  lib, ensureInit, ptrSlot, oidSlot, readPtr, cstr, check, toPtr,
  ptr, read, toArrayBuffer, CString, GitError,
} from "./libgit2";
// (oidSlot/cstr/read/toArrayBuffer/CString/Commit/Signature are used by methods
//  added in Tasks 5-7; importing them now keeps repository.ts stable across tasks.)

const GIT_OBJECT_COMMIT = 1;
const GIT_OBJECT_TREE = 2;
const GIT_OBJECT_BLOB = 3;
const GIT_SORT_TIME = 2;
const GIT_SORT_TOPOLOGICAL = 1;
const GIT_DIFF_FLAG_BINARY = 1 << 0;
const GIT_DELTA_ADDED = 1;
const GIT_DELTA_DELETED = 2;
const GIT_DELTA_MODIFIED = 3;
const GIT_DELTA_RENAMED = 4;
const GIT_DELTA_COPIED = 5;
const GIT_DELTA_TYPECHANGE = 8;
const textDecoder = new TextDecoder();

function readI32At(base: number, offset: number): number {
  const bytes = new Uint8Array(toArrayBuffer(toPtr(base), offset, 4));
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
}

function readU16At(base: number, offset: number): number {
  const bytes = new Uint8Array(toArrayBuffer(toPtr(base), offset, 2));
  return new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, true);
}

function readU32At(base: number, offset: number): number {
  const bytes = new Uint8Array(toArrayBuffer(toPtr(base), offset, 4));
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

function readU64At(base: number, offset: number): number {
  const bytes = new Uint8Array(toArrayBuffer(toPtr(base), offset, 8));
  return Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true));
}

function readByteAt(base: number, offset: number): number {
  return new Uint8Array(toArrayBuffer(toPtr(base), offset, 1))[0] ?? 0;
}

class Repo implements WritableRepository {
  constructor(readonly path: string, private handle: number) {}

  headRef(): string {
    const slot = ptrSlot();
    check(lib.git_repository_head(toPtr(ptr(slot)), toPtr(this.handle)));
    const refPtr = readPtr(slot);
    try {
      // bun:ffi may return a CString (boxed String) for `returns: cstring`;
      // normalize to a primitive JS string.
      return String(lib.git_reference_shorthand(toPtr(refPtr)));
    } finally {
      lib.git_reference_free(toPtr(refPtr));
    }
  }

  isBare(): boolean {
    return lib.git_repository_is_bare(toPtr(this.handle)) === 1;
  }

  updateRef(name: string, oldOidHex: string, newOidHex: string): void {
    const isCreate = oldOidHex === "0".repeat(40);
    const isDelete = newOidHex === "0".repeat(40);
    const current = this.lookupDirectTargetOid(name);
    const expected = isCreate ? null : oldOidHex;
    if (current !== expected) {
      throw new GitError(`ref ${name}: stale info`, -15 /* GIT_EMODIFIED */);
    }

    if (isDelete) {
      check(lib.git_reference_remove(toPtr(this.handle), cstr(name)));
      return;
    }

    const newOidBytes = Buffer.from(newOidHex, "hex");
    const currentIdBytes = current ? Buffer.from(current, "hex") : null;
    const outSlot = ptrSlot();
    check(
      lib.git_reference_create_matching(
        toPtr(ptr(outSlot)),
        toPtr(this.handle),
        cstr(name),
        toPtr(ptr(newOidBytes)),
        1, // force: overwrite is fine, current_id below still enforces the CAS
        currentIdBytes ? toPtr(ptr(currentIdBytes)) : toPtr(0),
        toPtr(0),
      ),
    );
    lib.git_reference_free(toPtr(readPtr(outSlot)));
  }

  // Looks up a ref by exact name and returns its direct target oid (hex), or
  // null if the ref does not exist. Used by updateRef's CAS check.
  private lookupDirectTargetOid(name: string): string | null {
    const slot = ptrSlot();
    const rc = lib.git_reference_lookup(toPtr(ptr(slot)), toPtr(this.handle), cstr(name));
    if (rc === -3 /* GIT_ENOTFOUND */) return null;
    check(rc);
    const refPtr = readPtr(slot);
    try {
      return this.directTargetOid(refPtr);
    } finally {
      lib.git_reference_free(toPtr(refPtr));
    }
  }

  references(): Reference[] {
    const iterSlot = ptrSlot();
    check(lib.git_reference_iterator_new(toPtr(ptr(iterSlot)), toPtr(this.handle)));
    const iter = readPtr(iterSlot);
    const refs: Reference[] = [];
    try {
      const refSlot = ptrSlot();
      while (true) {
        const rc = lib.git_reference_next(toPtr(ptr(refSlot)), toPtr(iter));
        if (rc === -31 /* GIT_ITEROVER */) break;
        check(rc);
        const refPtr = readPtr(refSlot);
        try {
          const fullName = String(lib.git_reference_name(toPtr(refPtr)));
          const isBranch = lib.git_reference_is_branch(toPtr(refPtr)) === 1;
          const isTag = lib.git_reference_is_tag(toPtr(refPtr)) === 1;
          if (!isBranch && !isTag) continue; // skip HEAD, notes, etc.
          const name = fullName.replace(/^refs\/(heads|tags)\//, "");
          const commitOid = this.peelToCommitOid(refPtr);
          const targetOid = this.directTargetOid(refPtr) ?? commitOid;
          refs.push({
            name,
            fullName,
            kind: isBranch ? "branch" : "tag",
            targetOid,
            commitOid,
          });
        } finally {
          lib.git_reference_free(toPtr(refPtr));
        }
      }
    } finally {
      lib.git_reference_iterator_free(toPtr(iter));
    }
    return refs;
  }

  // Group refs by the commit they point at, for decorating log rows.
  decorations(): Map<string, Reference[]> {
    const map = new Map<string, Reference[]>();
    for (const ref of this.references()) {
      const list = map.get(ref.commitOid) ?? [];
      list.push(ref);
      map.set(ref.commitOid, list);
    }
    return map;
  }

  private peelToCommitOid(refPtr: number): string {
    const objSlot = ptrSlot();
    check(lib.git_reference_peel(toPtr(ptr(objSlot)), toPtr(refPtr), GIT_OBJECT_COMMIT));
    const obj = readPtr(objSlot);
    try {
      const oidPtr = Number(lib.git_object_id(toPtr(obj)));
      return String(lib.git_oid_tostr_s(toPtr(oidPtr)));
    } finally {
      lib.git_object_free(toPtr(obj));
    }
  }

  private directTargetOid(refPtr: number): string | null {
    const oidPtr = Number(lib.git_reference_target(toPtr(refPtr)));
    return oidPtr ? String(lib.git_oid_tostr_s(toPtr(oidPtr))) : null;
  }

  log(opts: LogOptions): LogPage {
    const offset = opts.offset ?? 0;
    const limit = opts.limit;
    const walkSlot = ptrSlot();
    check(lib.git_revwalk_new(toPtr(ptr(walkSlot)), toPtr(this.handle)));
    const walk = readPtr(walkSlot);
    try {
      check(lib.git_revwalk_sorting(toPtr(walk), GIT_SORT_TOPOLOGICAL | GIT_SORT_TIME));
      if (opts.ref) {
        this.pushRef(walk, opts.ref);
      } else {
        check(lib.git_revwalk_push_head(toPtr(walk)));
      }
      const commits: Commit[] = [];
      const oid = oidSlot();
      let index = 0;
      let hasMore = false;
      while (true) {
        const rc = lib.git_revwalk_next(toPtr(ptr(oid)), toPtr(walk));
        if (rc === -31 /* GIT_ITEROVER */) break;
        check(rc);
        if (index < offset) { index++; continue; }
        if (commits.length >= limit) { hasMore = true; break; }
        commits.push(this.readCommit(oid));
        index++;
      }
      return { commits, hasMore };
    } finally {
      lib.git_revwalk_free(toPtr(walk));
    }
  }

  commit(rev: string): Commit | null {
    const objSlot = ptrSlot();
    const rc = lib.git_revparse_single(toPtr(ptr(objSlot)), toPtr(this.handle), cstr(rev));
    if (rc === -3 /* GIT_ENOTFOUND */) return null;
    check(rc);
    const obj = readPtr(objSlot);
    try {
      const commitSlot = ptrSlot();
      check(lib.git_object_peel(toPtr(ptr(commitSlot)), toPtr(obj), GIT_OBJECT_COMMIT));
      const commitObj = readPtr(commitSlot);
      try {
        const oidPtr = Number(lib.git_object_id(toPtr(commitObj)));
        return this.readCommitHex(String(lib.git_oid_tostr_s(toPtr(oidPtr))));
      } finally {
        lib.git_object_free(toPtr(commitObj));
      }
    } finally {
      lib.git_object_free(toPtr(obj));
    }
  }

  diff(rev: string): CommitDiff | null {
    const objSlot = ptrSlot();
    const rc = lib.git_revparse_single(toPtr(ptr(objSlot)), toPtr(this.handle), cstr(rev));
    if (rc === -3 /* GIT_ENOTFOUND */) return null;
    check(rc);
    const obj = readPtr(objSlot);
    try {
      const commitSlot = ptrSlot();
      check(lib.git_object_peel(toPtr(ptr(commitSlot)), toPtr(obj), GIT_OBJECT_COMMIT));
      const commitObj = readPtr(commitSlot);
      try {
        const newTree = this.lookupCommitTree(commitObj);
        let oldTree = 0;
        try {
          if (lib.git_commit_parentcount(toPtr(commitObj)) > 0) {
            const parentSlot = ptrSlot();
            check(lib.git_commit_parent(toPtr(ptr(parentSlot)), toPtr(commitObj), 0));
            const parent = readPtr(parentSlot);
            try {
              oldTree = this.lookupCommitTree(parent);
            } finally {
              lib.git_commit_free(toPtr(parent));
            }
          }
          const diffSlot = ptrSlot();
          check(
            lib.git_diff_tree_to_tree(
              toPtr(ptr(diffSlot)),
              toPtr(this.handle),
              toPtr(oldTree),
              toPtr(newTree),
              toPtr(0),
            ),
          );
          const diff = readPtr(diffSlot);
          try {
            return { files: this.readDiffFiles(diff) };
          } finally {
            lib.git_diff_free(toPtr(diff));
          }
        } finally {
          if (oldTree) lib.git_tree_free(toPtr(oldTree));
          lib.git_tree_free(toPtr(newTree));
        }
      } finally {
        lib.git_object_free(toPtr(commitObj));
      }
    } finally {
      lib.git_object_free(toPtr(obj));
    }
  }

  // Resolve a ref spec (branch/tag shorthand, full ref name, or oid) to a commit
  // and push it onto the walk. revparse + peel handles annotated tags correctly
  // (peeling the tag object down to its commit).
  private pushRef(walk: number, ref: string): void {
    const objSlot = ptrSlot();
    check(lib.git_revparse_single(toPtr(ptr(objSlot)), toPtr(this.handle), cstr(ref)));
    const obj = readPtr(objSlot);
    try {
      const commitSlot = ptrSlot();
      check(lib.git_object_peel(toPtr(ptr(commitSlot)), toPtr(obj), GIT_OBJECT_COMMIT));
      const commitObj = readPtr(commitSlot);
      try {
        const oidPtr = Number(lib.git_object_id(toPtr(commitObj)));
        check(lib.git_revwalk_push(toPtr(walk), toPtr(oidPtr)));
      } finally {
        lib.git_object_free(toPtr(commitObj));
      }
    } finally {
      lib.git_object_free(toPtr(obj));
    }
  }

  private readCommit(oidBytes: Uint8Array): Commit {
    const slot = ptrSlot();
    check(lib.git_commit_lookup(toPtr(ptr(slot)), toPtr(this.handle), toPtr(ptr(oidBytes))));
    const commit = readPtr(slot);
    try {
      const oid = Buffer.from(oidBytes).toString("hex");
      const summary = String(lib.git_commit_summary(toPtr(commit)));
      const message = String(lib.git_commit_message(toPtr(commit)));
      const author = this.readSignature(Number(lib.git_commit_author(toPtr(commit))));
      const committer = this.readSignature(Number(lib.git_commit_committer(toPtr(commit))));
      const parents: string[] = [];
      const pc = lib.git_commit_parentcount(toPtr(commit));
      for (let i = 0; i < pc; i++) {
        const pid = Number(lib.git_commit_parent_id(toPtr(commit), i));
        parents.push(String(lib.git_oid_tostr_s(toPtr(pid))));
      }
      return { oid, abbrevOid: oid.slice(0, 10), author, committer, summary, message, parents };
    } finally {
      lib.git_commit_free(toPtr(commit));
    }
  }

  private readCommitHex(oid: string): Commit {
    return this.readCommit(Buffer.from(oid, "hex"));
  }

  private lookupCommitTree(commit: number): number {
    const slot = ptrSlot();
    check(lib.git_commit_tree(toPtr(ptr(slot)), toPtr(commit)));
    return readPtr(slot);
  }

  // git_commit_author/committer return a `const git_signature *` with layout
  // { char *name; char *email; git_time { git_time_t time(i64); int offset; char sign; } }.
  // Read name at offset 0, email at offset 8, time (seconds since epoch) at offset 16.
  private readSignature(sigPtr: number): Signature {
    const namePtr = Number(read.ptr(toPtr(sigPtr), 0));
    const emailPtr = Number(read.ptr(toPtr(sigPtr), 8));
    const timeSecs = read.i64(toPtr(sigPtr), 16);
    return {
      name: namePtr ? new CString(toPtr(namePtr)).toString() : "",
      email: emailPtr ? new CString(toPtr(emailPtr)).toString() : "",
      when: new Date(Number(timeSecs) * 1000),
    };
  }

  private readDiffFiles(diff: number): DiffFile[] {
    const files: DiffFile[] = [];
    const count = Number(lib.git_diff_num_deltas(toPtr(diff)));
    for (let i = 0; i < count; i++) {
      const patchSlot = ptrSlot();
      check(lib.git_patch_from_diff(toPtr(ptr(patchSlot)), toPtr(diff), i));
      const patch = readPtr(patchSlot);
      try {
        const deltaPtr = patch
          ? Number(lib.git_patch_get_delta(toPtr(patch)))
          : Number(lib.git_diff_get_delta(toPtr(diff), i));
        if (!deltaPtr) continue;
        const delta = this.readDiffDelta(deltaPtr);
        files.push({
          ...delta,
          hunks: patch ? this.readDiffHunks(patch) : [],
        });
      } finally {
        if (patch) lib.git_patch_free(toPtr(patch));
      }
    }
    return files;
  }

  private readDiffDelta(deltaPtr: number): Omit<DiffFile, "hunks"> {
    const status = this.readDiffStatus(readI32At(deltaPtr, 0));
    const flags = readU32At(deltaPtr, 4);
    const oldFile = this.readDiffSide(deltaPtr + 16);
    const newFile = this.readDiffSide(deltaPtr + 64);
    return {
      status,
      oldPath: oldFile.path,
      newPath: newFile.path,
      binary: Boolean((flags | oldFile.flags | newFile.flags) & GIT_DIFF_FLAG_BINARY),
    };
  }

  private readDiffSide(sidePtr: number): { path: string | null; flags: number; mode: number } {
    const pathPtr = Number(read.ptr(toPtr(sidePtr), 24));
    return {
      path: pathPtr ? new CString(toPtr(pathPtr)).toString() : null,
      flags: readU32At(sidePtr, 40),
      mode: readU16At(sidePtr, 44),
    };
  }

  private readDiffStatus(status: number): DiffStatus {
    switch (status) {
      case GIT_DELTA_ADDED:
        return "added";
      case GIT_DELTA_DELETED:
        return "deleted";
      case GIT_DELTA_MODIFIED:
        return "modified";
      case GIT_DELTA_RENAMED:
        return "renamed";
      case GIT_DELTA_COPIED:
        return "copied";
      case GIT_DELTA_TYPECHANGE:
        return "typechange";
      default:
        return "modified";
    }
  }

  private readDiffHunks(patch: number): DiffHunk[] {
    const hunks: DiffHunk[] = [];
    const count = Number(lib.git_patch_num_hunks(toPtr(patch)));
    for (let hunkIndex = 0; hunkIndex < count; hunkIndex++) {
      const hunkSlot = ptrSlot();
      const linesSlot = ptrSlot();
      check(lib.git_patch_get_hunk(toPtr(ptr(hunkSlot)), toPtr(ptr(linesSlot)), toPtr(patch), hunkIndex));
      const hunkPtr = readPtr(hunkSlot);
      if (!hunkPtr) continue;
      const lineCount = readU64At(ptr(linesSlot), 0);
      const header = textDecoder.decode(new Uint8Array(toArrayBuffer(toPtr(hunkPtr), 24, readU64At(hunkPtr, 16)))).replace(/\n$/, "");
      const lines: DiffLine[] = [];
      for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
        const lineSlot = ptrSlot();
        check(lib.git_patch_get_line_in_hunk(toPtr(ptr(lineSlot)), toPtr(patch), hunkIndex, lineIndex));
        const linePtr = readPtr(lineSlot);
        if (!linePtr) continue;
        const origin = String.fromCharCode(readByteAt(linePtr, 0));
        const contentLen = readU64At(linePtr, 16);
        const contentPtr = Number(read.ptr(toPtr(linePtr), 32));
        const content =
          contentPtr && contentLen
            ? textDecoder.decode(new Uint8Array(toArrayBuffer(toPtr(contentPtr), 0, contentLen))).replace(/\n$/, "")
            : "";
        lines.push({
          type: this.readDiffLineType(origin),
          oldLineNo: readI32At(linePtr, 4) >= 0 ? readI32At(linePtr, 4) : null,
          newLineNo: readI32At(linePtr, 8) >= 0 ? readI32At(linePtr, 8) : null,
          content,
        });
      }
      hunks.push({
        header,
        oldStart: readI32At(hunkPtr, 0),
        oldLines: readI32At(hunkPtr, 4),
        newStart: readI32At(hunkPtr, 8),
        newLines: readI32At(hunkPtr, 12),
        lines,
      });
    }
    return hunks;
  }

  private readDiffLineType(origin: string): DiffLine["type"] {
    if (origin === "+" || origin === ">") return "add";
    if (origin === "-" || origin === "<") return "delete";
    return "context";
  }

  readFileAtRef(ref: string, path: string): Uint8Array | null {
    const spec = `${ref}:${path}`;
    const slot = ptrSlot();
    const rc = lib.git_revparse_single(toPtr(ptr(slot)), toPtr(this.handle), cstr(spec));
    if (rc === -3 /* GIT_ENOTFOUND */) return null;
    check(rc);
    const obj = readPtr(slot);
    try {
      if (lib.git_object_type(toPtr(obj)) !== GIT_OBJECT_BLOB) return null;
      const size = Number(lib.git_blob_rawsize(toPtr(obj)));
      const dataPtr = Number(lib.git_blob_rawcontent(toPtr(obj)));
      // Copy the bytes out of libgit2-owned memory before freeing the object.
      return new Uint8Array(toArrayBuffer(toPtr(dataPtr), 0, size)).slice();
    } finally {
      lib.git_object_free(toPtr(obj));
    }
  }

  tree(ref: string, path: string): TreeEntry[] | null {
    const spec = path ? `${ref}:${path}` : `${ref}:`;
    const slot = ptrSlot();
    const rc = lib.git_revparse_single(toPtr(ptr(slot)), toPtr(this.handle), cstr(spec));
    if (rc === -3 /* GIT_ENOTFOUND */) return null;
    check(rc);
    const obj = readPtr(slot);
    try {
      if (lib.git_object_type(toPtr(obj)) !== GIT_OBJECT_TREE) return null;
      const count = Number(lib.git_tree_entrycount(toPtr(obj)));
      const entries: TreeEntry[] = [];
      for (let i = 0; i < count; i++) {
        const entry = Number(lib.git_tree_entry_byindex(toPtr(obj), i));
        if (!entry) continue; // defensive: byindex returns null only for an out-of-range index
        const name = String(lib.git_tree_entry_name(toPtr(entry)));
        const mode = lib.git_tree_entry_filemode(toPtr(entry));
        const otype = lib.git_tree_entry_type(toPtr(entry));
        const type = otype === GIT_OBJECT_TREE ? "tree" : otype === GIT_OBJECT_COMMIT ? "commit" : "blob";
        const oidPtr = Number(lib.git_tree_entry_id(toPtr(entry)));
        const oid = String(lib.git_oid_tostr_s(toPtr(oidPtr)));
        const size = type === "blob" ? this.blobSize(entry) : undefined;
        entries.push({ name, mode, type, oid, size });
      }
      return entries;
    } finally {
      lib.git_object_free(toPtr(obj));
    }
  }

  // Load the blob behind a tree entry just to read its size. The entry pointer is
  // owned by the tree (no free); the looked-up object is freed here.
  private blobSize(entry: number): number {
    const slot = ptrSlot();
    check(lib.git_tree_entry_to_object(toPtr(ptr(slot)), toPtr(this.handle), toPtr(entry)));
    const obj = readPtr(slot);
    try {
      return Number(lib.git_blob_rawsize(toPtr(obj)));
    } finally {
      lib.git_object_free(toPtr(obj));
    }
  }

  // `git_indexer_progress` is a required (non-nullable) out-param struct:
  // 6x uint32 + a size_t, with no padding on 64-bit (24 bytes align to 8
  // already) -> 32 bytes total. We don't read it back (no progress reporting).
  indexPack(data: Uint8Array): void {
    const odbSlot = ptrSlot();
    check(lib.git_repository_odb(toPtr(ptr(odbSlot)), toPtr(this.handle)));
    const odb = readPtr(odbSlot);
    try {
      const idxSlot = ptrSlot();
      const packDir = join(this.path, "objects", "pack");
      check(lib.git_indexer_new(toPtr(ptr(idxSlot)), cstr(packDir), 0, toPtr(odb), toPtr(0)));
      const idx = readPtr(idxSlot);
      try {
        const stats = new Uint8Array(32);
        check(lib.git_indexer_append(toPtr(idx), toPtr(ptr(data)), data.length, toPtr(ptr(stats))));
        check(lib.git_indexer_commit(toPtr(idx), toPtr(ptr(stats))));
      } finally {
        lib.git_indexer_free(toPtr(idx));
      }
    } finally {
      lib.git_odb_free(toPtr(odb));
    }
  }

  packObjects(wants: string[], haves: string[]): Uint8Array {
    const walkSlot = ptrSlot();
    check(lib.git_revwalk_new(toPtr(ptr(walkSlot)), toPtr(this.handle)));
    const walk = readPtr(walkSlot);
    try {
      const pbSlot = ptrSlot();
      check(lib.git_packbuilder_new(toPtr(ptr(pbSlot)), toPtr(this.handle)));
      const pb = readPtr(pbSlot);
      try {
        for (const want of wants) {
          const wantBytes = Buffer.from(want, "hex");
          // A "want" is not always a commit -- e.g. an annotated tag oid,
          // which git_revwalk only follows through commit-parent links and
          // therefore never visits. Non-commit wants must be inserted into
          // the packbuilder directly (so the object itself is sent), then
          // peeled to the commit they (transitively) point at so that
          // commit's ancestry still gets walked.
          const objSlot = ptrSlot();
          check(lib.git_revparse_single(toPtr(ptr(objSlot)), toPtr(this.handle), cstr(want)));
          const obj = readPtr(objSlot);
          try {
            if (lib.git_object_type(toPtr(obj)) === GIT_OBJECT_COMMIT) {
              check(lib.git_revwalk_push(toPtr(walk), toPtr(ptr(wantBytes))));
            } else {
              check(lib.git_packbuilder_insert(toPtr(pb), toPtr(ptr(wantBytes)), toPtr(0)));
              const commitSlot = ptrSlot();
              const peelRc = lib.git_object_peel(toPtr(ptr(commitSlot)), toPtr(obj), GIT_OBJECT_COMMIT);
              if (peelRc === 0) {
                const commitObj = readPtr(commitSlot);
                try {
                  const oidPtr = Number(lib.git_object_id(toPtr(commitObj)));
                  check(lib.git_revwalk_push(toPtr(walk), toPtr(oidPtr)));
                } finally {
                  lib.git_object_free(toPtr(commitObj));
                }
              }
              // else: want peels to a tree/blob (no commit ancestry) -- the
              // direct insert above already covers it.
            }
          } finally {
            lib.git_object_free(toPtr(obj));
          }
        }
        for (const have of haves) {
          try {
            check(lib.git_revwalk_hide(toPtr(walk), toPtr(ptr(Buffer.from(have, "hex")))));
          } catch {
            // Client-declared "have" not present in our history (e.g. an
            // unrelated fork) -- fine to ignore for negotiation purposes.
          }
        }

        check(lib.git_packbuilder_insert_walk(toPtr(pb), toPtr(walk)));

        const gitBuf = new Uint8Array(24); // { ptr: void*, reserved: size_t, size: size_t }
        check(lib.git_packbuilder_write_buf(toPtr(ptr(gitBuf)), toPtr(pb)));
        try {
          const dataPtr = Number(read.ptr(toPtr(ptr(gitBuf)), 0));
          const size = readU64At(ptr(gitBuf), 16);
          return new Uint8Array(toArrayBuffer(toPtr(dataPtr), 0, size)).slice();
        } finally {
          lib.git_buf_dispose(toPtr(ptr(gitBuf)));
        }
      } finally {
        lib.git_packbuilder_free(toPtr(pb));
      }
    } finally {
      lib.git_revwalk_free(toPtr(walk));
    }
  }

  free(): void {
    if (this.handle) { // 0 = already freed (libgit2 uses 0 as the null-pointer sentinel)
      lib.git_repository_free(toPtr(this.handle));
      this.handle = 0;
    }
  }
}

export function openRepository(path: string): WritableRepository {
  ensureInit();
  const slot = ptrSlot();
  check(lib.git_repository_open(toPtr(ptr(slot)), cstr(path)));
  return new Repo(path, readPtr(slot));
}
