export type {
  ExtensionBridgeCdpEvent,
  ExtensionBridgeCdpRequest,
  ExtensionBridgeCdpResponse,
  ExtensionBridgeDiscovery,
  ExtensionBridgeEnvelope,
  ExtensionBridgeHello,
  ExtensionBridgeLeaderJoinUrl,
  ExtensionBridgeLick,
  ExtensionBridgeOpenSettings,
  ExtensionBridgeRejected,
  ExtensionBridgeVersionMismatch,
  ExtensionBridgeWelcome,
} from '@slicc/shared-ts';
export {
  EXTENSION_BRIDGE_PORT_NAME,
  EXTENSION_BRIDGE_PROTOCOL_VERSION,
  isBridgeVersionMismatch,
  isExtensionBridgeEnvelope,
} from '@slicc/shared-ts';
