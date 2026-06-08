/**
 * Welcome-completion sentinel writer — `/shared/.welcomed` marks that the
 * first-run wizard has reached the "shortcut migrate" step, so subsequent
 * boots skip the welcome dip.
 *
 * The dip's `shortcut-migrate` lick handler in `main.ts` fires this from
 * both the extension and standalone paths. Extracted here so the
 * leader/follower gating under `slicc_opfs_vfs === 'opfs'` is testable
 * without booting the full UI.
 *
 * Under the OPFS flag the write must route through the page-side
 * `WritableVfsClient` so it lands on the worker-owned canonical OPFS
 * store (matching the freezer / pending-enrichment reroute). Only
 * the OPFS-leader tab may write — a follower's `writableFs` is the
 * page-side LFS shadow which the worker-OPFS-backed UI never reads,
 * so its write would be a silent orphan (matches the follower-no-op
 * for `scheduleBackgroundEnrichment`).
 *
 * Flag off: `writableFs === localFs` (no remote client constructed)
 * AND `isWriter === true` (no election ran), so the call collapses
 * to `localFs.writeFile('/shared/.welcomed', '1')` byte-for-byte.
 */

import { createLogger } from '../core/logger.js';
import type { WritableVfsClient } from '../kernel/writable-vfs-client.js';

const log = createLogger('welcome-sentinel');

export const WELCOME_SENTINEL_PATH = '/shared/.welcomed';

export interface PersistWelcomeSentinelOptions {
  /**
   * Writable VFS handle. Flag off: the page-side `VirtualFS`. Flag on +
   * leader: `RemoteWritableVfsClient` (writes route to the worker over
   * the kernel transport). Flag on + follower: ignored — the call no-ops
   * before touching this.
   */
  writableFs: WritableVfsClient;
  /**
   * `true` when this tab may write to canonical storage. Flag off: pass
   * `true` (no election ran). Flag on: pass `__slicc_opfs_leader.isLeader`.
   * `false` short-circuits the write so a follower stays read-only.
   */
  isWriter: boolean;
}

/**
 * Persist the welcome-completion sentinel. Fire-and-forget — failures are
 * logged at `warn` so a transient IDB/OPFS hiccup doesn't break the
 * onboarding flow. Mirrors the pre-B4b inline call shape exactly so the
 * flag-off path stays byte-identical.
 */
export function persistWelcomeSentinel(opts: PersistWelcomeSentinelOptions): void {
  if (!opts.isWriter) {
    log.info('Welcome sentinel write skipped (OPFS follower — read-only tab)');
    return;
  }
  void opts.writableFs
    .writeFile(WELCOME_SENTINEL_PATH, '1')
    .catch((err) => log.warn('Failed to persist welcome completion marker', err));
}
