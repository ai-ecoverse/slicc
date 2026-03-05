/**
 * Git commands implementation for the virtual shell.
 *
 * Wraps isomorphic-git functions to provide a CLI-like interface
 * for git operations within the browser environment.
 */

// Buffer polyfill must be imported before isomorphic-git
import '../shims/buffer-polyfill.js';

import * as git from 'isomorphic-git';
import type FS from '@isomorphic-git/lightning-fs';
import { VirtualFS } from '../fs/index.js';
import { gitHttp } from './git-http.js';

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCommandsOptions {
  fs: VirtualFS;
  /** CORS proxy URL for remote operations. */
  corsProxy?: string;
  /** Default author name. */
  authorName?: string;
  /** Default author email. */
  authorEmail?: string;
  /** Global VirtualFS database name for shared git config values. */
  globalDbName?: string;
}

/**
 * Git commands handler that provides CLI-like git functionality.
 * Uses the shared VirtualFS instance (backed by LightningFS).
 */
export class GitCommands {
  private static globalFsByDbName: Map<string, Promise<VirtualFS>> = new Map();

  private lfs: FS.PromisifiedFS;
  private corsProxy?: string;
  private authorName: string;
  private authorEmail: string;
  private globalDbName: string;
  /** GitHub token for authentication (avoids rate limits on public repos, required for private). */
  private githubToken?: string;
  private githubTokenLoaded = false;

  constructor(private options: GitCommandsOptions) {
    // Use the shared VirtualFS's underlying LightningFS
    this.lfs = options.fs.getLightningFS();
    this.corsProxy = options.corsProxy;
    this.authorName = options.authorName ?? 'User';
    this.authorEmail = options.authorEmail ?? 'user@example.com';
    this.globalDbName = options.globalDbName ?? 'slicc-fs-global';
  }

  /**
   * Get onAuth callback for isomorphic-git operations.
   * Returns credentials if a GitHub token is configured.
   */
  private getOnAuth(): (() => { username: string; password: string }) | undefined {
    if (!this.githubToken) return undefined;
    const token = this.githubToken;
    return () => ({
      username: 'x-access-token',
      password: token,
    });
  }

  /** Get or create the shared Global VirtualFS instance for config persistence. */
  private getGlobalFs(): Promise<VirtualFS> {
    const existing = GitCommands.globalFsByDbName.get(this.globalDbName);
    if (existing) return existing;
    const created = VirtualFS.create({ dbName: this.globalDbName });
    GitCommands.globalFsByDbName.set(this.globalDbName, created);
    return created;
  }

  /** Load GitHub token from global VFS if not loaded in-memory yet. */
  private async ensureGithubTokenLoaded(): Promise<void> {
    if (this.githubTokenLoaded) return;
    this.githubTokenLoaded = true;
    try {
      const globalFs = await this.getGlobalFs();
      const token = (await globalFs.readTextFile('/workspace/.git/github-token')).trim();
      this.githubToken = token || undefined;
    } catch {
      this.githubToken = undefined;
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
      this.githubTokenLoaded = true;
      return;
    }
    await globalFs.writeFile('/workspace/.git/github-token', trimmed);
    this.githubToken = trimmed;
    this.githubTokenLoaded = true;
  }

  /**
   * Execute a git command.
   * @param args Command arguments (e.g., ['init'], ['commit', '-m', 'message'])
   * @param cwd Current working directory
   */
  async execute(args: string[], cwd: string): Promise<GitCommandResult> {
    if (args.length === 0) {
      return this.help();
    }

    const [command, ...rest] = args;

    try {
      await this.ensureGithubTokenLoaded();
      switch (command) {
        case 'init':
          return this.init(cwd, rest);
        case 'clone':
          return this.clone(cwd, rest);
        case 'add':
          return this.add(cwd, rest);
        case 'status':
          return this.status(cwd, rest);
        case 'commit':
          return this.commit(cwd, rest);
        case 'log':
          return this.log(cwd, rest);
        case 'branch':
          return this.branch(cwd, rest);
        case 'checkout':
          return this.checkout(cwd, rest);
        case 'diff':
          return this.diff(cwd, rest);
        case 'remote':
          return this.remote(cwd, rest);
        case 'fetch':
          return this.fetch(cwd, rest);
        case 'pull':
          return this.pull(cwd, rest);
        case 'push':
          return this.push(cwd, rest);
        case 'config':
          return this.config(cwd, rest);
        case 'rev-parse':
          return this.revParse(cwd, rest);
        case 'help':
        case '--help':
        case '-h':
          return this.help();
        case 'version':
        case '--version':
          return this.version();
        default:
          return {
            stdout: '',
            stderr: `git: '${command}' is not a git command. See 'git help'.\n`,
            exitCode: 1,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: `fatal: ${message}\n`,
        exitCode: 128,
      };
    }
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
  remote      Manage remote repositories
  fetch       Download objects and refs from remote
  pull        Fetch and merge changes
  push        Update remote refs
  config      Get and set repository options
  rev-parse   Pick out and massage parameters

`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async init(cwd: string, args: string[]): Promise<GitCommandResult> {
    const defaultBranch = this.parseArg(args, '--initial-branch', '-b') ?? 'main';

    await git.init({
      fs: this.lfs,
      dir: cwd,
      defaultBranch,
    });

    return {
      stdout: `Initialized empty Git repository in ${cwd}/.git/\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async clone(cwd: string, args: string[]): Promise<GitCommandResult> {
    if (args.length === 0) {
      return {
        stdout: '',
        stderr: 'fatal: You must specify a repository to clone.\n',
        exitCode: 128,
      };
    }

    const url = args[0];
    let dir = args[1];

    // Extract repo name from URL if dir not specified
    if (!dir) {
      const match = url.match(/\/([^\/]+?)(\.git)?$/);
      dir = match ? match[1] : 'repo';
    }

    const targetDir = dir.startsWith('/') ? dir : `${cwd}/${dir}`;
    const depth = this.parseArg(args, '--depth');
    const branch = this.parseArg(args, '--branch', '-b');
    const singleBranch = this.parseBooleanFlag(args, '--single-branch', true);

    let output = `Cloning into '${dir}'...\n`;

    // Use a shared cache for the clone operation
    const cache = {};

    await git.clone({
      fs: this.lfs,
      http: gitHttp,
      dir: targetDir,
      url,
      corsProxy: this.corsProxy,
      depth: depth ? parseInt(depth, 10) : 1, // Default to depth 1 for faster clones
      ref: branch,
      singleBranch,
      noCheckout: false, // Let clone handle checkout
      cache,
      onAuth: this.getOnAuth(),
      onProgress: (event) => {
        if (event.phase === 'Receiving objects') {
          output += `Receiving objects: ${event.loaded}/${event.total}\n`;
        }
      },
    });

    // List files that were checked out
    try {
      const files = await git.listFiles({ fs: this.lfs, dir: targetDir });
      if (files.length > 0) {
        output += `Checked out ${files.length} files.\n`;
      }
    } catch {
      // Ignore errors listing files
    }

    return {
      stdout: output + 'done.\n',
      stderr: '',
      exitCode: 0,
    };
  }

  private async add(cwd: string, args: string[]): Promise<GitCommandResult> {
    if (args.length === 0) {
      return {
        stdout: '',
        stderr: 'Nothing specified, nothing added.\n',
        exitCode: 0,
      };
    }

    const filepath = args[0] === '.' ? '.' : args[0];
    const force = args.includes('-f') || args.includes('--force');

    if (filepath === '.') {
      // Add all changes by syncing stage state to workdir state.
      const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
      for (const [file, , workdir, stage] of matrix) {
        if (workdir === stage) continue;
        if (workdir === 0) {
          await git.remove({ fs: this.lfs, dir: cwd, filepath: file });
        } else {
          await git.add({ fs: this.lfs, dir: cwd, filepath: file, force });
        }
      }
    } else {
      await git.add({ fs: this.lfs, dir: cwd, filepath, force });
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private async status(cwd: string, _args: string[]): Promise<GitCommandResult> {
    let output = '';

    try {
      const branch = await git.currentBranch({ fs: this.lfs, dir: cwd });
      output += `On branch ${branch ?? '(no branch)'}\n\n`;
    } catch {
      output += 'Not on any branch.\n\n';
    }

    const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });

    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const [file, head, workdir, stage] of matrix) {
      // [HEAD, WORKDIR, STAGE]
      // [0, 2, 0] - new untracked file
      // [0, 2, 2] - new staged file
      // [1, 2, 1] - modified unstaged
      // [1, 2, 2] - modified staged
      // [1, 0, 0] - deleted unstaged
      // [1, 0, 1] - deleted staged

      if (head === 0 && workdir === 2 && stage === 0) {
        untracked.push(file);
      } else if (stage === 2 || (head === 1 && stage === 0 && workdir === 0)) {
        staged.push(file);
      } else if (workdir !== stage && workdir !== 0) {
        unstaged.push(file);
      } else if (head === 1 && workdir === 0 && stage === 1) {
        unstaged.push(file + ' (deleted)');
      }
    }

    if (staged.length > 0) {
      output += 'Changes to be committed:\n';
      output += '  (use "git restore --staged <file>..." to unstage)\n\n';
      for (const file of staged) {
        output += `\t\x1b[32m${file}\x1b[0m\n`;
      }
      output += '\n';
    }

    if (unstaged.length > 0) {
      output += 'Changes not staged for commit:\n';
      output += '  (use "git add <file>..." to update what will be committed)\n\n';
      for (const file of unstaged) {
        output += `\t\x1b[31m${file}\x1b[0m\n`;
      }
      output += '\n';
    }

    if (untracked.length > 0) {
      output += 'Untracked files:\n';
      output += '  (use "git add <file>..." to include in what will be committed)\n\n';
      for (const file of untracked) {
        output += `\t\x1b[31m${file}\x1b[0m\n`;
      }
      output += '\n';
    }

    if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
      output += 'nothing to commit, working tree clean\n';
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async commit(cwd: string, args: string[]): Promise<GitCommandResult> {
    const message = this.parseArg(args, '-m', '--message');

    if (!message) {
      return {
        stdout: '',
        stderr: 'error: switch `m` requires a value\n',
        exitCode: 1,
      };
    }

    const amend = args.includes('--amend');

    const sha = await git.commit({
      fs: this.lfs,
      dir: cwd,
      message,
      author: {
        name: this.authorName,
        email: this.authorEmail,
      },
      amend,
    });

    const shortSha = sha.slice(0, 7);
    const branch = await git.currentBranch({ fs: this.lfs, dir: cwd });

    return {
      stdout: `[${branch ?? 'HEAD'} ${shortSha}] ${message}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async log(cwd: string, args: string[]): Promise<GitCommandResult> {
    const depth = this.parseArg(args, '-n', '--max-count');
    const oneline = args.includes('--oneline');

    const commits = await git.log({
      fs: this.lfs,
      dir: cwd,
      depth: depth ? parseInt(depth, 10) : 10,
    });

    let output = '';
    for (const entry of commits) {
      const { commit, oid } = entry;
      if (oneline) {
        output += `\x1b[33m${oid.slice(0, 7)}\x1b[0m ${commit.message.split('\n')[0]}\n`;
      } else {
        output += `\x1b[33mcommit ${oid}\x1b[0m\n`;
        output += `Author: ${commit.author.name} <${commit.author.email}>\n`;
        output += `Date:   ${new Date(commit.author.timestamp * 1000).toLocaleString()}\n\n`;
        output += `    ${commit.message.replace(/\n/g, '\n    ')}\n\n`;
      }
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async branch(cwd: string, args: string[]): Promise<GitCommandResult> {
    const deleteFlag = args.includes('-d') || args.includes('-D') || args.includes('--delete');
    const listAll = args.includes('-a') || args.includes('--all');

    // Filter out flags to get branch name
    const branchName = args.find((a) => !a.startsWith('-'));

    if (deleteFlag && branchName) {
      await git.deleteBranch({ fs: this.lfs, dir: cwd, ref: branchName });
      return {
        stdout: `Deleted branch ${branchName}\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    if (branchName && !deleteFlag) {
      // Create new branch
      await git.branch({ fs: this.lfs, dir: cwd, ref: branchName });
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // List branches
    const branches = await git.listBranches({ fs: this.lfs, dir: cwd });
    const current = await git.currentBranch({ fs: this.lfs, dir: cwd });

    let output = '';
    for (const branch of branches) {
      if (branch === current) {
        output += `* \x1b[32m${branch}\x1b[0m\n`;
      } else {
        output += `  ${branch}\n`;
      }
    }

    if (listAll) {
      try {
        const remoteBranches = await git.listBranches({
          fs: this.lfs,
          dir: cwd,
          remote: 'origin',
        });
        for (const branch of remoteBranches) {
          output += `  \x1b[31mremotes/origin/${branch}\x1b[0m\n`;
        }
      } catch {
        // No remote branches
      }
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async checkout(cwd: string, args: string[]): Promise<GitCommandResult> {
    const createBranch = args.includes('-b');
    const ref = args.find((a) => !a.startsWith('-'));

    if (!ref) {
      return {
        stdout: '',
        stderr: 'error: you must specify path(s) or a branch to checkout\n',
        exitCode: 1,
      };
    }

    if (createBranch) {
      await git.branch({ fs: this.lfs, dir: cwd, ref, checkout: true });
      return {
        stdout: `Switched to a new branch '${ref}'\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    await git.checkout({ fs: this.lfs, dir: cwd, ref });
    return {
      stdout: `Switched to branch '${ref}'\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async diff(cwd: string, _args: string[]): Promise<GitCommandResult> {
    // Basic diff showing changed files
    const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
    let output = '';

    for (const [file, head, workdir] of matrix) {
      if (head !== workdir && workdir !== 0) {
        output += `diff --git a/${file} b/${file}\n`;
        output += `--- a/${file}\n`;
        output += `+++ b/${file}\n`;
        output += `@@ (changes not shown - use status to see modified files) @@\n\n`;
      }
    }

    if (!output) {
      output = 'No changes.\n';
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async remote(cwd: string, args: string[]): Promise<GitCommandResult> {
    const [subcommand, ...rest] = args;

    if (subcommand === 'add' && rest.length >= 2) {
      const [name, url] = rest;
      await git.addRemote({ fs: this.lfs, dir: cwd, remote: name, url });
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (subcommand === 'remove' || subcommand === 'rm') {
      const name = rest[0];
      if (name) {
        await git.deleteRemote({ fs: this.lfs, dir: cwd, remote: name });
        return { stdout: '', stderr: '', exitCode: 0 };
      }
    }

    // List remotes
    const verbose = args.includes('-v') || args.includes('--verbose');
    const remotes = await git.listRemotes({ fs: this.lfs, dir: cwd });

    let output = '';
    for (const { remote, url } of remotes) {
      if (verbose) {
        output += `${remote}\t${url} (fetch)\n`;
        output += `${remote}\t${url} (push)\n`;
      } else {
        output += `${remote}\n`;
      }
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async fetch(cwd: string, args: string[]): Promise<GitCommandResult> {
    const remote = args.find((a) => !a.startsWith('-')) ?? 'origin';
    const prune = args.includes('--prune') || args.includes('-p');

    let output = `Fetching ${remote}\n`;

    const result = await git.fetch({
      fs: this.lfs,
      http: gitHttp,
      dir: cwd,
      remote,
      corsProxy: this.corsProxy,
      prune,
      onAuth: this.getOnAuth(),
      onProgress: (event) => {
        output += `${event.phase}: ${event.loaded}/${event.total}\n`;
      },
    });

    if (result.fetchHead) {
      output += `From ${remote}\n`;
      output += `   ${result.fetchHead.slice(0, 7)}..${result.fetchHeadDescription ?? ''}\n`;
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async pull(cwd: string, args: string[]): Promise<GitCommandResult> {
    const remote = args.find((a) => !a.startsWith('-')) ?? 'origin';

    let output = `Pulling from ${remote}...\n`;

    await git.pull({
      fs: this.lfs,
      http: gitHttp,
      dir: cwd,
      remote,
      corsProxy: this.corsProxy,
      author: {
        name: this.authorName,
        email: this.authorEmail,
      },
      onAuth: this.getOnAuth(),
      onProgress: (event) => {
        output += `${event.phase}: ${event.loaded}/${event.total}\n`;
      },
    });

    output += 'Already up to date.\n';
    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async push(cwd: string, args: string[]): Promise<GitCommandResult> {
    const remote = args[0] ?? 'origin';
    const branch = args[1] ?? (await git.currentBranch({ fs: this.lfs, dir: cwd }));
    const force = args.includes('-f') || args.includes('--force');

    let output = `Pushing to ${remote}...\n`;

    const result = await git.push({
      fs: this.lfs,
      http: gitHttp,
      dir: cwd,
      remote,
      ref: branch ?? undefined,
      corsProxy: this.corsProxy,
      force,
      onAuth: this.getOnAuth(),
      onProgress: (event) => {
        output += `${event.phase}: ${event.loaded}/${event.total}\n`;
      },
    });

    if (result.ok) {
      output += `To ${remote}\n`;
      output += `   ${branch} -> ${branch}\n`;
    } else {
      return {
        stdout: '',
        stderr: `error: failed to push to '${remote}': ${result.error}\n`,
        exitCode: 1,
      };
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async config(cwd: string, args: string[]): Promise<GitCommandResult> {
    const path = args.find((a) => !a.startsWith('-') && a.includes('.'));
    const value = args[args.indexOf(path ?? '') + 1];

    if (!path) {
      // List all config
      const config = await git.getConfigAll({ fs: this.lfs, dir: cwd, path: 'user.name' });
      let output = '';
      for (const v of config) {
        output += `user.name=${v}\n`;
      }
      return { stdout: output, stderr: '', exitCode: 0 };
    }

    if (value !== undefined) {
      // Handle special credential config
      if (path === 'credential.token' || path === 'github.token') {
        await this.setGithubToken(value);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      // Set config
      await git.setConfig({ fs: this.lfs, dir: cwd, path, value });
      // Update local author info if applicable
      if (path === 'user.name') this.authorName = value;
      if (path === 'user.email') this.authorEmail = value;
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // Get config
    if (path === 'credential.token' || path === 'github.token') {
      return {
        stdout: this.githubToken ? `${this.githubToken}\n` : '',
        stderr: '',
        exitCode: this.githubToken ? 0 : 1,
      };
    }
    const result = await git.getConfig({ fs: this.lfs, dir: cwd, path });
    return {
      stdout: result ? `${result}\n` : '',
      stderr: '',
      exitCode: result ? 0 : 1,
    };
  }

  private async revParse(cwd: string, args: string[]): Promise<GitCommandResult> {
    if (args.includes('--show-toplevel')) {
      try {
        const root = await git.findRoot({ fs: this.lfs, filepath: cwd });
        return { stdout: `${root}\n`, stderr: '', exitCode: 0 };
      } catch {
        return {
          stdout: '',
          stderr: 'fatal: not a git repository\n',
          exitCode: 128,
        };
      }
    }

    if (args.includes('--is-inside-work-tree')) {
      try {
        await git.findRoot({ fs: this.lfs, filepath: cwd });
        return { stdout: 'true\n', stderr: '', exitCode: 0 };
      } catch {
        return { stdout: 'false\n', stderr: '', exitCode: 0 };
      }
    }

    const ref = args.find((a) => !a.startsWith('-')) ?? 'HEAD';
    try {
      const oid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref });
      return { stdout: `${oid}\n`, stderr: '', exitCode: 0 };
    } catch {
      return {
        stdout: '',
        stderr: `fatal: ambiguous argument '${ref}'\n`,
        exitCode: 128,
      };
    }
  }

  /** Parse a flag with a value from args. */
  private parseArg(args: string[], ...flags: string[]): string | undefined {
    for (const flag of flags) {
      const idx = args.indexOf(flag);
      if (idx !== -1 && args[idx + 1]) {
        return args[idx + 1];
      }
      // Handle --flag=value format
      for (const arg of args) {
        if (arg.startsWith(`${flag}=`)) {
          return arg.slice(flag.length + 1);
        }
      }
    }
    return undefined;
  }

  /** Parse a boolean flag supporting --flag / --no-flag, with ordering. */
  private parseBooleanFlag(args: string[], flag: string, defaultValue: boolean): boolean {
    const noFlag = `--no-${flag.slice(2)}`;
    let value = defaultValue;
    for (const arg of args) {
      if (arg === flag) value = true;
      if (arg === noFlag) value = false;
    }
    return value;
  }
}

/**
 * Factory function to create GitCommands with VirtualFS.
 */
export function createGitCommands(options: GitCommandsOptions): GitCommands {
  return new GitCommands(options);
}
