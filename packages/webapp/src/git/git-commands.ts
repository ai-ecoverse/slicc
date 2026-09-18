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
import { colorWhenFromArgs, normalizeGitColorArgs, resolveGitColor } from './commands/color.js';
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
import type {
  GitCommandContext,
  GitCommandResult,
  GitCommandsOptions,
  GitExecuteOptions,
} from './commands/types.js';
import { createCommandScopedReadCache } from './fs-command-cache.js';
import { GitCacheManager } from './git-cache.js';
import { readGlobalGitConfigValue } from './git-config.js';
import {
  createIsomorphicGitFs,
  type IsoGitFsClient,
  type IsoGitFsPromises,
} from './vfs-fs-adapter.js';

export type { GitCommandResult, GitCommandsOptions, GitExecuteOptions } from './commands/types.js';

const logger = createLogger('git-commands');
const NETWORK_COMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

const PACK_WRITING_COMMANDS = new Set(['clone', 'fetch', 'pull']);

const VERIFY_PACKS_ENV = 'SLICC_GIT_VERIFY_PACKS';

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

const GLOBAL_SPEC: ArgSpec = {
  string: ['c', 'C', 'git-dir', 'work-tree'],

  boolean: ['help', 'version', 'no-pager', 'paginate', 'no-replace-objects', 'color'],
  alias: { h: 'help' },
  stopEarly: true,
};

function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

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

export class GitCommands {
  private static globalFsByDbName: Map<string, Promise<VirtualFS>> = new Map();

  private readonly lfs: IsoGitFsPromises;
  private corsProxy?: string;
  private authorName: string;
  private authorEmail: string;
  private globalDbName: string;

  private githubToken?: string;

  private currentEnv?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;

  private currentConfigOverrides?: ReadonlyMap<string, string>;

  private currentStdin = '';

  private readonly cacheManager: GitCacheManager;

  constructor(private options: GitCommandsOptions) {
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

  private contextFor(
    command: string,
    useColor: boolean
  ): { ctx: GitCommandContext; client: IsoGitFsClient } {
    const client = createIsomorphicGitFs(this.options.fs, { objectCache: true });
    const lfs = CACHEABLE_COMMANDS.has(command)
      ? createCommandScopedReadCache(client.promises)
      : client.promises;

    const onAuthFailure = this.createOnAuthFailure();
    const ctx: GitCommandContext = {
      lfs,
      fs: this.options.fs,

      cache: this.cacheManager.cache,
      corsProxy: this.corsProxy,
      getOnAuth: () => this.getOnAuth(),
      getOnAuthFailure: () => onAuthFailure,
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
      stdin: this.currentStdin,
      useColor,
    };
    return { ctx, client };
  }

  private getOnAuth(): (() => { username: string; password: string }) | undefined {
    const token = this.resolveAuthToken();
    if (!token) return undefined;
    return () => ({
      username: 'x-access-token',
      password: token,
    });
  }

  private createOnAuthFailure():
    | (() => Promise<{ username: string; password: string } | undefined>)
    | undefined {
    if (!this.options.ensureFreshGithubToken) return undefined;
    let retried = false;
    return async () => {
      if (retried) return undefined;
      retried = true;
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

  private getGlobalFs(): Promise<VirtualFS> {
    const existing = GitCommands.globalFsByDbName.get(this.globalDbName);
    if (existing) return existing;
    const created = VirtualFS.create({ dbName: this.globalDbName });
    GitCommands.globalFsByDbName.set(this.globalDbName, created);
    return created;
  }

  private async loadGithubToken(): Promise<void> {
    try {
      const globalFs = await this.getGlobalFs();
      const token = (await globalFs.readTextFile('/workspace/.git/github-token')).trim();
      this.githubToken = token || undefined;
    } catch {
      this.githubToken = undefined;
    }
  }

  private async ensureFreshGithubToken(opts?: { force?: boolean }): Promise<void> {
    try {
      await this.options.ensureFreshGithubToken?.(opts);
    } catch (err) {
      logger.warn('GitHub token freshness check failed; continuing with existing auth', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async setGithubToken(token: string): Promise<void> {
    const trimmed = token.trim();
    const globalFs = await this.getGlobalFs();
    if (!trimmed) {
      try {
        await globalFs.rm('/workspace/.git/github-token');
      } catch {}
      this.githubToken = undefined;
      return;
    }
    await globalFs.writeFile('/workspace/.git/github-token', trimmed);
    this.githubToken = trimmed;
  }

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

  async execute(
    args: string[],
    cwd: string,
    env?: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
    stdin?: string,
    executeOpts?: GitExecuteOptions
  ): Promise<GitCommandResult> {
    if (args.length === 0) {
      return this.help();
    }

    const parsed = this.stripGlobalFlags(normalizeGitColorArgs(args), cwd);
    if (parsed.versionRequested && parsed.remainingArgs.length === 0) {
      return this.version();
    }
    if (parsed.helpRequested || parsed.remainingArgs.length === 0) {
      return this.help();
    }

    const effectiveCwd = parsed.effectiveCwd;
    const [command, ...rest] = parsed.remainingArgs;

    const subcommandSpec = GIT_FLAG_SPECS[command] ?? {};
    const subHelp = parseArgs(rest, subcommandSpec);
    const shortHelpHasCommandMeaning = Object.hasOwn(subcommandSpec.alias ?? {}, 'h');
    if (subHelp.flags.help || (subHelp.flags.h && !shortHelpHasCommandMeaning)) {
      return this.help();
    }

    this.currentEnv = env;
    this.currentConfigOverrides = parsed.configOverrides;
    this.currentStdin = stdin ?? '';
    const useColor = this.invocationColor(args, env, parsed.configOverrides, executeOpts);

    const { ctx, client } = this.contextFor(command, useColor);
    try {
      this.cacheManager.setDeepVerification(this.shouldVerifyPackfiles());
      await this.cacheManager.beforeCommand(effectiveCwd);
      if (NETWORK_COMMANDS.has(command)) {
        await this.ensureFreshGithubToken();
      }
      await this.loadGithubToken();

      return await this.dispatch(command, ctx, effectiveCwd, rest);
    } catch (err) {
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
      this.currentStdin = '';

      client.clearStatCache();
    }
  }

  private async dispatch(
    command: string,
    ctx: GitCommandContext,
    cwd: string,
    rest: string[]
  ): Promise<GitCommandResult> {
    switch (command) {
      case 'init':
        return await init(ctx, cwd, rest);
      case 'clone':
        return await clone(ctx, cwd, rest);
      case 'add':
        return await add(ctx, cwd, rest);
      case 'status':
        return await status(ctx, cwd, rest);
      case 'commit':
        return await commit(ctx, cwd, rest);
      case 'log':
        return await log(ctx, cwd, rest);
      case 'ls-remote':
        return await lsRemote(ctx, cwd, rest);
      case 'branch':
        return await branch(ctx, cwd, rest);
      case 'checkout':
        return await checkout(ctx, cwd, rest);
      case 'clean':
        return await clean(ctx, cwd, rest);
      case 'diff':
        return await diff(ctx, cwd, rest);
      case 'show':
        return await show(ctx, cwd, rest);
      case 'remote':
        return await remote(ctx, cwd, rest);
      case 'fetch':
        return await fetch(ctx, cwd, rest);
      case 'pull':
        return await pull(ctx, cwd, rest);
      case 'push':
        return await push(ctx, cwd, rest);
      case 'merge':
        return await merge(ctx, cwd, rest);
      case 'merge-base':
        return await mergeBase(ctx, cwd, rest);
      case 'cherry-pick':
        return await cherryPick(ctx, cwd, rest);
      case 'rebase':
        return await rebase(ctx, cwd, rest);
      case 'revert':
        return await revert(ctx, cwd, rest);
      case 'merge-file':
        return await mergeFile(ctx, cwd, rest);
      case 'reset':
        return await reset(ctx, cwd, rest);
      case 'config':
        return await config(ctx, cwd, rest);
      case 'tag':
        return await tag(ctx, cwd, rest);
      case 'ls-files':
        return await lsFiles(ctx, cwd, rest);
      case 'ls-tree':
        return await lsTree(ctx, cwd, rest);
      case 'show-ref':
        return await showRef(ctx, cwd, rest);
      case 'symbolic-ref':
        return await symbolicRef(ctx, cwd, rest);
      case 'stash':
        return await stash(ctx, cwd, rest);
      case 'rm':
        return await rm(ctx, cwd, rest);
      case 'mv': {
        const { mv } = await import('./commands/mv.js');
        return await mv(ctx, cwd, rest);
      }
      case 'rev-parse':
        return await revParse(ctx, cwd, rest);
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
  }

  private invocationColor(
    args: string[],
    env: ReadonlyMap<string, string> | Readonly<Record<string, string>> | undefined,
    configOverrides: ReadonlyMap<string, string> | undefined,
    executeOpts: GitExecuteOptions | undefined
  ): boolean {
    return resolveGitColor({
      cliWhen: colorWhenFromArgs(args),
      colorUi: configOverrides?.get('color.ui'),
      noColorEnv: Boolean(env && readEnvVar(env, 'NO_COLOR')),
      stdoutIsTTY: executeOpts?.stdoutIsTTY === true,
      term: env ? readEnvVar(env, 'TERM') : undefined,
    });
  }

  private shouldVerifyPackfiles(): boolean {
    const env = this.currentEnv;
    const flag = env ? readEnvVar(env, VERIFY_PACKS_ENV) : undefined;
    if (flag !== undefined) return flag !== '0' && flag.toLowerCase() !== 'false';
    return this.options.verifyPackfiles === true;
  }

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

export function createGitCommands(options: GitCommandsOptions): GitCommands {
  return new GitCommands(options);
}
