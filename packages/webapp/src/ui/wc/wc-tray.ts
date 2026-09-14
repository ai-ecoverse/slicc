import type { SliccFloatbar } from '@slicc/webcomponents';
import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import { type PanelRpcPushMsg, panelRpcChannelName } from '../../kernel/panel-rpc.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import { TabPersistenceGuard } from '../../scoops/tab-persistence-guard.js';
import {
  FOLLOWER_STATUS_STORAGE_KEY,
  getFollowerTrayRuntimeStatus,
  subscribeToFollowerTrayRuntimeStatus,
} from '../../scoops/tray-follower-status.js';
import { shouldApplyFollowerStatus } from '../../scoops/tray-follower-sync.js';
import { attributeGuestMessage } from '../../scoops/tray-leader/biscotto-gate.js';
import {
  getLeaderTrayRuntimeStatus,
  subscribeToLeaderTrayRuntimeStatus,
} from '../../scoops/tray-leader.js';
import type { TrayLeaveResult } from '../../scoops/tray-leave.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../scoops/tray-runtime-config.js';
import type {
  TrayModelCatalogEntry,
  TrayModelSelectionState,
} from '../../scoops/tray-sync-protocol.js';
import type { WorkUnitModel } from '../../scoops/types.js';
import { apiHeaders, resolveApiUrl } from '../../shell/proxied-fetch.js';
import {
  setFollowerSprinkleInstancesGetter,
  writeSprinkleInstancesToShim,
} from '../../shell/sprinkle-instances.js';
import {
  getConnectedFollowers,
  setConnectedFollowersGetter,
  setTrayResetter,
  writeConnectedFollowersToShim,
} from '../../shell/supplemental-commands/host-command.js';
import {
  setPlaywrightTeleportBestFollower,
  setPlaywrightTeleportConnectedFollowers,
} from '../../shell/supplemental-commands/playwright/teleport.js';
import type { TeleportFollowerInfo } from '../../shell/supplemental-commands/playwright/teleport-follower-shim.js';
import { toKernelSudoRequest } from '../../sudo/leader-request.js';
import {
  isReadOnlyUnit,
  modelForUnit,
  toTabDescriptors,
} from '../../work-unit/client/presentation.js';
import type { Unsubscribe, WorkUnitClient, WorkUnitSummary } from '../../work-unit/client/types.js';
import { UnreadLedger } from '../../work-unit/client/unread.js';
import { parseQualifiedModelId, qualifiedModelId, thinkingFor } from '../../work-unit/record.js';
import { setupStandalonePanelRpc } from '../boot/setup-standalone-panel-rpc.js';
import { runHostedBootstrap } from '../boot/setup-standalone-tray-init-hosted.js';
import type { BootStageLogger } from '../boot/types.js';
import { FOLLOWERS_CHANGED_EVENT, toFollowerHudRows } from '../follower-presentation.js';
import { LeaderExecSessionPool } from '../leader-exec-runner.js';
import type { OffscreenClient } from '../offscreen-client.js';
import { type PageFollowerTrayHandle, startPageFollowerTray } from '../page-follower-tray.js';
import {
  getLeaderFollowerStates,
  type PageLeaderTrayHandle,
  type StartPageLeaderTrayOptions,
  startPageLeaderTray,
} from '../page-leader-tray.js';
import {
  getAccounts,
  getAllAvailableModels,
  getProviderConfig,
  resolveCurrentModel,
} from '../provider-settings.js';
import { createRemoteCdpPageBridge, type RemoteCdpPageBridge } from '../remote-cdp-page-bridge.js';
import { canonicalRuntimeId } from '../runtime-identity.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { SprinkleManager } from '../sprinkle-manager.js';
import {
  acquireLeaderRole,
  getDefaultLockManager,
  type LockManagerLike,
  requestLeaderLock,
} from '../tray-leader-lock.js';
import type { AgentHandle, ChatMessage } from '../types.js';
import { createWorkUnitAgentHandle } from '../work-unit-client/agent-handle.js';
import { RemoteWorkUnitClient } from '../work-unit-client/remote.js';
import {
  LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT,
  LEADER_MODEL_CATALOG_CHANGED_EVENT,
} from './leader-model-events.js';
import {
  LEADER_BROADCAST_SNAPSHOT_EVENT,
  LEADER_RUN_NEW_SESSION_EVENT,
  type LeaderRunNewSessionDetail,
} from './leader-session-events.js';
import type { WcChatController } from './wc-chat-controller.js';
import { createFollowerModelSurface } from './wc-follower-model-surface.js';
import { openDelegatedOAuthPopup } from './wc-follower-oauth.js';
import { getLeaderPermissionsSurface } from './wc-permissions-registry.js';
import { scoopColor } from './wc-scoop-color.js';
import { applyComposerAvailability, type SwitcherScoop, type WcShellRefs } from './wc-shell.js';
import { toScoopSummaries, turnsFromUnits } from './wc-tray-scoops.js';
import { rootForSelection } from './wc-unit-context.js';

export interface WcTrayDeps {
  refs: WcShellRefs;
  client: OffscreenClient;
  browser: BrowserAPI;
  realCdpTransport: CDPTransport;
  instanceId: string;
  runtimeMode: UiRuntimeMode;
  sprinkleManager: SprinkleManager;

  addSprinkle: (name: string, title: string, element: HTMLElement) => void;
  removeSprinkle: (name: string) => void;
  getController(): WcChatController | null;
  getSelectedJid(): string;
  agentHandle: AgentHandle;

  restoreLocalChrome(): void;

  workUnits: WorkUnitClient;
  openFs(): Promise<import('../../kernel/local-vfs-client.js').LocalVfsClient>;
  openWriter(): Promise<import('../../kernel/writable-vfs-client.js').WritableVfsClient>;
  window: Window;
  log: BootStageLogger;
}

export interface WcTrayHandle {
  getLeader(): PageLeaderTrayHandle | null;
  getFollower(): PageFollowerTrayHandle | null;

  scheduleScoopsListBroadcast(): void;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
}

interface TrayRoleState {
  leader: PageLeaderTrayHandle | null;
  follower: PageFollowerTrayHandle | null;

  disposeFollowerRole: (() => void) | null;
  persistenceGuard: TabPersistenceGuard;

  lockRelease: (() => void) | null;
}

function initialRoleState(): TrayRoleState {
  return {
    disposeFollowerRole: null,
    follower: null,
    leader: null,
    lockRelease: null,
    persistenceGuard: new TabPersistenceGuard(),
  };
}

function startFollowerRole(
  deps: WcTrayDeps,
  state: TrayRoleState,
  joinUrl: string
): PageFollowerTrayHandle {
  state.disposeFollowerRole?.();
  const role = buildFollowerOptions(deps, joinUrl, () => state.follower?.currentSync ?? null);
  state.disposeFollowerRole = role.dispose;
  return startPageFollowerTray(role.options);
}

export function getLeaderConnectedFollowers(handle: PageLeaderTrayHandle): TeleportFollowerInfo[] {
  const execIds = handle.sync.getExecCapableBootstrapIds();
  const cdpIds = handle.sync.getBrowserCapableBootstrapIds();
  const teleportIds = handle.sync.getTeleportEligibleBootstrapIds();
  const motds = handle.sync.getFollowerMotds();
  return getLeaderFollowerStates(handle.peers, handle.sync).map((follower) => {
    return {
      runtimeId: canonicalRuntimeId(follower.bootstrapId),
      bootstrapId: follower.bootstrapId,
      runtime: follower.runtime,
      connectedAt: follower.connectedAt,
      lastActivity: follower.lastActivity,
      floatType: follower.floatType,
      hostOrigin: follower.hostOrigin,
      selectedScoopJid: follower.selectedScoopJid,
      health: follower.health,
      peerState: follower.peerState,
      exec: execIds.has(follower.bootstrapId),
      cdp: cdpIds.has(follower.bootstrapId),
      teleportEligible: teleportIds.has(follower.bootstrapId),
      motd: motds.get(follower.bootstrapId),
    };
  });
}

function modelCatalogForTray(): TrayModelCatalogEntry[] {
  return getAllAvailableModels().flatMap((group) =>
    group.models.map((model) => ({
      providerName: group.providerName,
      modelId: `${group.providerId}:${model.id}`,
      modelName: model.name ?? model.id,
      reasoning: model.reasoning === true,
    }))
  );
}

function qualifiedModelIdForUnit(
  catalog: readonly TrayModelCatalogEntry[],
  pinned: WorkUnitModel | undefined
): string {
  if (!pinned) return currentQualifiedModelId(catalog);
  const qualified = qualifiedModelId(pinned);
  return (
    catalog.find((entry) => entry.modelId === qualified)?.modelId ??
    catalog.find((entry) => entry.modelId.endsWith(`:${pinned.id}`))?.modelId ??
    qualified
  );
}

function currentQualifiedModelId(catalog: readonly TrayModelCatalogEntry[]): string {
  const current = resolveCurrentModel();
  const exact = catalog.find((entry) => entry.modelId === `${current.provider}:${current.id}`);
  return (
    exact?.modelId ??
    catalog.find((entry) => entry.modelId.endsWith(`:${current.id}`))?.modelId ??
    `${current.provider}:${current.id}`
  );
}

async function refreshDynamicModelCatalogs(log: BootStageLogger): Promise<boolean> {
  const refreshes = getAccounts()
    .map((account) => getProviderConfig(account.providerId).refreshModels)
    .filter((refresh): refresh is NonNullable<typeof refresh> => refresh !== undefined);
  if (refreshes.length === 0) return false;
  const results = await Promise.allSettled(refreshes.map((refresh) => refresh()));
  for (const result of results) {
    if (result.status === 'rejected')
      log.warn('dynamic model catalog refresh failed', result.reason);
  }
  return true;
}

export function installLeaderModelCatalogRefresh(opts: {
  window: Pick<Window, 'addEventListener'>;
  getSync: () => Pick<PageLeaderTrayHandle['sync'], 'broadcastModelCatalog'> | null;
  refreshDynamicCatalogs: () => Promise<boolean>;
  log: BootStageLogger;
  refreshTimeoutMs?: number;
}): void {
  opts.window.addEventListener(LEADER_MODEL_CATALOG_CHANGED_EVENT, () => {
    opts.getSync()?.broadcastModelCatalog();
  });
  opts.window.addEventListener('slicc:accounts-changed', () => {
    opts.getSync()?.broadcastModelCatalog();
    void withTimeout(opts.refreshDynamicCatalogs(), opts.refreshTimeoutMs ?? 5000)
      .then((refreshed) => {
        if (refreshed) opts.getSync()?.broadcastModelCatalog();
      })
      .catch((err) => opts.log.warn('dynamic model catalog refresh failed', err));
  });
}

export function installLeaderModelStateBridge(opts: {
  window: Pick<Window, 'addEventListener'>;
  getSync: () => Pick<PageLeaderTrayHandle['sync'], 'broadcastModelState'> | null;
}): void {
  opts.window.addEventListener(LEADER_LOCAL_MODEL_STATE_CHANGED_EVENT, () => {
    opts.getSync()?.broadcastModelState();
  });
  opts.window.addEventListener('model-change', (event) => {
    const detail = (event as CustomEvent<{ source?: 'follower' }>).detail;
    if (detail?.source !== 'follower') opts.getSync()?.broadcastModelState();
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('dynamic model catalog refresh timed out')),
      timeoutMs
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function createTranscriptWatch(
  workUnits: RemoteWorkUnitClient,
  getController: () => WcChatController | null
): { watch: (jid: string) => void; forget: () => void } {
  let unwatch: Unsubscribe | null = null;
  let watched: string | null = null;
  return {
    forget: () => {
      unwatch?.();
      unwatch = null;
      watched = null;
    },
    watch: (jid) => {
      if (watched === jid && unwatch) return;
      unwatch?.();
      watched = jid;
      unwatch = workUnits.subscribe(jid, (event) => {
        if (event.type !== 'snapshot' || watched !== jid) return;
        const messages = event.snapshot.messages as unknown as ChatMessage[];
        const controller = getController();
        controller?.loadMessages(messages, event.snapshot.queuedIds);
        controller?.setProcessing(messages.some((message) => message.isStreaming));
      });
    },
  };
}

function installFollowerCaptureHandlers(
  deps: WcTrayDeps,
  handlers: {
    getSync: () => PageFollowerTrayHandle['currentSync'];
    onSelect: (scoopJid: string) => void;
    onStop: () => void;
  }
): () => void {
  const onSelect = (event: Event): void => {
    if (!handlers.getSync()) return;
    event.stopImmediatePropagation();
    const scoopJid = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (!scoopJid) return;
    handlers.onSelect(scoopJid);
  };
  const onStop = (event: Event): void => {
    if (!handlers.getSync()) return;
    event.stopImmediatePropagation();
    if (!deps.getController()?.processing) return;
    handlers.onStop();
  };
  deps.refs.switcher.addEventListener('slicc-scoop-select', onSelect, { capture: true });
  deps.refs.inputCard.addEventListener('stop', onStop, { capture: true });
  return () => {
    deps.refs.switcher.removeEventListener('slicc-scoop-select', onSelect, { capture: true });
    deps.refs.inputCard.removeEventListener('stop', onStop, { capture: true });
  };
}

export interface FollowerRole {
  options: Parameters<typeof startPageFollowerTray>[0];

  dispose(): void;
}

export function buildFollowerOptions(
  deps: WcTrayDeps,
  joinUrl: string,
  getSync: () => PageFollowerTrayHandle['currentSync']
): FollowerRole {
  const { browser, client, getController } = deps;

  const usableUnitId = (jid: string | null | undefined): string | null =>
    jid && jid.length > 0 ? jid : null;
  let selectedScoopJid: string | null = null;

  const workUnits = new RemoteWorkUnitClient({ getSync: () => getSync() ?? null });

  const unread = new UnreadLedger();
  const publishFollowerScoops = (): void => {
    const units = workUnits.currentUnits();
    deps.refs.switcher.scoops = toTabDescriptors(
      units,
      selectedScoopJid,
      scoopColor,
      unread.sync(units, selectedScoopJid)
    ) as SwitcherScoop[];
  };
  const transcript = createTranscriptWatch(workUnits, () => deps.getController());
  const watchUnit = transcript.watch;

  const applySelectionChrome = (): void => {
    const shown = workUnits.currentUnits().find((unit) => unit.id === selectedScoopJid);
    applyComposerAvailability(deps.refs, shown ? isReadOnlyUnit(shown) : false);
  };
  const modelSurface = createFollowerModelSurface({
    composerMeta: deps.refs.composerMeta,
    getSync,

    getUnits: () => workUnits.currentUnits(),
    setModel: (unitId, model) => {
      void workUnits.setModel(unitId, model).catch(() => undefined);
    },
    getSelectedScoopJid: () => selectedScoopJid,
    interceptLocalHandlers: true,
    getLockedEffortLevel: () => deps.window.localStorage.getItem('slicc_locked_effort_level'),
  });
  deps.refs.switcher.connection = 'disconnected';

  const disposeCapture = installFollowerCaptureHandlers(deps, {
    getSync,
    onSelect: (scoopJid) => {
      selectedScoopJid = scoopJid;
      publishFollowerScoops();
      applySelectionChrome();
      deps.refs.switcher.setAttribute('active', scoopJid);

      void workUnits.snapshot(scoopJid).catch(() => undefined);
      watchUnit(scoopJid);

      modelSurface.onShownUnitChanged();
    },
    onStop: () => {
      const target = usableUnitId(selectedScoopJid ?? workUnits.selectedUnitId);
      if (!target) return;
      void workUnits.signal(target, 'stop').catch((error) => {
        deps.log.warn('follower stop failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });

  const forgetSession = (): void => {
    workUnits.resetSelection();
    transcript.forget();
    modelSurface.reset();
  };
  const dispose = (): void => {
    disposeCapture();
    transcript.forget();
    workUnits.resetSelection();
    modelSurface.dispose();

    deps.getController()?.setAgent(deps.agentHandle);
    deps.restoreLocalChrome();
  };
  const options: Parameters<typeof startPageFollowerTray>[0] = workUnits.wrapOptions({
    joinUrl,
    onSnapshot: (_messages, scoopJid) => {
      selectedScoopJid = usableUnitId(scoopJid);
      if (selectedScoopJid) watchUnit(selectedScoopJid);
      applySelectionChrome();
      modelSurface.onShownUnitChanged();
    },
    onUserMessage: (text, _messageId, _scoopJid, attachments) =>
      getController()?.addUserMessage(text, attachments),
    onStatus: (status, scoopJid) => {
      if (shouldApplyFollowerStatus(scoopJid, selectedScoopJid)) {
        getController()?.setProcessing(status === 'processing');
      }
    },
    setChatAgent: (agent) => {
      getController()?.setAgent(
        createWorkUnitAgentHandle(workUnits, {
          getSelectedId: () => usableUnitId(selectedScoopJid ?? workUnits.selectedUnitId),
          onError: (error) => {
            deps.log.warn('follower send failed', { error });

            deps
              .getController()
              ?.addAssistantMessage(`_That message was not sent to the leader — ${error}_`);
          },
          onEvent: (listener) => agent.onEvent(listener),
        })
      );
    },
    browserAPI: browser,
    onForwardingToggle: (enabled) => client.sendSetFollowerForwarding(enabled),
    getSelectedScoopJid: () => selectedScoopJid,

    onGaveUp: () => forgetSession(),
    onConnectionChange: (connected) => {
      deps.refs.switcher.connection = connected ? 'connected' : 'disconnected';
      if (!connected) {
        forgetSession();
      }
    },
    addSprinkle: (name, title, element) => deps.addSprinkle(name, title, element),
    removeSprinkle: (name) => deps.removeSprinkle(name),
    onScoopsList: (scoops, activeScoopJid) => {
      if (!selectedScoopJid || !scoops.some((scoop) => scoop.jid === selectedScoopJid)) {
        selectedScoopJid = usableUnitId(activeScoopJid);
      }
      publishFollowerScoops();
      if (selectedScoopJid) deps.refs.switcher.setAttribute('active', selectedScoopJid);
      if (selectedScoopJid) watchUnit(selectedScoopJid);
      applySelectionChrome();
      modelSurface.onShownUnitChanged();
    },

    onOAuthPopupRequest: (url, signal) =>
      openDelegatedOAuthPopup(url, signal, {
        getPermissionsSurface: getLeaderPermissionsSurface,
        window: deps.window,
      }),
    onModelsList: modelSurface.onModelsList,
    onModelState: modelSurface.onModelState,
  });
  return { dispose, options };
}

function mirrorSprinkleInstances(state: TrayRoleState): void {
  writeSprinkleInstancesToShim(state.leader ? state.leader.sync.getSprinkleInstances() : []);
}

function applyFollowerPresentation(
  deps: WcTrayDeps,
  state: TrayRoleState,
  fallbackCount: number
): void {
  const followers = state.leader ? getLeaderConnectedFollowers(state.leader) : [];
  const count = fallbackCount;
  if (count > 0) {
    state.persistenceGuard.activate();
  } else {
    state.persistenceGuard.deactivate();
  }

  (deps.refs.floatbar as SliccFloatbar).followers = toFollowerHudRows(
    followers.filter((follower) => follower.peerState !== 'connecting')
  );
  writeConnectedFollowersToShim(followers);

  mirrorSprinkleInstances(state);

  deps.window.dispatchEvent(new CustomEvent(FOLLOWERS_CHANGED_EVENT, { detail: { followers } }));
}

function leaderModelCallbacks(
  deps: WcTrayDeps
): Pick<StartPageLeaderTrayOptions, 'getModelSelectionState' | 'onFollowerModelSelect'> {
  const { client, refs } = deps;

  let units: readonly WorkUnitSummary[] = [];
  deps.workUnits.subscribeList((next) => {
    units = next;
  });
  return {
    getModelSelectionState: (scoopJid): TrayModelSelectionState => {
      const catalog = modelCatalogForTray();
      const unit = client.getScoop(scoopJid);

      const thinking = unit ? thinkingFor(unit) : {};
      return {
        activeModelId: qualifiedModelIdForUnit(catalog, modelForUnit(units, scoopJid)),
        scoopJid,
        thinkingLevel: thinking.level === 'max' ? 'xhigh' : thinking.level,
        effortOverride:
          thinking.level === 'max' ? (thinking.effortOverride ?? 'max') : thinking.effortOverride,
      };
    },
    onFollowerModelSelect: (modelId, scoopJid) => {
      const entry = modelCatalogForTray().find((model) => model.modelId === modelId);
      if (!entry) return false;

      const target = rootForSelection(units, scoopJid ? { id: scoopJid } : null);
      if (!target) return false;
      const picked = parseQualifiedModelId(entry.modelId);
      if (!picked) return false;

      return client
        .setScoopModel(target.id, picked)
        .then((applied) => {
          if (applied && target.id === deps.getSelectedJid()) {
            refs.composerMeta.dispatchEvent(
              new CustomEvent('model-change', {
                bubbles: true,
                composed: true,
                detail: {
                  id: entry.modelId,
                  model: entry.modelName,
                  provider: entry.providerName,
                  source: 'follower',
                },
              })
            );
            refs.composerMeta.setAttribute('model', entry.modelName);
          }
          return applied;
        })
        .catch(() => false);
    },
  };
}

function deliverFollowerMessage(
  deps: WcTrayDeps,
  state: TrayRoleState,
  text: string,
  messageId: string,
  attachments: Parameters<StartPageLeaderTrayOptions['onFollowerMessage']>[2],
  options: Parameters<StartPageLeaderTrayOptions['onFollowerMessage']>[3]
): void {
  const { client } = deps;

  const seat = options?.biscotto;
  const source = seat ? `biscotto:${seat.id}` : undefined;
  const forAgent = seat ? attributeGuestMessage(text, seat.label) : text;

  const target = options?.targetScoopJid ?? client.selectedScoopJid;

  if (target === client.selectedScoopJid) {
    deps.getController()?.addUserMessage(forAgent, attachments, source);
  }
  if (target) {
    void deps.workUnits
      .send(target, {
        text: forAgent,
        messageId,
        ...(attachments ? { attachments } : {}),
        ...(options?.steer ? { steer: true } : {}),

        ...(options?.guestGate ? { guestGate: options.guestGate } : {}),
      })
      .catch((err) =>
        deps.log.warn('follower message delivery failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
  } else {
    deps.agentHandle.sendMessage(forAgent, messageId, attachments, options);
  }
  state.leader?.sync.broadcastUserMessage(forAgent, messageId, attachments);

  if (state.leader) writeConnectedFollowersToShim(getLeaderConnectedFollowers(state.leader));
}

export function createLeaderOptionsFactory(
  deps: WcTrayDeps,
  state: TrayRoleState,
  remoteCdpBridge: RemoteCdpPageBridge
): (workerBaseUrl: string) => StartPageLeaderTrayOptions {
  const { client, refs } = deps;
  const refreshFollowerPresentation = (fallbackCount = 0): void => {
    applyFollowerPresentation(deps, state, fallbackCount);
  };
  const execSessions = new LeaderExecSessionPool(client);
  return (workerBaseUrl) => ({
    workerBaseUrl,
    getMessages: () => deps.getController()?.getMessages() ?? [],
    getMessagesForScoop: (scoopJid) => client.getMessagesForScoop(scoopJid),
    getScoopJid: () => deps.getSelectedJid(),
    getScoops: () =>
      toScoopSummaries(
        client.getScoops(),
        refs.switcher.scoops,
        turnsFromUnits(deps.workUnits.currentUnits())
      ),
    getModelCatalog: modelCatalogForTray,
    ...leaderModelCallbacks(deps),
    onFollowerThinkingSet: (scoopJid, thinkingLevel, effortOverride) =>
      client.setScoopThinkingLevel(scoopJid, thinkingLevel, effortOverride),
    getSprinkles: () => {
      const opened = new Set(deps.sprinkleManager.opened());
      return deps.sprinkleManager.available().map((p) => ({
        name: p.name,
        title: p.title,
        path: p.path,
        open: opened.has(p.name),
        autoOpen: p.autoOpen,
        icon: p.icon,
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
    onSprinkleLick: (name, body, targetScoop, originLabel, originUnitJid) =>
      client.sendSprinkleLick(name, body, targetScoop, {
        label: originLabel,
        unitJid: originUnitJid,
      }),
    onSprinkleInstancesChanged: () => mirrorSprinkleInstances(state),
    onFollowerMessage: (text, messageId, attachments, options) =>
      deliverFollowerMessage(deps, state, text, messageId, attachments, options),

    onFollowerAbort: (targetScoopJid) => {
      const target = targetScoopJid ?? client.selectedScoopJid;
      if (!target) return;
      void deps.workUnits.signal(target, 'stop').catch((err) =>
        deps.log.warn('follower abort failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
    },
    onFollowerNewSession: (action) => {
      deps.window.dispatchEvent(
        new CustomEvent<LeaderRunNewSessionDetail>(LEADER_RUN_NEW_SESSION_EVENT, {
          detail: { action },
        })
      );
    },
    onFollowerCountChanged: refreshFollowerPresentation,

    onFollowerTargetsChanged: () => {
      if (state.leader) writeConnectedFollowersToShim(getLeaderConnectedFollowers(state.leader));
    },
    onRemoteTransportsCleaned: (runtimeId) => remoteCdpBridge.cleanupRuntime(runtimeId),
    onForwardedLick: (event) => client.sendForwardedLick(event),
    onCherryHostEvent: (runtimeId, name, detail) =>
      client.sendCherryHostEvent(runtimeId, name, detail),
    onPreviewLick: (event) => client.sendPreviewLick(event),

    requestSudoApproval: (request) => client.requestSudoApproval(toKernelSudoRequest(request)),
    createTranscriptExport: async (selector, signal) => {
      const { runTranscriptExportForFollower } = await import('./wc-transcript-export.js');
      return runTranscriptExportForFollower(selector, signal, client);
    },
    sendWebhookEvent: (webhookId, headers, body) =>
      client.sendWebhookEvent(webhookId, headers, body),
    onAgentEvent: (handler) => deps.agentHandle.onEvent(handler),

    execInShell: (command, execOpts) => execSessions.run({ command, ...execOpts }),
    closeExecShell: (sessionId) => execSessions.close(sessionId),
    browserAPI: deps.browser,
    browserTransport: deps.realCdpTransport,

    vfs: {
      async stat(path: string) {
        const fs = await deps.openFs();
        return fs.stat(path);
      },
      async readFile(path: string, options?: import('../../fs/types.js').ReadFileOptions) {
        const fs = await deps.openFs();
        return fs.readFile(path, options);
      },
      async readDir(path: string) {
        const fs = await deps.openFs();
        return fs.readDir(path);
      },
      async writeFile(
        path: string,
        content: import('../../fs/types.js').FileContent,
        options?: import('../../fs/types.js').WriteFileOptions
      ) {
        const fs = await deps.openWriter();
        return fs.writeFile(path, content, options);
      },
      async mkdir(path: string, options?: import('../../fs/types.js').MkdirOptions) {
        const fs = await deps.openWriter();
        return fs.mkdir(path, options);
      },
      async rm(path: string, options?: import('../../fs/types.js').RmOptions) {
        const fs = await deps.openWriter();
        return fs.rm(path, options);
      },
    } as import('../../fs/virtual-fs.js').VirtualFS,
  });
}

let leaderTurnEndUnsubscribe: (() => void) | null = null;

function createLeaderHookSetup(
  deps: WcTrayDeps,
  remoteCdpBridge: RemoteCdpPageBridge
): { wireLeaderHooks(handle: PageLeaderTrayHandle): void; clearLeaderHooks(): void } {
  return {
    wireLeaderHooks: (handle) => {
      void import('../../sudo/page-approval-service.js').then(({ setSudoTrayDelegate }) =>
        setSudoTrayDelegate({
          shouldDelegate: () => handle.sync.shouldDelegateSudo(),
          requestApproval: (req) => handle.sync.delegateSudoApproval(req),
        })
      );

      const offTurnEnd = deps.agentHandle.onEvent((event) => {
        if (event.type === 'turn_end') {
          const jid = deps.getSelectedJid();
          handle.sync.notifyTurnEnd(jid === 'cone' ? 'SLICC' : jid);
        }
      });
      leaderTurnEndUnsubscribe = offTurnEnd;
      setConnectedFollowersGetter(() => getLeaderConnectedFollowers(handle));
      setTrayResetter(() => handle.reset());

      setPlaywrightTeleportBestFollower(() => () => handle.sync.getBestFollowerForTeleport());
      setPlaywrightTeleportConnectedFollowers(() => () => getLeaderConnectedFollowers(handle));
      setFollowerSprinkleInstancesGetter(() => handle.sync.getSprinkleInstances());
      deps.sprinkleManager.setSendToSprinkleHook((name, data, target) =>
        handle.sync.broadcastSprinkleUpdate(name, data, target)
      );
      deps.sprinkleManager.setReloadHook((name) => handle.sync.broadcastSprinkleReloaded(name));
      deps.getController()?.setOnLocalUserMessage((text, messageId, attachments) => {
        handle.sync.noteLeaderUserMessage();
        handle.sync.broadcastUserMessage(text, messageId, attachments);
      });

      deps
        .getController()
        ?.setOnLocalProcessingChange((processing) =>
          handle.sync.broadcastStatus(processing ? 'processing' : 'ready')
        );
      void import('../theme-engine.js')
        .then(({ setThemeChangeListener, getActiveThemeId, getActiveThemeJson }) => {
          let debounceTimer: ReturnType<typeof setTimeout> | undefined;
          setThemeChangeListener((themeJson) => {
            if (getActiveThemeId() === '__preview') return;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => handle.sync.broadcastTheme(themeJson), 150);
          });

          handle.sync.broadcastTheme(getActiveThemeJson());
        })
        .catch((err) => deps.log.error('failed to install tray theme sync', err));
    },
    clearLeaderHooks: () => {
      void import('../../sudo/page-approval-service.js').then(({ setSudoTrayDelegate }) =>
        setSudoTrayDelegate(null)
      );
      leaderTurnEndUnsubscribe?.();
      leaderTurnEndUnsubscribe = null;
      setConnectedFollowersGetter(null);
      writeConnectedFollowersToShim([]);
      setFollowerSprinkleInstancesGetter(null);
      writeSprinkleInstancesToShim([]);
      setTrayResetter(null);
      setPlaywrightTeleportBestFollower(null);
      setPlaywrightTeleportConnectedFollowers(null);
      deps.getController()?.setOnLocalUserMessage(undefined);
      deps.getController()?.setOnLocalProcessingChange(undefined);
      deps.sprinkleManager.setSendToSprinkleHook(undefined);
      deps.sprinkleManager.setReloadHook(undefined);
      remoteCdpBridge.disposeAll();
      void import('../theme-engine.js')
        .then(({ setThemeChangeListener }) => {
          setThemeChangeListener(null);
        })
        .catch((err) => deps.log.error('failed to clear tray theme sync', err));
    },
  };
}

function hostedLeaderExtras(deps: WcTrayDeps): Partial<StartPageLeaderTrayOptions> {
  return {
    runtime: 'slicc-hosted-leader',
    kind: 'hosted',
    onLeaderReady: (session) => {
      void fetch(resolveApiUrl('/api/cloud-status'), {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
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

function startInitialRole(
  deps: WcTrayDeps,
  state: TrayRoleState,
  leaderOptions: (workerBaseUrl: string) => StartPageLeaderTrayOptions,
  wireLeaderHooks: (handle: PageLeaderTrayHandle) => void,
  lockManager: LockManagerLike | null
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
    state.follower = startFollowerRole(deps, state, storedJoinUrl);
  } else if (storedWorkerBaseUrl) {
    acquireAndStartLeader(
      storedWorkerBaseUrl,
      deps,
      state,
      leaderOptions,
      wireLeaderHooks,
      lockManager
    );
  }
}

function acquireAndStartLeader(
  workerBaseUrl: string,
  deps: WcTrayDeps,
  state: TrayRoleState,
  leaderOptions: (url: string) => StartPageLeaderTrayOptions,
  wireLeaderHooks: (handle: PageLeaderTrayHandle) => void,
  lockManager: LockManagerLike | null
): void {
  void acquireLeaderRole({
    workerBaseUrl,
    lockManager,
    shouldLead: () =>
      !state.leader &&
      !state.follower &&
      deps.window.localStorage.getItem(TRAY_WORKER_STORAGE_KEY) === workerBaseUrl,
    onGranted: (release) => {
      state.lockRelease = release;
      state.leader = startPageLeaderTray(leaderOptions(workerBaseUrl));
      wireLeaderHooks(state.leader);
    },
  });
}

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
    const lockRelease = state.lockRelease;
    state.leader = null;
    state.lockRelease = null;
    state.persistenceGuard.deactivate();
    clearLeaderHooks();
    const previousFollower = state.follower;
    state.follower = null;
    try {
      leaderToStop?.stop();
    } catch (err) {
      log.error('leader stop threw during tray-join switch', err);
    }
    lockRelease?.();
    try {
      previousFollower?.stop();
    } catch (err) {
      log.error('previous follower stop threw during tray-join switch', err);
    }
    try {
      state.follower = startFollowerRole(deps, state, joinUrl);
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
      state.persistenceGuard.deactivate();
      state.leader?.stop();
      state.follower?.stop();
      state.lockRelease?.();
      state.lockRelease = null;
    },
    { once: true }
  );
}

export async function wireWcTray(deps: WcTrayDeps): Promise<WcTrayHandle> {
  const { loadSprinkleStyles } = await import('../legacy-styles.js');
  await loadSprinkleStyles();

  const { client, instanceId, window: win, log } = deps;
  const state = initialRoleState();
  const lockManager = getDefaultLockManager();

  installLeaderModelCatalogRefresh({
    window: win,
    getSync: () => state.leader?.sync ?? null,
    refreshDynamicCatalogs: () => refreshDynamicModelCatalogs(log),
    log,
  });
  installLeaderModelStateBridge({
    window: win,
    getSync: () => state.leader?.sync ?? null,
  });

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

  client.setForwardLickHandler((event: LickEvent) => {
    const sync = state.follower?.currentSync;
    if (sync) sync.forwardLick(event);
    else log.warn('forward-lick dropped: no active follower sync');
  });

  const leaderOptions = createLeaderOptionsFactory(deps, state, remoteCdpBridge);
  const { wireLeaderHooks, clearLeaderHooks } = createLeaderHookSetup(deps, remoteCdpBridge);

  win.addEventListener(LEADER_BROADCAST_SNAPSHOT_EVENT, () => {
    state.leader?.sync.broadcastSnapshot();
  });

  const performTrayLeaveLocally = async (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult> => {
    const { performTrayLeave } = await import('../tray-leave-runtime.js');

    const releaseLockIfDormant = (): void => {
      if (state.leader) return;
      state.lockRelease?.();
      state.lockRelease = null;
    };
    const leavePromise = performTrayLeave(
      { workerBaseUrl: opts.workerBaseUrl, requestId: opts.requestId },
      {
        getLeader: () => state.leader,
        setLeader: (h) => {
          state.leader = h;
          if (!h) state.persistenceGuard.deactivate();
        },
        getFollower: () => state.follower,
        setFollower: (h) => {
          if (!h) {
            state.disposeFollowerRole?.();
            state.disposeFollowerRole = null;
          }
          state.follower = h as PageFollowerTrayHandle | null;
        },
        startLeader: (workerBaseUrl) => {
          state.lockRelease?.();
          state.lockRelease = null;

          void requestLeaderLock(workerBaseUrl, lockManager).then((lockResult) => {
            if (lockResult.status !== 'granted') return;
            if (!state.leader) {
              lockResult.release();
              return;
            }
            state.lockRelease = lockResult.release;
          });
          return startPageLeaderTray(leaderOptions(workerBaseUrl));
        },
        clearLeaderHooks,
        wireLeaderHooks,
        storage: win.localStorage,
        log,
      }
    );
    try {
      const result = await leavePromise;
      if (!state.follower) deps.refs.switcher.connection = 'connected';
      releaseLockIfDormant();
      return result;
    } catch (err) {
      releaseLockIfDormant();
      throw err;
    }
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

  startInitialRole(deps, state, leaderOptions, wireLeaderHooks, lockManager);

  subscribeToLeaderTrayRuntimeStatus((status) => {
    win.localStorage.setItem('slicc.leaderTrayStatus', JSON.stringify(status));
  });
  win.localStorage.setItem('slicc.leaderTrayStatus', JSON.stringify(getLeaderTrayRuntimeStatus()));

  subscribeToFollowerTrayRuntimeStatus((status) => {
    win.localStorage.setItem(FOLLOWER_STATUS_STORAGE_KEY, JSON.stringify(status));
  });
  win.localStorage.setItem(
    FOLLOWER_STATUS_STORAGE_KEY,
    JSON.stringify(getFollowerTrayRuntimeStatus())
  );

  writeConnectedFollowersToShim(getConnectedFollowers(), win.localStorage);

  installRoleSwitchListeners(deps, state, clearLeaderHooks, performTrayLeaveLocally);

  return {
    getLeader: () => state.leader,
    getFollower: () => state.follower,
    scheduleScoopsListBroadcast: () => state.leader?.scheduleScoopsListBroadcast(),
    performTrayLeaveLocally,
  };
}
