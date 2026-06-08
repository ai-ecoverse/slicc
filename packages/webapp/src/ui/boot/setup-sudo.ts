/**
 * `setup-sudo.ts` — boot stage that publishes the sudo broker hooks
 * on the page realm for each float.
 *
 * Extracted verbatim from `mainStandaloneWorker`
 * (~main.ts:1864–1869, `installSudoTestHook`) and `mainExtension`
 * (~main.ts:604 + 619, `installPanelSudoResponder`). Behavior is
 * unchanged — both helpers dynamic-import the sudo module to keep
 * the broker code out of the synchronous boot path, matching the
 * call sites they replace.
 *
 * Two thin functions rather than a single conditional install
 * because the standalone and extension floats want different
 * surfaces: standalone publishes a manual test hook on
 * `globalThis.__slicc_sudo`, while the extension panel installs the
 * `chrome.runtime.onMessage` responder that backs the offscreen
 * broker. The boot orchestrator picks the right one for its float.
 */

import type { SudoSetupDeps } from './types.js';

/**
 * Publish the manual sudo test hook on the page realm. In standalone
 * mode this resolves via `POST /api/sudo-approve` (native OS dialog
 * from the node-server process); no enforcement is wired yet — it's
 * a test surface.
 */
export async function setupSudoStandalone(_deps: SudoSetupDeps): Promise<void> {
  const { installSudoTestHook } = await import('../../sudo/index.js');
  installSudoTestHook();
}

/**
 * Install the sudo responder on the side-panel realm. The offscreen
 * broker relays approval requests here, where `window.confirm` /
 * `window.prompt` are genuine, non-agent-scriptable native gestures.
 */
export async function setupSudoExtension(_deps: SudoSetupDeps): Promise<void> {
  const { installPanelSudoResponder } = await import('../../sudo/index.js');
  installPanelSudoResponder();
}
