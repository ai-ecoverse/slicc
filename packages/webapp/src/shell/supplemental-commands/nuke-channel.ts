/**
 * `nuke-channel.ts` — page-side wiring for the `nuke` shell command.
 *
 * Split out of `nuke-command.ts` so the page-bootstrap reload listener
 * (`installNukeReloadListener`) can be imported without dragging in
 * `nuke-command.ts`'s `defineCommand` import — which in turn pulls in
 * the bundled `just-bash` browser entry (~800 kB of shell runtime). The
 * page-side `main.ts` only needs the BroadcastChannel listener, not
 * the shell command itself.
 *
 * Everything here is intentionally shell-free: no `just-bash` import,
 * no `Command` type, no shell context. The actual `nuke` command lives
 * in `nuke-command.ts` and re-exports these symbols for backward-compat.
 */

/**
 * BroadcastChannel name shared between the worker / offscreen shell
 * (where `nuke` runs) and the page-side `installNukeReloadListener`.
 * Worker mode runs the shell in a DedicatedWorker where
 * `location.reload()` is a no-op, so nuke broadcasts a reload request
 * that any same-origin window can act on.
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

/**
 * Listen for nuke-reload broadcasts in a page context. On receipt:
 *
 *   1. Synchronously remove every key in `keysToRemove` from the
 *      page's REAL `localStorage` (the worker / offscreen couldn't
 *      reach it themselves; see {@link NukeReloadMsg}).
 *   2. Call `onReload()` (defaults to `location.reload()`).
 *
 * Returns a disposer that detaches the listener. Wired by the page
 * bootstrap (`setup-nuke-reload-listener.ts` → `main.ts`) so nuke run
 * from any same-origin context — including the kernel-worker shell
 * or the extension's offscreen document — can trigger a page reload
 * AND propagate its localStorage clears. The listener is intentionally
 * minimal: the broadcast carries no auth, but it's scoped to the same
 * origin and the only writers are nuke itself.
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
