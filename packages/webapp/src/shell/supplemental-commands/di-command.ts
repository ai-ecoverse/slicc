/**
 * `di` (alias `uv`) command — a minimal Python package manager for SLICC.
 *
 * Thin argv + dispatch + error-formatting wrapper; all business logic lives in
 * `../di/`. Supported verbs are `add` and `list`; every other verb (including
 * real-uv subcommands like `pip` / `venv` / `tool` / `run`) exits non-zero with
 * a "not implemented in SLICC's di/uv subset" pointer to `di --help`.
 *
 * Registered twice (`di` and `uv`) with the same handler so `uv add numpy`
 * behaves identically to `di add numpy`.
 */

import type { Command, CommandContext, ExecResult, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { diAdd, diList, type ListRow } from '../di/index.js';

export interface DiCommandDeps {
  fs: VirtualFS;
  fetch: SecureFetch;
}

function usage(name: string): string {
  return `${name} - minimal Python package manager (pure-Python + Pyodide wheels)

Usage:
  ${name} add <pkg>[@<version>] [<pkg> ...]   resolve, stage, and record wheels
  ${name} add <pkg>==<version>                exact-version form
  ${name} list                               show recorded packages

Resolution:
  Packages in the Pyodide lockfile are fetched from the Pyodide CDN; everything
  else resolves against PyPI (pure-Python "none-any" wheels only). Wheels are
  staged under /workspace/python_wheels/ and recorded in pyproject.toml + uv.lock.

Anything else is not implemented in SLICC's ${name} subset; use real uv locally.
`;
}

function notImplemented(name: string, verb: string): ExecResult {
  return {
    stdout: '',
    stderr:
      `${name}: '${verb}' is not implemented in SLICC's di/uv subset; use real uv locally. ` +
      `Run '${name} --help' for supported verbs.\n`,
    exitCode: 1,
  };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatList(rows: ListRow[]): string {
  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const versionWidth = Math.max(7, ...rows.map((r) => r.version.length));
  return `${rows
    .map((r) => `${r.name.padEnd(nameWidth)}  ${r.version.padEnd(versionWidth)}  (${r.source})`)
    .join('\n')}\n`;
}

async function runAdd(
  name: string,
  args: string[],
  ctx: CommandContext,
  deps: DiCommandDeps
): Promise<ExecResult> {
  const specs = args.filter((a) => !a.startsWith('-'));
  if (specs.length === 0) {
    return { stdout: '', stderr: `${name}: add requires at least one package\n`, exitCode: 1 };
  }

  let outcome: Awaited<ReturnType<typeof diAdd>>;
  try {
    outcome = await diAdd(deps.fs, deps.fetch, ctx.cwd, specs);
  } catch (err) {
    return { stdout: '', stderr: `${name}: ${describeError(err)}\n`, exitCode: 1 };
  }

  const stdout = outcome.results.map((r) =>
    r.staged
      ? `${name}: added ${r.name}==${r.version} (${r.source}) -> ${r.fileName}`
      : `${name}: ${r.name}==${r.version} already staged (${r.source})`
  );
  const stderr = outcome.errors.map(
    (e) => `${name}: failed to add ${e.spec}: ${describeError(e.error)}`
  );

  return {
    stdout: stdout.length > 0 ? `${stdout.join('\n')}\n` : '',
    stderr: stderr.length > 0 ? `${stderr.join('\n')}\n` : '',
    exitCode: outcome.errors.length === 0 ? 0 : 1,
  };
}

async function runList(
  name: string,
  ctx: CommandContext,
  deps: DiCommandDeps
): Promise<ExecResult> {
  const rows = await diList(deps.fs, ctx.cwd);
  if (rows === null) {
    return {
      stdout: '',
      stderr: `${name}: no pyproject.toml found (run '${name} add <pkg>' first)\n`,
      exitCode: 0,
    };
  }
  if (rows.length === 0) {
    return { stdout: `${name}: no dependencies recorded\n`, stderr: '', exitCode: 0 };
  }
  return { stdout: formatList(rows), stderr: '', exitCode: 0 };
}

export function createDiCommand(name: string, deps: DiCommandDeps): Command {
  return defineCommand(name, async (args: string[], ctx: CommandContext) => {
    if (args.length === 0) {
      return { stdout: usage(name), stderr: `${name}: missing verb\n`, exitCode: 1 };
    }
    if (args[0] === '--help' || args[0] === '-h') {
      return { stdout: usage(name), stderr: '', exitCode: 0 };
    }

    const verb = args[0];
    const rest = args.slice(1);
    if (verb === 'add') return runAdd(name, rest, ctx, deps);
    if (verb === 'list') return runList(name, ctx, deps);
    return notImplemented(name, verb);
  });
}
