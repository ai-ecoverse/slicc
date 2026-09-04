/** `git commit` plus auto-staging and combined-flag expansion helpers. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { flagString, GIT_FLAG_SPECS, type GitParsedFlags } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

/** Names `parseArgs` records for `GIT_FLAG_SPECS.commit`, including aliases. */
const COMMIT_FLAG_NAMES = new Set([
  'message',
  'author',
  'date',
  'reuse-message',
  'reedit-message',
  'file',
  'cleanup',
  'amend',
  'all',
  'allow-empty',
  'm',
  'a',
  'C',
  'c',
  'F',
]);

export async function commit(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  // Handle combined -am "message" form: expand to -a -m "message"
  const expandedArgs = expandCombinedFlags(args);
  const flags = parseArgs(expandedArgs, GIT_FLAG_SPECS.commit).flags as GitParsedFlags;

  const resolved = await resolveCommitMessage(ctx, cwd, flags);
  if (typeof resolved !== 'string') return resolved;
  const message = resolved;

  const amend = flags.amend === true;
  const autoStage = flags.all === true;
  const allowEmpty = flags['allow-empty'] === true;

  // Auto-stage tracked modified files before committing
  if (autoStage) {
    await stageTrackedChanges(ctx, cwd);
  }

  // Check for empty commit if --allow-empty is not set
  if (!allowEmpty && !amend) {
    const matrix = await git.statusMatrix({ fs: ctx.lfs, cache: ctx.cache, dir: cwd });
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
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    message,
    author: await ctx.resolveAuthor(cwd),
    amend,
    noUpdateBranch: undefined,
  });

  const shortSha = sha.slice(0, 7);
  const branch = await git.currentBranch({ fs: ctx.lfs, dir: cwd });

  return {
    stdout: `[${branch ?? 'HEAD'} ${shortSha}] ${message}\n`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Value-taking flag as a string. `mri` stores a bare `-m` / `-F` (no following
 * token) as `true`; treat that as missing so we can name the switch.
 */
function valueFlag(flags: GitParsedFlags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined || value === true || value === false) return undefined;
  return flagString(flags, name);
}

function firstUnknownCommitFlag(flags: GitParsedFlags): string | undefined {
  return Object.keys(flags).find((key) => !COMMIT_FLAG_NAMES.has(key));
}

function unknownFlagError(flag: string): GitCommandResult {
  const kind = flag.length === 1 ? 'switch' : 'option';
  return {
    stdout: '',
    stderr: `error: unknown ${kind} \`${flag}\`\n`,
    exitCode: 129,
  };
}

function missingValueError(switchName: string): GitCommandResult {
  return {
    stdout: '',
    stderr: `error: switch \`${switchName}\` requires a value\n`,
    exitCode: 1,
  };
}

function missingCommitMessageError(flags: GitParsedFlags): GitCommandResult {
  const unknown = firstUnknownCommitFlag(flags);
  if (unknown) return unknownFlagError(unknown);
  if ('message' in flags || 'm' in flags) return missingValueError('m');
  if ('file' in flags || 'F' in flags) return missingValueError('F');
  return {
    stdout: '',
    stderr: "error: option `-m' or `-F' is required\n",
    exitCode: 1,
  };
}

function emptyCommitMessageError(): GitCommandResult {
  return {
    stdout: '',
    stderr: 'Aborting commit due to empty commit message.\n',
    exitCode: 1,
  };
}

function readLogFileError(filePath: string): GitCommandResult {
  return {
    stdout: '',
    stderr: `error: could not read log file '${filePath}': No such file or directory\n`,
    exitCode: 128,
  };
}

async function readCommitMessageFile(
  ctx: GitCommandContext,
  cwd: string,
  filePath: string
): Promise<string | GitCommandResult> {
  if (filePath === '-') return ctx.stdin;
  const abs = filePath.startsWith('/') ? filePath : `${cwd}/${filePath}`;
  try {
    return await ctx.fs.readTextFile(abs);
  } catch {
    return readLogFileError(filePath);
  }
}

async function resolveCommitMessage(
  ctx: GitCommandContext,
  cwd: string,
  flags: GitParsedFlags
): Promise<string | GitCommandResult> {
  const fromMessage = valueFlag(flags, 'message');
  if (fromMessage !== undefined) return fromMessage;

  const filePath = valueFlag(flags, 'file');
  if (filePath !== undefined) {
    const loaded = await readCommitMessageFile(ctx, cwd, filePath);
    if (typeof loaded !== 'string') return loaded;
    if (loaded === '') return emptyCommitMessageError();
    return loaded;
  }

  return missingCommitMessageError(flags);
}

/**
 * Stage all tracked files that have been modified or deleted (like `git add -u`).
 */
async function stageTrackedChanges(ctx: GitCommandContext, cwd: string): Promise<void> {
  const matrix = await git.statusMatrix({ fs: ctx.lfs, cache: ctx.cache, dir: cwd });
  for (const [file, head, workdir, stage] of matrix) {
    if (head === 0) continue; // Skip untracked files
    if (workdir === stage) continue; // Skip unchanged
    if (workdir === 0) {
      await git.remove({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: file });
    } else {
      await git.add({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: file });
    }
  }
}

/**
 * Expand combined single-char flags like -am into -a -m.
 * Preserves the value that follows -m.
 */
function expandCombinedFlags(args: string[]): string[] {
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
