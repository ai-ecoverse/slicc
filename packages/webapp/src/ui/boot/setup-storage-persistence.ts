import { createLogger } from '../../base/logger.js';

const log = createLogger('storage-persist');

interface StorageManagerLike {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

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
    return undefined;
  }
}

export async function requestStoragePersistence(
  storage: StorageManagerLike | undefined = resolveStorage()
): Promise<StoragePersistenceOutcome> {
  try {
    if (typeof storage?.persist !== 'function') return 'unsupported';
    if (typeof storage.persisted === 'function' && (await storage.persisted())) {
      return 'already-persisted';
    }
    return (await storage.persist()) ? 'granted' : 'denied';
  } catch (err) {
    log.warn('storage persistence check failed', err);
    return 'failed';
  }
}

let requested = false;

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
          log.warn(
            'Browser declined persistent storage — SLICC data can be evicted if the disk fills up'
          );
          break;
        case 'unsupported':
          log.debug('navigator.storage.persist() unavailable in this runtime');
          break;
        case 'failed':
          break;
      }
    })

    .catch(() => {});
}

export function __resetStoragePersistenceForTest(): void {
  requested = false;
}
