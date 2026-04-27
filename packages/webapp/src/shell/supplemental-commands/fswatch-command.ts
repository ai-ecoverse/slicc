import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

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

const activeWatches = new Map<string, FsWatchEntry>();
let nextId = 0;

export function createFsWatchCommand(): Command {
  return defineCommand('fswatch', async (args) => {
    const subcommand = args[0];

    if (!subcommand || subcommand === '--help') {
      return {
        stdout: `usage: fswatch <command> [options]

Commands:
  create --path <path> --pattern <glob> [--scoop <name>] [--name <name>]   Watch for file changes
  list                                                                       List active watchers
  delete <id>                                                                Remove a watcher

Options:
  --path <path>       Base VFS path to watch (required)
  --pattern <glob>    File pattern to match, e.g. "*.md", "*.bsh" (required)
  --scoop <name>      Route change events to this scoop as lick events
  --name <name>       Human-readable name for the watcher
`,
        stderr: '',
        exitCode: 0,
      };
    }

    if (subcommand === 'list') {
      if (activeWatches.size === 0) {
        return { stdout: 'No active file watchers.\n', stderr: '', exitCode: 0 };
      }
      let output = '';
      for (const [, entry] of activeWatches) {
        output += `ID: ${entry.id}\n`;
        output += `  Name:    ${entry.name}\n`;
        output += `  Path:    ${entry.basePath}\n`;
        output += `  Pattern: ${entry.pattern}\n`;
        if (entry.scoop) output += `  Scoop:   ${entry.scoop}\n`;
        output += `  Created: ${entry.createdAt}\n\n`;
      }
      return { stdout: output, stderr: '', exitCode: 0 };
    }

    if (subcommand === 'delete') {
      const id = args[1];
      if (!id) return { stdout: '', stderr: 'fswatch: delete requires an ID\n', exitCode: 1 };
      const entry = activeWatches.get(id);
      if (!entry) return { stdout: '', stderr: `fswatch: watcher not found: ${id}\n`, exitCode: 1 };
      entry.unsubscribe();
      activeWatches.delete(id);
      return { stdout: `Deleted watcher "${entry.name}" (${id})\n`, stderr: '', exitCode: 0 };
    }

    if (subcommand === 'create') {
      // Parse --path, --pattern, --scoop, --name from args
      let basePath = '',
        pattern = '',
        scoop = '',
        name = '';
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--path' && args[i + 1]) {
          basePath = args[++i];
        } else if (args[i] === '--pattern' && args[i + 1]) {
          pattern = args[++i];
        } else if (args[i] === '--scoop' && args[i + 1]) {
          scoop = args[++i];
        } else if (args[i] === '--name' && args[i + 1]) {
          name = args[++i];
        }
      }
      if (!basePath || !pattern) {
        return {
          stdout: '',
          stderr: 'fswatch: --path and --pattern are required\n',
          exitCode: 1,
        };
      }

      // Build a simple glob filter
      const globRegex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      const filter = (path: string) => {
        const filename = path.split('/').pop() ?? '';
        return globRegex.test(filename);
      };

      // Access VFS watcher via global hook
      const watcher = (globalThis as any).__slicc_fs_watcher;
      if (!watcher) {
        return {
          stdout: '',
          stderr: 'fswatch: file system watcher not available\n',
          exitCode: 1,
        };
      }

      const id = `fsw-${++nextId}`;
      if (!name) name = `${pattern} in ${basePath}`;

      const lickHandler = (globalThis as any).__slicc_lick_handler;

      const unsubscribe = watcher.watch(basePath, filter, (events: any[]) => {
        if (lickHandler) {
          lickHandler({
            type: 'fswatch',
            fswatchId: id,
            fswatchName: name,
            targetScoop: scoop,
            timestamp: new Date().toISOString(),
            changes: events.map((e: any) => ({ type: e.type, path: e.path })),
            body: { changes: events.map((e: any) => ({ type: e.type, path: e.path })) },
          });
        }
      });

      activeWatches.set(id, {
        id,
        name,
        basePath,
        pattern,
        scoop,
        unsubscribe,
        createdAt: new Date().toISOString(),
      });

      let output = `Created file watcher "${name}"\n`;
      output += `ID:      ${id}\n`;
      output += `Path:    ${basePath}\n`;
      output += `Pattern: ${pattern}\n`;
      if (scoop) output += `Scoop:   ${scoop}\n`;
      return { stdout: output, stderr: '', exitCode: 0 };
    }

    return { stdout: '', stderr: `fswatch: unknown command: ${subcommand}\n`, exitCode: 1 };
  });
}
