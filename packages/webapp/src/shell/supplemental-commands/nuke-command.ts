import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

/**
 * BroadcastChannel name shared with the page-side reload listener
 * (`installNukeReloadListener`). Worker mode runs the shell in a
 * DedicatedWorker where `location.reload()` is a no-op, so nuke
 * broadcasts a reload request that any same-origin window can act on.
 */
export const NUKE_CONTROL_CHANNEL = 'slicc-nuke-control';

/** Wire-format event the channel carries. */
export interface NukeReloadMsg {
  type: 'nuke-reload';
}

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
        try {
          // Drop the welcome-flow dedup ledger so the welcome dip
          // and its follow-up licks fire fresh on the next boot.
          // (Other localStorage entries — provider keys, layout prefs
          // — survive nuke by design.)
          localStorage.removeItem('slicc:welcome-flow-fired');
        } catch {
          /* localStorage disabled — ignore */
        }
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

        triggerReload();
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
 */
function triggerReload(): void {
  try {
    if (typeof BroadcastChannel === 'function') {
      const channel = new BroadcastChannel(NUKE_CONTROL_CHANNEL);
      channel.postMessage({ type: 'nuke-reload' } satisfies NukeReloadMsg);
      // Close after a short delay so the message has time to flush.
      setTimeout(() => channel.close(), 100);
    }
  } catch {
    /* environment without BroadcastChannel — fall through */
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
 * Listen for nuke-reload broadcasts in a page context and call
 * `location.reload()` when one arrives. Returns a disposer.
 *
 * Wired by the page bootstrap (`mainStandaloneWorker` / extension panel
 * bootstrap) so nuke run from any same-origin context — including the
 * kernel-worker shell — can trigger a page reload. The listener is
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
    if (data?.type === 'nuke-reload') onReload();
  };
  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
    channel.close();
  };
}
