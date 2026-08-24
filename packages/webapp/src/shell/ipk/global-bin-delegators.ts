/**
 * Publish PATH-visible `.jsh` delegators for globally installed package bins.
 *
 * Each delegator forwards to `ipx --global <bin> …` so execution uses the
 * shared global tree regardless of the invoking cwd's local `node_modules`.
 */

import type { DirEntry, VirtualFS } from '../../fs/index.js';
import { GLOBAL_BIN_DELEGATOR_MARKER, GLOBAL_BIN_DIR } from './global-prefix.js';

function joinPath(base: string, ...parts: string[]): string {
  const segments = [base, ...parts]
    .join('/')
    .split('/')
    .filter((p) => p.length > 0);
  return `/${segments.join('/')}`;
}

function buildDelegatorSource(binName: string): string {
  const escaped = JSON.stringify(binName);
  return [
    `// ${GLOBAL_BIN_DELEGATOR_MARKER}`,
    "const { start } = require('sliccy:exec');",
    `const __bin = ${escaped};`,
    "const __argv = ['ipx', '--global', __bin, ...process.argv.slice(2)];",
    "const __stdin = typeof stdin !== 'undefined' ? stdin : undefined;",
    'const __h = start(__argv, __stdin !== undefined ? { stdin: __stdin } : undefined);',
    '__h.stdin.end();',
    'const __r = await __h.done;',
    'if (__r.stdout) process.stdout.write(__r.stdout);',
    'if (__r.stderr) process.stderr.write(__r.stderr);',
    'process.exit(__r.exitCode);',
    '',
  ].join('\n');
}

/** Thrown when a global bin name would overwrite a user-authored `/shared/bin` script. */
export class GlobalBinCollisionError extends Error {
  constructor(
    public readonly binName: string,
    public readonly path: string
  ) {
    super(`ipk: refusing to overwrite user script at ${path} (bin '${binName}')`);
    this.name = 'GlobalBinCollisionError';
  }
}

/**
 * Fail fast when publishing global bins would overwrite user-authored scripts.
 * Call before mutating {@link GLOBAL_NODE_MODULES} so failed installs leave no
 * untracked packages on disk.
 */
export async function preflightGlobalBinDelegators(
  fs: VirtualFS,
  activeBinNames: ReadonlySet<string>
): Promise<void> {
  if (activeBinNames.size === 0) return;
  if (!(await fs.exists(GLOBAL_BIN_DIR))) {
    await fs.mkdir(GLOBAL_BIN_DIR, { recursive: true });
  }
  for (const binName of activeBinNames) {
    if (!binName || binName.includes('/')) continue;
    const path = joinPath(GLOBAL_BIN_DIR, `${binName}.jsh`);
    if (await fs.exists(path)) {
      if (!(await readDelegatorMarker(fs, path))) {
        throw new GlobalBinCollisionError(binName, path);
      }
    }
  }
}

async function readDelegatorMarker(fs: VirtualFS, path: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path);
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
    return text.includes(GLOBAL_BIN_DELEGATOR_MARKER);
  } catch {
    return false;
  }
}

/**
 * Write or refresh `.jsh` delegators under {@link GLOBAL_BIN_DIR} for the given
 * bin names. Removes stale ipk-managed delegators whose names are absent from
 * `activeBinNames` without touching user-authored scripts in the same directory.
 */
export async function reconcileGlobalBinDelegators(
  fs: VirtualFS,
  activeBinNames: ReadonlySet<string>
): Promise<void> {
  if (!(await fs.exists(GLOBAL_BIN_DIR))) {
    if (activeBinNames.size === 0) return;
    await fs.mkdir(GLOBAL_BIN_DIR, { recursive: true });
  }

  let existing: DirEntry[] = [];
  try {
    existing = await fs.readDir(GLOBAL_BIN_DIR);
  } catch {
    existing = [];
  }

  for (const entry of existing) {
    if (entry.type !== 'file' || !entry.name.endsWith('.jsh')) continue;
    const binName = entry.name.slice(0, -'.jsh'.length);
    if (activeBinNames.has(binName)) continue;
    const path = joinPath(GLOBAL_BIN_DIR, entry.name);
    if (await readDelegatorMarker(fs, path)) {
      await fs.rm(path);
    }
  }

  for (const binName of activeBinNames) {
    if (!binName || binName.includes('/')) continue;
    const path = joinPath(GLOBAL_BIN_DIR, `${binName}.jsh`);
    if (await fs.exists(path)) {
      if (!(await readDelegatorMarker(fs, path))) {
        throw new GlobalBinCollisionError(binName, path);
      }
    }
    await fs.writeFile(path, buildDelegatorSource(binName));
  }
}
