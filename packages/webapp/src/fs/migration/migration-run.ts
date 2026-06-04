/**
 * Wave C2 — VFS-bound migration runner.
 *
 * Wraps the C1 detection module (`migration-detect.ts`) and the C2
 * pure copy module (`migration-copy.ts`) and wires them to the live
 * worker-owned `VirtualFS` instance plus a real LightningFS read
 * handle against the legacy `slicc-fs` IDB.
 *
 * Callers MUST guard on `sharedFs.backend === 'opfs'` so the flag-off
 * (LFS) path stays byte-identical and never imports this module. C1
 * already does that at the kernel-host integration site
 * (`host.ts:349`).
 *
 * Lifecycle (worker boot, sentinel absent):
 *   1. Detect via C1 → `needs-migration` returns the read-only manifest.
 *   2. Run C2 copy:
 *        - mkdir + writeFile + symlink into OPFS via the VFS surface,
 *        - flush metadata sidecar,
 *        - count OPFS files + bytes,
 *        - on exact parity, write `/.slicc-migrated` atomically as the
 *          LAST operation.
 *   3. On any error or parity mismatch: the sentinel is NOT written,
 *      the OPFS state is left for retry, and the legacy IDB is
 *      untouched (we only ever called read-only LightningFS APIs).
 *
 * Re-boot after a successful run hits C1's sentinel-present fast
 * no-op and never imports this module's heavy code path.
 */

import type { VirtualFS } from '../virtual-fs.js';
import {
  type LegacyFileReader,
  type MigrationCopyResult,
  OPFS_MIGRATION_SENTINEL,
  type OpfsParityCount,
  type OpfsTargetWriter,
  runLegacyMigrationCopy,
} from './migration-copy.js';
import {
  OPFS_MIGRATION_SENTINEL as DETECT_SENTINEL,
  detectLegacyMigration,
  LEGACY_LFS_DB_NAME,
  type LegacyLfsReader,
  type MigrationLogger,
} from './migration-detect.js';
import { assertMigrationNotInSidePanel, type MigrationCallerEnv } from './migration-guard.js';

// Compile-time guard — the C1 sentinel constant must equal the C2 one
// (a divergence would mean C1 says "migrated" against a file C2 never
// wrote, silently breaking the gate).
const _SENTINEL_CHECK: typeof OPFS_MIGRATION_SENTINEL = DETECT_SENTINEL;
void _SENTINEL_CHECK;

export type MigrationRunResult =
  | { kind: 'sentinel-present' }
  | { kind: 'legacy-absent' }
  | { kind: 'copied'; result: MigrationCopyResult };

export interface RunLegacyMigrationFromVfsDeps {
  /**
   * Builds the legacy LightningFS reader (read-only file bytes). Defaults
   * to a real `@isomorphic-git/lightning-fs` instance against
   * `slicc-fs`.
   */
  legacyReaderFactory?: () => Promise<LegacyFileReader>;
  /**
   * Override the C1 LightningFS reader factory (for the walk). Defaults
   * to a real `@isomorphic-git/lightning-fs` instance against
   * `slicc-fs`.
   */
  legacyLfsFactory?: () => Promise<LegacyLfsReader>;
  /** OPFS-existence probe override (forwarded to C1). */
  probeLegacyDbExists?: () => Promise<boolean>;
  logger?: MigrationLogger;
  /**
   * Wave C4 caller-environment override. Tests pass a simulated env
   * (extension side panel, offscreen, worker, ...) so the side-panel
   * guard can be exercised without monkey-patching globals. Production
   * callers leave this undefined — the guard snapshots `globalThis`.
   */
  callerEnv?: MigrationCallerEnv;
}

/**
 * Worker-boot entry point. Runs C1 detection and, when needed, the
 * C2 copy + parity + sentinel write. Returns a structured result
 * (no exceptions thrown to the caller — boot is fire-and-forget).
 */
export async function runLegacyMigrationFromVfs(
  sharedFs: VirtualFS,
  deps: RunLegacyMigrationFromVfsDeps = {}
): Promise<MigrationRunResult> {
  // Wave C4 — defensive guard: the side panel must never invoke the
  // migration (the offscreen document is the sole VFS owner under the
  // `slicc_opfs_vfs` flag). Today the panel boot path doesn't import
  // this module; the assert protects against future regressions.
  assertMigrationNotInSidePanel(deps.callerEnv);
  const logger = deps.logger;
  const detection = await detectLegacyMigration({
    sentinelExists: async () => {
      try {
        await sharedFs.stat(OPFS_MIGRATION_SENTINEL);
        return true;
      } catch {
        return false;
      }
    },
    probeLegacyDbExists: deps.probeLegacyDbExists ?? defaultProbeLegacyDbExists,
    lfsFactory: deps.legacyLfsFactory ?? defaultLegacyLfsFactory,
    logger,
  });
  if (detection.kind === 'sentinel-present') return { kind: 'sentinel-present' };
  if (detection.kind === 'legacy-absent') return { kind: 'legacy-absent' };

  const source = await (deps.legacyReaderFactory ?? defaultLegacyReaderFactory)();
  const target = buildVfsTargetWriter(sharedFs);

  const result = await runLegacyMigrationCopy({
    manifest: detection.manifest,
    source,
    target,
    countOpfsFiles: () => countOpfsFiles(sharedFs),
    flushBeforeSentinel: () => sharedFs.flush().catch(() => {}),
    writeSentinel: async () => {
      // Atomic at the OPFS layer: a single writeFile call replaces
      // any existing entry. Empty content keeps the file as a pure
      // presence marker — C1 stats it, never reads its body.
      await sharedFs.writeFile(OPFS_MIGRATION_SENTINEL, '');
      // Persist the sentinel's inode in the metadata sidecar so a
      // crash between writeFile and the next mount can't lose it.
      await sharedFs.flush().catch(() => {});
    },
    logger,
  });

  return { kind: 'copied', result };
}

/**
 * Construct an {@link OpfsTargetWriter} backed by the shared
 * `VirtualFS`. `VirtualFS.mkdir({ recursive: true })` is idempotent
 * for existing dirs; `writeFile` accepts `Uint8Array`; `symlink` lands
 * in the Wave A metadata sidecar on the OPFS backend.
 */
function buildVfsTargetWriter(sharedFs: VirtualFS): OpfsTargetWriter {
  return {
    mkdir: async (path: string) => {
      await sharedFs.mkdir(path, { recursive: true });
    },
    writeFile: async (path: string, content: Uint8Array) => {
      await sharedFs.writeFile(path, content);
    },
    symlink: async (target: string, linkPath: string) => {
      await sharedFs.symlink(target, linkPath);
    },
  };
}

/**
 * Walk the OPFS-backed VFS and count regular files + sum their
 * sizes. Skips symlinks (counted separately in the C1 manifest), the
 * sentinel (not yet written at this point), and the ZenFS metadata
 * sidecar (`/.metadata.json`) since it's not legacy data.
 */
export async function countOpfsFiles(sharedFs: VirtualFS): Promise<OpfsParityCount> {
  let fileCount = 0;
  let totalBytes = 0;
  await walkLstat(sharedFs, '/', async (path, stat) => {
    if (path === OPFS_MIGRATION_SENTINEL) return;
    if (path === '/.metadata.json') return;
    if (stat.type === 'file') {
      fileCount++;
      totalBytes += stat.size ?? 0;
    }
  });
  return { fileCount, totalBytes };
}

async function walkLstat(
  sharedFs: VirtualFS,
  dir: string,
  visit: (path: string, stat: { type: string; size?: number }) => Promise<void>
): Promise<void> {
  let entries: { name: string; type: string }[];
  try {
    entries = await sharedFs.readDir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = dir === '/' ? `/${entry.name}` : `${dir}/${entry.name}`;
    let stat: { type: string; size?: number };
    try {
      stat = await sharedFs.lstat(path);
    } catch {
      continue;
    }
    await visit(path, stat);
    if (stat.type === 'directory') {
      await walkLstat(sharedFs, path, visit);
    }
  }
}

async function defaultLegacyReaderFactory(): Promise<LegacyFileReader> {
  const FS = (await import('@isomorphic-git/lightning-fs')).default;
  const lfs = new FS(LEGACY_LFS_DB_NAME).promises;
  return {
    readFile: async (path: string) => {
      const out = await lfs.readFile(path);
      // `@isomorphic-git/lightning-fs` returns Uint8Array for binary reads
      // when no encoding is passed; normalize defensively.
      if (out instanceof Uint8Array) return out;
      return new TextEncoder().encode(String(out));
    },
  };
}

async function defaultLegacyLfsFactory(): Promise<LegacyLfsReader> {
  const FS = (await import('@isomorphic-git/lightning-fs')).default;
  return new FS(LEGACY_LFS_DB_NAME).promises as unknown as LegacyLfsReader;
}

async function defaultProbeLegacyDbExists(): Promise<boolean> {
  try {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) return false;
    const databases = (factory as { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (typeof databases !== 'function') return true;
    const dbs = await databases.call(factory);
    return dbs.some((d) => d.name === LEGACY_LFS_DB_NAME);
  } catch {
    return true;
  }
}
