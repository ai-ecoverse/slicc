/**
 * `fswatch` — watch VFS paths and route change events into the lick stream.
 *
 * The dispatcher is a thin verb switch; each verb is its own function so the
 * command stays under the cognitive-complexity cap.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { defaultLickTarget, type LickTargetEnv } from '../lick-target-env.js';
import { isHelpRequest } from './subcommand-help.js';

// Keep a module-level registry of active fswatches
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

/** A change event as the VFS watcher reports it. */
interface FsWatchEvent {
  type: string;
  path: string;
}

/**
 * Hooks the kernel publishes on `globalThis`: the VFS watcher this command
 * subscribes to, and the sink that turns a change into a lick event.
 */
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
  --scoop <name>      Route change events to this scoop as lick events
  --name <name>       Human-readable name for the watcher
`;

const ok = (stdout: string): Result => ({ stdout, stderr: '', exitCode: 0 });
const fail = (message: string): Result => ({
  stdout: '',
  stderr: `fswatch: ${message}\n`,
  exitCode: 1,
});

function handleList(): Result {
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

function handleDelete(id: string | undefined): Result {
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

/** `create`'s flags all take a value — see `isHelpRequest`. */
const CREATE_VALUE_FLAGS = ['--path', '--pattern', '--scoop', '--name'];

/** Parse `--path`/`--pattern`/`--scoop`/`--name` out of `create`'s argv. */
function parseCreateOptions(args: string[]): CreateOptions {
  const opts: CreateOptions = { basePath: '', pattern: '', scoop: '', name: '' };
  const keys: Record<string, keyof CreateOptions> = {
    '--path': 'basePath',
    '--pattern': 'pattern',
    '--scoop': 'scoop',
    '--name': 'name',
  };
  for (let i = 1; i < args.length; i++) {
    const key = keys[args[i]];
    if (key && args[i + 1]) opts[key] = args[++i];
  }
  return opts;
}

/** Compile a `*`-glob over the filename into a path filter. */
function globFilter(pattern: string): (path: string) => boolean {
  const globRegex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  return (path: string) => globRegex.test(path.split('/').pop() ?? '');
}

function handleCreate(args: string[], env: LickTargetEnv): Result {
  const opts = parseCreateOptions(args);
  // No `--scoop`: a non-primary cone's shell names itself (SLICC_LICK_TARGET).
  opts.scoop = defaultLickTarget(opts.scoop, env) ?? '';
  if (!opts.basePath || !opts.pattern) return fail('--path and --pattern are required');

  // Access VFS watcher via global hook
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
    // Help before the verb runs — `create --help` must not register a watcher.
    if (!subcommand || isHelpRequest(args, { valueFlags: CREATE_VALUE_FLAGS })) return ok(HELP);

    switch (subcommand) {
      case 'list':
        return handleList();
      case 'delete':
        return handleDelete(args[1]);
      case 'create':
        return handleCreate(args, ctx.env);
      default:
        return fail(`unknown command: ${subcommand}`);
    }
  });
}
