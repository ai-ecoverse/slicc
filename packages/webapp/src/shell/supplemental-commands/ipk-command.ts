/**
 * `ipk` (Ice Pack) command — install packages into the nearest project's
 * `node_modules`. Also registered as `npm` (alias) so `npm install <pkg>` and
 * `npm i <pkg>` behave identically, and as `i` shorthand.
 *
 * Supports both named installs (`ipk install <pkg>...`) and the no-arg
 * install-from-manifest path (`ipk install` with no further arguments), which
 * reads `dependencies` + `devDependencies` from the cwd `package.json` and
 * installs them via the transitive installer. `npx`/`ipx` land in M6.
 */

import type { Command, CommandContext, ExecResult, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import {
  type InstallFromManifestResult,
  installFromManifest,
  installPackages,
  ManifestNotFoundError,
} from '../ipk/installer.js';

export interface IpkCommandDeps {
  fs: VirtualFS;
  fetch: SecureFetch;
}

const INSTALL_ALIASES = new Set(['install', 'i', 'add']);

function usage(name: string): string {
  return `${name} - install packages from the npm registry into node_modules

Usage:
  ${name} install [<pkg>[@<spec>] ...]
  ${name} i       [<pkg>[@<spec>] ...]

No-arg form:
  ${name} install            read cwd package.json and install every entry
                             from dependencies AND devDependencies

Spec forms:
  <pkg>            install the latest published version
  <pkg>@x.y.z      install an exact version
  <pkg>@^x.y.z     install the highest version matching the caret range
  <pkg>@~x.y.z     install the highest version matching the tilde range
  <pkg>@latest     install the version pointed at by the latest dist-tag
  <pkg>@*          install the latest published version (wildcard)
  @scope/name      scoped packages install under node_modules/@scope/name

Options:
  -h, --help       Show this help message

Installed packages are extracted into <cwd>/node_modules and named installs
are recorded in <cwd>/package.json under dependencies. Existing fields are
preserved. Idempotent: re-installing an already-satisfied package is a clean
no-op.
`;
}

function isHelpRequest(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
  const specs = args.filter((a) => !a.startsWith('-'));
  if (specs.length === 0) {
    return runManifestInstall(name, ctx, deps);
  }

  let outcome: Awaited<ReturnType<typeof installPackages>>;
  try {
    outcome = await installPackages(specs, {
      fs: deps.fs,
      fetch: deps.fetch,
      cwd: ctx.cwd,
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

  return {
    stdout: stdout.length > 0 ? `${stdout.join('\n')}\n` : '',
    stderr: stderr.length > 0 ? `${stderr.join('\n')}\n` : '',
    exitCode: outcome.errors.length === 0 ? 0 : 1,
  };
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

    return {
      stdout: '',
      stderr: `${name}: unknown subcommand '${sub}' (supported: install, i)\n`,
      exitCode: 1,
    };
  });
}
