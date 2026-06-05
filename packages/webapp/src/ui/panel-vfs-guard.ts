/**
 * The offscreen document is the sole canonical `VirtualFS`
 * constructor in extension mode; the side panel must stay a pure
 * RPC consumer of the worker's `VfsRpcHost`. Constructing a second
 * OPFS-backed `VirtualFS` from the panel would race the offscreen
 * on the same underlying storage and undermine the canonical-owner
 * invariant.
 *
 * This is intentionally **convention enforcement plus a guard log** —
 * not a runtime block. We still allow `VirtualFS.create` to run (for
 * the legacy LFS-shadow + mount-table-recovery paths) but emit a
 * loud warning so any regression that touches OPFS from the panel
 * surfaces in dev/QA before it ships.
 */

import type { VfsBackend } from '../fs/virtual-fs.js';

/** Minimal logger shape — matches `createLogger('main')` and friends. */
export interface PanelVfsGuardLogger {
  warn(message: string, ...data: unknown[]): void;
}

/**
 * Emit a startup warning when the side panel is about to construct
 * an OPFS-backed `VirtualFS`. Returns `true` when the warning fired
 * (useful for tests / telemetry hooks).
 */
export function warnIfPanelVfsConstructionUnderOpfs(
  backend: VfsBackend,
  logger: PanelVfsGuardLogger
): boolean {
  if (backend !== 'opfs') return false;
  logger.warn(
    'Side panel attempted VirtualFS.create with an OPFS-backed instance. ' +
      'Offscreen must be the sole VFS constructor; the panel should stay an RPC consumer.'
  );
  return true;
}
