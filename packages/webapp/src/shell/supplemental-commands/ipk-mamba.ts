import type { CommandContext, ExecResult, SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import {
  CONDA_PREFIX,
  DEFAULT_CONDA_CHANNELS,
  installCondaPackages,
  listInstalledCondaPackages,
  uninstallCondaPackages,
} from '../ipk/mamba-installer.js';
import { isHelpRequest, subcommandHelpText } from './subcommand-help.js';

export interface IpkMambaDeps {
  fs: VirtualFS;
  fetch: SecureFetch;
}

const INSTALL_ALIASES = new Set(['install', 'i', 'add']);
const UNINSTALL_ALIASES = new Set(['uninstall', 'remove', 'rm', 'un']);
const LIST_ALIASES = new Set(['list', 'ls']);

export function mambaUsage(parent: string): string {
  return `${parent} mamba - install emscripten-wasm32 packages from conda/emscripten-forge

Usage:
  ${parent} mamba install <pkg>[=<version>] ...
  ${parent} mamba list
  ${parent} mamba uninstall <pkg> ...

  install <pkg>[=<version>] ...
    Download and extract into ${CONDA_PREFIX}
  list
    List packages recorded under ${CONDA_PREFIX}/conda-meta
  uninstall|remove|rm <pkg> ...
    Remove package files and conda-meta record

Prefix:
  Packages extract into ${CONDA_PREFIX} (lib/, include/, bin/, conda-meta/).
  Shared conda env alongside npm's /shared/lib/node_modules.

Channels (default):
  ${DEFAULT_CONDA_CHANNELS.map((c) => `- ${c}`).join('\n  ')}
  Platform: emscripten-wasm32 (+ conda-forge noarch)

Spec forms:
  zlib              install the newest indexed build
  zlib=1.3.1        install that exact version (newest build)

Limitations (honest):
  Thin index lookup — not a full mamba/rattler SAT solve. Virtual packages
  (emscripten-abi, __*) are skipped; hard depends are NOT auto-installed.
  Archives: .tar.bz2 (current emscripten-forge format). .conda (zip+zstd)
  is not supported yet.

  Not a drop-in for convert/ffmpeg/python: those built-ins still need npm
  (@imagemagick/magick-wasm, @ffmpeg/core, pyodide). Forge imagemagick/ffmpeg
  ship link libraries (and incomplete CLI JS without .wasm); there is no
  forge pyodide. Use ipk mamba for forge libs such as zlib/libpng.

Options:
  -h, --help        Show this help message
`;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function formatCondaList(
  prefix: string,
  packages: Array<{ name: string; version: string; build: string }>
): string {
  if (packages.length === 0) {
    return `${prefix}\n└── (empty)\n`;
  }
  const lines = [`${prefix}`];
  for (let i = 0; i < packages.length; i++) {
    const branch = i === packages.length - 1 ? '└──' : '├──';
    const p = packages[i]!;
    lines.push(`${branch} ${p.name}-${p.version}-${p.build}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runMambaInstall(
  parent: string,
  args: string[],
  deps: IpkMambaDeps
): Promise<ExecResult> {
  const specs = args.filter((a) => !a.startsWith('-'));
  if (specs.length === 0) {
    return {
      stdout: '',
      stderr: `${parent} mamba install: requires at least one package name\n`,
      exitCode: 1,
    };
  }

  let outcome: Awaited<ReturnType<typeof installCondaPackages>>;
  try {
    outcome = await installCondaPackages(specs, {
      fs: deps.fs,
      fetch: deps.fetch,
    });
  } catch (err) {
    return {
      stdout: '',
      stderr: `${parent} mamba: install failed: ${describeError(err)}\n`,
      exitCode: 1,
    };
  }

  const stdout = outcome.results.map(
    (r) =>
      `${parent} mamba: installed ${r.name}-${r.version}-${r.build} ` +
      `(${r.files} files) -> ${r.prefix}`
  );
  const stderr = outcome.errors.map(
    (e) => `${parent} mamba: failed to install ${e.spec}: ${describeError(e.error)}`
  );

  return {
    stdout: stdout.length > 0 ? `${stdout.join('\n')}\n` : '',
    stderr: stderr.length > 0 ? `${stderr.join('\n')}\n` : '',
    exitCode: outcome.errors.length === 0 ? 0 : 1,
  };
}

async function runMambaList(parent: string, deps: IpkMambaDeps): Promise<ExecResult> {
  try {
    const packages = await listInstalledCondaPackages(deps.fs);
    return {
      stdout: formatCondaList(CONDA_PREFIX, packages),
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    return {
      stdout: '',
      stderr: `${parent} mamba: list failed: ${describeError(err)}\n`,
      exitCode: 1,
    };
  }
}

async function runMambaUninstall(
  parent: string,
  args: string[],
  deps: IpkMambaDeps
): Promise<ExecResult> {
  const names = args.filter((a) => !a.startsWith('-'));
  if (names.length === 0) {
    return {
      stdout: '',
      stderr: `${parent} mamba uninstall: requires at least one package name\n`,
      exitCode: 1,
    };
  }

  let outcome: Awaited<ReturnType<typeof uninstallCondaPackages>>;
  try {
    outcome = await uninstallCondaPackages(names, { fs: deps.fs });
  } catch (err) {
    return {
      stdout: '',
      stderr: `${parent} mamba: uninstall failed: ${describeError(err)}\n`,
      exitCode: 1,
    };
  }

  const stdout = outcome.results
    .filter((r) => r.removed)
    .map(
      (r) =>
        `${parent} mamba: removed ${r.name}` +
        (r.version && r.build ? `-${r.version}-${r.build}` : '')
    );
  const skipped = outcome.results.filter((r) => !r.removed).map((r) => r.name);
  const stderrParts = outcome.errors.map(
    (e) => `${parent} mamba: failed to uninstall ${e.spec}: ${describeError(e.error)}`
  );
  if (skipped.length > 0) {
    stderrParts.push(`${parent} mamba: ${skipped.join(', ')} not installed`);
  }

  return {
    stdout: stdout.length > 0 ? `${stdout.join('\n')}\n` : '',
    stderr: stderrParts.length > 0 ? `${stderrParts.join('\n')}\n` : '',
    exitCode: outcome.errors.length === 0 ? 0 : 1,
  };
}

export async function runIpkMamba(
  parent: string,
  args: string[],
  _ctx: CommandContext,
  deps: IpkMambaDeps
): Promise<ExecResult> {
  const help = mambaUsage(parent);

  if (args.length === 0) {
    return { stdout: help, stderr: `${parent} mamba: missing subcommand\n`, exitCode: 1 };
  }

  if (isHelpRequest(args)) {
    return { stdout: help, stderr: '', exitCode: 0 };
  }

  const sub = args[0]!;
  const rest = args.slice(1);

  if (isHelpRequest(rest)) {
    return {
      stdout: subcommandHelpText(`${parent} mamba`, sub, help),
      stderr: '',
      exitCode: 0,
    };
  }

  if (INSTALL_ALIASES.has(sub)) {
    return runMambaInstall(parent, rest, deps);
  }
  if (UNINSTALL_ALIASES.has(sub)) {
    return runMambaUninstall(parent, rest, deps);
  }
  if (LIST_ALIASES.has(sub)) {
    return runMambaList(parent, deps);
  }

  return {
    stdout: '',
    stderr:
      `${parent} mamba: unknown subcommand '${sub}' ` + `(supported: install, list, uninstall)\n`,
    exitCode: 1,
  };
}
