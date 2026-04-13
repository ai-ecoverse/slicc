import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { discoverJshCommands } from '../jsh-discovery.js';
import type { ScriptCatalog } from '../script-catalog.js';

export interface WhichCommandOptions {
  fs?: VirtualFS;
  scriptCatalog?: ScriptCatalog;
}

export function createWhichCommand(options: WhichCommandOptions | VirtualFS = {}): Command {
  const resolvedOptions: WhichCommandOptions =
    typeof (options as WhichCommandOptions).scriptCatalog !== 'undefined' ||
    typeof (options as WhichCommandOptions).fs !== 'undefined'
      ? (options as WhichCommandOptions)
      : typeof (options as Partial<VirtualFS>).walk === 'function' &&
          typeof (options as Partial<VirtualFS>).exists === 'function'
        ? ({ fs: options as VirtualFS } satisfies WhichCommandOptions)
        : {};

  return defineCommand('which', async (args, ctx) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `which - locate a command

Usage: which <command> [command...]

Prints the path of the given command(s).
  - Built-in commands resolve to /usr/bin/<name>
  - .jsh scripts resolve to their actual VFS path

Exit code 0 if all commands found, 1 if any not found.
`,
        stderr: '',
        exitCode: 0,
      };
    }

    if (args.length === 0) {
      return {
        stdout: '',
        stderr: 'which: missing argument\n',
        exitCode: 1,
      };
    }

    const registeredCommands = ctx.getRegisteredCommands?.() ?? [];
    const builtinSet = new Set(registeredCommands);

    // Discover .jsh commands via the shared discovery module
    const jshCommands = resolvedOptions.scriptCatalog
      ? await resolvedOptions.scriptCatalog.getJshCommands()
      : resolvedOptions.fs
        ? await discoverJshCommands(resolvedOptions.fs)
        : new Map<string, string>();

    const stdoutLines: string[] = [];
    let allFound = true;

    for (const name of args) {
      if (builtinSet.has(name)) {
        stdoutLines.push(`/usr/bin/${name}`);
      } else {
        const jshPath = jshCommands.get(name);
        if (jshPath) {
          stdoutLines.push(jshPath);
        } else {
          allFound = false;
        }
      }
    }

    return {
      stdout: stdoutLines.length > 0 ? stdoutLines.join('\n') + '\n' : '',
      stderr: '',
      exitCode: allFound ? 0 : 1,
    };
  });
}
