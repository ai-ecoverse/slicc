/**
 * `ipk` (Ice Pack) command — install packages into the nearest project's
 * `node_modules`. Also registered as `npm` (alias) so `npm install <pkg>` and
 * `npm i <pkg>` behave identically, and as `i` shorthand.
 *
 * Supports both named installs (`ipk install <pkg>...`) and the no-arg
 * install-from-manifest path (`ipk install` with no further arguments), which
 * reads `dependencies` + `devDependencies` from the cwd `package.json` and
 * installs them via the transitive installer.
 *
 * Script running (`npm run <script>`, `npm run-script`, and the `npm test` /
 * `start` / `stop` / `restart` lifecycle shortcuts) lives in `npm-run.ts`.
 */

import type { Command, CommandContext, ExecResult, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { GLOBAL_NODE_MODULES, GLOBAL_NPM_PREFIX } from '../ipk/global-prefix.js';
import {
  type InstallFromManifestResult,
  installFromManifest,
  installPackages,
  listGlobalPackages,
  listLocalPackages,
  ManifestNotFoundError,
  uninstallPackages,
} from '../ipk/installer.js';
import type { ScriptCatalog } from '../script-catalog.js';
import { LIFECYCLE_SHORTCUTS, RUN_ALIASES, runNpmScript } from './npm-run.js';

export interface IpkCommandDeps {
  fs: VirtualFS;
  fetch: SecureFetch;
  /** Invalidate `.jsh` discovery after global bin delegator changes. */
  scriptCatalog?: ScriptCatalog;
  /** Re-register PATH-visible commands in the active shell session. */
  syncScriptCommands?: () => void | Promise<void>;
}

const INSTALL_ALIASES = new Set(['install', 'i', 'add']);
const UNINSTALL_ALIASES = new Set(['uninstall', 'remove', 'rm', 'un']);
const LIST_ALIASES = new Set(['list', 'ls']);
const GLOBAL_INSTALL_FLAGS = new Set(['-g', '--global', '--location=global']);

function usage(name: string): string {
  return `${name} - install packages from the npm registry into node_modules
       and run package.json scripts

Usage:
  ${name} install [<pkg>[@<spec>] ...]
  ${name} install -g <pkg>[@<spec>] ...
  ${name} i       [<pkg>[@<spec>] ...]
  ${name} run     [<script> [-- <args>...]]
  ${name} test | start | stop | restart

No-arg forms:
  ${name} install            read cwd package.json and install every entry
                             from dependencies AND devDependencies
  ${name} run                list the scripts the nearest package.json defines

Global installs:
  ${name} install -g <pkg>   install into /shared/lib/node_modules and publish
                             CLI bins to /shared/bin (on the default $PATH).
                             Records deps in /shared/lib/package.json, not cwd.
  ${name} uninstall -g <pkg> remove a global package and reconcile the tree
  ${name} list -g            list globally installed direct dependencies
  ${name} root -g            print the global node_modules path

Local project (no -g):
  ${name} uninstall <pkg>    remove from cwd package.json and reconcile node_modules
  ${name} list               list direct dependencies from cwd package.json
  ${name} root               print <cwd>/node_modules

Script running:
  ${name} run <script>       run that scripts entry in the directory holding
                             the nearest package.json, with pre<script> and
                             post<script> around it
  ${name} run <script> -- -x pass extra arguments through to the script body;
                             everything after -- is the script's, including
                             --help and flags that would otherwise be ours
  ${name} test               shortcut for '${name} run test' (also start, stop,
                             restart). A missing 'start' falls back to
                             'node server.js' when the package has one, and
                             a missing 'restart' to stop + start
  --silent, -s               do not echo the script banner
  --if-present               exit 0 instead of failing on a missing script
                             (both are accepted on either side of <script>)

Spec forms:
  <pkg>            install the latest published version
  <pkg>@x.y.z      install an exact version
  <pkg>@^x.y.z     install the highest version matching the caret range
  <pkg>@~x.y.z     install the highest version matching the tilde range
  <pkg>@latest     install the version pointed at by the latest dist-tag
  <pkg>@*          install the latest published version (wildcard)
  @scope/name      scoped packages install under node_modules/@scope/name

Options:
  -g, --global     install packages into the shared global prefix (/shared/lib)
  -h, --help       Show this help message

Installed packages are extracted into <cwd>/node_modules and named installs
are recorded in <cwd>/package.json under dependencies. With -g, packages go
to /shared/lib/node_modules and deps are recorded in /shared/lib/package.json.
Existing fields are preserved. Idempotent: re-installing an already-satisfied
package is a clean no-op.
`;
}

export interface ParsedInstallArgs {
  global: boolean;
  specs: string[];
}

/** Split install flags from package specs (supports `-g` anywhere before specs). */
export function parseInstallArgs(args: string[]): ParsedInstallArgs {
  return parseGlobalFlagArgs(args);
}

/** Split global flags from positional args (supports `-g` anywhere before names). */
export function parseGlobalFlagArgs(args: string[]): ParsedInstallArgs {
  let global = false;
  const specs: string[] = [];
  for (const arg of args) {
    if (GLOBAL_INSTALL_FLAGS.has(arg)) {
      global = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    specs.push(arg);
  }
  return { global, specs };
}

/**
 * Help flags count only BEFORE a `--` separator: everything after it belongs to
 * the script (`npm run lint -- --help` asks lint for its help, not ipk).
 */
function isHelpRequest(args: string[]): boolean {
  const separator = args.indexOf('--');
  const own = separator === -1 ? args : args.slice(0, separator);
  return own.includes('--help') || own.includes('-h');
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function refreshGlobalBinCommands(deps: IpkCommandDeps): Promise<void> {
  deps.scriptCatalog?.invalidateJsh();
  await deps.syncScriptCommands?.();
}

async function runManifestInstall(
  name: string,
  ctx: CommandContext,
  deps: IpkCommandDeps
): Promise<ExecResult> {
  let outcome: InstallFromManifestResult;
  try {
    outcome = await installFromManifest({
      fs: deps.fs,
      fetch: deps.fetch,
      cwd: ctx.cwd,
    });
  } catch (err) {
    if (err instanceof ManifestNotFoundError) {
      return {
        stdout: '',
        stderr: `${name}: ${err.message}\n`,
        exitCode: 1,
      };
    }
    return {
      stdout: '',
      stderr: `${name}: install failed: ${describeError(err)}\n`,
      exitCode: 1,
    };
  }

  if (outcome.empty && outcome.errors.length === 0) {
    return {
      stdout: `${name}: nothing to install (package.json declares no dependencies)\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  const stdout = outcome.results.map(
    (r) => `${name}: installed ${r.name}@${r.version} -> ${r.installPath}`
  );
  const stderr = outcome.errors.map(
    (e) => `${name}: failed to install ${e.spec}: ${describeError(e.error)}`
  );

  return {
    stdout: stdout.length > 0 ? `${stdout.join('\n')}\n` : '',
    stderr: stderr.length > 0 ? `${stderr.join('\n')}\n` : '',
    exitCode: outcome.errors.length === 0 ? 0 : 1,
  };
}

async function runInstall(
  name: string,
  args: string[],
  ctx: CommandContext,
  deps: IpkCommandDeps
): Promise<ExecResult> {
  const { global, specs } = parseInstallArgs(args);
  if (global && specs.length === 0) {
    return {
      stdout: '',
      stderr: `${name}: global install requires at least one package name\n`,
      exitCode: 1,
    };
  }
  if (specs.length === 0) {
    return runManifestInstall(name, ctx, deps);
  }

  let outcome: Awaited<ReturnType<typeof installPackages>>;
  try {
    outcome = await installPackages(specs, {
      fs: deps.fs,
      fetch: deps.fetch,
      cwd: ctx.cwd,
      global,
    });
  } catch (err) {
    return {
      stdout: '',
      stderr: `${name}: install failed: ${describeError(err)}\n`,
      exitCode: 1,
    };
  }

  const stdout = outcome.results.map(
    (r) => `${name}: installed ${r.name}@${r.version} -> ${r.installPath}`
  );
  const stderr = outcome.errors.map(
    (e) => `${name}: failed to install ${e.spec}: ${describeError(e.error)}`
  );

  if (global && outcome.errors.length === 0 && outcome.results.length > 0) {
    await refreshGlobalBinCommands(deps);
  }

  return {
    stdout: stdout.length > 0 ? `${stdout.join('\n')}\n` : '',
    stderr: stderr.length > 0 ? `${stderr.join('\n')}\n` : '',
    exitCode: outcome.errors.length === 0 ? 0 : 1,
  };
}

function formatPackageList(
  prefix: string,
  packages: Array<{ name: string; version: string }>
): string {
  if (packages.length === 0) {
    return `${prefix}\n└── (empty)\n`;
  }
  const lines = [`${prefix}`];
  for (let i = 0; i < packages.length; i++) {
    const branch = i === packages.length - 1 ? '└──' : '├──';
    lines.push(`${branch} ${packages[i].name}@${packages[i].version}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runUninstall(
  name: string,
  args: string[],
  ctx: CommandContext,
  deps: IpkCommandDeps
): Promise<ExecResult> {
  const { global, specs } = parseGlobalFlagArgs(args);
  if (specs.length === 0) {
    return {
      stdout: '',
      stderr: `${name}: uninstall requires at least one package name\n`,
      exitCode: 1,
    };
  }

  let outcome: Awaited<ReturnType<typeof uninstallPackages>>;
  try {
    outcome = await uninstallPackages(specs, {
      fs: deps.fs,
      fetch: deps.fetch,
      cwd: ctx.cwd,
      global,
    });
  } catch (err) {
    return {
      stdout: '',
      stderr: `${name}: uninstall failed: ${describeError(err)}\n`,
      exitCode: 1,
    };
  }

  const stdout = outcome.results.filter((r) => r.removed).map((r) => `${name}: removed ${r.name}`);
  const skipped = outcome.results.filter((r) => !r.removed).map((r) => r.name);
  const stderrParts = outcome.errors.map(
    (e) => `${name}: failed to uninstall ${e.spec}: ${describeError(e.error)}`
  );
  if (skipped.length > 0) {
    stderrParts.push(`${name}: ${skipped.join(', ')} not installed${global ? ' globally' : ''}`);
  }

  const hasErrors = outcome.errors.length > 0;
  if (global && !hasErrors) {
    await refreshGlobalBinCommands(deps);
  }
  return {
    stdout: stdout.length > 0 ? `${stdout.join('\n')}\n` : '',
    stderr: stderrParts.length > 0 ? `${stderrParts.join('\n')}\n` : '',
    exitCode: hasErrors ? 1 : 0,
  };
}

async function runList(
  name: string,
  args: string[],
  ctx: CommandContext,
  deps: IpkCommandDeps
): Promise<ExecResult> {
  const { global } = parseGlobalFlagArgs(args);
  try {
    const packages = global
      ? await listGlobalPackages(deps.fs)
      : await listLocalPackages(deps.fs, ctx.cwd);
    const prefix = global ? GLOBAL_NPM_PREFIX : ctx.cwd;
    return {
      stdout: formatPackageList(prefix, packages),
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: `${name}: list failed: ${describeError(err)}\n`,
      exitCode: 1,
    };
  }
}

async function runRoot(
  _name: string,
  args: string[],
  ctx: CommandContext,
  _deps: IpkCommandDeps
): Promise<ExecResult> {
  const { global } = parseGlobalFlagArgs(args);
  const path = global ? GLOBAL_NODE_MODULES : `${ctx.cwd.replace(/\/$/, '')}/node_modules`;
  return { stdout: `${path}\n`, stderr: '', exitCode: 0 };
}

export function createIpkCommand(name: string, deps: IpkCommandDeps): Command {
  const isShorthand = name === 'i';
  return defineCommand(name, async (args: string[], ctx: CommandContext) => {
    if (isHelpRequest(args)) {
      return { stdout: usage(name), stderr: '', exitCode: 0 };
    }

    if (isShorthand) {
      return runInstall(name, args, ctx, deps);
    }

    if (args.length === 0) {
      return { stdout: usage(name), stderr: `${name}: missing subcommand\n`, exitCode: 1 };
    }

    const sub = args[0];
    const rest = args.slice(1);
    if (INSTALL_ALIASES.has(sub)) {
      return runInstall(name, rest, ctx, deps);
    }
    if (UNINSTALL_ALIASES.has(sub)) {
      return runUninstall(name, rest, ctx, deps);
    }
    if (LIST_ALIASES.has(sub)) {
      return runList(name, rest, ctx, deps);
    }
    if (sub === 'root') {
      return runRoot(name, rest, ctx, deps);
    }
    if (RUN_ALIASES.has(sub)) {
      return runNpmScript(name, rest, ctx, { fs: deps.fs });
    }
    // `npm test` is `npm run test`; the shortcut takes no script argument, so
    // its own name is the script name and the rest passes through as args.
    if (LIFECYCLE_SHORTCUTS.has(sub)) {
      return runNpmScript(name, args, ctx, { fs: deps.fs });
    }

    return {
      stdout: '',
      stderr: `${name}: unknown subcommand '${sub}' (supported: install, uninstall, list, root, run)\n`,
      exitCode: 1,
    };
  });
}
