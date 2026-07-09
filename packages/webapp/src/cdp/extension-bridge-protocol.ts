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

import type { DiscoveryKind } from '@slicc/shared-ts';

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
 * Discovery lick pushed SW → leader tab. The SW observes an agentic-resource-
 * discovery artifact on a main-frame document response — either a bare
 * `rel="ai-catalog"` RFC 8288 `Link` header (`chrome.webRequest`) or a
 * throttled per-origin well-known probe of `/.well-known/ai-catalog.json` /
 * `/llms.txt` (host_permissions bypass CORS) — and forwards it over the
 * welcomed Port so the leader can inject a `discovery` `LickEvent` into the
 * worker-side `LickManager`. Mirrors {@link ExtensionBridgeLick} (the navigate
 * path) but carries the structured discovery fields the `discovery` lick needs
 * (`discoveryOrigin` + `discoveryKind` + `discoveryUrl`). Silent: no OS
 * notification is shown for discovery (unlike a handoff).
 */
export interface ExtensionBridgeDiscovery {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'extension.discovery';
  /** Origin the artifact was advertised on / found at. */
  discoveryOrigin: string;
  /** Which artifact: an ARD `ai-catalog` manifest or an `llms-txt` digest. */
  discoveryKind: DiscoveryKind;
  /** Absolute URL of the manifest (`ai-catalog.json`) or digest (`llms.txt`). */
  discoveryUrl: string;
  /** URL of the main-frame document whose response triggered the discovery. */
  url: string;
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

/**
 * SW → leader tab: open the provider Settings dialog. Sent when the extension
 * side-panel follower hands a sign-in off to the leader (a provider login can't
 * complete in the cross-origin panel iframe). The SW focuses the leader tab and
 * posts this so the user lands on an already-open Settings dialog instead of a
 * dead tab. Carries no payload — it's a pure command.
 */
export interface ExtensionBridgeOpenSettings {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'extension.open-settings';
}

export type ExtensionBridgeEnvelope =
  | ExtensionBridgeHello
  | ExtensionBridgeWelcome
  | ExtensionBridgeRejected
  | ExtensionBridgeCdpRequest
  | ExtensionBridgeCdpResponse
  | ExtensionBridgeCdpEvent
  | ExtensionBridgeLick
  | ExtensionBridgeDiscovery
  | ExtensionBridgeLeaderJoinUrl
  | ExtensionBridgeOpenSettings;

const KINDS = new Set<ExtensionBridgeEnvelope['kind']>([
  'handshake.hello',
  'handshake.welcome',
  'handshake.rejected',
  'cdp.request',
  'cdp.response',
  'cdp.event',
  'extension.lick',
  'extension.discovery',
  'leader.join-url',
  'extension.open-settings',
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
