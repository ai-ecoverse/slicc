import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { defaultLickTarget, type LickTargetEnv } from '../lick-target-env.js';
import { getLickManagerSurface } from './lick-surface.js';
import { explicitLickTargetError } from './lick-target-check.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

interface FsWatchEntry {
  id: string;
  name: string;
  basePath: string;
  pattern: string;
  scoop?: string;
  unsubscribe: () => void;
  createdAt: string;
}

type Result = { stdout: string; stderr: string; exitCode: number };

interface FsWatchEvent {
  type: string;
  path: string;
}

interface FsWatchGlobals {
  __slicc_fs_watcher?: {
    watch(
      basePath: string,
      filter: (path: string) => boolean,
      onEvents: (events: FsWatchEvent[]) => void
    ): () => void;
  };
  __slicc_lick_handler?: (event: {
    type: 'fswatch';
    fswatchId: string;
    fswatchName: string;
    targetScoop: string;
    timestamp: string;
    changes: FsWatchEvent[];
    body: { changes: FsWatchEvent[] };
  }) => void;
}

const activeWatches = new Map<string, FsWatchEntry>();
let nextId = 0;

const HELP = `usage: fswatch <command> [options]

Commands:
  create --path <path> --pattern <glob> [--scoop <name>] [--name <name>]   Watch for file changes
  list                                                                       List active watchers
  delete <id>                                                                Remove a watcher

Options:
  --path <path>       Base VFS path to watch (required)
  --pattern <glob>    File pattern to match, e.g. "*.md", "*.bsh" (required)
  --scoop <target>    Scoop name, cone name, or folder. Omit for your own cone.
  --name <name>       Human-readable name for the watcher
`;

const ok = (stdout: string): Result => ({ stdout, stderr: '', exitCode: 0 });
const fail = (message: string): Result => ({
  stdout: '',
  stderr: `fswatch: ${message}\n`,
  exitCode: 1,
});

const CREATE_VALUE_FLAGS = ['--path', '--pattern', '--scoop', '--name'] as const;

function handleList(args: readonly string[]): Result {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return fail(parsed.error);

  if (activeWatches.size === 0) return ok('No active file watchers.\n');
  let output = '';
  for (const [, entry] of activeWatches) {
    output += `ID: ${entry.id}\n`;
    output += `  Name:    ${entry.name}\n`;
    output += `  Path:    ${entry.basePath}\n`;
    output += `  Pattern: ${entry.pattern}\n`;
    if (entry.scoop) output += `  Scoop:   ${entry.scoop}\n`;
    output += `  Created: ${entry.createdAt}\n\n`;
  }
  return ok(output);
}

function handleDelete(args: readonly string[]): Result {
  const parsed = parseKnownFlags(args.slice(1), {});
  if ('error' in parsed) return fail(parsed.error);

  const id = parsed.positionals[0];
  if (!id) return fail('delete requires an ID');
  const entry = activeWatches.get(id);
  if (!entry) return fail(`watcher not found: ${id}`);
  entry.unsubscribe();
  activeWatches.delete(id);
  return ok(`Deleted watcher "${entry.name}" (${id})\n`);
}

interface CreateOptions {
  basePath: string;
  pattern: string;
  scoop: string;
  name: string;
}

function parseCreateOptions(args: readonly string[]): CreateOptions | { error: string } {
  const parsed = parseKnownFlags(args.slice(1), { value: CREATE_VALUE_FLAGS });
  if ('error' in parsed) return parsed;
  return {
    basePath: parsed.values.get('--path') ?? '',
    pattern: parsed.values.get('--pattern') ?? '',
    scoop: parsed.values.get('--scoop') ?? '',
    name: parsed.values.get('--name') ?? '',
  };
}

function globFilter(pattern: string): (path: string) => boolean {
  const globRegex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return (path: string) => globRegex.test(path.split('/').pop() ?? '');
}

async function handleCreate(args: readonly string[], env: LickTargetEnv): Promise<Result> {
  const parsed = parseCreateOptions(args);
  if ('error' in parsed) return fail(parsed.error);

  const opts = parsed;
  const explicitScoop = opts.scoop || undefined;

  opts.scoop = defaultLickTarget(opts.scoop, env) ?? '';
  if (!opts.basePath || !opts.pattern) return fail('--path and --pattern are required');

  const targetError = await explicitLickTargetError(
    await getLickManagerSurface(),
    'fswatch create',
    explicitScoop
  );
  if (targetError) return { stdout: '', stderr: targetError, exitCode: 1 };

  const globals = globalThis as FsWatchGlobals;
  const watcher = globals.__slicc_fs_watcher;
  if (!watcher) return fail('file system watcher not available');

  const id = `fsw-${++nextId}`;
  const name = opts.name || `${opts.pattern} in ${opts.basePath}`;
  const lickHandler = globals.__slicc_lick_handler;

  const unsubscribe = watcher.watch(
    opts.basePath,
    globFilter(opts.pattern),
    (events: FsWatchEvent[]) => {
      if (!lickHandler) return;
      const changes = events.map((e) => ({ type: e.type, path: e.path }));
      lickHandler({
        type: 'fswatch',
        fswatchId: id,
        fswatchName: name,
        targetScoop: opts.scoop,
        timestamp: new Date().toISOString(),
        changes,
        body: { changes },
      });
    }
  );

  activeWatches.set(id, {
    id,
    name,
    basePath: opts.basePath,
    pattern: opts.pattern,
    scoop: opts.scoop,
    unsubscribe,
    createdAt: new Date().toISOString(),
  });

  let output = `Created file watcher "${name}"\n`;
  output += `ID:      ${id}\n`;
  output += `Path:    ${opts.basePath}\n`;
  output += `Pattern: ${opts.pattern}\n`;
  if (opts.scoop) output += `Scoop:   ${opts.scoop}\n`;
  return ok(output);
}

export function createFsWatchCommand(): Command {
  return defineCommand('fswatch', async (args, ctx) => {
    const subcommand = args[0];

    if (!subcommand || isHelpRequest(args, { valueFlags: CREATE_VALUE_FLAGS })) return ok(HELP);

    switch (subcommand) {
      case 'list':
        return handleList(args);
      case 'delete':
        return handleDelete(args);
      case 'create':
        return await handleCreate(args, ctx.env);
      default:
        return fail(`unknown command: ${subcommand}`);
    }
  });
}
