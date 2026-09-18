import type { VirtualFS } from '../../fs/index.js';
import type { GitCache } from '../git-cache.js';
import type { IsoGitFsPromises } from '../vfs-fs-adapter.js';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitExecuteOptions {
  stdoutIsTTY?: boolean;
}

export interface GitCommandsOptions {
  fs: VirtualFS;

  corsProxy?: string;

  ensureFreshGithubToken?: (opts?: { force?: boolean }) => Promise<void>;

  authorName?: string;

  authorEmail?: string;

  globalDbName?: string;

  maxResidentPacks?: number;

  verifyPackfiles?: boolean;
}

export interface GitCommandContext {
  readonly lfs: IsoGitFsPromises;

  readonly fs: VirtualFS;

  readonly cache: GitCache;

  readonly corsProxy?: string;

  getOnAuth(): (() => { username: string; password: string }) | undefined;

  getOnAuthFailure():
    | (() => Promise<{ username: string; password: string } | undefined>)
    | undefined;

  resolveAuthor(cwd: string): Promise<{ name: string; email: string }>;

  getGlobalFs(): Promise<VirtualFS>;

  setGithubToken(token: string): Promise<void>;

  getGithubToken(): string | undefined;

  setDefaultAuthorName(name: string): void;

  setDefaultAuthorEmail(email: string): void;

  getConfigOverrides(): ReadonlyMap<string, string> | undefined;

  readonly stdin: string;

  readonly useColor: boolean;
}
