/**
 * Shared types for the per-subcommand git command modules.
 *
 * `GitCommands` (git-commands.ts) owns the constructor, shared state, and the
 * `execute()` dispatch. Each subcommand module is a plain function that
 * receives a {@link GitCommandContext} instead of `this`, so the per-invocation
 * state (`githubToken`, config overrides, author defaults) stays owned by the
 * class while the implementations live in focused modules.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { GitCache } from '../git-cache.js';
import type { IsoGitFsPromises } from '../vfs-fs-adapter.js';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCommandsOptions {
  fs: VirtualFS;
  /** CORS proxy URL for remote operations. */
  corsProxy?: string;
  /** Best-effort GitHub token freshness check before network operations. */
  ensureFreshGithubToken?: () => Promise<void>;
  /** Default author name. */
  authorName?: string;
  /** Default author email. */
  authorEmail?: string;
  /** Global VirtualFS database name for shared git config values. */
  globalDbName?: string;
  /**
   * Max packfile buffers kept resident across commands (issue #2710).
   * Defaults to `DEFAULT_MAX_RESIDENT_PACKS`.
   */
  maxResidentPacks?: number;
  /**
   * Run isomorphic-git's deep (full payload) SHA-1 verification on every
   * packfile read. Off by default — see `git-cache.ts`. `$SLICC_GIT_VERIFY_PACKS`
   * turns it back on for a single shell.
   */
  verifyPackfiles?: boolean;
}

/**
 * Per-invocation surface handed to each subcommand module. Backed by the owning
 * `GitCommands` instance: the getters read live class state (mutations to the
 * GitHub token / author defaults made inside `config` are reflected on the
 * class), and the filesystem / auth helpers forward to the class methods.
 */
export interface GitCommandContext {
  /** isomorphic-git filesystem adapter (VirtualFS-backed). */
  readonly lfs: IsoGitFsPromises;
  /** The raw VirtualFS instance, for direct workdir reads/writes. */
  readonly fs: VirtualFS;
  /**
   * The instance-wide isomorphic-git object/pack cache (issue #2710). Pass it
   * as `cache:` to EVERY isomorphic-git call that accepts one — a call that
   * omits it re-reads and re-parses the repository's packfiles from scratch.
   */
  readonly cache: GitCache;
  /** CORS proxy URL for remote operations. */
  readonly corsProxy?: string;
  /** onAuth callback for isomorphic-git network operations (or undefined). */
  getOnAuth(): (() => { username: string; password: string }) | undefined;
  /** Resolve the git author identity for an operation. */
  resolveAuthor(cwd: string): Promise<{ name: string; email: string }>;
  /** The shared Global VirtualFS instance for config persistence. */
  getGlobalFs(): Promise<VirtualFS>;
  /** Persist (or clear, when empty) the GitHub token to the global VFS. */
  setGithubToken(token: string): Promise<void>;
  /** The currently loaded GitHub token, if any. */
  getGithubToken(): string | undefined;
  /** Update the in-memory default author name (from `git config user.name`). */
  setDefaultAuthorName(name: string): void;
  /** Update the in-memory default author email (from `git config user.email`). */
  setDefaultAuthorEmail(email: string): void;
  /** Per-invocation `-c key=val` overrides, or undefined. */
  getConfigOverrides(): ReadonlyMap<string, string> | undefined;
}
