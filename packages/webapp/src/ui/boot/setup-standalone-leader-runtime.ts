/**
 * `setup-standalone-leader-runtime.ts` — bundles the leader-tray
 * options factory, the page-side `performTrayLeave` wrapper, the
 * remote-CDP page bridge, the forward-lick handler, and the
 * leader-hook wiring used by `mainStandaloneWorker`. Extracted from
 * main.ts so the orchestrator stays under the boy-scout function-size
 * cap; behavior matches the inline original.
 */

import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import type { VirtualFS } from '../../fs/index.js';
import { type PanelRpcPushMsg, panelRpcChannelName } from '../../kernel/panel-rpc.js';
import type { TrayLeaveResult } from '../../scoops/tray-leave.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import type { Layout } from '../layout.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { PageFollowerTrayHandle } from '../page-follower-tray.js';
import type { PageLeaderTrayHandle, StartPageLeaderTrayOptions } from '../page-leader-tray.js';
import { startPageLeaderTray } from '../page-leader-tray.js';
import type { RemoteCdpPageBridge } from '../remote-cdp-page-bridge.js';
import { createRemoteCdpPageBridge } from '../remote-cdp-page-bridge.js';
import { canonicalRuntimeId } from '../runtime-identity.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import { createLeaderTraySetup } from './setup-tray.js';
import type { BootStageLogger } from './types.js';

export interface StandaloneLeaderRuntimeDeps {
  layout: Layout;
  client: OffscreenClient;
  browser: BrowserAPI;
  sprinkleManager: InstanceType<typeof SprinkleManager>;
  agentHandle: ReturnType<OffscreenClient['createAgentHandle']>;
  realCdpTransport: CDPTransport;
  localFs: VirtualFS;
  instanceId: string;
  getSelectedScoop(): RegisteredScoop | null;
  getLeader(): PageLeaderTrayHandle | null;
  setLeader(handle: PageLeaderTrayHandle | null): void;
  getFollower(): PageFollowerTrayHandle | null;
  setFollower(handle: PageFollowerTrayHandle | null): void;
  window: Window;
  log: BootStageLogger;
}

export interface StandaloneLeaderRuntime {
  buildLeaderTrayOptions(workerBaseUrl: string): StartPageLeaderTrayOptions;
  wireLeaderHooks(handle: PageLeaderTrayHandle): void;
  clearLeaderHooks(): void;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
  remoteCdpBridge: RemoteCdpPageBridge;
  remoteCdpPushChannel: BroadcastChannel | null;
}

export function setupStandaloneLeaderRuntime(
  deps: StandaloneLeaderRuntimeDeps
): StandaloneLeaderRuntime {
  const {
    layout,
    client,
    browser,
    sprinkleManager,
    agentHandle,
    realCdpTransport,
    localFs,
    instanceId,
    getSelectedScoop,
    getLeader,
    setLeader,
    getFollower,
    setFollower,
    window: win,
    log,
  } = deps;

  const remoteCdpPushChannel =
    typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(panelRpcChannelName(instanceId))
      : null;
  const remoteCdpBridge = createRemoteCdpPageBridge({
    getSync: () => getLeader()?.sync ?? null,
    postEvent: (payload) => {
      const msg: PanelRpcPushMsg = { type: 'panel-rpc-push', op: 'remote-cdp-event', payload };
      remoteCdpPushChannel?.postMessage(msg);
    },
  });

  client.setForwardLickHandler((event) => {
    const sync = getFollower()?.currentSync;
    if (sync) sync.forwardLick(event);
    else log.warn('forward-lick dropped: no active follower sync');
  });

  const buildLeaderTrayOptions = (workerBaseUrl: string): StartPageLeaderTrayOptions => ({
    workerBaseUrl,
    getMessages: () => layout.panels.chat.getMessages(),
    getScoopJid: () => getSelectedScoop()?.jid ?? 'cone',
    getScoops: () =>
      client.getScoops().map((s) => ({
        jid: s.jid,
        name: s.name,
        folder: s.folder,
        isCone: s.isCone,
        assistantLabel: s.assistantLabel,
        trigger: s.trigger,
      })),
    getSprinkles: () => {
      const opened = new Set(sprinkleManager.opened());
      return sprinkleManager.available().map((p) => ({
        name: p.name,
        title: p.title,
        path: p.path,
        open: opened.has(p.name),
        autoOpen: p.autoOpen,
      }));
    },
    readSprinkleContent: async (sprinkleName: string) => {
      const sprinkle = sprinkleManager.available().find((s) => s.name === sprinkleName);
      if (!sprinkle) return null;
      try {
        const raw = await localFs.readFile(sprinkle.path, { encoding: 'utf-8' });
        return typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
      } catch {
        return null;
      }
    },
    onSprinkleLick: (sprinkleName, body, targetScoop, originLabel) =>
      client.sendSprinkleLick(sprinkleName, body, targetScoop, originLabel),
    onForwardedLick: (event) => client.sendForwardedLick(event),
    onFollowerMessage: (text, messageId, attachments) => {
      layout.panels.chat.addUserMessage(text, attachments);
      agentHandle.sendMessage(text, messageId, attachments);
      getLeader()?.sync.broadcastUserMessage(text, messageId, attachments);
    },
    onFollowerAbort: () => agentHandle.stop(),
    onFollowerCountChanged: (_count) => {
      const followerPeers = getLeader()?.peers.getPeers() ?? [];
      win.localStorage.setItem(
        'slicc.leaderTrayFollowers',
        JSON.stringify(
          followerPeers.map((p) => ({
            runtimeId: canonicalRuntimeId(p.bootstrapId),
            runtime: p.runtime,
            connectedAt: p.connectedAt ?? undefined,
          }))
        )
      );
    },
    onRemoteTransportsCleaned: (runtimeId) => remoteCdpBridge.cleanupRuntime(runtimeId),
    sendWebhookEvent: (id, headers, body) => client.sendWebhookEvent(id, headers, body),
    onCherryHostEvent: (runtimeId, name, detail) =>
      client.sendCherryHostEvent(runtimeId, name, detail),
    onAgentEvent: (handler) => agentHandle.onEvent(handler),
    browserAPI: browser,
    browserTransport: realCdpTransport,
    vfs: localFs,
  });

  const { wireLeaderHooks, clearLeaderHooks } = createLeaderTraySetup({
    layout,
    sprinkleManager,
    remoteCdpBridge,
  });

  const performTrayLeaveLocally = async (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult> => {
    const { performTrayLeave } = await import('../tray-leave-runtime.js');
    return await performTrayLeave(
      { workerBaseUrl: opts.workerBaseUrl, requestId: opts.requestId },
      {
        getLeader,
        setLeader,
        getFollower,
        setFollower: (h) => setFollower(h as PageFollowerTrayHandle | null),
        startLeader: (workerBaseUrl) => startPageLeaderTray(buildLeaderTrayOptions(workerBaseUrl)),
        clearLeaderHooks,
        wireLeaderHooks,
        storage: win.localStorage,
        log,
      }
    );
  };

  return {
    buildLeaderTrayOptions,
    wireLeaderHooks,
    clearLeaderHooks,
    performTrayLeaveLocally,
    remoteCdpBridge,
    remoteCdpPushChannel,
  };
}
