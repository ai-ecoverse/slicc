/**
 * Multi-browser tray sync for the WC shell — the standalone leader/follower
 * orchestration formerly spread across `setup-standalone-{leader-runtime,
 * tray-init,tray-bootstrap,tray-events}.ts`, re-wired against the WC chat
 * controller and sprinkle zone. The tray primitives themselves
 * (`page-leader-tray.ts`, `page-follower-tray.ts`, `tray-leave-runtime.ts`)
 * are reused verbatim — they were already Layout-free.
 */

import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import { type PanelRpcPushMsg, panelRpcChannelName } from '../../kernel/panel-rpc.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import {
  FOLLOWER_STATUS_STORAGE_KEY,
  getFollowerTrayRuntimeStatus,
  subscribeToFollowerTrayRuntimeStatus,
} from '../../scoops/tray-follower-status.js';
import {
  getLeaderTrayRuntimeStatus,
  subscribeToLeaderTrayRuntimeStatus,
} from '../../scoops/tray-leader.js';
import type { TrayLeaveResult } from '../../scoops/tray-leave.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../scoops/tray-runtime-config.js';
import {
  getConnectedFollowers,
  setConnectedFollowersGetter,
  setTrayResetter,
  writeConnectedFollowersToShim,
} from '../../shell/supplemental-commands/host-command.js';
import { setupStandalonePanelRpc } from '../boot/setup-standalone-panel-rpc.js';
import { runHostedBootstrap } from '../boot/setup-standalone-tray-init-hosted.js';
import type { BootStageLogger } from '../boot/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { type PageFollowerTrayHandle, startPageFollowerTray } from '../page-follower-tray.js';
import {
  type PageLeaderTrayHandle,
  type StartPageLeaderTrayOptions,
  startPageLeaderTray,
} from '../page-leader-tray.js';
import { createRemoteCdpPageBridge, type RemoteCdpPageBridge } from '../remote-cdp-page-bridge.js';
import { canonicalRuntimeId } from '../runtime-identity.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import type { AgentHandle } from '../types.js';
import type { WcChatController } from './wc-chat-controller.js';
import type { WcShellRefs } from './wc-shell.js';

export interface WcTrayDeps {
  refs: WcShellRefs;
  client: OffscreenClient;
  browser: BrowserAPI;
  realCdpTransport: CDPTransport;
  instanceId: string;
  runtimeMode: UiRuntimeMode;
  sprinkleManager: SprinkleManager;
  /** Sprinkle add/remove surface for follower-synced sprinkles. */
  addSprinkle: (name: string, title: string, element: HTMLElement) => void;
  removeSprinkle: (name: string) => void;
  getController(): WcChatController | null;
  getSelectedJid(): string;
  agentHandle: AgentHandle;
  openFs(): Promise<import('../../kernel/local-vfs-client.js').LocalVfsClient>;
  /** Floatbar label to restore when the last follower leaves. */
  baseFloatLabel?: string;
  window: Window;
  log: BootStageLogger;
}

export interface WcTrayHandle {
  getLeader(): PageLeaderTrayHandle | null;
  getFollower(): PageFollowerTrayHandle | null;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
}

interface TrayRoleState {
  leader: PageLeaderTrayHandle | null;
  follower: PageFollowerTrayHandle | null;
}

function buildFollowerOptions(
  deps: WcTrayDeps,
  joinUrl: string
): Parameters<typeof startPageFollowerTray>[0] {
  const { browser, client, getController } = deps;
  return {
    joinUrl,
    onSnapshot: (messages) => getController()?.loadMessages(messages),
    onUserMessage: (text, _messageId, _scoopJid, attachments) =>
      getController()?.addUserMessage(text, attachments),
    onStatus: (status) => getController()?.setProcessing(status === 'processing'),
    setChatAgent: (agent) => getController()?.setAgent(agent),
    browserAPI: browser,
    onForwardingToggle: (enabled) => client.sendSetFollowerForwarding(enabled),
    addSprinkle: (name, title, element) => deps.addSprinkle(name, title, element),
    removeSprinkle: (name) => deps.removeSprinkle(name),
  };
}

/** Leader option factory — the WC equivalent of `buildLeaderTrayOptions`. */
function createLeaderOptionsFactory(
  deps: WcTrayDeps,
  state: TrayRoleState,
  remoteCdpBridge: RemoteCdpPageBridge
): (workerBaseUrl: string) => StartPageLeaderTrayOptions {
  const { client, refs } = deps;
  return (workerBaseUrl) => ({
    workerBaseUrl,
    getMessages: () => deps.getController()?.getMessages() ?? [],
    getScoopJid: () => deps.getSelectedJid(),
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
      const opened = new Set(deps.sprinkleManager.opened());
      return deps.sprinkleManager.available().map((p) => ({
        name: p.name,
        title: p.title,
        path: p.path,
        open: opened.has(p.name),
        autoOpen: p.autoOpen,
      }));
    },
    readSprinkleContent: async (sprinkleName) => {
      const sprinkle = deps.sprinkleManager.available().find((s) => s.name === sprinkleName);
      if (!sprinkle) return null;
      try {
        const fs = await deps.openFs();
        const raw = await fs.readFile(sprinkle.path, { encoding: 'utf-8' });
        return typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
      } catch {
        return null;
      }
    },
    onSprinkleLick: (name, body, targetScoop, originLabel) =>
      client.sendSprinkleLick(name, body, targetScoop, originLabel),
    onFollowerMessage: (text, messageId, attachments) => {
      deps.getController()?.addUserMessage(text, attachments);
      deps.agentHandle.sendMessage(text, messageId, attachments);
      state.leader?.sync.broadcastUserMessage(text, messageId, attachments);
    },
    onFollowerAbort: () => deps.agentHandle.stop(),
    onFollowerCountChanged: (count) => {
      refs.floatbar.setAttribute(
        'label',
        count > 0
          ? `tray · ${count} follower${count === 1 ? '' : 's'}`
          : (deps.baseFloatLabel ?? 'standalone · live')
      );
      // Mirror the live follower list into the shim so the standalone
      // worker-side `host` command (no live getter) reflects it.
      writeConnectedFollowersToShim(getConnectedFollowers());
    },
    onRemoteTransportsCleaned: (runtimeId) => remoteCdpBridge.cleanupRuntime(runtimeId),
    onForwardedLick: (event) => client.sendForwardedLick(event),
    onCherryHostEvent: (runtimeId, name, detail) =>
      client.sendCherryHostEvent(runtimeId, name, detail),
    sendWebhookEvent: (webhookId, headers, body) =>
      client.sendWebhookEvent(webhookId, headers, body),
    onAgentEvent: (handler) => deps.agentHandle.onEvent(handler),
    browserAPI: deps.browser,
    browserTransport: deps.realCdpTransport,
    // Lazy VFS proxy for preview.request handling — the kernel worker owns
    // the real VFS; we bridge through openFs() on demand.
    vfs: {
      async stat(path: string) {
        const fs = await deps.openFs();
        return fs.stat(path);
      },
      async readFile(path: string, options?: import('../../fs/types.js').ReadFileOptions) {
        const fs = await deps.openFs();
        return fs.readFile(path, options);
      },
    } as import('../../fs/virtual-fs.js').VirtualFS,
  });
}

/** Leader-only hooks: shell `host` command surfaces + broadcast taps. */
function createLeaderHookSetup(
  deps: WcTrayDeps,
  remoteCdpBridge: RemoteCdpPageBridge
): { wireLeaderHooks(handle: PageLeaderTrayHandle): void; clearLeaderHooks(): void } {
  return {
    wireLeaderHooks: (handle) => {
      setConnectedFollowersGetter(() =>
        handle.peers.getPeers().map((p) => ({
          runtimeId: canonicalRuntimeId(p.bootstrapId),
          runtime: p.runtime,
          connectedAt: p.connectedAt ?? undefined,
        }))
      );
      setTrayResetter(() => handle.reset());
      deps.sprinkleManager.setSendToSprinkleHook((name, data) =>
        handle.sync.broadcastSprinkleUpdate(name, data)
      );
      deps.sprinkleManager.setReloadHook((name) => handle.sync.broadcastSprinkleReloaded(name));
      deps
        .getController()
        ?.setOnLocalUserMessage((text, messageId, attachments) =>
          handle.sync.broadcastUserMessage(text, messageId, attachments)
        );
      // Mirror the leader's turn lifecycle to followers. The live float
      // emits no `turn_end` agent event, so the follower's `onStatus`
      // mapping (→ `setProcessing`) is the only signal that clears its send
      // spinner and re-arms the queued-card flush after a send.
      deps
        .getController()
        ?.setOnLocalProcessingChange((processing) =>
          handle.sync.broadcastStatus(processing ? 'processing' : 'ready')
        );
      import('../theme-engine.js').then(({ setThemeChangeListener, getActiveThemeId }) => {
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        setThemeChangeListener((themeJson) => {
          if (getActiveThemeId() === '__preview') return;
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => handle.sync.broadcastTheme(themeJson), 150);
        });
      });
    },
    clearLeaderHooks: () => {
      setConnectedFollowersGetter(null);
      writeConnectedFollowersToShim([]);
      setTrayResetter(null);
      deps.getController()?.setOnLocalUserMessage(undefined);
      deps.getController()?.setOnLocalProcessingChange(undefined);
      deps.sprinkleManager.setSendToSprinkleHook(undefined);
      deps.sprinkleManager.setReloadHook(undefined);
      remoteCdpBridge.disposeAll();
      import('../theme-engine.js').then(({ setThemeChangeListener }) => {
        setThemeChangeListener(null);
      });
    },
  };
}

/** The `/api/cloud-status` POST after a hosted leader connects. */
function hostedLeaderExtras(deps: WcTrayDeps): Partial<StartPageLeaderTrayOptions> {
  return {
    runtime: 'slicc-hosted-leader',
    kind: 'hosted',
    onLeaderReady: (session) => {
      void fetch('/api/cloud-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          joinUrl: session.joinUrl,
          trayId: session.trayId,
          controllerUrl: session.controllerUrl,
          webhookUrl: session.webhookUrl,
          runtime: session.runtime,
          sliccVersion: __SLICC_VERSION__,
        }),
        signal: AbortSignal.timeout(10000),
      }).catch((err) => {
        deps.log.error('failed to POST /api/cloud-status', { error: String(err) });
      });
    },
  };
}

/** Boot-time role selection — mirrors the legacy tray-init order. */
function startInitialRole(
  deps: WcTrayDeps,
  state: TrayRoleState,
  leaderOptions: (workerBaseUrl: string) => StartPageLeaderTrayOptions,
  wireLeaderHooks: (handle: PageLeaderTrayHandle) => void
): void {
  const { window: win, log } = deps;
  if (deps.runtimeMode === 'hosted-leader') {
    win.localStorage.removeItem(TRAY_JOIN_STORAGE_KEY);
    const workerBaseUrl = win.localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
    if (!workerBaseUrl) {
      log.error('hosted-leader: tray worker base URL not seeded');
      return;
    }
    state.leader = startPageLeaderTray({
      ...leaderOptions(workerBaseUrl),
      ...hostedLeaderExtras(deps),
    });
    wireLeaderHooks(state.leader);
    void runHostedBootstrap({ log });
    return;
  }
  const storedJoinUrl = win.localStorage.getItem(TRAY_JOIN_STORAGE_KEY);
  const storedWorkerBaseUrl = win.localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
  if (storedJoinUrl) {
    state.follower = startPageFollowerTray(buildFollowerOptions(deps, storedJoinUrl));
  } else if (storedWorkerBaseUrl) {
    state.leader = startPageLeaderTray(leaderOptions(storedWorkerBaseUrl));
    wireLeaderHooks(state.leader);
  }
}

/** `slicc:tray-join` / `slicc:tray-leave` window events (shell `host` cmd). */
function installRoleSwitchListeners(
  deps: WcTrayDeps,
  state: TrayRoleState,
  clearLeaderHooks: () => void,
  performTrayLeaveLocally: WcTrayHandle['performTrayLeaveLocally']
): void {
  const { window: win, log } = deps;
  win.addEventListener('slicc:tray-join', (rawEvent) => {
    const joinUrl = (rawEvent as CustomEvent<{ joinUrl?: string }>).detail?.joinUrl;
    if (!joinUrl) return;
    const leaderToStop = state.leader;
    state.leader = null;
    clearLeaderHooks();
    const previousFollower = state.follower;
    state.follower = null;
    try {
      leaderToStop?.stop();
    } catch (err) {
      log.error('leader stop threw during tray-join switch', err);
    }
    try {
      previousFollower?.stop();
    } catch (err) {
      log.error('previous follower stop threw during tray-join switch', err);
    }
    try {
      state.follower = startPageFollowerTray(buildFollowerOptions(deps, joinUrl));
    } catch (err) {
      log.error('tray-join failed', err);
    }
  });
  win.addEventListener('slicc:tray-leave', (rawEvent) => {
    const event = rawEvent as CustomEvent<{ workerBaseUrl?: string | null; requestId?: string }>;
    void performTrayLeaveLocally({
      workerBaseUrl: event.detail?.workerBaseUrl ?? null,
      requestId: event.detail?.requestId,
    }).catch((err) => log.error('tray-leave failed', err));
  });
  win.addEventListener(
    'beforeunload',
    () => {
      state.leader?.stop();
      state.follower?.stop();
    },
    { once: true }
  );
}

export async function wireWcTray(deps: WcTrayDeps): Promise<WcTrayHandle> {
  // Idempotent; also called by wireWcSprinkles. Duplicated here because in
  // follower mode openVfs() may never resolve (no local kernel), so
  // wireWcSprinkles never runs — without this the follower renders sprinkles
  // without sprinkle-components.css.
  const { loadSprinkleStyles } = await import('../legacy-styles.js');
  await loadSprinkleStyles();

  const { client, instanceId, window: win, log } = deps;
  const state: TrayRoleState = { leader: null, follower: null };

  const remoteCdpPushChannel =
    typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(panelRpcChannelName(instanceId))
      : null;
  const remoteCdpBridge = createRemoteCdpPageBridge({
    getSync: () => state.leader?.sync ?? null,
    postEvent: (payload) => {
      const msg: PanelRpcPushMsg = { type: 'panel-rpc-push', op: 'remote-cdp-event', payload };
      remoteCdpPushChannel?.postMessage(msg);
    },
  });

  // Worker-forwarded licks (follower mode routes `navigate` to the leader).
  client.setForwardLickHandler((event: LickEvent) => {
    const sync = state.follower?.currentSync;
    if (sync) sync.forwardLick(event);
    else log.warn('forward-lick dropped: no active follower sync');
  });

  const leaderOptions = createLeaderOptionsFactory(deps, state, remoteCdpBridge);
  const { wireLeaderHooks, clearLeaderHooks } = createLeaderHookSetup(deps, remoteCdpBridge);

  const performTrayLeaveLocally = async (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult> => {
    const { performTrayLeave } = await import('../tray-leave-runtime.js');
    return await performTrayLeave(
      { workerBaseUrl: opts.workerBaseUrl, requestId: opts.requestId },
      {
        getLeader: () => state.leader,
        setLeader: (h) => {
          state.leader = h;
        },
        getFollower: () => state.follower,
        setFollower: (h) => {
          state.follower = h as PageFollowerTrayHandle | null;
        },
        startLeader: (workerBaseUrl) => startPageLeaderTray(leaderOptions(workerBaseUrl)),
        clearLeaderHooks,
        wireLeaderHooks,
        storage: win.localStorage,
        log,
      }
    );
  };

  await setupStandalonePanelRpc({
    instanceId,
    browser: deps.browser,
    remoteCdpBridge,
    remoteCdpPushChannel,
    getLeader: () => state.leader,
    performTrayLeaveLocally,
    window: win,
  });

  startInitialRole(deps, state, leaderOptions, wireLeaderHooks);

  subscribeToLeaderTrayRuntimeStatus((status) => {
    win.localStorage.setItem('slicc.leaderTrayStatus', JSON.stringify(status));
  });
  win.localStorage.setItem('slicc.leaderTrayStatus', JSON.stringify(getLeaderTrayRuntimeStatus()));
  // Mirror the follower status the same way the leader status is mirrored.
  // The standalone kernel worker runs the `host` command but never runs the
  // FollowerSyncManager (it lives here on the page), so without this shim the
  // worker's follower global is permanently inactive and `host` reports
  // `status: inactive` while genuinely following. `installPageStorageSync`
  // forwards these writes into the worker's localStorage shim, where
  // `getFollowerStatusWithFallback` reads them. Seed on boot so a stale value
  // from a prior session can't fake a connection.
  subscribeToFollowerTrayRuntimeStatus((status) => {
    win.localStorage.setItem(FOLLOWER_STATUS_STORAGE_KEY, JSON.stringify(status));
  });
  win.localStorage.setItem(
    FOLLOWER_STATUS_STORAGE_KEY,
    JSON.stringify(getFollowerTrayRuntimeStatus())
  );
  // Seed the follower shim on boot so a stale value from a previous session
  // can't make the worker-side `host` report phantom followers.
  writeConnectedFollowersToShim(getConnectedFollowers(), win.localStorage);

  installRoleSwitchListeners(deps, state, clearLeaderHooks, performTrayLeaveLocally);

  return {
    getLeader: () => state.leader,
    getFollower: () => state.follower,
    performTrayLeaveLocally,
  };
}
