/**
 * `setup-storage-persistence.ts` — ask the browser to stop treating
 * SLICC's filesystem as disposable.
 *
 * SLICC's entire VFS — workspace, sessions, memory, git checkouts — is an
 * OPFS tree. OPFS lives in the quota manager's *best-effort* storage, so
 * Chromium reclaims disk space by evicting whole buckets: whenever free
 * space drops below `min(2 GiB, 10% of the volume)`,
 * `QuotaTemporaryStorageEvictor` runs (every 30 minutes, first round 5
 * minutes after startup) and deletes least-recently-used buckets until the
 * shortage is covered. "Bucket" means the origin's *entire* OPFS tree,
 * removed at once, silently, while the tab keeps running. There is no
 * event to listen for and nothing in the page can veto it after the fact.
 *
 * `navigator.storage.persist()` is the one lever the page does have. A
 * granted request marks the origin's default bucket persistent, and the
 * eviction query skips those rows outright:
 *
 * ```sql
 * SELECT id, storage_key, name FROM buckets WHERE persistent = 0 ORDER BY last_accessed
 * ```
 * (`storage/browser/quota/quota_database.cc`)
 *
 * So this is not a nice-to-have hint — it is the difference between being
 * on the eviction list and being off it.
 *
 * **It never prompts.** Chromium auto-decides from site engagement,
 * bookmarks, notification permission, and PWA installation; Firefox is the
 * engine that would show a permission prompt, and it does not implement
 * OPFS eviction the same way. A denial is therefore not something the user
 * refused — it means the heuristics have not warmed up yet, so we log it
 * and move on. Re-requesting on the next boot is exactly right: the answer
 * changes as engagement accumulates.
 *
 * Fire-and-forget from `main.ts` — nothing about boot may wait on it.
 */

import { createLogger } from '../../base/logger.js';

const log = createLogger('storage-persist');

/** The sliver of `StorageManager` this module uses. */
interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

/**
 * What came back. Distinguished rather than collapsed to a boolean so the
 * log (and the tests) can tell "the browser has no opinion yet" apart from
 * "this browser cannot do it at all" — only the latter is permanent.
 */
export type StoragePersistenceOutcome =
  | 'already-persisted'
  | 'granted'
  | 'denied'
  | 'unsupported'
  | 'failed';

function resolveStorage(): StorageManagerLike | undefined {
  try {
    return (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator?.storage;
  } catch {
    // `navigator` is absent in Node/Vitest and can throw behind some
    // hardened embedders.
    return undefined;
  }
}

/**
 * Request persistence for this origin's default bucket.
 *
 * Checks {@link StorageManagerLike.persisted} first: a bucket that is
 * already persistent needs nothing, and the distinction is worth logging —
 * "granted" on every reload would otherwise hide the fact that the grant is
 * sticky.
 *
 * Never throws. A storage API that rejects is a diagnostic, not a boot
 * failure; the data is exactly as safe as it was before the call.
 */
export async function requestStoragePersistence(
  storage: StorageManagerLike | undefined = resolveStorage()
): Promise<StoragePersistenceOutcome> {
  try {
    // Inside the guard, not before it: a hardened or proxied
    // `StorageManager` can throw on plain property access, and a capability
    // check that rejects would defeat the whole point of this `try`.
    if (typeof storage?.persist !== 'function') return 'unsupported';
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      return 'already-persisted';
    }
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch (err) {
    // Deliberately names the check rather than `persist()` — `persisted()`
    // and the capability probe above reach this same handler.
    log.warn('storage persistence check failed', err);
    return 'failed';
  }
}

let requested = false;

/**
 * Kick off the request once per page. Idempotent — repeat calls are no-ops,
 * so a runtime that boots through more than one path cannot double-request.
 *
 * Deliberately returns `void` rather than the promise: no caller should be
 * able to accidentally `await` this onto the boot critical path.
 */
export function setupStoragePersistence(): void {
  if (requested) return;
  requested = true;
  void requestStoragePersistence()
    .then((outcome) => {
      switch (outcome) {
        case 'granted':
          log.info('OPFS marked persistent — SLICC data is now exempt from disk-pressure eviction');
          break;
        case 'already-persisted':
          log.debug('OPFS already persistent');
          break;
        case 'denied':
          // Worth a warning: the VFS is a live eviction candidate until this
          // flips, and `df` reports the same flag if anyone goes looking.
          log.warn(
            'Browser declined persistent storage — SLICC data can be evicted if the disk fills up'
          );
          break;
        case 'unsupported':
          log.debug('navigator.storage.persist() unavailable in this runtime');
          break;
        case 'failed':
          // Already logged with the underlying error inside
          // `requestStoragePersistence` — saying it twice adds nothing.
          break;
      }
    })
    // Belt and braces. `requestStoragePersistence` already fails closed, so
    // the only way here is the logging above throwing — and an unhandled
    // rejection on the boot path lands in `main()`'s catch and puts the user
    // on the recovery screen over a storage hint.
    .catch(() => {});
}

/** Test-only: clear the once-per-page latch. */
export function __resetStoragePersistenceForTest(): void {
  requested = false;
}
