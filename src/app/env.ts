import { createFactory } from 'hono/factory'

import { Commit, CommitDiff, Repository } from "../git";
import { DiscoveredRepo } from "../git/scan";

export type Env = {
  Bindings: {
    TSGIT_SCAN_PATH: string;
    TSGIT_CLONE_URL_BASE?: string;
    TSGIT_SUMMARY_BRANCHES: number;
    TSGIT_SUMMARY_TAGS: number;
    TSGIT_SUMMARY_LOG: number;
    TSGIT_LOG_PAGE_SIZE: number;
    TSGIT_REPOLIST_PAGE_SIZE: number;
    mimeTypes: Record<string, string>;
  };
  Variables: {
    disc: DiscoveredRepo;
    repo: Repository;
    commit: Commit;
    diff: CommitDiff;
  }
};

export const factory = createFactory<Env>();
