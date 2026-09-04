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
 *
 * This is `node-rest` by definition — "standalone" IS that topology, not a
 * fact this module probes for — so it constructs that one adapter directly
 * rather than asking the kernel worker's composed broker (a different JS
 * realm; the object cannot cross that boundary) (#2276).
 */
export async function setupSudoStandalone(_deps: SudoSetupDeps): Promise<void> {
  const { createSudoBroker, installSudoTestHook } = await import('../../sudo/index.js');
  const { createRestCapabilityBroker } = await import('../../work-unit/capability/index.js');
  installSudoTestHook(createSudoBroker(createRestCapabilityBroker()));
}

/**
 * Install the sudo responder on the side-panel realm. The offscreen
 * broker relays approval requests here, where `confirm` / `prompt` are
 * genuine native gestures the agent's realms cannot answer. The responder
 * captures those natives at module init so a later page-realm override of
 * the globals can't self-approve — see `panel-responder.ts`.
 */
export async function setupSudoExtension(_deps: SudoSetupDeps): Promise<void> {
  const { installPanelSudoResponder } = await import('../../sudo/index.js');
  installPanelSudoResponder();
}
