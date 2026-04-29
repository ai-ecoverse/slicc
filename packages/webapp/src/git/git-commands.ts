/**
 * Git commands implementation for the virtual shell.
 *
 * Wraps isomorphic-git functions to provide a CLI-like interface
 * for git operations within the browser environment.
 */

// Buffer polyfill must be imported before isomorphic-git
import '../shims/buffer-polyfill.js';

import * as git from 'isomorphic-git';
import { VirtualFS } from '../fs/index.js';
import { GLOBAL_FS_DB_NAME } from '../fs/global-db.js';
import { gitHttp } from './git-http.js';
import { unifiedDiff, diffStat } from './diff.js';
import { createIsomorphicGitFs, type IsoGitFsPromises } from './vfs-fs-adapter.js';

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

  private lfs: IsoGitFsPromises;
  private corsProxy?: string;
  private authorName: string;
  private authorEmail: string;
  private globalDbName: string;
  /** GitHub token for authentication (avoids rate limits on public repos, required for private). */
  private githubToken?: string;

  constructor(private options: GitCommandsOptions) {
    // Route through a VirtualFS-backed adapter so isomorphic-git sees mount
    // points (File System Access API) the same way shell/agent tools do.
    // See packages/webapp/src/git/vfs-fs-adapter.ts.
    this.lfs = createIsomorphicGitFs(options.fs).promises;
    this.corsProxy = options.corsProxy;
    this.authorName = options.authorName ?? 'User';
    this.authorEmail = options.authorEmail ?? 'user@example.com';
    this.globalDbName = options.globalDbName ?? GLOBAL_FS_DB_NAME;
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
      await this.loadGithubToken();
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
        case 'show':
          return this.show(cwd, rest);
        case 'remote':
          return this.remote(cwd, rest);
        case 'fetch':
          return this.fetch(cwd, rest);
        case 'pull':
          return this.pull(cwd, rest);
        case 'push':
          return this.push(cwd, rest);
        case 'merge':
          return this.merge(cwd, rest);
        case 'reset':
          return this.reset(cwd, rest);
        case 'config':
          return this.config(cwd, rest);
        case 'tag':
          return this.tag(cwd, rest);
        case 'ls-files':
          return this.lsFiles(cwd, rest);
        case 'show-ref':
          return this.showRef(cwd, rest);
        case 'stash':
          return this.stash(cwd, rest);
        case 'rm':
          return this.rm(cwd, rest);
        case 'mv':
          return this.mv(cwd, rest);
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
  show        Show commit details and diffs
  remote      Manage remote repositories
  fetch       Download objects and refs from remote
  pull        Fetch and merge changes
  push        Update remote refs
  merge       Join two development histories together
  reset       Reset HEAD, index, and working tree
  stash       Stash changes in a dirty working directory
  rm          Remove files from the working tree and index
  mv          Move or rename a file
  tag         Create, list, or delete tags
  ls-files    Show tracked files
  show-ref    List references (branches and tags)
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
    const allFlag = args.includes('-A') || args.includes('--all');
    const updateFlag = args.includes('-u') || args.includes('--update');
    const force = args.includes('-f') || args.includes('--force');

    // Filter out flags to get file paths
    const paths = args.filter((a) => !a.startsWith('-'));

    if (!allFlag && !updateFlag && paths.length === 0) {
      return {
        stdout: '',
        stderr: 'Nothing specified, nothing added.\n',
        exitCode: 0,
      };
    }

    if (allFlag) {
      // Stage ALL changes (new, modified, deleted)
      const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
      for (const [file, , workdir, stage] of matrix) {
        if (workdir === stage) continue;
        if (workdir === 0) {
          await git.remove({ fs: this.lfs, dir: cwd, filepath: file });
        } else {
          await git.add({ fs: this.lfs, dir: cwd, filepath: file, force });
        }
      }
    } else if (paths.includes('.')) {
      // Stage new and modified files, but NOT deletions (unlike -A/--all)
      const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
      for (const [file, , workdir, stage] of matrix) {
        if (workdir === stage) continue;
        // Skip deletions — git add . does not stage removals
        if (workdir === 0) continue;
        await git.add({ fs: this.lfs, dir: cwd, filepath: file, force });
      }
    } else if (updateFlag) {
      // Stage modifications and deletions of tracked files only (no new/untracked files)
      const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
      for (const [file, head, workdir, stage] of matrix) {
        // Only tracked files (head !== 0) that have changed
        if (head === 0) continue;
        if (workdir === stage) continue;
        if (workdir === 0) {
          await git.remove({ fs: this.lfs, dir: cwd, filepath: file });
        } else {
          await git.add({ fs: this.lfs, dir: cwd, filepath: file, force });
        }
      }
    } else {
      // Add specific files
      for (const filepath of paths) {
        await git.add({ fs: this.lfs, dir: cwd, filepath, force });
      }
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private async status(cwd: string, args: string[]): Promise<GitCommandResult> {
    const short = args.includes('--short') || args.includes('-s');
    const porcelain = args.includes('--porcelain');

    if (short || porcelain) {
      return this.statusShort(cwd);
    }

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

  /**
   * Output status in short/porcelain format: `XY filename`
   * X = index status, Y = workdir status
   */
  private async statusShort(cwd: string): Promise<GitCommandResult> {
    const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
    let output = '';

    for (const [file, head, workdir, stage] of matrix) {
      let indexCode = ' ';
      let workdirCode = ' ';

      if (head === 0 && workdir === 2 && stage === 0) {
        // Untracked
        indexCode = '?';
        workdirCode = '?';
      } else if (head === 0 && workdir === 2 && stage === 2) {
        // New file, staged
        indexCode = 'A';
      } else if (head === 0 && workdir === 2 && stage === 3) {
        // New file, staged with unstaged modifications
        indexCode = 'A';
        workdirCode = 'M';
      } else if (head === 1 && workdir === 2 && stage === 1) {
        // Modified, not staged
        workdirCode = 'M';
      } else if (head === 1 && workdir === 2 && stage === 2) {
        // Modified, staged
        indexCode = 'M';
      } else if (head === 1 && workdir === 2 && stage === 3) {
        // Modified, staged with additional unstaged modifications
        indexCode = 'M';
        workdirCode = 'M';
      } else if (head === 1 && workdir === 0 && stage === 0) {
        // Deleted, staged
        indexCode = 'D';
      } else if (head === 1 && workdir === 0 && stage === 1) {
        // Deleted in workdir, not staged
        workdirCode = 'D';
      } else if (head === 1 && workdir === 1 && stage === 1) {
        // Unchanged
        continue;
      } else {
        // Fallback: skip unchanged files
        continue;
      }

      output += `${indexCode}${workdirCode} ${file}\n`;
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async commit(cwd: string, args: string[]): Promise<GitCommandResult> {
    // Handle combined -am "message" form: expand to -a -m "message"
    const expandedArgs = this.expandCombinedFlags(args);

    const message = this.parseArg(expandedArgs, '-m', '--message');

    if (!message) {
      return {
        stdout: '',
        stderr: 'error: switch `m` requires a value\n',
        exitCode: 1,
      };
    }

    const amend = expandedArgs.includes('--amend');
    const autoStage = expandedArgs.includes('-a') || expandedArgs.includes('--all');
    const allowEmpty = expandedArgs.includes('--allow-empty');

    // Auto-stage tracked modified files before committing
    if (autoStage) {
      await this.stageTrackedChanges(cwd);
    }

    // Check for empty commit if --allow-empty is not set
    if (!allowEmpty && !amend) {
      const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
      const hasStaged = matrix.some(([, head, , stage]) => stage !== head);
      if (!hasStaged) {
        return {
          stdout: '',
          stderr: 'nothing to commit, working tree clean\n',
          exitCode: 1,
        };
      }
    }

    const sha = await git.commit({
      fs: this.lfs,
      dir: cwd,
      message,
      author: {
        name: this.authorName,
        email: this.authorEmail,
      },
      amend,
      noUpdateBranch: undefined,
    });

    const shortSha = sha.slice(0, 7);
    const branch = await git.currentBranch({ fs: this.lfs, dir: cwd });

    return {
      stdout: `[${branch ?? 'HEAD'} ${shortSha}] ${message}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  /**
   * Stage all tracked files that have been modified or deleted (like `git add -u`).
   */
  private async stageTrackedChanges(cwd: string): Promise<void> {
    const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
    for (const [file, head, workdir, stage] of matrix) {
      if (head === 0) continue; // Skip untracked files
      if (workdir === stage) continue; // Skip unchanged
      if (workdir === 0) {
        await git.remove({ fs: this.lfs, dir: cwd, filepath: file });
      } else {
        await git.add({ fs: this.lfs, dir: cwd, filepath: file });
      }
    }
  }

  /**
   * Expand combined single-char flags like -am into -a -m.
   * Preserves the value that follows -m.
   */
  private expandCombinedFlags(args: string[]): string[] {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      // Match combined flags like -am, -avm, etc. (single dash, multiple letters)
      // Skip args containing '=' (e.g., -m=msg) to avoid corrupting them
      if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2 && !arg.includes('=')) {
        const flags = arg.slice(1);
        for (const ch of flags) {
          result.push(`-${ch}`);
        }
      } else {
        result.push(arg);
      }
    }
    return result;
  }

  private async log(cwd: string, args: string[]): Promise<GitCommandResult> {
    const depth = this.parseArg(args, '-n', '--max-count');
    const oneline = args.includes('--oneline');
    const showStat = args.includes('--stat');
    const reverse = args.includes('--reverse');
    const all = args.includes('--all');
    const format = this.parseArg(args, '--format', '--pretty');
    const authorFilter = this.parseArg(args, '--author');
    const grepFilter = this.parseArg(args, '--grep');

    // Detect --follow <file>: the positional arg after flags
    const followIdx = args.indexOf('--follow');
    const followFile = followIdx !== -1 ? args[followIdx + 1] : undefined;

    let commits: Awaited<ReturnType<typeof git.log>>;

    if (all) {
      commits = await this.logAllBranches(cwd, depth ? parseInt(depth, 10) : undefined);
    } else {
      commits = await git.log({
        fs: this.lfs,
        dir: cwd,
        depth: depth ? parseInt(depth, 10) : 10,
        ...(followFile ? { filepath: followFile, follow: true } : {}),
      });
    }

    // Apply --author filter
    if (authorFilter) {
      commits = commits.filter((e) => e.commit.author.name.includes(authorFilter));
    }

    // Apply --grep filter
    if (grepFilter) {
      commits = commits.filter((e) => e.commit.message.includes(grepFilter));
    }

    if (reverse) {
      commits = commits.slice().reverse();
    }

    let output = '';
    for (const entry of commits) {
      const { commit, oid } = entry;
      if (format) {
        output += this.formatLogEntry(oid, commit, format) + '\n';
      } else if (oneline) {
        output += `\x1b[33m${oid.slice(0, 7)}\x1b[0m ${commit.message.split('\n')[0]}\n`;
      } else {
        output += `\x1b[33mcommit ${oid}\x1b[0m\n`;
        output += `Author: ${commit.author.name} <${commit.author.email}>\n`;
        output += `Date:   ${new Date(commit.author.timestamp * 1000).toLocaleString()}\n\n`;
        output += `    ${commit.message.replace(/\n/g, '\n    ')}\n\n`;
      }

      if (showStat) {
        output += await this.logStatForCommit(cwd, entry);
      }
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  /**
   * Collect commits from all local branches, dedup by oid, sorted by date descending.
   */
  private async logAllBranches(
    cwd: string,
    maxCount?: number
  ): Promise<Awaited<ReturnType<typeof git.log>>> {
    const branches = await git.listBranches({ fs: this.lfs, dir: cwd });
    const seen = new Set<string>();
    const allCommits: Awaited<ReturnType<typeof git.log>> = [];

    for (const branch of branches) {
      try {
        const branchCommits = await git.log({
          fs: this.lfs,
          dir: cwd,
          ref: branch,
          depth: maxCount ?? 50,
        });
        for (const entry of branchCommits) {
          if (!seen.has(entry.oid)) {
            seen.add(entry.oid);
            allCommits.push(entry);
          }
        }
      } catch {
        // Skip branches that can't be read
      }
    }

    // Sort by timestamp descending (newest first)
    allCommits.sort((a, b) => b.commit.author.timestamp - a.commit.author.timestamp);

    if (maxCount) {
      return allCommits.slice(0, maxCount);
    }
    return allCommits;
  }

  /**
   * Format a log entry using a format string with placeholders.
   */
  private formatLogEntry(oid: string, commit: git.CommitObject, format: string): string {
    const date = new Date(commit.author.timestamp * 1000);
    return format
      .replace(/%H/g, oid)
      .replace(/%h/g, oid.slice(0, 7))
      .replace(/%s/g, commit.message.split('\n')[0])
      .replace(/%an/g, commit.author.name)
      .replace(/%ae/g, commit.author.email)
      .replace(/%ad/g, date.toLocaleString())
      .replace(/%ar/g, this.relativeDate(date));
  }

  /**
   * Compute a human-readable relative date string like "2 hours ago".
   */
  private relativeDate(date: Date): string {
    const now = Date.now();
    const diffMs = now - date.getTime();
    const seconds = Math.floor(diffMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (seconds < 60) return `${seconds} seconds ago`;
    if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
    if (weeks < 4) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
    if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
    return `${years} year${years !== 1 ? 's' : ''} ago`;
  }

  /**
   * Produce --stat output for a single commit by diffing against its parent.
   */
  private async logStatForCommit(
    cwd: string,
    entry: Awaited<ReturnType<typeof git.log>>[0]
  ): Promise<string> {
    const { commit, oid } = entry;
    const parentOid = commit.parent.length > 0 ? commit.parent[0] : undefined;

    if (parentOid) {
      const result = await this.diffCommits(cwd, parentOid, oid, { nameOnly: false, stat: true });
      return result.stdout;
    }

    // Initial commit: diff against empty tree
    return await this.diffInitialCommit(cwd, oid, true);
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

    // Detect file restoration mode: git checkout [<commit>] -- <file>...
    const ddIdx = args.indexOf('--');
    if (ddIdx !== -1) {
      const filePaths = args.slice(ddIdx + 1);
      if (filePaths.length === 0) {
        return {
          stdout: '',
          stderr: 'error: you must specify path(s) to restore\n',
          exitCode: 1,
        };
      }
      // Check for optional commit ref before --
      const preArgs = args.slice(0, ddIdx).filter((a) => !a.startsWith('-'));
      const commitRef = preArgs[0]; // e.g., git checkout abc123 -- file.txt
      return this.checkoutFiles(cwd, filePaths, commitRef);
    }

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

  /**
   * Restore files from a commit (or HEAD if no commit specified).
   * Reads the blob from the commit tree and writes it to the working directory.
   */
  private async checkoutFiles(
    cwd: string,
    filePaths: string[],
    commitRef?: string
  ): Promise<GitCommandResult> {
    const ref = commitRef ?? 'HEAD';
    const oid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref });

    for (const filepath of filePaths) {
      const { blob } = await git.readBlob({ fs: this.lfs, dir: cwd, oid, filepath });
      // Ensure parent directory exists
      const slashIdx = filepath.lastIndexOf('/');
      if (slashIdx !== -1) {
        await this.options.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
      }
      await this.options.fs.writeFile(`${cwd}/${filepath}`, blob);
      // Also update the index to match
      await git.add({ fs: this.lfs, dir: cwd, filepath });
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private async diff(cwd: string, args: string[]): Promise<GitCommandResult> {
    const staged = args.includes('--staged') || args.includes('--cached');
    const nameOnly = args.includes('--name-only');
    const showStat = args.includes('--stat');

    // Check for commit-to-commit diff: git diff <commit1> <commit2>
    const nonFlags = args.filter((a) => !a.startsWith('-'));
    if (nonFlags.length >= 2) {
      return this.diffCommits(cwd, nonFlags[0], nonFlags[1], { nameOnly, stat: showStat });
    }

    type FileChange = {
      filepath: string;
      oldContent: string;
      newContent: string;
    };

    const changes: FileChange[] = [];

    if (staged) {
      // --staged: compare HEAD tree vs index using walk
      await git.walk({
        fs: this.lfs,
        dir: cwd,
        trees: [git.TREE({ ref: 'HEAD' }), git.STAGE()],
        map: async (filepath, [headEntry, stageEntry]) => {
          if (filepath === '.' || filepath.startsWith('.git')) return undefined;
          const headType = headEntry ? await headEntry.type() : undefined;
          const stageType = stageEntry ? await stageEntry.type() : undefined;
          if (headType === 'tree' || stageType === 'tree') return undefined;

          const headOid = headEntry ? await headEntry.oid() : undefined;
          const stageOid = stageEntry ? await stageEntry.oid() : undefined;
          if (headOid === stageOid) return undefined;

          let oldText = '';
          if (headOid) {
            try {
              const { blob } = await git.readBlob({ fs: this.lfs, dir: cwd, oid: headOid });
              oldText = new TextDecoder().decode(blob);
            } catch {
              /* not in HEAD */
            }
          }

          let newText = '';
          if (stageOid) {
            try {
              const { blob } = await git.readBlob({ fs: this.lfs, dir: cwd, oid: stageOid });
              newText = new TextDecoder().decode(blob);
            } catch {
              /* not in stage */
            }
          }

          changes.push({ filepath, oldContent: oldText, newContent: newText });
          return undefined;
        },
      });
    } else {
      // Default: compare index (stage) vs workdir — shows only unstaged changes
      // Collect all index entries with their OIDs
      const indexEntries = new Map<string, string>();
      await git.walk({
        fs: this.lfs,
        dir: cwd,
        trees: [git.STAGE()],
        map: async (filepath, [entry]) => {
          if (filepath === '.' || filepath.startsWith('.git') || !entry) return undefined;
          const type = await entry.type();
          if (type !== 'blob') return undefined;
          const oid = await entry.oid();
          if (oid) indexEntries.set(filepath, oid);
          return undefined;
        },
      });

      // Compare each index entry with workdir content directly
      // (bypasses statusMatrix stat-caching issues for same-length modifications)
      for (const [file, stageOid] of indexEntries) {
        let oldText = '';
        try {
          const { blob } = await git.readBlob({ fs: this.lfs, dir: cwd, oid: stageOid });
          oldText = new TextDecoder().decode(blob);
        } catch {
          /* not readable */
        }

        let newText = '';
        try {
          newText = await this.options.fs.readTextFile(`${cwd}/${file}`);
        } catch {
          /* file deleted in workdir */
        }

        if (oldText !== newText) {
          changes.push({ filepath: file, oldContent: oldText, newContent: newText });
        }
      }

      // Also check for tracked files deleted in workdir but still in index
      // (handled above since deleted workdir files would have newText = '')
    }

    if (changes.length === 0) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (nameOnly) {
      const output = changes.map((c) => c.filepath).join('\n') + '\n';
      return { stdout: output, stderr: '', exitCode: 0 };
    }

    if (showStat) {
      return this.formatDiffStat(changes);
    }

    // Full unified diff
    let output = '';
    for (const change of changes) {
      output += unifiedDiff({
        oldContent: change.oldContent,
        newContent: change.newContent,
        oldName: change.filepath,
        newName: change.filepath,
      });
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async diffCommits(
    cwd: string,
    ref1: string,
    ref2: string,
    opts: { nameOnly: boolean; stat: boolean }
  ): Promise<GitCommandResult> {
    // Resolve short SHAs to full OIDs
    let resolvedRef1 = ref1;
    let resolvedRef2 = ref2;
    try {
      resolvedRef1 = await git.expandOid({ fs: this.lfs, dir: cwd, oid: ref1 });
    } catch {
      // Not a short OID, try as branch/tag ref
      try {
        resolvedRef1 = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: ref1 });
      } catch {
        /* use as-is */
      }
    }
    try {
      resolvedRef2 = await git.expandOid({ fs: this.lfs, dir: cwd, oid: ref2 });
    } catch {
      try {
        resolvedRef2 = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: ref2 });
      } catch {
        /* use as-is */
      }
    }

    type FileChange = {
      filepath: string;
      oldContent: string;
      newContent: string;
    };

    const changes: FileChange[] = [];

    await git.walk({
      fs: this.lfs,
      dir: cwd,
      trees: [git.TREE({ ref: resolvedRef1 }), git.TREE({ ref: resolvedRef2 })],
      map: async (filepath, [entry1, entry2]) => {
        if (filepath === '.') return undefined;

        const type1 = entry1 ? await entry1.type() : undefined;
        const type2 = entry2 ? await entry2.type() : undefined;

        if (type1 === 'tree' || type2 === 'tree') return undefined;

        const oid1 = entry1 ? await entry1.oid() : undefined;
        const oid2 = entry2 ? await entry2.oid() : undefined;

        if (oid1 === oid2) return undefined;

        const content1 = entry1 ? await entry1.content() : undefined;
        const content2 = entry2 ? await entry2.content() : undefined;

        const oldText = content1 ? new TextDecoder().decode(content1) : '';
        const newText = content2 ? new TextDecoder().decode(content2) : '';

        changes.push({ filepath, oldContent: oldText, newContent: newText });
        return undefined;
      },
    });

    if (changes.length === 0) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (opts.nameOnly) {
      const output = changes.map((c) => c.filepath).join('\n') + '\n';
      return { stdout: output, stderr: '', exitCode: 0 };
    }

    if (opts.stat) {
      return this.formatDiffStat(changes);
    }

    let output = '';
    for (const change of changes) {
      output += unifiedDiff({
        oldContent: change.oldContent,
        newContent: change.newContent,
        oldName: change.filepath,
        newName: change.filepath,
      });
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private formatDiffStat(
    changes: { filepath: string; oldContent: string; newContent: string }[]
  ): GitCommandResult {
    const RED = '\x1b[31m';
    const GREEN = '\x1b[32m';
    const RESET = '\x1b[0m';

    let output = '';
    let totalInsertions = 0;
    let totalDeletions = 0;
    let maxNameLen = 0;

    const stats = changes.map((c) => {
      const s = diffStat(c.oldContent, c.newContent);
      if (c.filepath.length > maxNameLen) maxNameLen = c.filepath.length;
      totalInsertions += s.insertions;
      totalDeletions += s.deletions;
      return { filepath: c.filepath, ...s };
    });

    for (const s of stats) {
      const total = s.insertions + s.deletions;
      const bar = `${GREEN}${'+'.repeat(s.insertions)}${RESET}${RED}${'-'.repeat(s.deletions)}${RESET}`;
      output += ` ${s.filepath.padEnd(maxNameLen)} | ${String(total).padStart(4)} ${bar}\n`;
    }

    output += ` ${changes.length} file${changes.length !== 1 ? 's' : ''} changed`;
    if (totalInsertions > 0)
      output += `, ${totalInsertions} insertion${totalInsertions !== 1 ? 's' : ''}(+)`;
    if (totalDeletions > 0)
      output += `, ${totalDeletions} deletion${totalDeletions !== 1 ? 's' : ''}(-)`;
    output += '\n';

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async show(cwd: string, args: string[]): Promise<GitCommandResult> {
    const stat = args.includes('--stat');
    const format = this.parseArg(args, '--format', '--pretty');
    const flagsWithValues = new Set(['--format', '--pretty']);
    let ref: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('-')) {
        if (flagsWithValues.has(arg)) i++;
        continue;
      }
      ref = arg;
      break;
    }

    // Handle <commit>:<path> syntax — show file content at a commit
    if (ref && ref.includes(':')) {
      return await this.showFileAtCommit(cwd, ref);
    }

    const commitRef = ref ?? 'HEAD';
    let oid: string;
    try {
      oid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: commitRef });
    } catch {
      // Try expanding as a short OID
      try {
        oid = await git.expandOid({ fs: this.lfs, dir: cwd, oid: commitRef });
      } catch {
        return {
          stdout: '',
          stderr: `fatal: bad object ${commitRef}\n`,
          exitCode: 128,
        };
      }
    }

    const { commit } = await git.readCommit({ fs: this.lfs, dir: cwd, oid });

    let output = this.formatShowHeader(oid, commit, format);

    // Compute diff against parent
    const parentOid = commit.parent.length > 0 ? commit.parent[0] : undefined;

    if (parentOid) {
      const diffResult = await this.diffCommits(cwd, parentOid, oid, { nameOnly: false, stat });
      output += diffResult.stdout;
    } else {
      // Initial commit: diff against empty tree
      const diffResult = await this.diffInitialCommit(cwd, oid, stat);
      output += diffResult;
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async showFileAtCommit(cwd: string, refPath: string): Promise<GitCommandResult> {
    const colonIdx = refPath.indexOf(':');
    const commitRef = refPath.slice(0, colonIdx) || 'HEAD';
    const filepath = refPath.slice(colonIdx + 1);
    const oid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: commitRef });
    const result = await git.readBlob({ fs: this.lfs, dir: cwd, oid, filepath });
    const content = new TextDecoder().decode(result.blob);
    return { stdout: content, stderr: '', exitCode: 0 };
  }

  private formatShowHeader(oid: string, commit: git.CommitObject, format?: string): string {
    if (format) {
      return (
        format
          .replace(/%H/g, oid)
          .replace(/%h/g, oid.slice(0, 7))
          .replace(/%s/g, commit.message.split('\n')[0])
          .replace(/%an/g, commit.author.name)
          .replace(/%ae/g, commit.author.email)
          .replace(/%ad/g, new Date(commit.author.timestamp * 1000).toLocaleString()) + '\n'
      );
    }
    let output = `\x1b[33mcommit ${oid}\x1b[0m\n`;
    output += `Author: ${commit.author.name} <${commit.author.email}>\n`;
    output += `Date:   ${new Date(commit.author.timestamp * 1000).toLocaleString()}\n\n`;
    output += `    ${commit.message.replace(/\n/g, '\n    ')}\n\n`;
    return output;
  }

  private async diffInitialCommit(cwd: string, commitOid: string, stat: boolean): Promise<string> {
    type FileEntry = { filepath: string; content: string };
    const files: FileEntry[] = [];

    await git.walk({
      fs: this.lfs,
      dir: cwd,
      trees: [git.TREE({ ref: commitOid })],
      map: async (filepath, [entry]) => {
        if (filepath === '.' || !entry) return undefined;
        const type = await entry.type();
        if (type !== 'blob') return undefined;
        const content = await entry.content();
        if (!content) return undefined;
        files.push({ filepath, content: new TextDecoder().decode(content) });
        return undefined;
      },
    });

    if (files.length === 0) return '';

    if (stat) {
      const changes = files.map((f) => ({
        filepath: f.filepath,
        oldContent: '',
        newContent: f.content,
      }));
      return this.formatDiffStat(changes).stdout;
    }

    let output = '';
    for (const file of files) {
      output += unifiedDiff({
        oldContent: '',
        newContent: file.content,
        oldName: file.filepath,
        newName: file.filepath,
      });
    }
    return output;
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
    const force = args.includes('-f') || args.includes('--force');
    const setUpstream = args.includes('-u') || args.includes('--set-upstream');

    // Extract positional args (skip flags)
    const positional = args.filter((a) => !a.startsWith('-'));
    const remote = positional[0] ?? 'origin';
    const branch = positional[1] ?? (await git.currentBranch({ fs: this.lfs, dir: cwd }));

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

      // Set upstream tracking if -u/--set-upstream was specified
      if (setUpstream && branch) {
        await git.setConfig({
          fs: this.lfs,
          dir: cwd,
          path: `branch.${branch}.remote`,
          value: remote,
        });
        await git.setConfig({
          fs: this.lfs,
          dir: cwd,
          path: `branch.${branch}.merge`,
          value: `refs/heads/${branch}`,
        });
        output += `Branch '${branch}' set up to track remote branch '${branch}' from '${remote}'.\n`;
      }
    } else {
      return {
        stdout: '',
        stderr: `error: failed to push to '${remote}': ${result.error}\n`,
        exitCode: 1,
      };
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async merge(cwd: string, args: string[]): Promise<GitCommandResult> {
    const noFf = args.includes('--no-ff');
    const ffOnly = args.includes('--ff-only');
    const theirs = args.find((a) => !a.startsWith('-'));

    if (!theirs) {
      return {
        stdout: '',
        stderr: 'fatal: No branch specified to merge.\n',
        exitCode: 128,
      };
    }

    try {
      const result = await git.merge({
        fs: this.lfs,
        dir: cwd,
        ours: (await git.currentBranch({ fs: this.lfs, dir: cwd })) ?? undefined,
        theirs,
        fastForward: !noFf,
        fastForwardOnly: ffOnly,
        author: {
          name: this.authorName,
          email: this.authorEmail,
        },
        abortOnConflict: true,
      });

      if (result.alreadyMerged) {
        return { stdout: 'Already up to date.\n', stderr: '', exitCode: 0 };
      }

      if (result.fastForward) {
        // Fast-forward: update the working directory to match the new HEAD
        await git.checkout({
          fs: this.lfs,
          dir: cwd,
          ref: (await git.currentBranch({ fs: this.lfs, dir: cwd })) ?? 'HEAD',
        });
        return {
          stdout: `Updating..${result.oid ? result.oid.slice(0, 7) : ''}\nFast-forward\n`,
          stderr: '',
          exitCode: 0,
        };
      }

      if (result.mergeCommit) {
        // Merge commit created — checkout the working directory
        await git.checkout({
          fs: this.lfs,
          dir: cwd,
          ref: (await git.currentBranch({ fs: this.lfs, dir: cwd })) ?? 'HEAD',
        });
        return {
          stdout: `Merge made by the 'ort' strategy.\n`,
          stderr: '',
          exitCode: 0,
        };
      }

      return { stdout: 'Merge complete.\n', stderr: '', exitCode: 0 };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'MergeConflictError') {
        const data = (err as Error & { data?: { filepaths?: string[] } }).data;
        const files = data?.filepaths ?? [];
        let output = 'Auto-merging failed. Fix conflicts and then commit the result.\n';
        if (files.length > 0) {
          output += 'CONFLICT (content): Merge conflict in:\n';
          for (const f of files) {
            output += `  ${f}\n`;
          }
        }
        return { stdout: '', stderr: output, exitCode: 1 };
      }
      if (err instanceof Error && err.name === 'MergeNotSupportedError') {
        return {
          stdout: '',
          stderr: 'fatal: merge is not possible because you have unmerged files.\n',
          exitCode: 128,
        };
      }
      if (err instanceof Error && err.name === 'FastForwardError') {
        return {
          stdout: '',
          stderr: 'fatal: Not possible to fast-forward, aborting.\n',
          exitCode: 128,
        };
      }
      throw err;
    }
  }

  private async tag(cwd: string, args: string[]): Promise<GitCommandResult> {
    const deleteFlag = args.includes('-d') || args.includes('--delete');
    const listPattern = this.parseArg(args, '-l', '--list');
    const annotate = args.includes('-a') || args.includes('--annotate');
    const message = this.parseArg(args, '-m', '--message');
    const force = args.includes('-f') || args.includes('--force');

    // Collect positional args (not flags or their values)
    const flagsWithValues = new Set(['-l', '--list', '-m', '--message']);
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('-')) {
        if (flagsWithValues.has(arg)) i++; // skip value
        continue;
      }
      positional.push(arg);
    }

    // Delete tag
    if (deleteFlag) {
      const tagName = positional[0];
      if (!tagName) {
        return { stdout: '', stderr: 'fatal: tag name required\n', exitCode: 128 };
      }
      await git.deleteTag({ fs: this.lfs, dir: cwd, ref: tagName });
      return { stdout: `Deleted tag '${tagName}'\n`, stderr: '', exitCode: 0 };
    }

    // List tags (with optional pattern)
    if (listPattern !== undefined || positional.length === 0) {
      const tags = await git.listTags({ fs: this.lfs, dir: cwd });
      let filtered = tags;
      const pattern = listPattern || undefined;
      if (pattern) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        filtered = tags.filter((t) => regex.test(t));
      }
      const output = filtered.map((t) => `${t}\n`).join('');
      return { stdout: output, stderr: '', exitCode: 0 };
    }

    // Create tag
    const tagName = positional[0];
    const target = positional[1]; // optional commit

    if (annotate || message) {
      // Annotated tag
      await git.annotatedTag({
        fs: this.lfs,
        dir: cwd,
        ref: tagName,
        message: message ?? tagName,
        object: target,
        tagger: {
          name: this.authorName,
          email: this.authorEmail,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: 0,
        },
        force,
      });
    } else {
      // Lightweight tag
      await git.tag({
        fs: this.lfs,
        dir: cwd,
        ref: tagName,
        object: target,
        force,
      });
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private async lsFiles(cwd: string, args: string[]): Promise<GitCommandResult> {
    const modified = args.includes('--modified') || args.includes('-m');
    const others = args.includes('--others') || args.includes('-o');
    const deleted = args.includes('--deleted') || args.includes('-d');
    // --cached/-c is the default behavior

    const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
    const files: string[] = [];

    for (const [file, head, workdir, stage] of matrix) {
      if (others) {
        // Untracked files: not in HEAD and not in index
        if (head === 0 && stage === 0 && workdir === 2) {
          files.push(file);
        }
      } else if (modified) {
        // Modified in workdir vs index
        if (workdir !== 0 && workdir !== stage && head !== 0) {
          files.push(file);
        }
      } else if (deleted) {
        // Deleted from workdir but still tracked
        if (workdir === 0 && (head !== 0 || stage !== 0)) {
          files.push(file);
        }
      } else {
        // Default (--cached): files in the index
        if (stage !== 0 || head !== 0) {
          // Show files that are tracked (in HEAD or staged)
          if (workdir === 0 && stage === 0 && head !== 0) {
            // Deleted and staged for removal — still in HEAD but removed from index
            // Don't show these as "cached"
          } else if (stage !== 0) {
            files.push(file);
          } else if (head !== 0 && workdir !== 0) {
            // In HEAD and still in workdir (not staged but tracked)
            files.push(file);
          }
        }
      }
    }

    files.sort();
    const output = files.map((f) => `${f}\n`).join('');
    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async showRef(cwd: string, args: string[]): Promise<GitCommandResult> {
    const headsOnly = args.includes('--heads');
    const tagsOnly = args.includes('--tags');
    const pattern = args.find((a) => !a.startsWith('-'));

    let output = '';

    if (!tagsOnly) {
      const branches = await git.listBranches({ fs: this.lfs, dir: cwd });
      for (const branch of branches) {
        const oid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: branch });
        const refPath = `refs/heads/${branch}`;
        if (pattern && !refPath.includes(pattern)) continue;
        output += `${oid} ${refPath}\n`;
      }
    }

    if (!headsOnly) {
      const tags = await git.listTags({ fs: this.lfs, dir: cwd });
      for (const tag of tags) {
        const oid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: tag });
        const refPath = `refs/tags/${tag}`;
        if (pattern && !refPath.includes(pattern)) continue;
        output += `${oid} ${refPath}\n`;
      }
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async config(cwd: string, args: string[]): Promise<GitCommandResult> {
    const listFlag = args.includes('--list') || args.includes('-l');
    const unsetFlag = args.includes('--unset');
    const globalFlag = args.includes('--global');

    // Find the config key (contains a dot, not a flag)
    const path = args.find((a) => !a.startsWith('-') && a.includes('.'));

    // --list: show all config entries
    if (listFlag) {
      return this.configList(cwd, globalFlag);
    }

    // --unset: remove a config entry
    if (unsetFlag) {
      if (!path) {
        return { stdout: '', stderr: 'error: key required for --unset\n', exitCode: 1 };
      }
      if (path === 'credential.token' || path === 'github.token') {
        await this.setGithubToken('');
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (globalFlag) {
        const globalFs = await this.getGlobalFs();
        try {
          const content = await globalFs.readTextFile('/workspace/.gitconfig');
          const newContent = this.removeConfigKey(content, path);
          await globalFs.writeFile('/workspace/.gitconfig', newContent);
        } catch {
          /* file may not exist */
        }
      } else {
        // isomorphic-git doesn't have a deleteConfig, so we set to empty then remove from file
        try {
          const configPath = `${cwd}/.git/config`;
          const content = await this.options.fs.readTextFile(configPath);
          const newContent = this.removeConfigKey(content, path);
          await this.options.fs.writeFile(configPath, newContent);
        } catch {
          /* ignore */
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (!path) {
      // No key and no --list: show usage hint
      return {
        stdout: '',
        stderr: 'usage: git config [--global] [--list] [--unset] <key> [<value>]\n',
        exitCode: 1,
      };
    }

    // Find value: the arg after the key that is not a flag
    const pathIdx = args.indexOf(path);
    let value: string | undefined;
    for (let i = pathIdx + 1; i < args.length; i++) {
      if (!args[i].startsWith('-')) {
        value = args[i];
        break;
      }
    }

    if (value !== undefined) {
      // Handle special credential config
      if (path === 'credential.token' || path === 'github.token') {
        await this.setGithubToken(value);
        return { stdout: '', stderr: '', exitCode: 0 };
      }

      if (globalFlag) {
        // Store in global config file
        await this.setGlobalConfig(path, value);
      } else {
        // Set config in repo
        await git.setConfig({ fs: this.lfs, dir: cwd, path, value });
      }
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

    // When --global, only read global config; otherwise try repo first, then global
    let result: string | undefined;
    if (globalFlag) {
      result = await this.getGlobalConfig(path);
    } else {
      result = await git.getConfig({ fs: this.lfs, dir: cwd, path });
      if (!result) {
        result = await this.getGlobalConfig(path);
      }
    }

    return {
      stdout: result ? `${result}\n` : '',
      stderr: '',
      exitCode: result ? 0 : 1,
    };
  }

  /**
   * List all config entries from .git/config (and optionally global config).
   */
  private async configList(cwd: string, globalOnly: boolean): Promise<GitCommandResult> {
    let output = '';

    if (!globalOnly) {
      // Read repo config
      try {
        const configPath = `${cwd}/.git/config`;
        const content = await this.options.fs.readTextFile(configPath);
        output += this.parseGitConfigToList(content);
      } catch {
        /* no config file */
      }
    }

    // Read global config
    try {
      const globalFs = await this.getGlobalFs();
      const content = await globalFs.readTextFile('/workspace/.gitconfig');
      output += this.parseGitConfigToList(content);
    } catch {
      /* no global config */
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  /**
   * Parse a git config INI file and return key=value lines.
   */
  private parseGitConfigToList(content: string): string {
    let output = '';
    let section = '';
    let subsection = '';

    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;

      const sectionMatch = line.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
      if (sectionMatch) {
        section = sectionMatch[1].toLowerCase();
        subsection = sectionMatch[2] ?? '';
        continue;
      }

      const kvMatch = line.match(/^(\w+)\s*=\s*(.*)$/);
      if (kvMatch && section) {
        const key = kvMatch[1];
        const value = kvMatch[2].trim();
        const fullKey = subsection ? `${section}.${subsection}.${key}` : `${section}.${key}`;
        output += `${fullKey}=${value}\n`;
      }
    }

    return output;
  }

  /**
   * Remove a key from git config INI content.
   */
  private removeConfigKey(content: string, key: string): string {
    const parts = key.split('.');
    const targetKey = parts.pop()!;
    const targetSection = parts.join('.');

    const lines = content.split('\n');
    const result: string[] = [];
    let currentSection = '';

    for (const line of lines) {
      const trimmed = line.trim();
      const sectionMatch = trimmed.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
      if (sectionMatch) {
        const sec = sectionMatch[1].toLowerCase();
        const sub = sectionMatch[2] ?? '';
        currentSection = sub ? `${sec}.${sub}` : sec;
        result.push(line);
        continue;
      }

      if (currentSection === targetSection) {
        const kvMatch = trimmed.match(/^(\w+)\s*=/);
        if (kvMatch && kvMatch[1] === targetKey) {
          continue; // Skip this line (remove it)
        }
      }

      result.push(line);
    }

    return result.join('\n');
  }

  /**
   * Set a value in the global config file.
   */
  private async setGlobalConfig(key: string, value: string): Promise<void> {
    const globalFs = await this.getGlobalFs();
    const configPath = '/workspace/.gitconfig';

    let content = '';
    try {
      content = await globalFs.readTextFile(configPath);
    } catch {
      /* file doesn't exist yet */
    }

    const parts = key.split('.');
    const configKey = parts.pop()!;
    const section = parts.join('.');

    // Try to update existing key in the right section
    const lines = content.split('\n');
    let currentSection = '';
    let found = false;
    let sectionExists = false;

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      const sectionMatch = trimmed.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
      if (sectionMatch) {
        const sec = sectionMatch[1].toLowerCase();
        const sub = sectionMatch[2] ?? '';
        currentSection = sub ? `${sec}.${sub}` : sec;
        if (currentSection === section) sectionExists = true;
        continue;
      }

      if (currentSection === section) {
        const kvMatch = trimmed.match(/^(\w+)\s*=/);
        if (kvMatch && kvMatch[1] === configKey) {
          lines[i] = `\t${configKey} = ${value}`;
          found = true;
          break;
        }
      }
    }

    if (found) {
      await globalFs.writeFile(configPath, lines.join('\n'));
      return;
    }

    if (sectionExists) {
      // Add key to existing section
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        const sectionMatch = trimmed.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
        if (sectionMatch) {
          const sec = sectionMatch[1].toLowerCase();
          const sub = sectionMatch[2] ?? '';
          const cs = sub ? `${sec}.${sub}` : sec;
          if (cs === section) {
            lines.splice(i + 1, 0, `\t${configKey} = ${value}`);
            break;
          }
        }
      }
      await globalFs.writeFile(configPath, lines.join('\n'));
      return;
    }

    // Create new section
    const sectionParts = section.split('.');
    let sectionHeader: string;
    if (sectionParts.length > 1) {
      sectionHeader = `[${sectionParts[0]} "${sectionParts.slice(1).join('.')}"]`;
    } else {
      sectionHeader = `[${section}]`;
    }
    const newContent = content
      ? content.trimEnd() + `\n${sectionHeader}\n\t${configKey} = ${value}\n`
      : `${sectionHeader}\n\t${configKey} = ${value}\n`;
    await globalFs.writeFile(configPath, newContent);
  }

  /**
   * Get a value from the global config file.
   */
  private async getGlobalConfig(key: string): Promise<string | undefined> {
    const globalFs = await this.getGlobalFs();
    try {
      const content = await globalFs.readTextFile('/workspace/.gitconfig');
      const parts = key.split('.');
      const configKey = parts.pop()!;
      const section = parts.join('.');

      let currentSection = '';
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        const sectionMatch = line.match(/^\[(\w+)(?:\s+"([^"]*)")?\]$/);
        if (sectionMatch) {
          const sec = sectionMatch[1].toLowerCase();
          const sub = sectionMatch[2] ?? '';
          currentSection = sub ? `${sec}.${sub}` : sec;
          continue;
        }
        if (currentSection === section) {
          const kvMatch = line.match(/^(\w+)\s*=\s*(.*)$/);
          if (kvMatch && kvMatch[1] === configKey) {
            return kvMatch[2].trim();
          }
        }
      }
    } catch {
      /* no global config */
    }
    return undefined;
  }

  private async reset(cwd: string, args: string[]): Promise<GitCommandResult> {
    const soft = args.includes('--soft');
    const hard = args.includes('--hard');
    const mixed = args.includes('--mixed');

    const positional = args.filter((a) => !a.startsWith('-'));
    const hasMode = soft || hard || mixed;

    if (!hasMode && positional.length === 0) {
      // "git reset" with no args — unstage all files
      const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
      for (const [file, head, , stage] of matrix) {
        if (stage !== head) {
          await git.resetIndex({ fs: this.lfs, dir: cwd, filepath: file });
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    if (!hasMode) {
      // File-level reset: "git reset <file>" or "git reset HEAD <file>"
      const files = positional.filter((a) => a !== 'HEAD');
      if (files.length === 0) {
        // "git reset HEAD" — unstage all
        const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
        for (const [file, head, , stage] of matrix) {
          if (stage !== head) {
            await git.resetIndex({ fs: this.lfs, dir: cwd, filepath: file });
          }
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      for (const file of files) {
        await git.resetIndex({ fs: this.lfs, dir: cwd, filepath: file });
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // Commit-level reset: --soft, --mixed, or --hard
    const targetRef = positional[0] ?? 'HEAD';
    const targetOid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: targetRef });
    const branch = await git.currentBranch({ fs: this.lfs, dir: cwd, fullname: true });

    if (!branch) {
      return {
        stdout: '',
        stderr: 'fatal: not on a branch, cannot reset\n',
        exitCode: 128,
      };
    }

    // Move branch pointer to the target commit
    await git.writeRef({
      fs: this.lfs,
      dir: cwd,
      ref: branch,
      value: targetOid,
      force: true,
    });

    if (soft) {
      return { stdout: `HEAD is now at ${targetOid.slice(0, 7)}\n`, stderr: '', exitCode: 0 };
    }

    // --mixed (default) or --hard: reset index to match the target commit
    // Collect previously tracked files before resetting index (needed for --hard cleanup)
    const previouslyTracked = new Set(await git.listFiles({ fs: this.lfs, dir: cwd }));
    for (const file of previouslyTracked) {
      await git.remove({ fs: this.lfs, dir: cwd, filepath: file });
    }
    await this.resetIndexToCommit(cwd, targetOid);

    if (!hard) {
      return { stdout: `HEAD is now at ${targetOid.slice(0, 7)}\n`, stderr: '', exitCode: 0 };
    }

    // --hard: also restore workdir to match the target commit
    await this.resetWorkdirToCommit(cwd, targetOid, previouslyTracked);

    return { stdout: `HEAD is now at ${targetOid.slice(0, 7)}\n`, stderr: '', exitCode: 0 };
  }

  private async resetIndexToCommit(cwd: string, oid: string): Promise<void> {
    const { tree } = await git.readTree({ fs: this.lfs, dir: cwd, oid });
    await this.addTreeToIndex(cwd, oid, tree, '');
  }

  private async addTreeToIndex(
    cwd: string,
    commitOid: string,
    tree: Array<{ mode: string; path: string; oid: string; type: string }>,
    prefix: string
  ): Promise<void> {
    for (const entry of tree) {
      const filepath = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'blob') {
        await git.resetIndex({ fs: this.lfs, dir: cwd, filepath, ref: commitOid });
      } else if (entry.type === 'tree') {
        const { tree: subtree } = await git.readTree({
          fs: this.lfs,
          dir: cwd,
          oid: entry.oid,
        });
        await this.addTreeToIndex(cwd, commitOid, subtree, filepath);
      }
    }
  }

  private async resetWorkdirToCommit(
    cwd: string,
    oid: string,
    previouslyTracked: Set<string>
  ): Promise<void> {
    const targetFiles = new Set<string>();
    const { tree } = await git.readTree({ fs: this.lfs, dir: cwd, oid });
    await this.collectTreeFiles(cwd, tree, '', targetFiles);

    for (const filepath of targetFiles) {
      const { blob } = await git.readBlob({ fs: this.lfs, dir: cwd, oid, filepath });
      const slashIdx = filepath.lastIndexOf('/');
      if (slashIdx !== -1) {
        await this.options.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
      }
      await this.options.fs.writeFile(`${cwd}/${filepath}`, blob);
    }

    // Remove previously-tracked workdir files not in the target commit
    // Only remove files that were tracked before the reset — skip untracked files
    for (const file of previouslyTracked) {
      if (!targetFiles.has(file)) {
        try {
          await this.options.fs.rm(`${cwd}/${file}`);
        } catch {
          // ignore
        }
      }
    }
  }

  private async collectTreeFiles(
    cwd: string,
    tree: Array<{ mode: string; path: string; oid: string; type: string }>,
    prefix: string,
    files: Set<string>
  ): Promise<void> {
    for (const entry of tree) {
      const filepath = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'blob') {
        files.add(filepath);
      } else if (entry.type === 'tree') {
        const { tree: subtree } = await git.readTree({
          fs: this.lfs,
          dir: cwd,
          oid: entry.oid,
        });
        await this.collectTreeFiles(cwd, subtree, filepath, files);
      }
    }
  }

  private async stash(cwd: string, args: string[]): Promise<GitCommandResult> {
    const subcommand = args[0];

    if (!subcommand || subcommand.startsWith('-')) {
      return this.stashPush(cwd, args);
    }

    switch (subcommand) {
      case 'push':
      case 'save':
        return this.stashPush(cwd, args.slice(1));
      case 'pop':
        return this.stashPop(cwd);
      case 'list':
        return this.stashList(cwd);
      case 'drop':
        return this.stashDrop(cwd, args.slice(1));
      case 'show':
        return this.stashShow(cwd);
      default:
        return { stdout: '', stderr: `error: unknown subcommand: ${subcommand}\n`, exitCode: 1 };
    }
  }

  private async stashPush(cwd: string, _args: string[]): Promise<GitCommandResult> {
    const branch = (await git.currentBranch({ fs: this.lfs, dir: cwd })) ?? 'HEAD';
    let headOid: string;
    try {
      headOid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: 'HEAD' });
    } catch {
      return { stdout: '', stderr: 'fatal: cannot stash without a HEAD commit\n', exitCode: 128 };
    }

    // Detect dirty files by directly comparing HEAD content with VFS content.
    // statusMatrix may miss workdir modifications due to LightningFS stat caching.
    const headFiles = await git.listFiles({ fs: this.lfs, dir: cwd, ref: 'HEAD' });
    const indexFiles = await git.listFiles({ fs: this.lfs, dir: cwd });
    const allTracked = new Set([...headFiles, ...indexFiles]);

    // Also detect newly staged files via statusMatrix
    const matrix = await git.statusMatrix({ fs: this.lfs, dir: cwd });
    for (const [file, head, , stage] of matrix) {
      if (head === 0 && stage !== 0) allTracked.add(file);
    }

    type DirtyFile = { file: string; inHead: boolean; existsInWorkdir: boolean };
    const dirtyFiles: DirtyFile[] = [];
    const indexEntries: { filepath: string; oid: string }[] = [];

    for (const filepath of allTracked) {
      const inHead = headFiles.includes(filepath);

      let workdirContent: string | undefined;
      try {
        workdirContent = await this.options.fs.readTextFile(`${cwd}/${filepath}`);
      } catch {
        /* file doesn't exist in workdir */
      }

      if (inHead) {
        const { blob } = await git.readBlob({ fs: this.lfs, dir: cwd, oid: headOid, filepath });
        const headContent = new TextDecoder().decode(blob);

        if (workdirContent === undefined) {
          dirtyFiles.push({ file: filepath, inHead: true, existsInWorkdir: false });
        } else if (workdirContent !== headContent) {
          dirtyFiles.push({ file: filepath, inHead: true, existsInWorkdir: true });
          const oid = await git.writeBlob({
            fs: this.lfs,
            dir: cwd,
            blob: new TextEncoder().encode(workdirContent),
          });
          indexEntries.push({ filepath, oid });
        } else {
          // Unchanged — include in stash tree as-is
          const blobOid = await git.writeBlob({ fs: this.lfs, dir: cwd, blob });
          indexEntries.push({ filepath, oid: blobOid });
        }
      } else if (workdirContent !== undefined) {
        // New file not in HEAD
        dirtyFiles.push({ file: filepath, inHead: false, existsInWorkdir: true });
        const oid = await git.writeBlob({
          fs: this.lfs,
          dir: cwd,
          blob: new TextEncoder().encode(workdirContent),
        });
        indexEntries.push({ filepath, oid });
      }
    }

    if (dirtyFiles.length === 0) {
      return { stdout: '', stderr: 'No local changes to save\n', exitCode: 1 };
    }

    const treeOid = await this.buildTreeFromEntries(cwd, indexEntries);

    const parents: string[] = [headOid];
    try {
      const prevStash = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: 'refs/stash' });
      parents.push(prevStash);
    } catch {
      /* no previous stash */
    }

    const { commit: headCommit } = await git.readCommit({ fs: this.lfs, dir: cwd, oid: headOid });
    const message = `WIP on ${branch}: ${headOid.slice(0, 7)} ${headCommit.message.split('\n')[0]}`;
    const stashOid = await git.writeCommit({
      fs: this.lfs,
      dir: cwd,
      commit: {
        tree: treeOid,
        parent: parents,
        author: {
          name: this.authorName,
          email: this.authorEmail,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: 0,
        },
        committer: {
          name: this.authorName,
          email: this.authorEmail,
          timestamp: Math.floor(Date.now() / 1000),
          timezoneOffset: 0,
        },
        message,
      },
    });

    await git.writeRef({ fs: this.lfs, dir: cwd, ref: 'refs/stash', value: stashOid, force: true });

    // Restore workdir to HEAD state
    for (const dirty of dirtyFiles) {
      if (!dirty.inHead) {
        // New file — remove from workdir and index
        try {
          await this.options.fs.rm(`${cwd}/${dirty.file}`);
        } catch {
          /* ignore */
        }
        try {
          await git.remove({ fs: this.lfs, dir: cwd, filepath: dirty.file });
        } catch {
          /* ignore */
        }
      } else {
        // Modified/deleted — restore from HEAD
        const { blob } = await git.readBlob({
          fs: this.lfs,
          dir: cwd,
          oid: headOid,
          filepath: dirty.file,
        });
        await this.options.fs.writeFile(`${cwd}/${dirty.file}`, blob);
        await git.resetIndex({ fs: this.lfs, dir: cwd, filepath: dirty.file, ref: headOid });
      }
    }

    return {
      stdout: `Saved working directory and index state ${message}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async buildTreeFromEntries(
    cwd: string,
    entries: { filepath: string; oid: string }[]
  ): Promise<string> {
    type TreeNode =
      | { type: 'blob'; oid: string; mode: string }
      | { type: 'tree'; children: Map<string, TreeNode> };
    const root = new Map<string, TreeNode>();

    for (const { filepath, oid } of entries) {
      const parts = filepath.split('/');
      let current = root;
      for (let i = 0; i < parts.length - 1; i++) {
        let node = current.get(parts[i]);
        if (!node || node.type !== 'tree') {
          node = { type: 'tree', children: new Map() };
          current.set(parts[i], node);
        }
        current = node.children;
      }
      current.set(parts[parts.length - 1], { type: 'blob', oid, mode: '100644' });
    }

    const writeTree = async (nodes: Map<string, TreeNode>): Promise<string> => {
      const treeEntries: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
      for (const [name, node] of nodes) {
        if (node.type === 'blob') {
          treeEntries.push({ mode: node.mode, path: name, oid: node.oid, type: 'blob' });
        } else {
          const subtreeOid = await writeTree(node.children);
          treeEntries.push({ mode: '040000', path: name, oid: subtreeOid, type: 'tree' });
        }
      }
      return await git.writeTree({ fs: this.lfs, dir: cwd, tree: treeEntries });
    };

    return writeTree(root);
  }

  private async stashPop(cwd: string): Promise<GitCommandResult> {
    let stashOid: string;
    try {
      stashOid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: 'refs/stash' });
    } catch {
      return { stdout: '', stderr: 'error: No stash entries found.\n', exitCode: 1 };
    }

    const { commit: stashCommit } = await git.readCommit({ fs: this.lfs, dir: cwd, oid: stashOid });
    const headOid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: 'HEAD' });

    await this.restoreStashTree(cwd, stashCommit.tree, headOid);

    if (stashCommit.parent.length > 1) {
      await git.writeRef({
        fs: this.lfs,
        dir: cwd,
        ref: 'refs/stash',
        value: stashCommit.parent[1],
        force: true,
      });
    } else {
      await this.deleteRef(cwd, 'refs/stash');
    }

    return {
      stdout: `Dropped refs/stash@{0} (${stashOid.slice(0, 7)})\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async restoreStashTree(cwd: string, treeOid: string, headOid: string): Promise<void> {
    const stashFiles = new Map<string, Uint8Array>();

    const walkTree = async (oid: string, prefix: string): Promise<void> => {
      const { tree } = await git.readTree({ fs: this.lfs, dir: cwd, oid });
      for (const entry of tree) {
        const filepath = prefix ? `${prefix}/${entry.path}` : entry.path;
        if (entry.type === 'blob') {
          const { blob } = await git.readBlob({ fs: this.lfs, dir: cwd, oid: entry.oid });
          stashFiles.set(filepath, blob);
        } else if (entry.type === 'tree') {
          await walkTree(entry.oid, filepath);
        }
      }
    };
    await walkTree(treeOid, '');

    const headFileSet = new Set<string>();
    try {
      const headFiles = await git.listFiles({ fs: this.lfs, dir: cwd, ref: 'HEAD' });
      for (const f of headFiles) headFileSet.add(f);
    } catch {
      /* no HEAD */
    }

    for (const [filepath, blob] of stashFiles) {
      const slashIdx = filepath.lastIndexOf('/');
      if (slashIdx !== -1) {
        await this.options.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
      }
      await this.options.fs.writeFile(`${cwd}/${filepath}`, blob);
      // Restore index state: stage files that differ from HEAD
      const blobText = new TextDecoder().decode(blob);
      let headText: string | undefined;
      if (headFileSet.has(filepath)) {
        try {
          const { blob: headBlob } = await git.readBlob({
            fs: this.lfs,
            dir: cwd,
            oid: headOid,
            filepath,
          });
          headText = new TextDecoder().decode(headBlob);
        } catch {
          /* not in HEAD */
        }
      }
      if (headText !== blobText) {
        await git.add({ fs: this.lfs, dir: cwd, filepath });
      }
    }

    for (const filepath of headFileSet) {
      if (!stashFiles.has(filepath)) {
        try {
          await this.options.fs.rm(`${cwd}/${filepath}`);
        } catch {
          /* ignore */
        }
        await git.remove({ fs: this.lfs, dir: cwd, filepath });
      }
    }
  }

  private async stashList(cwd: string): Promise<GitCommandResult> {
    let output = '';
    let index = 0;

    try {
      let currentRef = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: 'refs/stash' });

      while (currentRef) {
        const { commit } = await git.readCommit({ fs: this.lfs, dir: cwd, oid: currentRef });
        output += `stash@{${index}}: ${commit.message}\n`;
        index++;

        if (commit.parent.length > 1) {
          currentRef = commit.parent[1];
        } else {
          break;
        }
      }
    } catch {
      /* no stash ref */
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  }

  private async stashDrop(cwd: string, args: string[]): Promise<GitCommandResult> {
    let index = 0;
    const stashRef = args.find((a) => a.startsWith('stash@{'));
    if (stashRef) {
      const match = stashRef.match(/stash@\{(\d+)\}/);
      if (match) index = parseInt(match[1], 10);
    }

    let topOid: string;
    try {
      topOid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: 'refs/stash' });
    } catch {
      return { stdout: '', stderr: 'error: No stash entries found.\n', exitCode: 1 };
    }

    if (index === 0) {
      const { commit } = await git.readCommit({ fs: this.lfs, dir: cwd, oid: topOid });
      if (commit.parent.length > 1) {
        await git.writeRef({
          fs: this.lfs,
          dir: cwd,
          ref: 'refs/stash',
          value: commit.parent[1],
          force: true,
        });
      } else {
        await this.deleteRef(cwd, 'refs/stash');
      }
      return {
        stdout: `Dropped refs/stash@{0} (${topOid.slice(0, 7)})\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    // Collect the stash chain from top to the entry just before the dropped one
    const chain: { oid: string; commit: git.CommitObject }[] = [];
    let current = topOid;
    for (let i = 0; i < index; i++) {
      const { commit } = await git.readCommit({ fs: this.lfs, dir: cwd, oid: current });
      chain.push({ oid: current, commit });
      if (commit.parent.length <= 1) {
        return { stdout: '', stderr: `error: stash@{${index}} not found\n`, exitCode: 1 };
      }
      current = commit.parent[1];
    }

    // `current` is now the stash entry to drop
    const dropOid = current;
    const { commit: droppedCommit } = await git.readCommit({
      fs: this.lfs,
      dir: cwd,
      oid: dropOid,
    });
    const nextStash = droppedCommit.parent.length > 1 ? droppedCommit.parent[1] : undefined;

    // Rewrite the chain from the entry just before the drop backwards to the top
    let newChild = nextStash;
    for (let i = chain.length - 1; i >= 0; i--) {
      const entry = chain[i];
      const newParents = [entry.commit.parent[0]];
      if (newChild) newParents.push(newChild);
      newChild = await git.writeCommit({
        fs: this.lfs,
        dir: cwd,
        commit: { ...entry.commit, parent: newParents },
      });
    }

    // newChild is now the rewritten top stash entry
    if (newChild) {
      await git.writeRef({
        fs: this.lfs,
        dir: cwd,
        ref: 'refs/stash',
        value: newChild,
        force: true,
      });
    } else {
      await this.deleteRef(cwd, 'refs/stash');
    }

    return {
      stdout: `Dropped refs/stash@{${index}} (${dropOid.slice(0, 7)})\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  private async stashShow(cwd: string): Promise<GitCommandResult> {
    let stashOid: string;
    try {
      stashOid = await git.resolveRef({ fs: this.lfs, dir: cwd, ref: 'refs/stash' });
    } catch {
      return { stdout: '', stderr: 'error: No stash entries found.\n', exitCode: 1 };
    }

    const { commit: stashCommit } = await git.readCommit({ fs: this.lfs, dir: cwd, oid: stashOid });
    const baseOid = stashCommit.parent[0];

    return this.diffCommits(cwd, baseOid, stashOid, { nameOnly: false, stat: true });
  }

  private async deleteRef(cwd: string, ref: string): Promise<void> {
    try {
      await this.lfs.unlink(`${cwd}/.git/${ref}`);
    } catch {
      /* ignore */
    }
  }

  private async rm(cwd: string, args: string[]): Promise<GitCommandResult> {
    const cached = args.includes('--cached');
    const recursive = args.includes('-r') || args.includes('-R') || args.includes('--recursive');

    const paths = args.filter((a) => !a.startsWith('-'));

    if (paths.length === 0) {
      return {
        stdout: '',
        stderr: 'fatal: No pathspec given. Which files should I remove?\n',
        exitCode: 128,
      };
    }

    for (const filepath of paths) {
      const fullPath = filepath.startsWith('/') ? filepath : `${cwd}/${filepath}`;

      let isDir = false;
      try {
        const stat = await this.options.fs.stat(fullPath);
        isDir = stat.type === 'directory';
      } catch {
        /* file might not exist in workdir */
      }

      if (isDir) {
        if (!recursive) {
          return {
            stdout: '',
            stderr: `fatal: not removing '${filepath}' recursively without -r\n`,
            exitCode: 128,
          };
        }
        const indexFiles = await git.listFiles({ fs: this.lfs, dir: cwd });
        const matchingFiles = indexFiles.filter(
          (f) => f === filepath || f.startsWith(filepath + '/')
        );

        for (const file of matchingFiles) {
          await git.remove({ fs: this.lfs, dir: cwd, filepath: file });
          if (!cached) {
            try {
              await this.options.fs.rm(`${cwd}/${file}`);
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        await git.remove({ fs: this.lfs, dir: cwd, filepath });
        if (!cached) {
          try {
            await this.options.fs.rm(fullPath);
          } catch {
            /* ignore */
          }
        }
      }
    }

    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private async mv(cwd: string, args: string[]): Promise<GitCommandResult> {
    const paths = args.filter((a) => !a.startsWith('-'));

    if (paths.length < 2) {
      return { stdout: '', stderr: 'fatal: usage: git mv <source> <destination>\n', exitCode: 128 };
    }

    const src = paths[0];
    const dst = paths[1];
    const srcPath = src.startsWith('/') ? src : `${cwd}/${src}`;
    const dstPath = dst.startsWith('/') ? dst : `${cwd}/${dst}`;

    let content: string | Uint8Array;
    try {
      content = await this.options.fs.readFile(srcPath, { encoding: 'binary' });
    } catch {
      return {
        stdout: '',
        stderr: `fatal: bad source, source=${src}, destination=${dst}\n`,
        exitCode: 128,
      };
    }

    const dstSlash = dstPath.lastIndexOf('/');
    if (dstSlash !== -1) {
      await this.options.fs.mkdir(dstPath.slice(0, dstSlash), { recursive: true });
    }

    await this.options.fs.writeFile(dstPath, content);
    await this.options.fs.rm(srcPath);
    await git.add({ fs: this.lfs, dir: cwd, filepath: dst });
    await git.remove({ fs: this.lfs, dir: cwd, filepath: src });

    return { stdout: '', stderr: '', exitCode: 0 };
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
