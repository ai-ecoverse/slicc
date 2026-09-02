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
import { createLogger } from '../base/logger.js';
import { GLOBAL_FS_DB_NAME } from '../fs/global-db.js';
import { VirtualFS } from '../fs/index.js';
import { type ArgSpec, parseArgs } from '../shell/arg-parser.js';
import { add } from './commands/add.js';
import { branch } from './commands/branch.js';
import { checkout } from './commands/checkout.js';
import { cherryPick } from './commands/cherry-pick.js';
import { clean } from './commands/clean.js';
import { clone } from './commands/clone.js';
import { commit } from './commands/commit.js';
import { config } from './commands/config.js';
import { diff } from './commands/diff.js';
import { fetch } from './commands/fetch.js';
import { init } from './commands/init.js';
import { log } from './commands/log.js';
import { lsFiles } from './commands/ls-files.js';
import { lsRemote } from './commands/ls-remote.js';
import { lsTree } from './commands/ls-tree.js';
import { merge } from './commands/merge.js';
import { mergeBase } from './commands/merge-base.js';
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
import { createCommandScopedReadCache } from './fs-command-cache.js';
import { GitCacheManager } from './git-cache.js';
import { readGlobalGitConfigValue } from './git-config.js';
import {
  createIsomorphicGitFs,
  type IsoGitFsClient,
  type IsoGitFsPromises,
} from './vfs-fs-adapter.js';

export type { GitCommandResult, GitCommandsOptions } from './commands/types.js';

const logger = createLogger('git-commands');
const NETWORK_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);
/** Commands that land new packfiles locally, invalidating the pack cache (#2710). */
const PACK_WRITING_COMMANDS = new Set(['clone', 'fetch', 'pull']);
/** Shell env var that re-enables the deep packfile SHA-1 verification (#2710). */
const VERIFY_PACKS_ENV = 'SLICC_GIT_VERIFY_PACKS';

/**
 * Subcommands that get a command-scoped read cache (`fs-command-cache.ts`),
 * which collapses isomorphic-git's per-file re-stat of `.git/index` and
 * per-candidate re-read of every ancestor `.gitignore` onto one round trip
 * each (issue #2709).
 *
 * The cache only sees writes made through the isomorphic-git adapter, so this
 * is an allowlist of subcommands that mutate the repo exclusively that way.
 * Everything that writes straight to the VirtualFS (`ctx.fs`) — checkout,
 * reset, rm, mv, stash, rebase, revert, clean, merge-file, config — would
 * leave the memo stale and is handed the plain adapter instead, as are the
 * network commands, which stream far more object data than is worth
 * retaining.
 */
const CACHEABLE_COMMANDS = new Set([
  'add',
  'branch',
  'commit',
  'diff',
  'init',
  'log',
  'ls-files',
  'ls-tree',
  'merge-base',
  'rev-parse',
  'show',
  'show-ref',
  'status',
  'symbolic-ref',
  'tag',
]);

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

  /**
   * The uncached adapter over the repo's VirtualFS. `execute()` derives a
   * per-invocation view of it (see {@link GitCommands.contextFor}); nothing
   * here is ever a cached adapter, because instance state is shared by
   * concurrent invocations and a memo must not be.
   */
  /**
   * The BARE adapter {@link GitCacheManager} samples the repository through:
   * no object memo (#2712), no readdir-primed stat cache (#2716), and never a
   * command's read memo (#2709).
   *
   * `packSignature` is an INVALIDATION sampler — it lists `objects/pack` and
   * lstats `packed-refs` to decide whether the packs it is holding are still
   * the packs on disk. Answering either from a memo is a cache validating
   * itself against its own memory. `statCacheMax: 0` and the absent
   * `objectCache` make that structural instead of a property of who calls
   * what.
   */
  private readonly lfs: IsoGitFsPromises;
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
  /**
   * Guards {@link getOnAuthFailure} so a 401 triggers at most one silent
   * renew+retry per `execute()` (#2777). Reset at the start of every
   * network-capable invocation.
   */
  private authFailureRetried = false;

  /**
   * Cross-command isomorphic-git object/pack cache (#2710). One per INSTANCE —
   * unlike the per-invocation read memo `contextFor` builds (#2709), the
   * object/pack cache is only worth having when it outlives the command that
   * filled it, and `GitCacheManager` owns the invalidation that makes sharing
   * it safe.
   */
  private readonly cacheManager: GitCacheManager;

  constructor(private options: GitCommandsOptions) {
    // Route through a VirtualFS-backed adapter so isomorphic-git sees mount
    // points (File System Access API) the same way shell/agent tools do.
    // See packages/webapp/src/git/vfs-fs-adapter.ts. This uncached instance
    // backs the class's own config reads; each `execute()` builds its own.
    this.lfs = createIsomorphicGitFs(options.fs, { statCacheMax: 0 }).promises;
    this.corsProxy = options.corsProxy;
    this.authorName = options.authorName ?? 'User';
    this.authorEmail = options.authorEmail ?? 'user@example.com';
    this.globalDbName = options.globalDbName ?? GLOBAL_FS_DB_NAME;
    this.cacheManager = new GitCacheManager(this.lfs, {
      ...(options.maxResidentPacks !== undefined
        ? { maxResidentPacks: options.maxResidentPacks }
        : {}),
    });
  }

  /**
   * Build the context for ONE `execute()` call.
   *
   * `lfs` is the only per-invocation part, and it is TWO memos deep:
   *
   * - The base adapter carries the `.git/objects` memo (issue #2712) — the
   *   `objects/pack` listing isomorphic-git re-reads on every packed object
   *   lookup, and the `objects/` fan-out listing that decides whether the
   *   loose probe `_readObject` always tries first can find anything at all.
   *   Every subcommand gets it: unlike the read cache, the object store is
   *   written ONLY through this adapter (nothing reaches past it to `ctx.fs`
   *   for `.git/objects`), so a command that writes to the working tree
   *   directly cannot leave it stale, and every write through the adapter
   *   drops it anyway.
   * - A cacheable subcommand is additionally wrapped in a fresh
   *   `createCommandScopedReadCache` (issue #2709), which sits ABOVE the
   *   object memo: a read it misses still reaches the fan-out shortcut
   *   instead of the filesystem, and a write it forwards invalidates both.
   *
   * Both memos are built here and nowhere else, so two commands overlapping
   * in time never share either one, and both are unreachable — and therefore
   * collected — as soon as the command returns.
   */
  private contextFor(command: string): { ctx: GitCommandContext; client: IsoGitFsClient } {
    const client = createIsomorphicGitFs(this.options.fs, { objectCache: true });
    const lfs = CACHEABLE_COMMANDS.has(command)
      ? createCommandScopedReadCache(client.promises)
      : client.promises;
    const ctx: GitCommandContext = {
      lfs,
      fs: this.options.fs,
      // The object/pack cache is the instance's, NOT the invocation's (#2710):
      // the read memo above must die with the command, but the parsed `.idx`
      // files and pack buffers are what the next command must not pay for
      // again.
      cache: this.cacheManager.cache,
      corsProxy: this.corsProxy,
      getOnAuth: () => this.getOnAuth(),
      getOnAuthFailure: () => this.getOnAuthFailure(),
      resolveAuthor: (cwd) => this.resolveAuthor(cwd, lfs),
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
    return { ctx, client };
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
   * After GitHub rejects credentials, force one silent renew and retry with
   * the refreshed bridge token. isomorphic-git keeps calling this as long as
   * credentials are returned, so the {@link authFailureRetried} latch caps
   * retries at one (#2777).
   */
  private getOnAuthFailure():
    | (() => Promise<{ username: string; password: string } | undefined>)
    | undefined {
    // Always install the callback when a freshness hook exists — even if the
    // first onAuth had no token, a force renew might produce one.
    if (!this.options.ensureFreshGithubToken) return undefined;
    return async () => {
      if (this.authFailureRetried) return undefined;
      this.authFailureRetried = true;
      try {
        await this.options.ensureFreshGithubToken?.({ force: true });
      } catch (err) {
        logger.warn('GitHub token force-renew after 401 failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
      await this.loadGithubToken();
      const token = this.resolveAuthToken();
      if (!token) return undefined;
      return { username: 'x-access-token', password: token };
    };
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
  private async ensureFreshGithubToken(opts?: { force?: boolean }): Promise<void> {
    try {
      await this.options.ensureFreshGithubToken?.(opts);
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
  private async resolveAuthor(
    cwd: string,
    lfs: IsoGitFsPromises
  ): Promise<{ name: string; email: string }> {
    const readLocal = async (key: string): Promise<string | undefined> => {
      try {
        return await git.getConfig({ fs: lfs, dir: cwd, path: key });
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
    const subcommandSpec = GIT_FLAG_SPECS[command] ?? {};
    const subHelp = parseArgs(rest, subcommandSpec);
    const shortHelpHasCommandMeaning = Object.hasOwn(subcommandSpec.alias ?? {}, 'h');
    if (subHelp.flags.help || (subHelp.flags.h && !shortHelpHasCommandMeaning)) {
      return this.help();
    }

    this.currentEnv = env;
    this.currentConfigOverrides = parsed.configOverrides;
    // One context — and with it one view of `.git/objects` (#2712) plus, for a
    // cacheable subcommand, one read memo (#2709) — per invocation, so nothing
    // a command reads is visible to any other.
    const { ctx, client } = this.contextFor(command);
    try {
      // Object/pack cache housekeeping (#2710). The verification switch is
      // per-invocation (it reads the shell env), and `beforeCommand` re-samples
      // the repository's pack state so a pack landed by another writer since
      // the last command is never served out of a stale cache.
      this.cacheManager.setDeepVerification(this.shouldVerifyPackfiles());
      await this.cacheManager.beforeCommand(effectiveCwd);
      if (NETWORK_COMMANDS.has(command)) {
        this.authFailureRetried = false;
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
          return await init(ctx, effectiveCwd, rest);
        case 'clone':
          return await clone(ctx, effectiveCwd, rest);
        case 'add':
          return await add(ctx, effectiveCwd, rest);
        case 'status':
          return await status(ctx, effectiveCwd, rest);
        case 'commit':
          return await commit(ctx, effectiveCwd, rest);
        case 'log':
          return await log(ctx, effectiveCwd, rest);
        case 'ls-remote':
          return await lsRemote(ctx, effectiveCwd, rest);
        case 'branch':
          return await branch(ctx, effectiveCwd, rest);
        case 'checkout':
          return await checkout(ctx, effectiveCwd, rest);
        case 'clean':
          return await clean(ctx, effectiveCwd, rest);
        case 'diff':
          return await diff(ctx, effectiveCwd, rest);
        case 'show':
          return await show(ctx, effectiveCwd, rest);
        case 'remote':
          return await remote(ctx, effectiveCwd, rest);
        case 'fetch':
          return await fetch(ctx, effectiveCwd, rest);
        case 'pull':
          return await pull(ctx, effectiveCwd, rest);
        case 'push':
          return await push(ctx, effectiveCwd, rest);
        case 'merge':
          return await merge(ctx, effectiveCwd, rest);
        case 'merge-base':
          return await mergeBase(ctx, effectiveCwd, rest);
        case 'cherry-pick':
          return await cherryPick(ctx, effectiveCwd, rest);
        case 'rebase':
          return await rebase(ctx, effectiveCwd, rest);
        case 'revert':
          return await revert(ctx, effectiveCwd, rest);
        case 'merge-file':
          return await mergeFile(ctx, effectiveCwd, rest);
        case 'reset':
          return await reset(ctx, effectiveCwd, rest);
        case 'config':
          return await config(ctx, effectiveCwd, rest);
        case 'tag':
          return await tag(ctx, effectiveCwd, rest);
        case 'ls-files':
          return await lsFiles(ctx, effectiveCwd, rest);
        case 'ls-tree':
          return await lsTree(ctx, effectiveCwd, rest);
        case 'show-ref':
          return await showRef(ctx, effectiveCwd, rest);
        case 'symbolic-ref':
          return await symbolicRef(ctx, effectiveCwd, rest);
        case 'stash':
          return await stash(ctx, effectiveCwd, rest);
        case 'rm':
          return await rm(ctx, effectiveCwd, rest);
        case 'mv':
          return await mv(ctx, effectiveCwd, rest);
        case 'rev-parse':
          return await revParse(ctx, effectiveCwd, rest);
        case 'help':
          return this.help();
        case 'version':
          return this.version();
        default:
          return {
            stdout: '',
            stderr: `git: '${command}' is not a git command. See 'git help'.\n`,
            exitCode: 127,
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
      await this.cacheManager.afterCommand(effectiveCwd, {
        wrotePacks: PACK_WRITING_COMMANDS.has(command),
      });
      this.currentEnv = undefined;
      this.currentConfigOverrides = undefined;
      // The adapter is per-invocation, so its readdir-primed stat cache
      // (#2716) dies with this call anyway — but a listing must never answer a
      // stat issued by the NEXT command, which can run after the host
      // filesystem moved on, so the scope boundary is stated rather than
      // inferred from who happens to hold a reference to `ctx`.
      client.clearStatCache();
    }
  }

  /**
   * Whether to run isomorphic-git's deep (full payload) SHA-1 check on every
   * packfile read. Off by default: it costs a full hash of the pack (5.2 s for
   * the 92 MB slicc pack) on data the VFS already delivered, and canonical git
   * verifies packs on `fsck` / `index-pack`, not on an object read. The
   * O(1) trailer check runs either way. `$SLICC_GIT_VERIFY_PACKS=1` turns the
   * deep check back on for a shell that wants it.
   */
  private shouldVerifyPackfiles(): boolean {
    const env = this.currentEnv;
    const flag = env ? readEnvVar(env, VERIFY_PACKS_ENV) : undefined;
    if (flag !== undefined) return flag !== '0' && flag.toLowerCase() !== 'false';
    return this.options.verifyPackfiles === true;
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
  clean       Remove untracked files from the working tree
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
  ls-tree     List the contents of a tree object
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
