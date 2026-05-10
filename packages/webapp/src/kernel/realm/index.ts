/**
 * `realm/` barrel — public surface used by `node-command`,
 * `jsh-executor`, and `python-command` to spawn hard-killable
 * realms.
 */

export {
  runInRealm,
  type RealmResult,
  type RunInRealmOptions,
  type Realm,
  type RealmFactory,
} from './realm-runner.js';
export { attachRealmHost, type RealmHostHandle } from './realm-host.js';
export { RealmRpcClient, type RealmPortLike } from './realm-rpc.js';
export { createDefaultRealmFactory, resolvePyodideIndexURL } from './realm-factory.js';
export { createIframeRealm, type RealmIframeOptions } from './realm-iframe.js';
export type {
  RealmKind,
  RealmInitMsg,
  RealmDoneMsg,
  RealmErrorMsg,
  RealmRpcRequest,
  RealmRpcResponse,
  SerializedFetchResponse,
} from './realm-types.js';
