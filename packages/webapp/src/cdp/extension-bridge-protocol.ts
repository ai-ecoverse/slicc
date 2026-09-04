/**
 * Extension bridge protocol — moved to @slicc/shared-ts (#2276 slice E) so
 * the thin chrome extension can import it without reaching into
 * packages/webapp/src. Re-exported here so no webapp-internal import path
 * changes.
 */

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
