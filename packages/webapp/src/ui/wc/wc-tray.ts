/**
 * Multi-browser tray sync for the WC shell — the standalone leader/follower
 * orchestration formerly spread across `setup-standalone-{leader-runtime,
 * tray-init,tray-bootstrap,tray-events}.ts`, re-wired against the WC chat
 * controller and sprinkle zone. The tray primitives themselves
 * (`page-leader-tray.ts`, `page-follower-tray.ts`, `tray-leave-runtime.ts`)
 * are reused verbatim — they were already Layout-free.
 */

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
  ScoopSummary,
  TrayModelCatalogEntry,
  TrayModelSelectionState,
} from '../../scoops/tray-sync-protocol.js';
import type { RegisteredScoop } from '../../scoops/types.js';
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
import type { WorkUnitClient } from '../../work-unit/client/types.js';
import {
  modelFor,
  parseQualifiedModelId,
  qualifiedModelId,
  thinkingFor,
} from '../../work-unit/record.js';
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
import type { AgentHandle } from '../types.js';
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
import type { WcShellRefs } from './wc-shell.js';
import { toFollowerSwitcherScoops, toScoopSummaries } from './wc-tray-scoops.js';
import { rootForSelection } from './wc-unit-context.js';

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
  /**
   * The leader's client protocol. A follower's message and abort are delivered
   * through it because they NAME a unit — the sending follower's own selection
   * — which the selection-bound {@link agentHandle} cannot express (#2382).
   */
  workUnits: WorkUnitClient;
  openFs(): Promise<import('../../kernel/local-vfs-client.js').LocalVfsClient>;
  openWriter(): Promise<import('../../kernel/writable-vfs-client.js').WritableVfsClient>;
  window: Window;
  log: BootStageLogger;
}

export interface WcTrayHandle {
  getLeader(): PageLeaderTrayHandle | null;
  getFollower(): PageFollowerTrayHandle | null;
  /** Notify the active leader that rendered scoop state changed. */
  scheduleScoopsListBroadcast(): void;
  performTrayLeaveLocally(opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult>;
}

interface TrayRoleState {
  leader: PageLeaderTrayHandle | null;
  follower: PageFollowerTrayHandle | null;
  persistenceGuard: TabPersistenceGuard;
  /** Release function for the current leader lock (null when no lock held). */
  lockRelease: (() => void) | null;
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

/**
 * The provider-qualified id a follower should show for one unit (#2310):
 * that unit's own recorded model, falling back to the profile default only
 * when it has none (a record not yet backfilled).
 */
function qualifiedModelIdForUnit(
  catalog: readonly TrayModelCatalogEntry[],
  unit: RegisteredScoop | undefined
): string {
  const pinned = unit ? modelFor(unit) : undefined;
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
  // A catalog that only BECAME available (provider warm-up finished, an account
  // resolved at boot) reaches followers that attached before it (#2329) — the
  // accounts-changed listener below only covers a user editing accounts.
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

/**
 * The leader-capable float's own follower wiring. It still installs the raw
 * sync manager as the chat agent (`setChatAgent`) and has no addressable-unit
 * gate, unlike the dedicated follower mount — it is the third follower wiring
 * and it collapses onto the one mount in #2382 PR D rather than being
 * half-migrated here.
 */
export function buildFollowerOptions(
  deps: WcTrayDeps,
  joinUrl: string,
  getSync: () => PageFollowerTrayHandle['currentSync']
): Parameters<typeof startPageFollowerTray>[0] {
  const { browser, client, getController } = deps;
  let selectedScoopJid: string | null = null;
  /**
   * Last roster the leader sent. `toFollowerSwitcherScoops` orders the SELECTED
   * cone's scoops ahead of the rest, so a local selection has to re-publish the
   * descriptors — this leader-capable float is the third follower wiring path
   * (with `wc-follower.ts` and the leader's own `wc-live.ts`) and needs the same
   * behaviour (#2272).
   */
  let followerScoops: readonly ScoopSummary[] = [];
  const publishFollowerScoops = (): void => {
    deps.refs.switcher.scoops = toFollowerSwitcherScoops(followerScoops, selectedScoopJid);
  };
  const modelSurface = createFollowerModelSurface({
    composerMeta: deps.refs.composerMeta,
    getSync,
    // This float follows someone else's tray but has no `RemoteWorkUnitClient`
    // of its own (the mounts collapse onto one client in #2382 PR D), so the
    // pick goes out as the raw frame it always did — still naming the unit.
    setModel: (unitId, model) => getSync()?.selectModel(qualifiedModelId(model), unitId),
    getSelectedScoopJid: () => selectedScoopJid,
    interceptLocalHandlers: true,
    getLockedEffortLevel: () => deps.window.localStorage.getItem('slicc_locked_effort_level'),
  });
  deps.refs.switcher.connection = 'disconnected';
  // No follower browser rail here on purpose. This float is leader-capable, so
  // `wireWcBrowser` already gave it a tab switcher at boot — and that one is
  // strictly better while following: it lists local pages AND the tray
  // registry, and opens a chosen tab in THIS browser, which is what "in front
  // of me" means on a follower too. Wiring a second rail raced it for the
  // globe (two listeners, two full-screen overlays on one click). The
  // dedicated follower mount, which has no switcher of its own, wires it.
  deps.refs.switcher.addEventListener(
    'slicc-scoop-select',
    (event) => {
      const sync = getSync();
      if (!sync) return;
      event.stopImmediatePropagation();
      const scoopJid = (event as CustomEvent<{ key?: string }>).detail?.key;
      if (!scoopJid) return;
      selectedScoopJid = scoopJid;
      publishFollowerScoops(); // re-order for the new selection, as the leader does
      deps.refs.switcher.setAttribute('active', scoopJid);
      sync.selectScoop(scoopJid);
    },
    { capture: true }
  );
  return {
    joinUrl,
    onSnapshot: (messages, scoopJid) => {
      selectedScoopJid = scoopJid;
      const controller = getController();
      controller?.loadMessages(messages);
      controller?.setProcessing(messages.some((message) => message.isStreaming));
    },
    onUserMessage: (text, _messageId, _scoopJid, attachments) =>
      getController()?.addUserMessage(text, attachments),
    onStatus: (status, scoopJid) => {
      if (shouldApplyFollowerStatus(scoopJid, selectedScoopJid)) {
        getController()?.setProcessing(status === 'processing');
      }
    },
    setChatAgent: (agent) => getController()?.setAgent(agent),
    browserAPI: browser,
    onForwardingToggle: (enabled) => client.sendSetFollowerForwarding(enabled),
    getSelectedScoopJid: () => selectedScoopJid,
    onConnectionChange: (connected) => {
      deps.refs.switcher.connection = connected ? 'connected' : 'disconnected';
      if (!connected) {
        modelSurface.reset();
      }
    },
    addSprinkle: (name, title, element) => deps.addSprinkle(name, title, element),
    removeSprinkle: (name) => deps.removeSprinkle(name),
    onScoopsList: (scoops, activeScoopJid) => {
      if (!selectedScoopJid || !scoops.some((scoop) => scoop.jid === selectedScoopJid)) {
        selectedScoopJid = activeScoopJid;
      }
      followerScoops = scoops;
      publishFollowerScoops();
      deps.refs.switcher.setAttribute('active', selectedScoopJid);
    },
    // #1915: this float has a mounted permissions surface (it can lead), so
    // it can host a login the leader's kernel cannot prompt for.
    onOAuthPopupRequest: (url, signal) =>
      openDelegatedOAuthPopup(url, signal, {
        getPermissionsSurface: getLeaderPermissionsSurface,
        window: deps.window,
      }),
    onModelsList: modelSurface.onModelsList,
    onModelState: modelSurface.onModelState,
  };
}

/**
 * Mirror the leader's follower-reported sprinkle instances into the worker
 * shim. `sprinkle list` runs in the kernel worker and reads them from there,
 * so every event that can change the set — a report arriving, a follower
 * disconnecting — has to refresh it (issue #2166).
 */
function mirrorSprinkleInstances(state: TrayRoleState): void {
  writeSprinkleInstancesToShim(state.leader ? state.leader.sync.getSprinkleInstances() : []);
}

/**
 * Publish the leader's follower roster to every surface that shows it: the
 * tab-persistence guard, the floatbar (label + followers segment + HUD rows),
 * the kernel-worker `localStorage` shims `host`/`ssh` and `sprinkle list` read,
 * and the window event an open sync dialog listens on.
 */
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
  // The count used to be smuggled into the label string; it now has its own
  // hoverable/clickable segment — the label names the float kind only
  // (see installFloatbarStatus in wc-floatbar-online.ts).
  (deps.refs.floatbar as SliccFloatbar).followers = toFollowerHudRows(
    followers.filter((follower) => follower.peerState !== 'connecting')
  );
  writeConnectedFollowersToShim(followers);
  // A follower that disconnects takes its sprinkle documents with it and sends
  // no farewell report, so the instance shim refreshes on the same signal.
  mirrorSprinkleInstances(state);
  // Let an open sync dialog re-render (its Status tab appears on the first
  // follower and its rows go live) without polling the roster. Dispatched on
  // the INJECTED window (`deps.window`), the same one the rest of this module
  // uses — never the global, which a detached/worker-side caller may not have.
  deps.window.dispatchEvent(new CustomEvent(FOLLOWERS_CHANGED_EVENT, { detail: { followers } }));
}

/**
 * The leader's per-cone model surface for followers (#2310): what a follower
 * is told about the unit it is viewing, and what a pick from it changes —
 * exactly that cone's record, never the leader's own selection.
 */
function leaderModelCallbacks(
  deps: WcTrayDeps
): Pick<StartPageLeaderTrayOptions, 'getModelSelectionState' | 'onFollowerModelSelect'> {
  const { client, refs } = deps;
  return {
    getModelSelectionState: (scoopJid): TrayModelSelectionState => {
      const catalog = modelCatalogForTray();
      const unit = client.getScoop(scoopJid);
      // The model of the cone the follower is looking at (a scoop shows its
      // owning cone's), plus that unit's own thinking level.
      const root = rootForSelection(client.getScoops(), unit ?? null);
      const thinking = unit ? thinkingFor(unit) : {};
      return {
        activeModelId: qualifiedModelIdForUnit(catalog, root),
        scoopJid,
        thinkingLevel: thinking.level === 'max' ? 'xhigh' : thinking.level,
        effortOverride:
          thinking.level === 'max' ? (thinking.effortOverride ?? 'max') : thinking.effortOverride,
      };
    },
    onFollowerModelSelect: (modelId, scoopJid) => {
      const entry = modelCatalogForTray().find((model) => model.modelId === modelId);
      if (!entry) return false;
      // A follower changes the model of the cone IT is looking at — never the
      // leader's selected cone and never a global setting.
      const named = scoopJid ? client.getScoop(scoopJid) : undefined;
      const target = rootForSelection(client.getScoops(), named ?? null);
      if (!target) return false;
      const picked = parseQualifiedModelId(entry.modelId);
      if (!picked) return false;
      // Resolve only once the kernel has persisted it: the leader broadcasts
      // the follower's new `model.state` off this promise, and broadcasting
      // early would recompute it from the record's old value.
      return client
        .setScoopModel(target.jid, picked)
        .then((applied) => {
          // Reflect the pick locally only while the follower is on the cone
          // the leader has selected; otherwise the leader's pill would show
          // another cone's model.
          if (applied && target.jid === deps.getSelectedJid()) {
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

/** Leader option factory — the WC equivalent of `buildLeaderTrayOptions`. */
/**
 * Deliver one follower's prompt into the leader's kernel (#2382).
 *
 * The unit is the SENDER's, not this leader's: `options.targetScoopJid` is the
 * peer's own `scoops.select`, which the leader already records and already
 * mirrors a transcript for. Delivering through the composer's agent handle
 * instead would target `client.selectedScoopJid`, so a follower reading cone B
 * typed into whichever cone this leader happened to be displaying.
 */
function deliverFollowerMessage(
  deps: WcTrayDeps,
  state: TrayRoleState,
  text: string,
  messageId: string,
  attachments: Parameters<StartPageLeaderTrayOptions['onFollowerMessage']>[2],
  options: Parameters<StartPageLeaderTrayOptions['onFollowerMessage']>[3]
): void {
  const { client } = deps;
  // A guest's words are not the owner's. `source` carries the provenance into
  // the transcript record, and the model-visible text is fenced with the seat
  // label so the cone cannot read a guest instruction as an owner instruction.
  // The fence is provenance, NOT a security control — a guest can write
  // anything inside its own message, including a convincing forgery of this
  // frame. The real control is the message-review gate.
  const seat = options?.biscotto;
  const source = seat ? `biscotto:${seat.id}` : undefined;
  const forAgent = seat ? attributeGuestMessage(text, seat.label) : text;
  // A peer that never selected anything falls back to the leader's selection,
  // which is what every peer did before this.
  const target = options?.targetScoopJid ?? client.selectedScoopJid;
  // The leader's thread shows the unit it is DISPLAYING. A prompt for another
  // unit must not appear on it — that unit's own replay carries the message
  // when the user switches to it.
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
        // Approving the MESSAGE is not approving the actions it provokes, so a
        // guest-caused turn carries its own tool gate. Resolved by the review
        // gate, which knows the seat record and the shared unit; the kernel
        // never sees the `off` case.
        ...(options?.guestGate ? { guestGate: options.guestGate } : {}),
      })
      .catch((err) =>
        deps.log.warn('follower message delivery failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      );
  } else {
    // Nothing selected on either side — report it the way a local send with no
    // selection is reported, rather than dropping it silently.
    deps.agentHandle.sendMessage(forAgent, messageId, attachments, options);
  }
  state.leader?.sync.broadcastUserMessage(forAgent, messageId, attachments);
  // The message bumped the sender's lastActivity — mirror it into the
  // worker-realm shim so kernel-side follower selection sees fresh recency (the
  // shim otherwise only refreshes on follower-count changes).
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
    getScoops: () => toScoopSummaries(client.getScoops(), refs.switcher.scoops),
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
    onSprinkleLick: (name, body, targetScoop, originLabel) =>
      client.sendSprinkleLick(name, body, targetScoop, originLabel),
    onSprinkleInstancesChanged: () => mirrorSprinkleInstances(state),
    onFollowerMessage: (text, messageId, attachments, options) =>
      deliverFollowerMessage(deps, state, text, messageId, attachments, options),
    // Same routing as the message above: a follower's stop names the unit that
    // follower is looking at, not the one this leader is displaying.
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
      // Route the follower's freezer new-chat to wc-live's `runNewSession`
      // via a window event; that path owns the archive + `clearAllMessages`,
      // and dispatches the broadcast-snapshot event back through here so every
      // follower drops the stale chat. (See `leader-session-events.ts`.)
      deps.window.dispatchEvent(
        new CustomEvent<LeaderRunNewSessionDetail>(LEADER_RUN_NEW_SESSION_EVENT, {
          detail: { action },
        })
      );
    },
    onFollowerCountChanged: refreshFollowerPresentation,
    // Advertised targets decide teleport eligibility, and they change without
    // the follower count changing — an iOS follower opening its first tab goes
    // from ineligible to eligible. Re-publish so kernel-side selection stops
    // reading a snapshot that predates the capability.
    onFollowerTargetsChanged: () => {
      if (state.leader) writeConnectedFollowersToShim(getLeaderConnectedFollowers(state.leader));
    },
    onRemoteTransportsCleaned: (runtimeId) => remoteCdpBridge.cleanupRuntime(runtimeId),
    onForwardedLick: (event) => client.sendForwardedLick(event),
    onCherryHostEvent: (runtimeId, name, detail) =>
      client.sendCherryHostEvent(runtimeId, name, detail),
    onPreviewLick: (event) => client.sendPreviewLick(event),
    // Follower-originated gates (transcript export) are sudo actions (#2062):
    // the kernel checks `NOPASSWD Export` grants, routes the prompt to the
    // human — possibly straight back here as a tray delegation — and persists
    // "Always". `followerLabel`/`hostOrigin` are informational.
    // Mapped by a named, tested function on purpose: the inline literal that
    // used to live here silently dropped `approver`, which made the whole
    // approver-tier feature inert in production while unit tests stayed green.
    requestSudoApproval: (request) => client.requestSudoApproval(toKernelSudoRequest(request)),
    createTranscriptExport: async (selector, signal) => {
      const { runTranscriptExportForFollower } = await import('./wc-transcript-export.js');
      return runTranscriptExportForFollower(selector, signal, client);
    },
    sendWebhookEvent: (webhookId, headers, body) =>
      client.sendWebhookEvent(webhookId, headers, body),
    onAgentEvent: (handler) => deps.agentHandle.onEvent(handler),
    // Run a CLI follower's `slicc … exec` in the leader's own shell, streaming
    // output back over the tray. Uses a headless terminal session against the
    // kernel worker (same surface as the panel terminals).
    execInShell: (command, execOpts) => execSessions.run({ command, ...execOpts }),
    closeExecShell: (sessionId) => execSessions.close(sessionId),
    browserAPI: deps.browser,
    browserTransport: deps.realCdpTransport,
    // Lazy VFS proxy for preview.request and follower-originated fs.request
    // handling — the kernel worker owns the real VFS; we bridge through
    // openFs()/openWriter() on demand. The route-level guard in FsRouter
    // excludes /proc before any operation reaches these handles.
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

/** Leader-only hooks: shell `host` command surfaces + broadcast taps. */
function createLeaderHookSetup(
  deps: WcTrayDeps,
  remoteCdpBridge: RemoteCdpPageBridge
): { wireLeaderHooks(handle: PageLeaderTrayHandle): void; clearLeaderHooks(): void } {
  return {
    wireLeaderHooks: (handle) => {
      // The page-realm sudo service asks the leader whether a follower's
      // human should answer a prompt instead of the local dialog (#2062).
      void import('../../sudo/page-approval-service.js').then(({ setSudoTrayDelegate }) =>
        setSudoTrayDelegate({
          shouldDelegate: () => handle.sync.shouldDelegateSudo(),
          requestApproval: (req) => handle.sync.delegateSudoApproval(req),
        })
      );
      // Wake suspended phones when a turn lands (metadata only; no-op until an
      // iOS follower registered a push token this session).
      const offTurnEnd = deps.agentHandle.onEvent((event) => {
        if (event.type === 'turn_end') {
          const jid = deps.getSelectedJid();
          handle.sync.notifyTurnEnd(jid === 'cone' ? 'SLICC' : jid);
        }
      });
      leaderTurnEndUnsubscribe = offTurnEnd;
      setConnectedFollowersGetter(() => getLeaderConnectedFollowers(handle));
      setTrayResetter(() => handle.reset());
      // Page-realm teleport selection: the kernel-worker realm covers itself
      // via the `slicc.leaderTrayFollowers` shim (`teleport-follower-shim.ts`).
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
      // Mirror the leader's turn lifecycle to followers. The live float
      // emits no `turn_end` agent event, so the follower's `onStatus`
      // mapping (→ `setProcessing`) is the only signal that clears its send
      // spinner and re-arms the queued-card flush after a send.
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
          // Seed the sync layer with the CURRENT theme: the listener only
          // fires on the next change, but a follower joining a leader that
          // booted themed must receive the palette at bootstrap.
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

/** The `/api/cloud-status` POST after a hosted leader connects. */
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

/** Boot-time role selection — mirrors the legacy tray-init order. */
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
    // Hosted-leader is cloud-only (one tab per sandbox) — skip election.
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
    state.follower = startPageFollowerTray(
      buildFollowerOptions(deps, storedJoinUrl, () => state.follower?.currentSync ?? null)
    );
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

/**
 * Acquire the same-origin leader lock and start the leader tray.
 * If another tab already holds the lock, defers and auto-starts on
 * late promotion — when the other tab releases.
 *
 * The `shouldLead` intent guard is re-checked at grant time (initial
 * AND promotion): the tab must still be role-less and the stored
 * worker URL must still be the one this election was started for.
 * The storage check covers "user left the tray / switched workers
 * while we were deferred" — without it, a late promotion would start
 * a leader on a tray the user explicitly left.
 */
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
      state.follower = startPageFollowerTray(
        buildFollowerOptions(deps, joinUrl, () => state.follower?.currentSync ?? null)
      );
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
  // Idempotent; also called by wireWcSprinkles. Duplicated here because in
  // follower mode openVfs() may never resolve (no local kernel), so
  // wireWcSprinkles never runs — without this the follower renders sprinkles
  // without sprinkle-components.css.
  const { loadSprinkleStyles } = await import('../legacy-styles.js');
  await loadSprinkleStyles();

  const { client, instanceId, window: win, log } = deps;
  const state: TrayRoleState = {
    leader: null,
    follower: null,
    persistenceGuard: new TabPersistenceGuard(),
    lockRelease: null,
  };
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

  // Worker-forwarded licks (follower mode routes `navigate` to the leader).
  client.setForwardLickHandler((event: LickEvent) => {
    const sync = state.follower?.currentSync;
    if (sync) sync.forwardLick(event);
    else log.warn('forward-lick dropped: no active follower sync');
  });

  const leaderOptions = createLeaderOptionsFactory(deps, state, remoteCdpBridge);
  const { wireLeaderHooks, clearLeaderHooks } = createLeaderHookSetup(deps, remoteCdpBridge);

  // Leader-side broadcast tap for the new-session clear. wc-live dispatches
  // this after `clearAllMessages` so already-connected followers receive the
  // cleared snapshot instead of keeping stale chat. The listener is a no-op
  // when this tab is a follower (no `state.leader`).
  win.addEventListener(LEADER_BROADCAST_SNAPSHOT_EVENT, () => {
    state.leader?.sync.broadcastSnapshot();
  });

  const performTrayLeaveLocally = async (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }): Promise<TrayLeaveResult> => {
    const { performTrayLeave } = await import('../tray-leave-runtime.js');
    // Release the leader lock whenever this call ends without a running
    // leader: leave-entirely (workerBaseUrl null) and any failed restart.
    // A dormant tab holding the lock would block the other tab's election
    // forever. A successful switch keeps the lock — the startLeader dep
    // below already released the old one and re-acquired for the new URL.
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
          state.follower = h as PageFollowerTrayHandle | null;
        },
        startLeader: (workerBaseUrl) => {
          // Release the old lock before acquiring for the new worker.
          state.lockRelease?.();
          state.lockRelease = null;
          // Acquire the lock asynchronously — the startLeader
          // contract is synchronous so we fire-and-forget. The leader
          // starts immediately regardless (user-initiated switch; the
          // DO arbitrates the brief cross-tab race). On `deferred` we
          // deliberately do NOT wait for promotion — the lazy
          // `waitForPromotion` is simply never invoked, so no phantom
          // lock request is left behind. The grant is re-checked
          // against the live state: if the restart already failed or
          // was superseded by the time the lock arrives, release it
          // instead of pinning a lock without a leader.
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
    scheduleScoopsListBroadcast: () => state.leader?.scheduleScoopsListBroadcast(),
    performTrayLeaveLocally,
  };
}
