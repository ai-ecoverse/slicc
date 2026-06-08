/**
 * `setup-standalone-panel-rpc.ts` — installs the page-side panel-RPC
 * handler so DOM-bound shell commands run by the kernel worker
 * (`screencapture` / `say` / `afplay` / clipboard / `open`, plus the
 * playwright app-origin lookup, plus the leader-tray `host reset` /
 * `host leave` / `cherry-emit` bridges) can reach the page realm.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:699–758).
 * `imgcat` is intentionally terminal-only and stays out of the
 * bridge — it's meant for the in-panel terminal, not the agent.
 */

import type { BrowserAPI } from '../../cdp/index.js';
import type { TrayLeaveResult } from '../../scoops/tray-leave.js';
import type { PageLeaderTrayHandle } from '../page-leader-tray.js';
import type { RemoteCdpPageBridge } from '../remote-cdp-page-bridge.js';

export interface StandalonePanelRpcDeps {
  instanceId: string;
  browser: BrowserAPI;
  remoteCdpBridge: RemoteCdpPageBridge;
  remoteCdpPushChannel: BroadcastChannel | null;
  /** Lazy accessor — reads the live binding so post-install assignments are visible. */
  getLeader(): PageLeaderTrayHandle | null;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
  window: Window;
}

export async function setupStandalonePanelRpc(deps: StandalonePanelRpcDeps): Promise<void> {
  const {
    instanceId,
    browser,
    remoteCdpBridge,
    remoteCdpPushChannel,
    getLeader,
    performTrayLeaveLocally,
    window: win,
  } = deps;

  const { installPanelRpcHandler, createPanelRpcEventEmitter } = await import(
    '../../kernel/panel-rpc.js'
  );
  const { createStandalonePanelRpcHandlers } = await import('../panel-rpc-handlers.js');
  const panelRpcEventEmitter = createPanelRpcEventEmitter({ instanceId });
  const stopPanelRpcHandler = installPanelRpcHandler({
    instanceId,
    handlers: createStandalonePanelRpcHandlers({
      resetTray: async () => {
        const leader = getLeader();
        if (!leader) {
          throw new Error('no active tray session to reset');
        }
        return await leader.reset();
      },
      // Worker-side `serve` bridges here so the kernel-worker shell can mint a
      // preview URL via the page-side leader's controllerToken, then broadcast
      // preview.open through the page-side LeaderSyncManager. Extension uses
      // the in-realm `setPreviewMinter` hook instead.
      mintPreview: async ({ entryPath, servedRoot, bridge, noBridge }) => {
        const leader = getLeader();
        const sync = leader?.currentLeaderSync;
        if (!sync) {
          throw new Error('serve: no active leader tray; cannot mint preview');
        }
        const { getLeaderTrayRuntimeStatus } = await import('../../scoops/tray-leader.js');
        const session = getLeaderTrayRuntimeStatus().session;
        if (!session) {
          throw new Error('serve: leader tray has no active session');
        }
        const controllerUrl = new URL(session.controllerUrl);
        const controllerToken = controllerUrl.pathname.split('/').pop() ?? '';
        const { CHERRY_RUNTIME_TAG } = await import('../../scoops/tray-sync-protocol.js');
        const { mintPreviewViaWorker } = await import(
          '../../shell/supplemental-commands/preview-mint-client.js'
        );
        // Cherry-attached followers default --bridge:true; --no-bridge always wins.
        const hasCherryFollower = sync
          .getConnectedFollowers()
          .some((f) => f.runtime === CHERRY_RUNTIME_TAG);
        const effectiveAllowLive = !noBridge && (bridge || hasCherryFollower);
        const { url } = await mintPreviewViaWorker({
          workerBaseUrl: session.workerBaseUrl,
          trayId: session.trayId,
          controllerToken,
          servedRoot,
          entryPath,
          allowLive: effectiveAllowLive,
        });
        sync.broadcastPreviewOpen(url);
        return { url, pushed: sync.getConnectedFollowers().length };
      },
      leaveTray: async ({ workerBaseUrl, requestId }) =>
        await performTrayLeaveLocally({ workerBaseUrl, requestId }),
      emitEvent: (channel, payload) => panelRpcEventEmitter.emit(channel, payload),
      emitCherrySliccEvent: (runtimeId, name, detail) =>
        getLeader()?.sync.emitCherrySliccEvent(runtimeId, name, detail) ?? false,
      listRemoteTargets: () => browser.listAllTargets(),
      remoteCdp: remoteCdpBridge,
    }),
  });
  win.addEventListener(
    'beforeunload',
    () => {
      stopPanelRpcHandler();
      panelRpcEventEmitter.dispose();
      remoteCdpBridge.disposeAll();
      remoteCdpPushChannel?.close();
    },
    { once: true }
  );
}
