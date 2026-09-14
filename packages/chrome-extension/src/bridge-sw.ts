import {
  type CDPPayload,
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  type ExtensionBridgeCdpRequest,
  type ExtensionBridgeDiscovery,
  type ExtensionBridgeEnvelope,
  type ExtensionBridgeLick,
  type ExtensionBridgeOpenSettings,
  isBridgeVersionMismatch,
  isExtensionBridgeEnvelope,
  SLICC_HOSTED_ORIGIN,
  type TargetInfo,
} from '@slicc/shared-ts';

interface BridgeTargetAttachResult extends CDPPayload {
  sessionId: string;
}

type BridgeTargetDetachResult = CDPPayload;

interface BridgeTargetCreateResult extends CDPPayload {
  targetId: string;
}

interface BridgeTargetCloseResult extends CDPPayload {
  success: true;
}

interface BridgeTargetGetTargetsResult extends CDPPayload {
  targetInfos: TargetInfo[];
}

function readTargetIdParam(params: CDPPayload, label = 'targetId'): string {
  const targetId = params[label];
  if (typeof targetId !== 'string') {
    throw new Error(`Invalid targetId: ${String(targetId)}`);
  }
  return targetId;
}

function readCreateTargetUrl(params: CDPPayload): string {
  const url = params['url'];
  return typeof url === 'string' ? url : 'about:blank';
}

const LEADER_TAB_ID_KEY = 'slicc_leader_tab_id';

export const BRIDGE_ALLOWED_ORIGINS: readonly string[] = [SLICC_HOSTED_ORIGIN];

export const BRIDGE_DEV_ORIGINS: readonly string[] = [
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

export interface BridgeSwDeps {
  readStoredLeaderTabId: () => Promise<number | undefined>;

  writeStoredLeaderTabId?: (tabId: number) => Promise<void>;

  maybeUnmaskCdpFrame: (
    tabId: number,
    method: string,
    params: CDPPayload | undefined
  ) => Promise<CDPPayload | undefined>;

  attachDebugger: (tabId: number) => Promise<boolean>;

  detachDebugger: (tabId: number) => Promise<void>;

  sendDebuggerCommand: (tabId: number, method: string, params?: CDPPayload) => Promise<CDPPayload>;

  subscribeDebuggerEvents: (
    handler: (tabId: number, method: string, params?: CDPPayload) => void
  ) => () => void;

  queryTabs: () => Promise<ChromeTab[]>;

  queryActiveTabId: () => Promise<number | undefined>;

  getTab: (tabId: number) => Promise<ChromeTab | undefined>;

  createTab: (url: string) => Promise<number>;

  removeTab: (tabId: number) => Promise<void>;

  activateTab: (tabId: number) => Promise<void>;

  allowedOrigins?: readonly string[];

  onLeaderJoinUrl?: (joinUrl: string | null) => void;
}

export interface PinResult {
  ok: boolean;

  reason?: string;
}

function senderUrlIsLeaderTab(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl).searchParams.get('slicc') === 'leader';
  } catch {
    return false;
  }
}

export async function validateBridgePin(
  sender: ChromeMessageSender | undefined,
  deps: Pick<BridgeSwDeps, 'readStoredLeaderTabId' | 'writeStoredLeaderTabId' | 'allowedOrigins'>
): Promise<PinResult> {
  const allowed = deps.allowedOrigins ?? BRIDGE_ALLOWED_ORIGINS;
  if (!sender) return { ok: false, reason: 'no-sender' };
  if (!sender.origin || !allowed.includes(sender.origin)) {
    return { ok: false, reason: 'origin-not-allowed' };
  }
  const senderTabId = sender.tab?.id;
  if (typeof senderTabId !== 'number') {
    return { ok: false, reason: 'no-sender-tab' };
  }
  if (sender.frameId !== 0) {
    return { ok: false, reason: 'not-top-frame' };
  }
  const storedTabId = await deps.readStoredLeaderTabId();
  if (storedTabId === undefined) {
    if (senderUrlIsLeaderTab(sender.url) && deps.writeStoredLeaderTabId) {
      await deps.writeStoredLeaderTabId(senderTabId);
      return { ok: true };
    }
    return { ok: false, reason: 'leader-tab-not-pinned' };
  }
  if (storedTabId !== senderTabId) {
    return { ok: false, reason: 'sender-tab-not-leader' };
  }
  return { ok: true };
}

interface PortState {
  channelId: string | null;

  sessionToTab: Map<string, number>;

  attachRefCounts: Map<number, number>;

  ownedTabs: Set<number>;

  unsubscribeEvents: (() => void) | null;
}

const welcomedLeaderPorts = new Map<ChromeRuntimePort, string>();

const liveBridgePortStates = new Map<ChromeRuntimePort, PortState>();

function invalidatePortDebuggerAttachment(state: PortState, tabId: number): void {
  state.ownedTabs.delete(tabId);
  state.attachRefCounts.delete(tabId);
  for (const [sessionId, attachedTabId] of state.sessionToTab) {
    if (attachedTabId === tabId) state.sessionToTab.delete(sessionId);
  }
}

export function notifyBridgeDebuggerDetached(tabId: number): void {
  for (const [port, state] of liveBridgePortStates) {
    const detachedSessionIds = [...state.sessionToTab]
      .filter(([, attachedTabId]) => attachedTabId === tabId)
      .map(([sessionId]) => sessionId);
    invalidatePortDebuggerAttachment(state, tabId);
    if (state.channelId === null) continue;
    for (const sessionId of detachedSessionIds) {
      try {
        port.postMessage({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId: state.channelId,
          kind: 'cdp.event',
          method: 'Target.detachedFromTarget',
          params: { sessionId, targetId: String(tabId) },
        } satisfies ExtensionBridgeEnvelope);
      } catch {}
    }
  }
}

export function postLickToWelcomedLeaderPorts(
  lick: Omit<ExtensionBridgeLick, 'bridge' | 'channelId'>
): number {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        ...lick,
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId,
      } satisfies ExtensionBridgeLick);
      delivered += 1;
    } catch {}
  }
  return delivered;
}

export function postOpenSettingsToWelcomedLeaderPorts(): number {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        kind: 'extension.open-settings',
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId,
      } satisfies ExtensionBridgeOpenSettings);
      delivered += 1;
    } catch {}
  }
  return delivered;
}

export function postDiscoveryToWelcomedLeaderPorts(
  discovery: Omit<ExtensionBridgeDiscovery, 'bridge' | 'channelId'>
): number {
  let delivered = 0;
  for (const [port, channelId] of welcomedLeaderPorts) {
    try {
      port.postMessage({
        ...discovery,
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId,
      } satisfies ExtensionBridgeDiscovery);
      delivered += 1;
    } catch {}
  }
  return delivered;
}

export function __clearWelcomedLeaderPortsForTest(): void {
  welcomedLeaderPorts.clear();
  liveBridgePortStates.clear();
}

export async function readStoredLeaderTabIdFromSession(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(LEADER_TAB_ID_KEY);
    const raw = result[LEADER_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch {
    return undefined;
  }
}

export async function writeStoredLeaderTabIdToSession(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.set({ [LEADER_TAB_ID_KEY]: tabId });
  } catch {}
}

export function buildDefaultBridgeSwDeps(overrides?: Partial<BridgeSwDeps>): BridgeSwDeps {
  const base: BridgeSwDeps = {
    readStoredLeaderTabId: readStoredLeaderTabIdFromSession,
    writeStoredLeaderTabId: writeStoredLeaderTabIdToSession,
    maybeUnmaskCdpFrame: async (_tabId, _method, params) => params,
    attachDebugger: async (tabId) => {
      await chrome.debugger.attach({ tabId }, '1.3');
      return true;
    },
    detachDebugger: async (tabId) => {
      await chrome.debugger.detach({ tabId }).catch(() => {});
    },
    sendDebuggerCommand: async (tabId, method, params) => {
      const result = await chrome.debugger.sendCommand({ tabId }, method, params);
      return result ?? {};
    },
    subscribeDebuggerEvents: (handler) => {
      const wrapped = (source: { tabId: number }, method: string, params?: CDPPayload): void =>
        handler(source.tabId, method, params);
      chrome.debugger.onEvent.addListener(wrapped);
      return () => chrome.debugger.onEvent.removeListener(wrapped);
    },
    queryTabs: () => chrome.tabs.query({}),
    queryActiveTabId: async () => {
      try {
        const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return typeof t?.id === 'number' ? t.id : undefined;
      } catch {
        return undefined;
      }
    },
    getTab: async (tabId) => {
      try {
        return await chrome.tabs.get(tabId);
      } catch {
        return undefined;
      }
    },
    createTab: async (url) => {
      const tab = await chrome.tabs.create({ url, active: false });
      return tab.id;
    },
    removeTab: (tabId) => chrome.tabs.remove(tabId),
    activateTab: async (tabId) => {
      try {
        const tab = await chrome.tabs.update(tabId, { active: true });
        if (typeof tab?.windowId === 'number') {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch {}
    },
  };
  return { ...base, ...(overrides ?? {}) };
}

export async function handleBridgePortConnect(
  port: ChromeRuntimePort,
  deps: BridgeSwDeps
): Promise<void> {
  if (port.name !== EXTENSION_BRIDGE_PORT_NAME) return;

  const state: PortState = {
    channelId: null,
    sessionToTab: new Map(),
    attachRefCounts: new Map(),
    ownedTabs: new Set(),
    unsubscribeEvents: null,
  };

  let pinned = false;
  let rejected = false;
  const earlyQueue: unknown[] = [];

  const runMessage = (raw: unknown): void => {
    handleBridgeMessage(port, state, raw, deps).catch((err) => {
      console.error('[slicc-bridge-sw] handleBridgeMessage threw', err);
    });
  };

  port.onMessage.addListener((raw: unknown) => {
    if (rejected) return;
    if (!pinned) {
      earlyQueue.push(raw);
      return;
    }
    runMessage(raw);
  });

  port.onDisconnect.addListener(() => {
    welcomedLeaderPorts.delete(port);
    liveBridgePortStates.delete(port);
    if (state.unsubscribeEvents) {
      state.unsubscribeEvents();
      state.unsubscribeEvents = null;
    }

    for (const tabId of state.ownedTabs) {
      deps.detachDebugger(tabId).catch(() => {});
    }
    state.ownedTabs.clear();
    state.sessionToTab.clear();
    state.attachRefCounts.clear();
  });

  const pin = await validateBridgePin(port.sender, deps);
  if (!pin.ok) {
    rejected = true;

    try {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: 'rejected',
        kind: 'handshake.rejected',
        reason: pin.reason ?? 'pin-failed',
      } satisfies ExtensionBridgeEnvelope);
    } catch {}
    try {
      port.disconnect();
    } catch {}
    return;
  }

  pinned = true;

  for (const raw of earlyQueue) runMessage(raw);
  earlyQueue.length = 0;
}

async function handleBridgeMessage(
  port: ChromeRuntimePort,
  state: PortState,
  raw: unknown,
  deps: BridgeSwDeps
): Promise<void> {
  if (isBridgeVersionMismatch(raw)) {
    console.warn('[slicc-bridge-sw] bridge protocol version mismatch — update the older side', {
      peerVersion: raw.bridge,
      ourVersion: EXTENSION_BRIDGE_PROTOCOL_VERSION,
    });

    try {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: raw.channelId,
        kind: 'handshake.rejected',
        reason: 'version-mismatch',
      } satisfies ExtensionBridgeEnvelope);
      port.disconnect();
    } catch {}
    return;
  }
  if (!isExtensionBridgeEnvelope(raw)) return;
  const env = raw as ExtensionBridgeEnvelope;

  if (state.channelId === null) {
    if (env.kind !== 'handshake.hello') {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: env.channelId,
        kind: 'handshake.rejected',
        reason: 'expected-hello-first',
      } satisfies ExtensionBridgeEnvelope);
      try {
        port.disconnect();
      } catch {}
      return;
    }
    state.channelId = env.channelId;
    liveBridgePortStates.set(port, state);

    state.unsubscribeEvents = deps.subscribeDebuggerEvents((tabId, method, params) => {
      let sessionId: string | undefined;
      for (const [sid, tid] of state.sessionToTab) {
        if (tid === tabId) {
          sessionId = sid;
          break;
        }
      }
      if (sessionId === undefined) return;
      const channelId = state.channelId;
      if (channelId === null) return;
      try {
        port.postMessage({
          bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
          channelId,
          kind: 'cdp.event',
          method,
          params,
          sessionId,
        } satisfies ExtensionBridgeEnvelope);
      } catch {}
    });
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state.channelId,
      kind: 'handshake.welcome',
    } satisfies ExtensionBridgeEnvelope);

    welcomedLeaderPorts.set(port, state.channelId);
    return;
  }

  if (env.kind === 'leader.join-url') {
    if (env.channelId !== state.channelId) return;
    deps.onLeaderJoinUrl?.(env.joinUrl);
    return;
  }

  if (env.kind !== 'cdp.request') return;
  if (env.channelId !== state.channelId) return;

  const id = env.id;
  try {
    const result = await dispatchCdpCommand(env, state, deps);
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state.channelId,
      kind: 'cdp.response',
      id,
      result,
    } satisfies ExtensionBridgeEnvelope);
  } catch (err) {
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state.channelId,
      kind: 'cdp.response',
      id,
      error: err instanceof Error ? err.message : String(err),
    } satisfies ExtensionBridgeEnvelope);
  }
}

async function dispatchCdpCommand(
  req: Pick<ExtensionBridgeCdpRequest, 'method' | 'params' | 'sessionId'>,
  state: PortState,
  deps: BridgeSwDeps
): Promise<CDPPayload> {
  const { method, params, sessionId } = req;

  if (method === 'Target.getTargets') return cdpGetTargets(state, deps);
  if (method === 'Target.attachToTarget') return cdpAttachToTarget(params ?? {}, state, deps);
  if (method === 'Target.detachFromTarget') return cdpDetachFromTarget(params ?? {}, state, deps);
  if (method === 'Target.createTarget') return cdpCreateTarget(params ?? {}, deps);
  if (method === 'Target.closeTarget') return cdpCloseTarget(params ?? {}, state, deps);

  const tabId = sessionId !== undefined ? state.sessionToTab.get(sessionId) : undefined;
  if (tabId === undefined) {
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? '(none)'}. Attach to a target first.`
    );
  }

  if (method === 'Page.bringToFront') {
    await deps.activateTab(tabId);
  }
  const effectiveParams = await deps.maybeUnmaskCdpFrame(tabId, method, params);
  return deps.sendDebuggerCommand(tabId, method, effectiveParams);
}

async function cdpGetTargets(
  _state: PortState,
  deps: BridgeSwDeps
): Promise<BridgeTargetGetTargetsResult> {
  const [tabs, activeId] = await Promise.all([deps.queryTabs(), deps.queryActiveTabId()]);
  const targetInfos = tabs
    .filter((t): t is ChromeTab & { id: number } => typeof t.id === 'number')
    .map((t) => ({
      targetId: String(t.id),
      type: 'page',
      title: t.title ?? '',
      url: t.url ?? '',
      attached: false,
      active: t.id === activeId,
    }));
  return { targetInfos };
}

async function cdpAttachToTarget(
  params: CDPPayload,
  state: PortState,
  deps: BridgeSwDeps
): Promise<BridgeTargetAttachResult> {
  const targetId = readTargetIdParam(params);
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  if (!state.ownedTabs.has(tabId)) {
    const attachedByThisPort = await deps.attachDebugger(tabId);
    if (attachedByThisPort) state.ownedTabs.add(tabId);
  }

  const sessionId = targetId;
  state.sessionToTab.set(sessionId, tabId);
  state.attachRefCounts.set(tabId, (state.attachRefCounts.get(tabId) ?? 0) + 1);
  return { sessionId };
}

async function cdpDetachFromTarget(
  params: CDPPayload,
  state: PortState,
  deps: BridgeSwDeps
): Promise<BridgeTargetDetachResult> {
  const sessionId = params['sessionId'];
  if (typeof sessionId !== 'string') return {};
  const tabId = state.sessionToTab.get(sessionId);
  if (tabId === undefined) return {};

  const nextRefCount = (state.attachRefCounts.get(tabId) ?? 1) - 1;
  if (nextRefCount > 0) {
    state.attachRefCounts.set(tabId, nextRefCount);
    return {};
  }

  state.attachRefCounts.delete(tabId);
  for (const [sid, attachedTabId] of state.sessionToTab) {
    if (attachedTabId === tabId) state.sessionToTab.delete(sid);
  }
  if (state.ownedTabs.has(tabId)) {
    state.ownedTabs.delete(tabId);
    await deps.detachDebugger(tabId);
  }
  return {};
}

async function cdpCreateTarget(
  params: CDPPayload,
  deps: BridgeSwDeps
): Promise<BridgeTargetCreateResult> {
  const url = readCreateTargetUrl(params);
  const tabId = await deps.createTab(url);
  return { targetId: String(tabId) };
}

async function cdpCloseTarget(
  params: CDPPayload,
  state: PortState,
  deps: BridgeSwDeps
): Promise<BridgeTargetCloseResult> {
  const targetId = readTargetIdParam(params);
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  for (const [sid, tid] of state.sessionToTab) {
    if (tid === tabId) state.sessionToTab.delete(sid);
  }
  state.attachRefCounts.delete(tabId);
  if (state.ownedTabs.has(tabId)) {
    state.ownedTabs.delete(tabId);
    await deps.detachDebugger(tabId);
  }
  await deps.removeTab(tabId);
  return { success: true };
}
