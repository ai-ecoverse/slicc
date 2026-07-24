/**
 * Git commands implementation for the virtual shell.
 *
 * Wraps isomorphic-git functions to provide a CLI-like interface
 * for git operations within the browser environment.
 *
 * This file owns the constructor, shared per-invocation state
 * (`githubToken`, config overrides, author defaults), the auth/token/author
 * resolution helpers, and the `execute()` dispatch. Each subcommand's
 * implementation lives in a focused module under `./commands/` and receives a
 * {@link GitCommandContext} instead of `this`.
 */

// Buffer polyfill must be imported before isomorphic-git
import '../shims/buffer-polyfill.js';

import * as git from 'isomorphic-git';
import { createLogger } from '../core/logger.js';
import { GLOBAL_FS_DB_NAME } from '../fs/global-db.js';
import { VirtualFS } from '../fs/index.js';
import { type ArgSpec, parseArgs } from '../shell/arg-parser.js';
import { add } from './commands/add.js';
import { branch } from './commands/branch.js';
import { checkout } from './commands/checkout.js';
import { cherryPick } from './commands/cherry-pick.js';
import { clone } from './commands/clone.js';
import { commit } from './commands/commit.js';
import { config } from './commands/config.js';
import { diff } from './commands/diff.js';
import { fetch } from './commands/fetch.js';
import { init } from './commands/init.js';
import { log } from './commands/log.js';
import { lsFiles } from './commands/ls-files.js';
import { merge } from './commands/merge.js';
import { mergeFile } from './commands/merge-file.js';
import { mv } from './commands/mv.js';
import { pull } from './commands/pull.js';
import { push } from './commands/push.js';
import { rebase } from './commands/rebase.js';
import { remote } from './commands/remote.js';
import { reset } from './commands/reset.js';
import { revParse } from './commands/rev-parse.js';
import { revert } from './commands/revert.js';
import { rm } from './commands/rm.js';
import { expandGitError, GIT_FLAG_SPECS } from './commands/shared.js';
import { show } from './commands/show.js';
import { showRef } from './commands/show-ref.js';
import { stash } from './commands/stash.js';
import { status } from './commands/status.js';
import { symbolicRef } from './commands/symbolic-ref.js';
import { tag } from './commands/tag.js';
import type { GitCommandContext, GitCommandResult, GitCommandsOptions } from './commands/types.js';
import { readGlobalGitConfigValue } from './git-config.js';
import { createIsomorphicGitFs, type IsoGitFsPromises } from './vfs-fs-adapter.js';

export type { GitCommandResult, GitCommandsOptions } from './commands/types.js';

const logger = createLogger('git-commands');
const NETWORK_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

/**
 * Leading global flags accepted BEFORE the subcommand (`git -c k=v commit …`).
 * `stopEarly` makes the parser collect only the leading flags and leave the
 * subcommand + its own flags untouched in `positionals`. `c` / `C` /
 * `git-dir` / `work-tree` are value-taking; the rest are recognized no-ops so
 * they don't consume the subcommand token. `-h` aliases `--help`.
 */
const GLOBAL_SPEC: ArgSpec = {
  string: ['c', 'C', 'git-dir', 'work-tree'],
  boolean: ['help', 'version', 'no-pager', 'paginate', 'no-replace-objects'],
  alias: { h: 'help' },
  stopEarly: true,
};

/** Coerce an mri flag value (string | string[] | undefined) to a string[]. */
function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

/** Read an env var from either a Map (shell ctx.env) or a plain Record. */
function readEnvVar(
  env: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  name: string
): string | undefined {
  if (env instanceof Map) {
    const v = env.get(name);
    return v && v.length > 0 ? v : undefined;
  }
  const v = (env as Record<string, string>)[name];
  return v && v.length > 0 ? v : undefined;
}

/**
 * Git commands handler that provides CLI-like git functionality.
 * Uses the shared VirtualFS instance (backed by LightningFS).
 */
export class GitCommands {
  private static globalFsByDbName: Map<string, Promise<VirtualFS>> = new Map();

  private lfs: IsoGitFsPromises;
  private corsProxy?: string;
  private authorName: string;
  private authorEmail: string;
  private globalDbName: string;
  /** GitHub token for authentication (avoids rate limits on public repos, required for private). */
  private githubToken?: string;
  /**
   * Shell env vars threaded in from the current `execute()` call. Used as an
   * ambient fallback by `resolveAuthToken()` when no explicit `github.token`
   * file is set. Cleared at the end of every `execute()` invocation so a
   * subsequent call without env doesn't accidentally inherit it.
   */
  private currentEnv?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /**
   * Per-invocation config overrides parsed from leading `-c key=val` flags.
   * Honored for the allowlist below; unknown keys remain accepted no-ops.
   * Cleared at the end of every `execute()` invocation so overrides do not
   * leak across calls.
   */
  private currentConfigOverrides?: ReadonlyMap<string, string>;

  /** Shared surface handed to each subcommand module (see GitCommandContext). */
  private readonly ctx: GitCommandContext;

  constructor(private options: GitCommandsOptions) {
    // Route through a VirtualFS-backed adapter so isomorphic-git sees mount
    // points (File System Access API) the same way shell/agent tools do.
    // See packages/webapp/src/git/vfs-fs-adapter.ts.
    this.lfs = createIsomorphicGitFs(options.fs).promises;
    this.corsProxy = options.corsProxy;
    this.authorName = options.authorName ?? 'User';
    this.authorEmail = options.authorEmail ?? 'user@example.com';
    this.globalDbName = options.globalDbName ?? GLOBAL_FS_DB_NAME;

    this.ctx = {
      lfs: this.lfs,
      fs: this.options.fs,
      corsProxy: this.corsProxy,
      getOnAuth: () => this.getOnAuth(),
      resolveAuthor: (cwd) => this.resolveAuthor(cwd),
      getGlobalFs: () => this.getGlobalFs(),
      setGithubToken: (token) => this.setGithubToken(token),
      getGithubToken: () => this.githubToken,
      setDefaultAuthorName: (name) => {
        this.authorName = name;
      },
      setDefaultAuthorEmail: (email) => {
        this.authorEmail = email;
      },
      getConfigOverrides: () => this.currentConfigOverrides,
    };
  }

  /**
   * Get onAuth callback for isomorphic-git operations.
   * Returns credentials if a GitHub token is configured (via file or env).
   */
  private getOnAuth(): (() => { username: string; password: string }) | undefined {
    const token = this.resolveAuthToken();
    if (!token) return undefined;
    return () => ({
      username: 'x-access-token',
      password: token,
    });
  }

  /**
   * Resolve the effective GitHub auth token, in priority order:
   *   1. `git config github.token` (the `/workspace/.git/github-token` file,
   *      loaded into `this.githubToken` at the start of every `execute()`)
   *   2. `$GH_TOKEN` from the shell env (matches the `gh` CLI convention)
   *   3. `$GITHUB_TOKEN` from the shell env
   * Returns undefined when none is set.
   */
  private resolveAuthToken(): string | undefined {
    if (this.githubToken) return this.githubToken;
    const env = this.currentEnv;
    if (!env) return undefined;
    const gh = readEnvVar(env, 'GH_TOKEN');
    if (gh) return gh;
    const gt = readEnvVar(env, 'GITHUB_TOKEN');
    if (gt) return gt;
    return undefined;
  }

  /** Get or create the shared Global VirtualFS instance for config persistence. */
  private getGlobalFs(): Promise<VirtualFS> {
    const existing = GitCommands.globalFsByDbName.get(this.globalDbName);
    if (existing) return existing;
    const created = VirtualFS.create({ dbName: this.globalDbName });
    GitCommands.globalFsByDbName.set(this.globalDbName, created);
    return created;
  }

  /**
   * Load the GitHub token from the global VFS. Re-reads on every call: the
   * file is the source of truth and may be updated by other writers (notably
   * the GitHub OAuth provider after login) without going through this
   * instance, so we cannot cache absence or presence.
   */
  private async loadGithubToken(): Promise<void> {
    try {
      const globalFs = await this.getGlobalFs();
      const token = (await globalFs.readTextFile('/workspace/.git/github-token')).trim();
      this.githubToken = token || undefined;
    } catch {
      this.githubToken = undefined;
    }
  }

  /** Refresh GitHub auth before network operations without making git depend on the provider. */
  private async ensureFreshGithubToken(): Promise<void> {
    try {
      await this.options.ensureFreshGithubToken?.();
    } catch (err) {
      logger.warn('GitHub token freshness check failed; continuing with existing auth', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Persist GitHub token to global VFS. */
  private async setGithubToken(token: string): Promise<void> {
    const trimmed = token.trim();
    const globalFs = await this.getGlobalFs();
    if (!trimmed) {
      try {
        await globalFs.rm('/workspace/.git/github-token');
      } catch {
        // ignore if not present
      }
      this.githubToken = undefined;
      return;
    }
    await globalFs.writeFile('/workspace/.git/github-token', trimmed);
    this.githubToken = trimmed;
  }

  /**
   * Resolve the git author identity for an operation, mirroring git's lookup
   * order: per-invocation `-c` overrides → local repo config → global config →
   * in-memory defaults from the constructor. This way values written to
   * /workspace/.gitconfig (e.g. by the GitHub OAuth provider or by
   * `git config --global`) take effect on subsequent commits without
   * requiring a fresh GitCommands instance, while `git -c user.email=…` wins
   * for a single invocation (matches real git).
   */
  private async resolveAuthor(cwd: string): Promise<{ name: string; email: string }> {
    const readLocal = async (key: string): Promise<string | undefined> => {
      try {
        return await git.getConfig({ fs: this.lfs, dir: cwd, path: key });
      } catch {
        return undefined;
      }
    };
    const overrides = this.currentConfigOverrides;
    const globalFs = await this.getGlobalFs();
    const name =
      overrides?.get('user.name') ??
      (await readLocal('user.name')) ??
      (await readGlobalGitConfigValue(globalFs, 'user.name')) ??
      this.authorName;
    const email =
      overrides?.get('user.email') ??
      (await readLocal('user.email')) ??
      (await readGlobalGitConfigValue(globalFs, 'user.email')) ??
      this.authorEmail;
    return { name, email };
  }

  /**
   * Execute a git command.
   * @param args Command arguments (e.g., ['init'], ['commit', '-m', 'message'])
   * @param cwd Current working directory
   * @param env Optional shell env vars used as an ambient auth fallback
   *   (`$GH_TOKEN`, `$GITHUB_TOKEN`) when no explicit `github.token` file is
   *   set. Matches the `gh` CLI convention.
   */
  async execute(
    args: string[],
    cwd: string,
    env?: ReadonlyMap<string, string> | Readonly<Record<string, string>>
  ): Promise<GitCommandResult> {
    if (args.length === 0) {
      return this.help();
    }

    // Strip global flags (-c, -C, --no-pager, --git-dir, --work-tree, --help,
    // --version) before dispatching. Global help/version are intercepted here;
    // per-subcommand --help / -h is intercepted further below so spies on
    // git.fetch / git.checkout / git.clone never see a call.
    const parsed = this.stripGlobalFlags(args, cwd);
    if (parsed.versionRequested && parsed.remainingArgs.length === 0) {
      return this.version();
    }
    if (parsed.helpRequested || parsed.remainingArgs.length === 0) {
      return this.help();
    }

    const effectiveCwd = parsed.effectiveCwd;
    const [command, ...rest] = parsed.remainingArgs;

    // Per-subcommand help: `git <cmd> --help` / `-h` must short-circuit BEFORE
    // any network/FS action runs (#1033-4). Parsing `rest` with the
    // subcommand's flag spec is position-aware: a `--help` that is the VALUE of
    // a preceding value-flag (`commit -m --help`) is shadowed onto that flag,
    // and a `--help` after a `--` separator (`checkout -- --help`) lands in
    // `doubleDashRest` — neither sets the `help` flag (#1047 review).
    const subHelp = parseArgs(rest, GIT_FLAG_SPECS[command] ?? {});
    if (subHelp.flags.help || subHelp.flags.h) {
      return this.help();
    }

    this.currentEnv = env;
    this.currentConfigOverrides = parsed.configOverrides;
    try {
      if (NETWORK_COMMANDS.has(command)) {
        await this.ensureFreshGithubToken();
      }
      await this.loadGithubToken();
      // NB: every async dispatch below MUST be `return await`, not `return`.
      // The `finally` block clears `currentEnv` / `currentConfigOverrides`,
      // and per JS spec a bare `return promise` in a try block runs the
      // finally synchronously after the expression evaluates (i.e. before
      // the returned promise resolves) — clearing the overrides while the
      // subcommand is still mid-await and breaking `-c key=val` for any
      // consumer that reads them after its first await.
      switch (command) {
        case 'init':
          return await init(this.ctx, effectiveCwd, rest);
        case 'clone':
          return await clone(this.ctx, effectiveCwd, rest);
        case 'add':
          return await add(this.ctx, effectiveCwd, rest);
        case 'status':
          return await status(this.ctx, effectiveCwd, rest);
        case 'commit':
          return await commit(this.ctx, effectiveCwd, rest);
        case 'log':
          return await log(this.ctx, effectiveCwd, rest);
        case 'branch':
          return await branch(this.ctx, effectiveCwd, rest);
        case 'checkout':
          return await checkout(this.ctx, effectiveCwd, rest);
        case 'diff':
          return await diff(this.ctx, effectiveCwd, rest);
        case 'show':
          return await show(this.ctx, effectiveCwd, rest);
        case 'remote':
          return await remote(this.ctx, effectiveCwd, rest);
        case 'fetch':
          return await fetch(this.ctx, effectiveCwd, rest);
        case 'pull':
          return await pull(this.ctx, effectiveCwd, rest);
        case 'push':
          return await push(this.ctx, effectiveCwd, rest);
        case 'merge':
          return await merge(this.ctx, effectiveCwd, rest);
        case 'cherry-pick':
          return await cherryPick(this.ctx, effectiveCwd, rest);
        case 'rebase':
          return await rebase(this.ctx, effectiveCwd, rest);
        case 'revert':
          return await revert(this.ctx, effectiveCwd, rest);
        case 'merge-file':
          return await mergeFile(this.ctx, effectiveCwd, rest);
        case 'reset':
          return await reset(this.ctx, effectiveCwd, rest);
        case 'config':
          return await config(this.ctx, effectiveCwd, rest);
        case 'tag':
          return await tag(this.ctx, effectiveCwd, rest);
        case 'ls-files':
          return await lsFiles(this.ctx, effectiveCwd, rest);
        case 'show-ref':
          return await showRef(this.ctx, effectiveCwd, rest);
        case 'symbolic-ref':
          return await symbolicRef(this.ctx, effectiveCwd, rest);
        case 'stash':
          return await stash(this.ctx, effectiveCwd, rest);
        case 'rm':
          return await rm(this.ctx, effectiveCwd, rest);
        case 'mv':
          return await mv(this.ctx, effectiveCwd, rest);
        case 'rev-parse':
          return await revParse(this.ctx, effectiveCwd, rest);
        case 'help':
          return this.help();
        case 'version':
          return this.version();
        default:
          return {
            stdout: '',
            stderr: `git: '${command}' is not a git command. See 'git help'.\n`,
            exitCode: 1,
          };
      }
    } catch (err) {
      // #1033-5: unpack MultipleGitError/AggregateError wrappers so the CLI
      // shows the real underlying failures, not the cosmetic wrapper text.
      const message = expandGitError(err);
      return {
        stdout: '',
        stderr: `fatal: ${message}\n`,
        exitCode: 128,
      };
    } finally {
      this.currentEnv = undefined;
      this.currentConfigOverrides = undefined;
    }
  }

  /**
   * Strip global git flags that appear BEFORE the subcommand:
   *   `-c <key>=<val>`, `-C <dir>`, `--no-pager`, `--git-dir[=<dir>]`,
   *   `--work-tree[=<dir>]`, `--help` / `-h`, `--version`.
   *
   * The shared parser's `stopEarly` mode collects only the leading flags and
   * leaves the subcommand + its own flags untouched in `positionals`. `-c
   * key=val` overrides are collected into a per-invocation map (repeated flags
   * arrive as an array, so all of them apply and the last wins); known keys
   * (see `resolveAuthor` / `init`) take effect, unknown keys remain accepted
   * no-ops so they don't fall through to the "not a git command" branch
   * (#1033-2). Real git lowercases the section + variable name, so
   * `-c USER.email=…` resolves like the lowercase form (#1047 review); the
   * value is preserved as-is. `-C <dir>` is applied cumulatively.
   */
  private stripGlobalFlags(
    args: string[],
    cwd: string
  ): {
    effectiveCwd: string;
    remainingArgs: string[];
    helpRequested: boolean;
    versionRequested: boolean;
    configOverrides: ReadonlyMap<string, string>;
  } {
    const parsed = parseArgs(args, GLOBAL_SPEC);

    let effectiveCwd = cwd;
    for (const dir of asStringArray(parsed.flags.C)) {
      if (dir === '') continue;
      effectiveCwd = dir.startsWith('/') ? dir : `${effectiveCwd}/${dir}`;
    }

    const configOverrides = new Map<string, string>();
    for (const entry of asStringArray(parsed.flags.c)) {
      if (entry === '') continue;
      const eq = entry.indexOf('=');
      // Malformed (no `=`) is accepted as a no-op key for back-compat.
      if (eq < 0) {
        configOverrides.set(entry.toLowerCase(), '');
        continue;
      }
      configOverrides.set(entry.slice(0, eq).toLowerCase(), entry.slice(eq + 1));
    }

    return {
      effectiveCwd,
      remainingArgs: parsed.positionals,
      helpRequested: Boolean(parsed.flags.help || parsed.flags.h),
      versionRequested: Boolean(parsed.flags.version),
      configOverrides,
    };
  }

  private version(): GitCommandResult {
    const isoGitVersion = git.version();
    return {
      stdout: `git version 2.43.0 (isomorphic-git ${isoGitVersion})\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private help(): GitCommandResult {
    return {
      stdout: `usage: git <command> [<args>]

Available commands:
  init        Initialize a new repository
  clone       Clone a repository
  add         Add file contents to the index
  status      Show the working tree status
  commit      Record changes to the repository
  log         Show commit logs
  branch      List, create, or delete branches
  checkout    Switch branches or restore files
  diff        Show changes between commits
  show        Show commit details and diffs
  remote      Manage remote repositories
  fetch       Download objects and refs from remote
  pull        Fetch and merge changes
  push        Update remote refs
  merge       Join two development histories together
  merge-file  Run a three-way file merge
  cherry-pick Apply the changes introduced by an existing commit
  rebase      Reapply commits on top of another base tip
  revert      Revert an existing commit
  reset       Reset HEAD, index, and working tree
  stash       Stash changes in a dirty working directory
  rm          Remove files from the working tree and index
  mv          Move or rename a file
  tag         Create, list, or delete tags
  ls-files    Show tracked files
  show-ref    List references (branches and tags)
  symbolic-ref Read, modify, or delete symbolic refs
  config      Get and set repository options
  rev-parse   Pick out and massage parameters

`,
      stderr: '',
      exitCode: 0,
    };
  }
}

/**
 * Factory function to create GitCommands with VirtualFS.
 */
export function createGitCommands(options: GitCommandsOptions): GitCommands {
  return new GitCommands(options);
}
