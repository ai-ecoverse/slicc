/**
 * `setup-tray.ts` — boot stage that builds the
 * `wireLeaderHooks` / `clearLeaderHooks` pair used by the
 * standalone-worker orchestrator when a `PageLeaderTrayHandle` is
 * started, switched, or torn down.
 *
 * Extracted verbatim from `mainStandaloneWorker`
 * (~main.ts:2812 for `wireLeaderHooks`, ~main.ts:2829 for
 * `clearLeaderHooks`). Behavior is unchanged — this is a pure
 * relocation so the boot orchestrator gets thinner and the hook
 * wiring becomes testable in isolation.
 *
 * The leader-tray START itself (the `if/else if` chain at
 * ~main.ts:2967–3160 that selects between hosted-leader / cherry
 * follower / stored-join follower / stored-worker leader) stays in
 * `main.ts`: it closes over local boot bindings (`runtimeMode`,
 * `cherryJoinUrl`, `cherryTransport`, the `/api/cloud-status` POST
 * and `applyHostedAccounts` chain) that don't generalize cleanly.
 * The helpers in this module are what those start-sites call
 * AFTER the handle is constructed.
 */

import {
  setConnectedFollowersGetter,
  setTrayResetter,
} from '../../shell/supplemental-commands/host-command.js';
import type { PageLeaderTrayHandle } from '../page-leader-tray.js';
import { canonicalRuntimeId } from '../runtime-identity.js';
import type { TrayHandle, TraySetupDeps } from './types.js';

/**
 * Build the leader-hook wiring functions against the boot-scope
 * deps. The returned `wireLeaderHooks` is called immediately after a
 * `startPageLeaderTray()` resolution (both at boot and on a
 * `performTrayLeave` role-switch); `clearLeaderHooks` is the
 * symmetrical teardown.
 */
export function createLeaderTraySetup(deps: TraySetupDeps): TrayHandle {
  const { layout, sprinkleManager, remoteCdpBridge } = deps;

  /**
   * Wire the leader-only hooks against the live handle. Called after
   * `startPageLeaderTray` resolves successfully (both at boot and on
   * `performTrayLeave` role-switch). The `null`-clearing counterpart
   * is `clearLeaderHooks` below.
   */
  const wireLeaderHooks = (handle: PageLeaderTrayHandle): void => {
    setConnectedFollowersGetter(() =>
      handle.peers.getPeers().map((p) => ({
        runtimeId: canonicalRuntimeId(p.bootstrapId),
        runtime: p.runtime,
        connectedAt: p.connectedAt ?? undefined,
      }))
    );
    setTrayResetter(() => handle.reset());
    sprinkleManager.setSendToSprinkleHook((name, data) =>
      handle.sync.broadcastSprinkleUpdate(name, data)
    );
    layout.panels.chat.setOnLocalUserMessage((text, messageId, attachments) =>
      handle.sync.broadcastUserMessage(text, messageId, attachments)
    );
  };

  const clearLeaderHooks = (): void => {
    setConnectedFollowersGetter(null);
    setTrayResetter(null);
    layout.panels.chat.setOnLocalUserMessage(undefined);
    sprinkleManager.setSendToSprinkleHook(undefined);
    remoteCdpBridge.disposeAll();
  };

  return { wireLeaderHooks, clearLeaderHooks };
}
