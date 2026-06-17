import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import {
  NUKE_CONTROL_CHANNEL,
  NUKE_LOCAL_STORAGE_KEYS,
  type NukeReloadMsg,
} from './nuke-channel.js';

// Re-export the channel-layer symbols so existing consumers (including
// the test suite) keep their import paths working. New page-side
// callers should import directly from `./nuke-channel.js` to avoid
// pulling `just-bash` into the page bundle (see file header below).
export {
  installNukeReloadListener,
  NUKE_CONTROL_CHANNEL,
  NUKE_LOCAL_STORAGE_KEYS,
  type NukeReloadMsg,
} from './nuke-channel.js';

export function createNukeCommand(): Command {
  return defineCommand('nuke', async (args) => {
    // Help flag
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout:
          'Usage: nuke <launch-code>\n\n' +
          'Completely reset the environment by deleting all local data and reloading.\n' +
          'Destroys the file system, chat history, and scoops database.\n' +
          'Requires the secret launch code to proceed.\n',
        stderr: '',
        exitCode: 0,
      };
    }

    // Check for the secret launch code: args must contain '1234' when concatenated
    if (args.join('').includes('1234')) {
      // Drop the service worker first — it keeps its own IDB
      // connections open and will block deleteDatabase otherwise.
      // Then await every delete BEFORE reloading: a half-finished
      // delete that completes during the new page's `open()` aborts
      // the upgrade with "Version change transaction was aborted in
      // upgradeneeded event handler", leaving the user stranded on a
      // "Failed to start" screen.
      void (async () => {
        try {
          const regs = await navigator.serviceWorker?.getRegistrations?.();
          if (regs) await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
        } catch {
          /* ignore — best effort */
        }
        // localStorage clears are intentionally NOT done here in
        // worker / offscreen contexts — they'd write to a per-context
        // shim or an isolated MV3 storage and be lost. Instead we
        // forward the key list to the page-side listener via
        // `triggerReload(NUKE_LOCAL_STORAGE_KEYS)` below, which
        // removes them from the real `localStorage` before reloading.
        try {
          const dbs = await indexedDB.databases();
          await Promise.all(
            dbs
              .filter((db): db is { name: string; version?: number } => !!db.name)
              .map(
                (db) =>
                  new Promise<void>((resolve) => {
                    const req = indexedDB.deleteDatabase(db.name);
                    // `onblocked` fires when another tab is holding a
                    // connection — resolve anyway so we don't hang the
                    // reload forever; the worst case is a single DB
                    // surviving, which the user can fix with a
                    // second nuke.
                    req.onsuccess = () => resolve();
                    req.onerror = () => resolve();
                    req.onblocked = () => resolve();
                  })
              )
          );
        } catch {
          /* indexedDB.databases unsupported on some browsers — fall through */
        }

        // Wipe the OPFS-backed VFS tree. Since the ZenFS/OPFS migration
        // the bulk of local state (workspace files, scoops, mounts) lives
        // in OPFS, not IndexedDB, so a nuke that only wipes IDB would
        // leave the user's prior workspace on disk. Guard on
        // `navigator.storage.getDirectory` (mirrors
        // `resolveVfsBackendFromEnv`) so contexts without OPFS — older
        // browsers, some test envs — fall through cleanly.
        try {
          const storage = (navigator as unknown as { storage?: StorageManager }).storage;
          if (typeof storage?.getDirectory === 'function') {
            const root = (await storage.getDirectory()) as unknown as {
              keys: () => AsyncIterableIterator<string>;
              removeEntry: (name: string, options?: { recursive: boolean }) => Promise<void>;
            };
            const names: string[] = [];
            for await (const name of root.keys()) names.push(name);
            await Promise.all(
              names.map((name) => root.removeEntry(name, { recursive: true }).catch(() => {}))
            );
          }
        } catch {
          /* OPFS unavailable / blocked — best effort, never block reload */
        }

        triggerReload(NUKE_LOCAL_STORAGE_KEYS);
      })();
      return { stdout: 'Nuking everything…\n', stderr: '', exitCode: 0 };
    }

    // No valid launch code — show warning
    return {
      stdout: '',
      stderr:
        '⚠️  WARNING: this will reset the entire environment, file system, chats, and scoops.\n' +
        'Run nuke again with the secret launch code to proceed.\n',
      exitCode: 1,
    };
  });
}

/**
 * Trigger a page reload. From a window context this is a direct
 * `location.reload()`; from a DedicatedWorker (kernel-worker mode) the
 * worker can't reload the page, so we broadcast a reload request that
 * `installNukeReloadListener` (running in the page) acts on. Both
 * paths fire defensively so a missing listener still falls back to
 * the in-context reload attempt.
 *
 * `keysToRemove` is the list of `localStorage` entries the listener
 * should clear on the page side before reloading — see
 * {@link NukeReloadMsg} for why this can't be done in-process.
 */
function triggerReload(keysToRemove: readonly string[] = []): void {
  const keys = [...keysToRemove];
  try {
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
      channel.postMessage({ type: 'nuke-reload', keysToRemove: keys } satisfies NukeReloadMsg);
      // Close after a short delay so the message has time to flush.
      setTimeout(() => channel.close(), 100);
    }
  } catch {
    /* environment without BroadcastChannel — fall through */
  }
  // Best-effort same-context removal too — only meaningful when we're
  // actually IN the page realm (e.g. a future inline standalone path).
  // In worker / offscreen this writes to a shim and is harmless.
  for (const key of keys) {
    try {
      (globalThis as { localStorage?: Storage }).localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
  }
  try {
    // Bypass the bf-cache so the new page boots from a clean slate.
    // No-op in DedicatedWorkers where `location.reload` is undefined,
    // which is fine — the broadcast above handles those contexts.
    const loc = (globalThis as { location?: { reload?: () => void } }).location;
    loc?.reload?.();
  } catch {
    /* ignore */
  }
}
