import type { DiscoveryKind } from './agent-wire-types.js';
import type { CDPPayload } from './tray-sync-protocol.js';

export const EXTENSION_BRIDGE_PROTOCOL_VERSION = 1;

export const EXTENSION_BRIDGE_PORT_NAME = 'slicc.cdp-bridge';

interface ExtensionBridgeWireProbe {
  bridge?: unknown;
  channelId?: unknown;
  kind?: unknown;
}

export interface ExtensionBridgeVersionMismatch {
  bridge: number;
  channelId: string;
  kind: string;
}

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

  params?: CDPPayload;
  sessionId?: string;
}

export interface ExtensionBridgeCdpResponse {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.response';
  id: number;

  result?: CDPPayload;
  error?: string;
}

export interface ExtensionBridgeCdpEvent {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.event';
  method: string;

  params?: CDPPayload;
  sessionId?: string;
}

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

export interface ExtensionBridgeDiscovery {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'extension.discovery';

  discoveryOrigin: string;

  discoveryKind: DiscoveryKind;

  discoveryUrl: string;

  url: string;
}

export interface ExtensionBridgeLeaderJoinUrl {
  bridge: typeof EXTENSION_BRIDGE_PROTOCOL_VERSION;
  channelId: string;
  kind: 'leader.join-url';
  joinUrl: string | null;
}

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

export function isExtensionBridgeEnvelope(value: unknown): value is ExtensionBridgeEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as ExtensionBridgeWireProbe;
  return (
    v.bridge === EXTENSION_BRIDGE_PROTOCOL_VERSION &&
    typeof v.channelId === 'string' &&
    typeof v.kind === 'string' &&
    KINDS.has(v.kind as ExtensionBridgeEnvelope['kind'])
  );
}

export function isBridgeVersionMismatch(value: unknown): value is ExtensionBridgeVersionMismatch {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as ExtensionBridgeWireProbe;
  return (
    typeof v.bridge === 'number' &&
    v.bridge !== EXTENSION_BRIDGE_PROTOCOL_VERSION &&
    typeof v.channelId === 'string' &&
    typeof v.kind === 'string'
  );
}
