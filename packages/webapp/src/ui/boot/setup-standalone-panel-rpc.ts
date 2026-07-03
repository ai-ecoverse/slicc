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
import { storeTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
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
  const { getLeaderPermissionsSurface } = await import('../wc/wc-permissions-registry.js');
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
      leaveTray: async ({ workerBaseUrl, requestId }) =>
        await performTrayLeaveLocally({ workerBaseUrl, requestId }),
      joinTray: ({ joinUrl }) => {
        // Persist (so a panel reload re-joins) then hand off to the
        // `slicc:tray-join` listener in `wc-tray.ts`, which stops any
        // current role and starts the follower. `storeTrayJoinUrl`
        // re-parses + writes both the join and worker storage keys.
        storeTrayJoinUrl(win.localStorage, joinUrl);
        win.dispatchEvent(new CustomEvent('slicc:tray-join', { detail: { joinUrl } }));
        return { joinUrl };
      },
      emitEvent: (channel, payload) => panelRpcEventEmitter.emit(channel, payload),
      emitCherrySliccEvent: (runtimeId, name, detail) =>
        getLeader()?.sync.emitCherrySliccEvent(runtimeId, name, detail) ?? false,
      // Worker-side `serve` bridges here so the kernel-worker can mint a preview URL
      // via the page-side leader's controllerToken and broadcast preview.open.
      // Extension uses the in-realm `setPreviewMinter` hook instead.
      mintPreview: async ({
        entryPath,
        servedRoot,
        bridge,
        noBridge,
        maxTabs,
        quiet,
        webhookId,
      }) => {
        const sync = getLeader()?.currentLeaderSync;
        if (!sync) throw new Error('serve: no active leader tray; cannot mint preview');
        const { getLeaderTrayRuntimeStatus } = await import('../../scoops/tray-leader.js');
        const session = getLeaderTrayRuntimeStatus().session;
        if (!session) throw new Error('serve: leader tray has no active session');
        const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop() ?? '';
        const { CHERRY_RUNTIME_TAG } = await import('../../scoops/tray-sync-protocol.js');
        const { mintPreviewViaWorker } = await import(
          '../../shell/supplemental-commands/preview-mint-client.js'
        );
        const hasCherryFollower = sync
          .getConnectedFollowers()
          .some((f) => f.runtime === CHERRY_RUNTIME_TAG);
        const effectiveAllowLive = !noBridge && (bridge || hasCherryFollower);
        const effectiveBridge = !noBridge && bridge;
        const { url, previewToken } = await mintPreviewViaWorker({
          workerBaseUrl: session.workerBaseUrl,
          trayId: session.trayId,
          controllerToken,
          servedRoot,
          entryPath,
          allowLive: effectiveAllowLive,
          bridge: effectiveBridge,
          maxTabs,
          webhookId,
        });
        // Get title from entryPath basename, or 'Preview' if empty
        const title = entryPath ? (entryPath.split('/').pop() ?? 'Preview') : 'Preview';
        sync.registerMintedPreview(previewToken, { url, title, quiet: quiet ?? false });
        sync.broadcastPreviewOpen(url);
        return { url, pushed: sync.getConnectedFollowers().length, previewToken };
      },
      revokePreview: async ({ previewToken }) => {
        const sync = getLeader()?.currentLeaderSync;
        if (!sync) throw new Error('serve --stop: no active leader tray; cannot revoke preview');
        const { getLeaderTrayRuntimeStatus } = await import('../../scoops/tray-leader.js');
        const session = getLeaderTrayRuntimeStatus().session;
        if (!session) throw new Error('serve --stop: leader tray has no active session');
        const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop() ?? '';
        const { revokePreviewViaWorker } = await import(
          '../../shell/supplemental-commands/preview-mint-client.js'
        );
        const result = await revokePreviewViaWorker({
          workerBaseUrl: session.workerBaseUrl,
          trayId: session.trayId,
          controllerToken,
          previewToken,
        });
        sync.dropMintedPreview(previewToken);
        return result;
      },
      // Worker-side `serve --list` bridges here so the kernel-worker
      // can list active previews via the page-side leader's
      // controllerToken and the worker HTTP API.
      listPreviews: async () => {
        const { getLeaderTrayRuntimeStatus } = await import('../../scoops/tray-leader.js');
        const session = getLeaderTrayRuntimeStatus().session;
        if (!session) throw new Error('serve: leader tray has no active session');
        const controllerToken = new URL(session.controllerUrl).pathname.split('/').pop() ?? '';
        const { listPreviewsViaWorker } = await import(
          '../../shell/supplemental-commands/preview-mint-client.js'
        );
        return await listPreviewsViaWorker({
          workerBaseUrl: session.workerBaseUrl,
          trayId: session.trayId,
          controllerToken,
        });
      },
      listRemoteTargets: () => browser.listAllTargets(),
      remoteCdp: remoteCdpBridge,
      // Lazy lookup — the leader surface may mount after the panel-RPC
      // handler is installed (the `<slicc-permissions>` install runs from
      // the WC shell's attach pass), so the resolver must read the live
      // registry binding rather than capture it at install time.
      getPermissionsSurface: () => getLeaderPermissionsSurface(),
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
