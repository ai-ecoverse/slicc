/**
 * Back-compat re-export. The secrets bridge client lives in the shell transport
 * layer because extension-delegate routing is configured by `proxied-fetch.ts`.
 * Existing core call sites keep importing `callSecretsBridge` from here unchanged.
 */
export {
  callSecretsBridge,
  type SecretsBridgePayload,
} from '../shell/secrets-bridge-client.js';
