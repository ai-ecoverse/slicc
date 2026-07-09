import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import {
  NUKE_CONTROL_CHANNEL,
  NUKE_LOCAL_STORAGE_KEYS,
  type NukeReloadMsg,
} from './nuke-channel.js';
import { wipeLocalStorageState } from './wipe-local-storage-state.js';

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
      // Wipe all local state (SW + IDB + OPFS) via the shared helper,
      // then forward the localStorage key list to the page-side listener
      // before reloading. The wipe awaits every delete BEFORE reloading:
      // a half-finished delete that completes during the new page's
      // `open()` aborts the upgrade with "Version change transaction was
      // aborted in upgradeneeded event handler", leaving the user
      // stranded on a "Failed to start" screen.
      //
      // localStorage clears are intentionally NOT done inside the wipe
      // in worker / offscreen contexts — they'd write to a per-context
      // shim or an isolated MV3 storage and be lost. Instead we forward
      // the key list to the page-side listener via
      // `triggerReload(NUKE_LOCAL_STORAGE_KEYS)`, which removes them from
      // the real `localStorage` before reloading.
      void (async () => {
        await wipeLocalStorageState();
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
