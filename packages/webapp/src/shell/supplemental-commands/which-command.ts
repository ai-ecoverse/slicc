import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { discoverJshCommands, pathToScanRoots } from '../jsh-discovery.js';
import type { ScriptCatalog } from '../script-catalog.js';
import { discoverWorkflowCommands, type WorkflowCommandEntry } from '../workflow-discovery.js';
import { parseKnownFlags } from './subcommand-flags.js';
import { isHelpRequest } from './subcommand-help.js';

export interface WhichCommandOptions {
  fs?: VirtualFS;
  scriptCatalog?: ScriptCatalog;
  getStaticBuiltins?: () => string[];
  /**
   * Names registered via script registration (.jsh / workflow). The registry
   * cannot unregister, so a script whose PATH root was removed stays
   * registered while dispatch answers 127 — `which` must not report
   * `/usr/bin/<name>` for it from the registered-name fallback.
   */
  getScriptRegisteredNames?: () => string[];
}

/**
 * Discovers .jsh commands from catalog or direct FS scan. Lookup follows
 * the caller's `$PATH` (#2085) so `which` and dispatch answer from the
 * same root set; without an env, the default roots apply.
 */
async function getJshMap(
  opts: WhichCommandOptions,
  pathValue: string | undefined
): Promise<Map<string, string>> {
  const roots = pathValue === undefined ? undefined : pathToScanRoots(pathValue);
  if (opts.scriptCatalog) return opts.scriptCatalog.getJshCommands(roots);
  if (opts.fs) return discoverJshCommands(opts.fs, roots);
  return new Map();
}

/** Discovers workflow commands from catalog or direct FS scan. */
async function getWorkflowMap(
  opts: WhichCommandOptions
): Promise<Map<string, WorkflowCommandEntry>> {
  if (opts.scriptCatalog) return opts.scriptCatalog.getWorkflowCommands();
  if (opts.fs) return discoverWorkflowCommands(opts.fs);
  return new Map();
}

/** Resolves the path(s) for a single command name according to precedence rules. */
function resolveCommandPath(
  name: string,
  jshPath: string | undefined,
  wf: WorkflowCommandEntry | undefined,
  staticBuiltins: Set<string>,
  builtinSet: Set<string>,
  scriptRegistered: Set<string>
): { lines: string[]; found: boolean } {
  if (staticBuiltins.has(name)) {
    const lines = [`/usr/bin/${name}`];
    if (jshPath || wf) lines.push(`  (shadowed by built-in ${name})`);
    return { lines, found: true };
  }
  if (jshPath) {
    const lines = [jshPath];
    if (wf) lines.push(`  ${wf.path} (workflow, shadowed by .jsh)`);
    return { lines, found: true };
  }
  if (wf) {
    return { lines: [`${wf.path} (workflow)`], found: true };
  }
  if (builtinSet.has(name) && !scriptRegistered.has(name)) {
    return { lines: [`/usr/bin/${name}`], found: true };
  }
  // A script-registered name that no catalog map answered for is STALE (its
  // PATH root was removed); dispatch would 127, so `which` reports not found.
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

    const jshCommands = await getJshMap(resolvedOptions, ctx.env.get('PATH'));
    const workflowCommands = await getWorkflowMap(resolvedOptions);

    // Static built-ins (echo, ls, …) win over any same-named script. Falls back to the
    // registered set when not supplied (legacy fs-only construction).
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
