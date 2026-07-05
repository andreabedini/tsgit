import { createFactory } from 'hono/factory'

import { Commit, CommitDiff, WritableRepository } from "../git";
import { DiscoveredRepo } from "../git/scan";
import type { HtpasswdEntry } from "../config/htpasswd";

export type Env = {
  Bindings: {
    TSGIT_SCAN_PATH: string;
    TSGIT_CLONE_URL_BASE?: string;
    TSGIT_SUMMARY_BRANCHES: number;
    TSGIT_SUMMARY_TAGS: number;
    TSGIT_SUMMARY_LOG: number;
    TSGIT_LOG_PAGE_SIZE: number;
    TSGIT_REPOLIST_PAGE_SIZE: number;
    TSGIT_HTPASSWD_FILE?: string;
    mimeTypes: Record<string, string>;
    pushCredentials: HtpasswdEntry[];
  };
  Variables: {
    disc: DiscoveredRepo;
    repo: WritableRepository;
    commit: Commit;
    diff: CommitDiff;
  }
};

export const factory = createFactory<Env>();
