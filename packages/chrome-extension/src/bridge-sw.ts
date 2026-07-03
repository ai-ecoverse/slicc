/**
 * Service-worker side of the Wave-3b CDP bridge.
 *
 * The sliccy.ai leader tab opens a long-lived Port to the extension via
 * `chrome.runtime.connect(EXT_ID, { name: EXTENSION_BRIDGE_PORT_NAME })`;
 * this module handles it from `chrome.runtime.onConnectExternal`:
 *
 *   1. Three-factor pin (Wave-1 Spike B): origin allowlist + `sender.tab.id
 *      === storedLeaderTabId` (read from `chrome.storage.session` under
 *      `slicc_leader_tab_id`, owned by the sibling leader-tab task) +
 *      `sender.frameId === 0` (top-level only). Pin failures fail closed —
 *      the SW posts `handshake.rejected` and disconnects.
 *   2. After `handshake.welcome`, the port is FULL CDP pass-through:
 *      `Target.*` calls map to chrome.tabs operations; everything else maps
 *      to `chrome.debugger.sendCommand`. `chrome.debugger` events are
 *      forwarded as `cdp.event` envelopes.
 *   3. Outbound CDP commands are routed through `maybeUnmaskCdpFrame` so
 *      whole-token secret fields are unmasked SW-side — raw CDP secrets
 *      MUST NEVER reach the leader tab.
 *
 * This module is intentionally a thin slice of the existing `cdp-command`
 * proxy in `service-worker.ts`: it shares `chrome.debugger`, attached-tab
 * accounting, and the unmask hook, but owns its own per-port session
 * map so multiple leader tabs (extremely rare — pinned + sole-leader by
 * design — but defensively supported) don't trample each other's
 * sessionId -> tab mappings.
 */

import {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  type ExtensionBridgeEnvelope,
  type ExtensionBridgeLick,
  isExtensionBridgeEnvelope,
} from '../../webapp/src/cdp/extension-bridge-protocol.js';

/** Storage key the sibling leader-tab task writes after pinning the leader. */
const LEADER_TAB_ID_KEY = 'slicc_leader_tab_id';

/** Origin allowlist for the bridge Port. Externally_connectable also gates
 *  this at the manifest level, but enforcing in code is defense-in-depth and
 *  makes test injection straightforward. */
export const BRIDGE_ALLOWED_ORIGINS: readonly string[] = ['https://www.sliccy.ai'];

/** Dev-mode origins added when SLICC_EXT_DEV=1 is built. The build pipeline
 *  swaps in the dev allowlist via this module's `setBridgeAllowedOrigins`
 *  hook in `service-worker.ts`. */
export const BRIDGE_DEV_ORIGINS: readonly string[] = [
  'http://localhost:8787',
  'http://127.0.0.1:8787',
];

/** Dependencies the SW supplies. Kept narrow so tests can stub the surface
 *  without monkey-patching chrome.*. */
export interface BridgeSwDeps {
  /** Resolve the storage-pinned leader tab id, or `undefined` if unset. */
  readStoredLeaderTabId: () => Promise<number | undefined>;
  /** Unmask whole-token secret fields in outbound CDP frames against the
   *  target tab's CURRENT hostname. Reuses the existing
   *  `maybeUnmaskCdpFrame` in service-worker.ts. */
  maybeUnmaskCdpFrame: (
    tabId: number,
    method: string,
    params: Record<string, unknown> | undefined
  ) => Promise<Record<string, unknown> | undefined>;
  /** Attach the chrome.debugger to a tab, idempotent. */
  attachDebugger: (tabId: number) => Promise<void>;
  /** Detach the chrome.debugger from a tab if attached. */
  detachDebugger: (tabId: number) => Promise<void>;
  /** chrome.debugger.sendCommand bound to `{ tabId }`. */
  sendDebuggerCommand: (
    tabId: number,
    method: string,
    params?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
  /**
   * Subscribe to `chrome.debugger.onEvent`. Returns the unsubscribe function.
   * Tests pass a noop here; production wires `chrome.debugger.onEvent.addListener`.
   */
  subscribeDebuggerEvents: (
    handler: (tabId: number, method: string, params?: Record<string, unknown>) => void
  ) => () => void;
  /** chrome.tabs.query() — minimal subset. */
  queryTabs: () => Promise<ChromeTab[]>;
  /** Query the active tab in the last focused window. */
  queryActiveTabId: () => Promise<number | undefined>;
  /** chrome.tabs.get(). */
  getTab: (tabId: number) => Promise<ChromeTab | undefined>;
  /** chrome.tabs.create — used by Target.createTarget. */
  createTab: (url: string) => Promise<number>;
  /** chrome.tabs.remove — used by Target.closeTarget. */
  removeTab: (tabId: number) => Promise<void>;
  /** Origin allowlist used for the pin. Override for dev / tests. */
  allowedOrigins?: readonly string[];
  /**
   * Callback when the leader tab sends its tray joinUrl (or null on tray drop).
   * The SW caches this and broadcasts it to the on-demand cherry side panel.
   */
  onLeaderJoinUrl?: (joinUrl: string | null) => void;
}

/** Result of validating an incoming `onConnectExternal` Port. */
export interface PinResult {
  ok: boolean;
  /** Reason exposed to the leader tab in `handshake.rejected`. Generic
   *  string — no internal details that would help an attacker fingerprint
   *  the gate. */
  reason?: string;
}

/**
 * Three-factor pin check. Pure function (modulo the async storage read in
 * `deps.readStoredLeaderTabId`) so unit tests can drive it directly.
 *
 *   1. origin ∈ allowlist
 *   2. sender.tab.id === storedLeaderTabId  (key absent → fail closed)
 *   3. sender.frameId === 0
 */
export async function validateBridgePin(
  sender: ChromeMessageSender | undefined,
  deps: Pick<BridgeSwDeps, 'readStoredLeaderTabId' | 'allowedOrigins'>
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
    // The sibling leader-tab task owns the storage key. Absent → fail
    // closed: we don't know which tab is "the leader" yet.
    return { ok: false, reason: 'leader-tab-not-pinned' };
  }
  if (storedTabId !== senderTabId) {
    return { ok: false, reason: 'sender-tab-not-leader' };
  }
  return { ok: true };
}

/** Per-port state. One port == one leader tab connection. */
interface PortState {
  channelId: string | null;
  /** Synthetic sessionId → real chrome tab id. */
  sessionToTab: Map<string, number>;
  /** Tabs we attached the debugger to from THIS port. Used so disconnect
   *  detaches only what we attached (other code paths may also attach). */
  ownedTabs: Set<number>;
  /** Unsubscribe from chrome.debugger.onEvent when the port closes. */
  unsubscribeEvents: (() => void) | null;
}

/**
 * Registry of WELCOMED leader Ports keyed by Port → its pinned channelId. A
 * Port is added right after `handshake.welcome` is posted (in
 * {@link handleBridgeMessage}) and removed in the Port's `onDisconnect` (in
 * {@link handleBridgePortConnect}). Used by
 * {@link postLickToWelcomedLeaderPorts} to push SW-observed handoff licks over
 * the live bridge instead of the unreliable `chrome.runtime.sendMessage`
 * broadcast (the leader has no in-page listener for that in thin mode).
 */
const welcomedLeaderPorts = new Map<ChromeRuntimePort, string>();

/**
 * Post an `extension.lick` envelope to every welcomed leader Port, each
 * stamped with that Port's pinned channelId. Best-effort: a post to a dead
 * Port is swallowed (its `onDisconnect` evicts it from the registry). The
 * caller passes the lick fields minus `bridge` / `channelId`, which are
 * stamped here. Returns the number of Ports the envelope was posted to.
 */
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
    } catch {
      /* port disconnected; its onDisconnect will evict it */
    }
  }
  return delivered;
}

/** Test-only: clear the welcomed-port registry between cases. */
export function __clearWelcomedLeaderPortsForTest(): void {
  welcomedLeaderPorts.clear();
}

/**
 * Default `readStoredLeaderTabId` implementation. The sibling leader-tab
 * task writes the key to `chrome.storage.session`; this is the read half.
 */
export async function readStoredLeaderTabIdFromSession(): Promise<number | undefined> {
  try {
    const result = await chrome.storage.session.get(LEADER_TAB_ID_KEY);
    const raw = result[LEADER_TAB_ID_KEY];
    return typeof raw === 'number' ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Default deps wired against the real chrome.* APIs. Provided as a factory
 * so the SW can override `attachDebugger` / `detachDebugger` etc. to share
 * the existing attachedTabs accounting in `service-worker.ts`.
 */
export function buildDefaultBridgeSwDeps(overrides?: Partial<BridgeSwDeps>): BridgeSwDeps {
  const base: BridgeSwDeps = {
    readStoredLeaderTabId: readStoredLeaderTabIdFromSession,
    maybeUnmaskCdpFrame: async (_tabId, _method, params) => params,
    attachDebugger: async (tabId) => {
      await chrome.debugger.attach({ tabId }, '1.3');
    },
    detachDebugger: async (tabId) => {
      await chrome.debugger.detach({ tabId }).catch(() => {
        /* tab may already be closed */
      });
    },
    sendDebuggerCommand: async (tabId, method, params) => {
      const result = await chrome.debugger.sendCommand({ tabId }, method, params);
      return result ?? {};
    },
    subscribeDebuggerEvents: (handler) => {
      const wrapped = (
        source: { tabId: number },
        method: string,
        params?: Record<string, unknown>
      ): void => handler(source.tabId, method, params);
      chrome.debugger.onEvent.addListener(wrapped);
      return () => chrome.debugger.onEvent.removeListener(wrapped);
    },
    queryTabs: () => chrome.tabs.query({}),
    queryActiveTabId: async () => {
      // Never let a transient chrome.tabs.query rejection fail the whole
      // Target.getTargets response — the active marker is cosmetic.
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
  };
  return { ...base, ...(overrides ?? {}) };
}

/**
 * Handle one connecting Port. Returns when the port is wired up; the
 * remainder of the lifetime runs in registered listeners.
 */
export async function handleBridgePortConnect(
  port: ChromeRuntimePort,
  deps: BridgeSwDeps
): Promise<void> {
  if (port.name !== EXTENSION_BRIDGE_PORT_NAME) return;

  const state: PortState = {
    channelId: null,
    sessionToTab: new Map(),
    ownedTabs: new Set(),
    unsubscribeEvents: null,
  };

  // The leader-side ExtensionBridgeTransport posts its `handshake.hello`
  // synchronously after `chrome.runtime.connect`. Chrome drops Port messages
  // that arrive before ANY onMessage listener is attached, so the listener
  // MUST attach synchronously here — before the awaited pin check creates a
  // microtask gap. Messages that land during the pin check are buffered and
  // drained once pinned. See docs/pitfalls.md "Chrome Port: onMessage
  // Listener Must Attach Synchronously".
  let pinned = false;
  let rejected = false;
  const earlyQueue: unknown[] = [];

  const runMessage = (raw: unknown): void => {
    handleBridgeMessage(port, state, raw, deps).catch((err) => {
      // Handler errors are surfaced per-command via cdp.response.error;
      // this catch is the safety net for envelope-routing bugs.
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
    // Evict from the welcomed-port registry so we never post a lick to a dead
    // Port (no-op if the port never reached the welcome step).
    welcomedLeaderPorts.delete(port);
    if (state.unsubscribeEvents) {
      state.unsubscribeEvents();
      state.unsubscribeEvents = null;
    }
    // Detach debugger from tabs we own. Other paths in service-worker.ts
    // own their own attachedTabs set; the SW deps' detachDebugger is wired
    // to coordinate with that set so we never detach a tab still in use
    // by the offscreen CDP proxy.
    for (const tabId of state.ownedTabs) {
      deps.detachDebugger(tabId).catch(() => {});
    }
    state.ownedTabs.clear();
    state.sessionToTab.clear();
  });

  const pin = await validateBridgePin(port.sender, deps);
  if (!pin.ok) {
    rejected = true;
    // Use a fresh channelId placeholder in the reject — the leader hasn't
    // sent its hello yet, so we don't know its channelId. The transport
    // accepts any channelId in handshake.rejected because the leader has
    // not yet pinned to one server-side either.
    try {
      port.postMessage({
        bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
        channelId: 'rejected',
        kind: 'handshake.rejected',
        reason: pin.reason ?? 'pin-failed',
      } satisfies ExtensionBridgeEnvelope);
    } catch {
      /* port may already be gone */
    }
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    return;
  }

  pinned = true;
  // Drain any messages that arrived during the pin check, in order.
  for (const raw of earlyQueue) runMessage(raw);
  earlyQueue.length = 0;
}

async function handleBridgeMessage(
  port: ChromeRuntimePort,
  state: PortState,
  raw: unknown,
  deps: BridgeSwDeps
): Promise<void> {
  if (!isExtensionBridgeEnvelope(raw)) return;
  const env = raw as ExtensionBridgeEnvelope;

  // First message MUST be handshake.hello; it pins the channelId for the
  // rest of the port's life.
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
      } catch {
        /* gone */
      }
      return;
    }
    state.channelId = env.channelId;
    // Start forwarding chrome.debugger events. Filter by tab id against
    // the per-port sessionToTab so we don't leak events from tabs another
    // port (or the offscreen path) is attached to.
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
      } catch {
        /* port disconnected, onDisconnect will tear down */
      }
    });
    port.postMessage({
      bridge: EXTENSION_BRIDGE_PROTOCOL_VERSION,
      channelId: state.channelId,
      kind: 'handshake.welcome',
    } satisfies ExtensionBridgeEnvelope);
    // The Port is now welcomed — register it so SW-observed handoff licks can
    // be pushed over the live bridge (see postLickToWelcomedLeaderPorts).
    welcomedLeaderPorts.set(port, state.channelId);
    return;
  }

  // leader.join-url is accepted post-handshake so the leader can push the tray
  // joinUrl to the SW for caching and broadcast to the on-demand cherry side panel.
  if (env.kind === 'leader.join-url') {
    if (env.channelId !== state.channelId) return;
    deps.onLeaderJoinUrl?.(env.joinUrl);
    return;
  }

  // After handshake the only kind we accept is cdp.request or leader.join-url.
  // Channel id mismatch → drop (defense against a buggy peer; the Port itself
  // is already pinned by onConnectExternal).
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
  req: { method: string; params?: Record<string, unknown>; sessionId?: string },
  state: PortState,
  deps: BridgeSwDeps
): Promise<Record<string, unknown>> {
  const { method, params, sessionId } = req;

  // Per-port `Target.*` shims map to chrome.tabs operations, so the leader
  // sees a real CDP-like target surface without us hard-coding tab ids.
  if (method === 'Target.getTargets') return cdpGetTargets(state, deps);
  if (method === 'Target.attachToTarget') return cdpAttachToTarget(params ?? {}, state, deps);
  if (method === 'Target.detachFromTarget') return cdpDetachFromTarget(params ?? {}, state, deps);
  if (method === 'Target.createTarget') return cdpCreateTarget(params ?? {}, deps);
  if (method === 'Target.closeTarget') return cdpCloseTarget(params ?? {}, state, deps);

  // Generic pass-through. sessionId MUST resolve to a tab we attached on
  // behalf of THIS port; cross-port sessionId reuse is a bug.
  const tabId = sessionId !== undefined ? state.sessionToTab.get(sessionId) : undefined;
  if (tabId === undefined) {
    throw new Error(
      `No tab attached for sessionId: ${sessionId ?? '(none)'}. Attach to a target first.`
    );
  }
  const effectiveParams = await deps.maybeUnmaskCdpFrame(tabId, method, params);
  return deps.sendDebuggerCommand(tabId, method, effectiveParams);
}

async function cdpGetTargets(
  _state: PortState,
  deps: BridgeSwDeps
): Promise<Record<string, unknown>> {
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
  params: Record<string, unknown>,
  state: PortState,
  deps: BridgeSwDeps
): Promise<Record<string, unknown>> {
  const targetId = params['targetId'] as string;
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  if (!state.ownedTabs.has(tabId)) {
    await deps.attachDebugger(tabId);
    state.ownedTabs.add(tabId);
  }
  // sessionId === targetId so the leader can correlate without an extra
  // round-trip (matches the existing offscreen CDP proxy's convention).
  const sessionId = targetId;
  state.sessionToTab.set(sessionId, tabId);
  return { sessionId };
}

async function cdpDetachFromTarget(
  params: Record<string, unknown>,
  state: PortState,
  deps: BridgeSwDeps
): Promise<Record<string, unknown>> {
  const sessionId = params['sessionId'] as string;
  const tabId = state.sessionToTab.get(sessionId);
  if (tabId === undefined) return {};
  state.sessionToTab.delete(sessionId);
  const stillReferenced = [...state.sessionToTab.values()].includes(tabId);
  if (!stillReferenced && state.ownedTabs.has(tabId)) {
    state.ownedTabs.delete(tabId);
    await deps.detachDebugger(tabId);
  }
  return {};
}

async function cdpCreateTarget(
  params: Record<string, unknown>,
  deps: BridgeSwDeps
): Promise<Record<string, unknown>> {
  const url = (params['url'] as string) ?? 'about:blank';
  const tabId = await deps.createTab(url);
  return { targetId: String(tabId) };
}

async function cdpCloseTarget(
  params: Record<string, unknown>,
  state: PortState,
  deps: BridgeSwDeps
): Promise<Record<string, unknown>> {
  const targetId = params['targetId'] as string;
  const tabId = parseInt(targetId, 10);
  if (!Number.isFinite(tabId) || tabId <= 0) {
    throw new Error(`Invalid targetId: ${targetId}`);
  }
  for (const [sid, tid] of state.sessionToTab) {
    if (tid === tabId) state.sessionToTab.delete(sid);
  }
  if (state.ownedTabs.has(tabId)) {
    state.ownedTabs.delete(tabId);
    await deps.detachDebugger(tabId);
  }
  await deps.removeTab(tabId);
  return { success: true };
}
