import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import {
  discoverJshCommandIndex,
  type JshCommandCollision,
  type JshCommandIndex,
  jshScanRootsFromPath,
} from '../jsh-discovery.js';
import type { ScriptCatalog } from '../script-catalog.js';
import { discoverWorkflowCommands, type WorkflowCommandEntry } from '../workflow-discovery.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

export interface WhichCommandOptions {
  fs?: VirtualFS;
  scriptCatalog?: ScriptCatalog;
  getStaticBuiltins?: () => string[];

  getScriptRegisteredNames?: () => string[];
}

const EMPTY_JSH_INDEX: JshCommandIndex = { commands: new Map(), collisions: [] };

async function getJshIndex(
  opts: WhichCommandOptions,
  pathValue: string | undefined
): Promise<JshCommandIndex> {
  const roots = jshScanRootsFromPath(pathValue);
  if (opts.scriptCatalog) return opts.scriptCatalog.getJshIndex(roots);
  if (opts.fs) return discoverJshCommandIndex(opts.fs, roots);
  return EMPTY_JSH_INDEX;
}

async function getWorkflowMap(
  opts: WhichCommandOptions
): Promise<Map<string, WorkflowCommandEntry>> {
  if (opts.scriptCatalog) return opts.scriptCatalog.getWorkflowCommands();
  if (opts.fs) return discoverWorkflowCommands(opts.fs);
  return new Map();
}

function resolveCommandPath(
  name: string,
  jshPath: string | undefined,
  collision: JshCommandCollision | undefined,
  wf: WorkflowCommandEntry | undefined,
  staticBuiltins: Set<string>,
  builtinSet: Set<string>,
  scriptRegistered: Set<string>
): { lines: string[]; found: boolean } {
  if (staticBuiltins.has(name)) {
    const lines = [`/usr/bin/${name}`];
    if (jshPath || wf) lines.push(`  (shadowed by built-in ${name})`);
    if (jshPath) {
      const shadowedJsh = collision ? [jshPath, ...collision.shadowedPaths] : [jshPath];
      for (const path of shadowedJsh) lines.push(`  (shadowed ${path})`);
    }
    return { lines, found: true };
  }
  if (jshPath) {
    const lines = [jshPath];
    if (collision) {
      for (const shadowed of collision.shadowedPaths) {
        lines.push(`  (shadowed ${shadowed})`);
      }
    }
    if (wf) lines.push(`  ${wf.path} (workflow, shadowed by .jsh)`);
    return { lines, found: true };
  }
  if (wf) {
    return { lines: [`${wf.path} (workflow)`], found: true };
  }
  if (builtinSet.has(name) && !scriptRegistered.has(name)) {
    return { lines: [`/usr/bin/${name}`], found: true };
  }

  return { lines: [], found: false };
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

  const HELP = `which - locate a command

Usage: which <command> [command...]

Prints the path of the given command(s).
  - Built-in commands resolve to /usr/bin/<name>
  - .jsh scripts resolve to their actual VFS path
  - Duplicate .jsh names print the live path first, then each shadowed copy

Exit code 0 if all commands found, 1 if any not found.
`;

  return defineCommand('which', async (args, ctx) => {
    if (isHelpRequest(args)) {
      return { stdout: HELP, stderr: '', exitCode: 0 };
    }

    const parsed = parseKnownFlags(args, {});
    if ('error' in parsed) {
      return { stdout: '', stderr: `which: ${parsed.error}\n`, exitCode: 1 };
    }

    if (parsed.positionals.length === 0) {
      return {
        stdout: '',
        stderr: 'which: missing argument\n',
        exitCode: 1,
      };
    }

    const registeredCommands = ctx.getRegisteredCommands?.() ?? [];
    const builtinSet = new Set(registeredCommands);

    const jshIndex = await getJshIndex(resolvedOptions, ctx.env.get('PATH'));
    const jshCommands = jshIndex.commands;
    const jshCollisions = new Map(jshIndex.collisions.map((c) => [c.name, c]));
    const workflowCommands = await getWorkflowMap(resolvedOptions);

    const staticBuiltins =
      typeof resolvedOptions.getStaticBuiltins === 'function'
        ? new Set(resolvedOptions.getStaticBuiltins())
        : builtinSet;

    const scriptRegistered = new Set(resolvedOptions.getScriptRegisteredNames?.() ?? []);

    const stdoutLines: string[] = [];
    let allFound = true;

    for (const name of parsed.positionals) {
      const jshPath = jshCommands.get(name);
      const wf = workflowCommands.get(name);
      const result = resolveCommandPath(
        name,
        jshPath,
        jshCollisions.get(name),
        wf,
        staticBuiltins,
        builtinSet,
        scriptRegistered
      );
      stdoutLines.push(...result.lines);
      if (!result.found) allFound = false;
    }

    return {
      stdout: stdoutLines.length > 0 ? stdoutLines.join('\n') + '\n' : '',
      stderr: '',
      exitCode: allFound ? 0 : 1,
    };
  });
}
