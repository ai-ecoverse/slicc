/**
 * `setup-nuke-reload-listener.ts` — wires the page-side `nuke-reload`
 * BroadcastChannel listener into every page-owning bootstrap.
 *
 * The `nuke <launch-code>` shell command runs in the kernel worker
 * (standalone) or the offscreen document (extension), neither of which
 * can `location.reload()` the visible page or reach its real
 * `localStorage`. It therefore broadcasts a `nuke-reload` message that
 * the page-side listener (`installNukeReloadListener`) must be running
 * to receive — without this wiring the nuke wipes state but the page
 * never reloads, so the user sees nothing happen.
 *
 * Called from `main.ts` once per page-owning runtime: standalone,
 * electron-overlay, hosted-leader, cherry, extension side panel, and
 * the extension detached popout. Cloud / hosted floats reuse the same
 * `main.ts` boot path so they are covered by the same call. The
 * design-time `?ui-fixture` surface has no kernel and skips this stage
 * along with the rest of boot.
 */

import { installNukeReloadListener } from '../../shell/supplemental-commands/nuke-command.js';

let dispose: (() => void) | null = null;

/**
 * Install the nuke-reload listener if it is not already installed.
 * Returns the dispose handle (same one on repeat calls — idempotent).
 */
export function setupNukeReloadListener(): () => void {
  if (dispose) return dispose;
  dispose = installNukeReloadListener();
  return dispose;
}

/**
 * Test-only helper. Dispose the listener (if any) and clear the
 * module-level installed flag so the next `setupNukeReloadListener()`
 * call reinstalls a fresh channel.
 */
export function __resetNukeReloadListenerForTest(): void {
  if (dispose) dispose();
  dispose = null;
}
