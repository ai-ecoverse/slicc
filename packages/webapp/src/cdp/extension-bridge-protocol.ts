/**
 * Extension bridge protocol: envelope contract spoken between the sliccy.ai
 * leader tab and the extension service worker over the long-lived
 * `chrome.runtime.connect` Port.
 *
 * Wave 3b — full CDP pass-through. The leader tab opens a Port to the
 * extension via `chrome.runtime.connect(EXT_ID, { name: PORT_NAME })`; the SW
 * gates the connection in `onConnectExternal` with the three-factor pin
 * (origin allowlist + `sender.tab.id === storedLeaderTabId` + `sender.frameId
 * === 0`) decided in Wave-1 Spike B. The envelope shapes below are the
 * post-handshake wire format both sides exchange.
 *
 * The envelopes deliberately mirror the Cherry handshake/CDP-request shape
 * (`packages/webapp/src/cdp/cherry-host-protocol.ts`) so the two transports
 * stay structurally aligned; they are NOT interchangeable (Cherry is a
 * synthetic CDP subset over postMessage; this one is full chrome.debugger
 * pass-through over chrome.runtime.Port).
 */

/** Protocol version bumped on any breaking envelope change. */
export const EXTENSION_BRIDGE_PROTOCOL_VERSION = 1;

/** Port name the leader passes to `chrome.runtime.connect`. */
export const EXTENSION_BRIDGE_PORT_NAME = 'slicc.cdp-bridge';

export interface ExtensionBridgeHello {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'handshake.hello';
}

export interface ExtensionBridgeWelcome {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'handshake.welcome';
}

/**
 * Handshake rejection. The SW posts this when the three-factor pin fails
 * (e.g. `slicc_leader_tab_id` absent, sender tab mismatch, non-top-level
 * frame). Pin failures fail closed: the SW disconnects right after.
 */
export interface ExtensionBridgeRejected {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'handshake.rejected';
  reason: string;
}

export interface ExtensionBridgeCdpRequest {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.request';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface ExtensionBridgeCdpResponse {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.response';
  id: number;
  result?: Record<string, unknown>;
  error?: string;
}

export interface ExtensionBridgeCdpEvent {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.event';
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/**
 * Navigate/upskill lick pushed SW → leader tab. The SW observes a SLICC
 * handoff `Link` header (`chrome.webRequest.onHeadersReceived`) and forwards
 * it over the welcomed Port so the leader can inject it into the worker-side
 * `LickManager`. The payload mirrors `dispatchNavigateEvent`'s fields in
 * `scoops/lick-ws-bridge.ts` (the standalone `/licks-ws` navigate shape).
 */
export interface ExtensionBridgeLick {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'extension.lick';
  verb: 'handoff' | 'upskill';
  target: string;
  url: string;
  instruction?: string;
  branch?: string;
  path?: string;
  title?: string;
}

/**
 * Leader tray joinUrl pushed leader tab → SW. The leader's tray session mints a
 * `/join/<trayId>.<secret>` URL that per-page cherry followers need to connect;
 * the URL is NOT in the page URL itself (only `/tray/<trayId>` with no secret).
 * The leader sends this over the welcomed Port so the SW can cache it and push
 * it to injected per-page cherry relays. `null` when the tray drops (so the SW
 * clears its cache).
 */
export interface ExtensionBridgeLeaderJoinUrl {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'leader.join-url';
  joinUrl: string | null;
}

export type ExtensionBridgeEnvelope =
  | ExtensionBridgeHello
  | ExtensionBridgeWelcome
  | ExtensionBridgeRejected
  | ExtensionBridgeCdpRequest
  | ExtensionBridgeCdpResponse
  | ExtensionBridgeCdpEvent
  | ExtensionBridgeLick
  | ExtensionBridgeLeaderJoinUrl;

const KINDS = new Set<ExtensionBridgeEnvelope['kind']>([
  'handshake.hello',
  'handshake.welcome',
  'handshake.rejected',
  'cdp.request',
  'cdp.response',
  'cdp.event',
  'extension.lick',
  'leader.join-url',
]);

/**
 * Structural validator. Both sides MUST run this on every inbound message
 * before acting on it — the Port is trusted (gated by `onConnectExternal`),
 * but a buggy / outdated peer could still post malformed envelopes.
 */
export function isExtensionBridgeEnvelope(value: unknown): value is ExtensionBridgeEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.bridge === EXTENSION_BRIDGE_PROTOCOL_VERSION &&
    typeof v.channelId === 'string' &&
    typeof v.kind === 'string' &&
    KINDS.has(v.kind as ExtensionBridgeEnvelope['kind'])
  );
}

/**
 * True when a message is shaped like a bridge envelope but carries a DIFFERENT
 * protocol version — i.e. the peer (hosted leader tab vs installed extension)
 * is a version-skewed build, not Port noise. `isExtensionBridgeEnvelope`
 * rejects these, so without this check a skewed peer is indistinguishable
 * from the generic handshake timeout. Callers log it distinctly.
 */
export function isBridgeVersionMismatch(
  value: unknown
): value is { bridge: number; channelId: string; kind: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.bridge === 'number' &&
    v.bridge !== EXTENSION_BRIDGE_PROTOCOL_VERSION &&
    typeof v.channelId === 'string' &&
    typeof v.kind === 'string'
  );
}
