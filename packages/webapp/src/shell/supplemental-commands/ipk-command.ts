/**
 * `ipk` (Ice Pack) command — install named packages into the nearest project's
 * `node_modules`. Also registered as `npm` (alias) so `npm install <pkg>` and
 * `npm i <pkg>` work the same way.
 *
 * M1 scope: single + multi-package named installs over the
 * `installPackage` single-package path in `shell/ipk/installer.ts`. No-arg
 * install (read deps from `package.json`) and full transitive resolution
 * land in M2. `npx`/`ipx` land in M6.
 */

import type { Command, CommandContext, ExecResult, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { installPackages } from '../ipk/installer.js';

export interface IpkCommandDeps {
  fs: VirtualFS;
  fetch: SecureFetch;
}

const INSTALL_ALIASES = new Set(['install', 'i', 'add']);

function usage(name: string): string {
  return `${name} - install packages from the npm registry into node_modules

Usage:
  ${name} install <pkg>[@<spec>] [<pkg> ...]
  ${name} i <pkg>[@<spec>] [<pkg> ...]

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

Installed packages are extracted into <cwd>/node_modules and recorded in
<cwd>/package.json under dependencies. Existing fields are preserved.
`;
}

function isHelpRequest(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function runInstall(
  name: string,
  args: string[],
  ctx: CommandContext,
  deps: IpkCommandDeps
): Promise<ExecResult> {
  const specs = args.filter((a) => !a.startsWith('-'));
  if (specs.length === 0) {
    return {
      stdout: '',
      stderr: `${name}: install requires at least one package name (no-arg install lands in m2)\n`,
      exitCode: 1,
    };
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
    if (args.length === 0) {
      return { stdout: usage(name), stderr: `${name}: missing subcommand\n`, exitCode: 1 };
    }

    if (isShorthand) {
      return runInstall(name, args, ctx, deps);
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
