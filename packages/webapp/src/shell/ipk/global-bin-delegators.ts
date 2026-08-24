/**
 * Publish PATH-visible `.jsh` delegators for globally installed package bins.
 *
 * Each delegator forwards to `ipx <bin> …` so execution uses the same jsh
 * runtime, module loader, and provider env seeding as a direct ipx invocation.
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
    "const { spawn } = require('sliccy:exec');",
    `const __bin = ${escaped};`,
    "spawn(['ipx', __bin, ...process.argv.slice(2)])",
    '  .then((r) => process.exit(r.exitCode), () => process.exit(1));',
    '',
  ].join('\n');
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
    await fs.writeFile(path, buildDelegatorSource(binName));
  }
}
