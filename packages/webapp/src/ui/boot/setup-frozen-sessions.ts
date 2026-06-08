/**
 * `setup-frozen-sessions.ts` — boot stage that installs the
 * `onFrozenSessionOpen` handler and exposes a deferred
 * `attachScoopsVfs()` to wire the scoops-panel sidebar to the
 * panel-read VFS once the worker's `VfsRpcHost` is live.
 *
 * Extracted verbatim from `mainStandaloneWorker`
 * (~main.ts:2362–2400 for the open handler, and main.ts:2447–2453 for
 * the deferred `setVfs`). Behavior is unchanged.
 *
 * The open handler reads `vfs.panelReadVfs` at call-fire time (not at
 * install time) so the OPFS-flag swap performed by `attachWorkerVfs()`
 * is visible to the click action.
 */

import { frozenSessionPath, parseFrozenArchive } from '../session-freezer.js';
import type { FrozenSessionsHandle, FrozenSessionsSetupDeps } from './types.js';

/**
 * Install the frozen-sessions click handler and return the deferred
 * `attachScoopsVfs()` hook the orchestrator calls after
 * `await host.ready`.
 *
 * NOTE: `setVfs()` eagerly reads `/sessions/index.json`, but under
 * `slicc_opfs_vfs=opfs` `panelReadVfs` is a worker-RPC client and the
 * worker's `VfsRpcHost` only starts listening at the tail of boot.
 * Wiring it is therefore deferred until after `await host.ready` —
 * otherwise the read fires before any responder exists, the
 * request is dropped, and the frozen-sessions list renders empty even
 * though the archives are present on OPFS.
 */
export function setupFrozenSessions(deps: FrozenSessionsSetupDeps): FrozenSessionsHandle {
  const { layout, vfs, log } = deps;

  // Frozen sessions sidebar (standalone only). The panel reads
  // /sessions/index.json and the per-archive markdown through
  // `panelReadVfs` — either the page-side `localFs` (shared IDB with
  // the worker) or, under `slicc_opfs_vfs=opfs`, the worker-backed
  // `RemoteVfsClient` so reads see the canonical OPFS view. Clicking
  // an entry reads the archive, parses it back into messages, and
  // displays it in the chat panel read-only — matching the affordance
  // of clicking a live scoop (which also opens the chat view rather
  // than a file).
  layout.onFrozenSessionOpen = (entry) => {
    void (async () => {
      try {
        const raw = await vfs.panelReadVfs.readFile(frozenSessionPath(entry), {
          encoding: 'utf-8',
        });
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        const parsed = parseFrozenArchive(text);
        const title = parsed.title || entry.title;
        await layout.panels.chat.displayFrozenSession({
          contextId: `frozen:${entry.filename}`,
          messages: parsed.messages,
          title,
        });
        layout.setThreadHeaderName(`❄ ${title}`);
        layout.setActiveTab('chat');
      } catch (err) {
        log.warn('Failed to open frozen session', {
          filename: entry.filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };

  return {
    attachScoopsVfs(): void {
      // Wire the frozen-sessions sidebar now that the worker's `VfsRpcHost`
      // is live (it starts at the tail of `boot()`, just before the
      // ready signal). `setVfs` eagerly reads `/sessions/index.json` through
      // `panelReadVfs`; doing it pre-ready under `slicc_opfs_vfs=opfs` would
      // drop the read against a not-yet-listening worker and leave the list
      // empty. Flag off (`panelReadVfs === localFs`) this is equally correct.
      layout.panels.scoops.setVfs(vfs.panelReadVfs);
    },
  };
}
