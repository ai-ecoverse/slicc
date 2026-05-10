import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

/**
 * BroadcastChannel name shared with the page-side reload listener
 * (`installNukeReloadListener`). Worker mode runs the shell in a
 * DedicatedWorker where `location.reload()` is a no-op, so nuke
 * broadcasts a reload request that any same-origin window can act on.
 */
export const NUKE_CONTROL_CHANNEL = 'slicc-nuke-control';

/**
 * Wire-format event the channel carries. Optionally carries a list of
 * `localStorage` keys for the listener to remove BEFORE reloading.
 *
 * Why the keys are sent in the broadcast: the worker's `localStorage`
 * is a Map-backed shim (see `kernel-worker.ts:installLocalStorageShim`)
 * and `installPageStorageSync` only forwards page→worker. Worker-side
 * `localStorage.removeItem(...)` updates the in-memory Map and dies
 * with the worker — never reaching the page's real `localStorage`.
 * The same applies in the extension: `nuke` runs in the offscreen
 * document, whose `localStorage` is isolated from the side panel's
 * (MV3 contexts each get their own). So the source-of-truth realm
 * (the page in standalone, the side panel in extension) needs to do
 * the removals itself; broadcasting the key list lets the listener
 * apply them synchronously before triggering `location.reload()`.
 */
export interface NukeReloadMsg {
  type: 'nuke-reload';
  /** localStorage keys to remove on the page side before reloading. */
  keysToRemove?: string[];
}

/**
 * `localStorage` keys cleared on every nuke. Provider credentials and
 * layout prefs survive by design (nuke is "wipe local state", not
 * "factory reset"); state that would suppress the welcome flow on
 * the next boot must be cleared so a fresh nuked instance behaves
 * like a fresh install.
 *
 * Exported so tests can pin the list and the page-side listener can
 * apply the same set even when called for other reasons.
 */
export const NUKE_LOCAL_STORAGE_KEYS: readonly string[] = [
  // Welcome-flow dedup ledger so the welcome dip and its follow-up
  // licks fire fresh on the next boot.
  'slicc:welcome-flow-fired',
  // Tray-join URL + matching worker base URL. The local IDB state
  // that backs the tray follower is wiped by nuke (slicc-fs,
  // sessions, mounts), so a stale `slicc.trayJoinUrl` would gate the
  // welcome flow `if (!hasStoredTrayJoinUrl(...))` AND point at a
  // peer the local tab can no longer rejoin without re-onboarding.
  'slicc.trayJoinUrl',
  'slicc.trayWorkerBaseUrl',
];

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

/**
 * Listen for nuke-reload broadcasts in a page context. On receipt:
 *
 *   1. Synchronously remove every key in `keysToRemove` from the
 *      page's REAL `localStorage` (the worker / offscreen couldn't
 *      reach it themselves; see {@link NukeReloadMsg}).
 *   2. Call `onReload()` (defaults to `location.reload()`).
 *
 * Returns a disposer that detaches the listener. Wired by the page
 * bootstrap (`mainStandaloneWorker` / extension panel bootstrap) so
 * nuke run from any same-origin context — including the kernel-worker
 * shell or the extension's offscreen document — can trigger a page
 * reload AND propagate its localStorage clears. The listener is
 * intentionally minimal: the broadcast carries no auth, but it's
 * scoped to the same origin and the only writers are nuke itself.
 */
export function installNukeReloadListener(
  onReload: () => void = () => location.reload()
): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
  const handler = (event: MessageEvent): void => {
    const data = event.data as NukeReloadMsg | undefined;
    if (data?.type !== 'nuke-reload') return;
    if (Array.isArray(data.keysToRemove)) {
      for (const key of data.keysToRemove) {
        if (typeof key !== 'string') continue;
        try {
          localStorage.removeItem(key);
        } catch {
          /* localStorage disabled — ignore */
        }
      }
    }
    onReload();
  };
  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
    channel.close();
  };
}
