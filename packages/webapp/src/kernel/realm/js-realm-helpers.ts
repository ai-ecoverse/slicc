/**
 * Compatibility barrel for pure-JS runtime helpers exposed inside `.jsh` and
 * `node -e` realms. Implementations live in responsibility-specific modules.
 */

export type { CliApi, CliDeps, CliDieOpts, CliWarnOpts } from './helpers/cli.js';
export { createCli } from './helpers/cli.js';
export type { ColorApi } from './helpers/color.js';
export { createColor } from './helpers/color.js';
export type { FmtApi } from './helpers/fmt.js';
export { fmt } from './helpers/fmt.js';
export type { NodeAssert } from './helpers/node-assert.js';
export { NodeAssertionError, nodeAssert, nodeAssertStrict } from './helpers/node-assert.js';
export type {
  CpExecBridge,
  CpExecHandle,
  CpExecResult,
  CpExecStartOptions,
  CpSpawnSyncResult,
  CpSyncExecBridge,
  NodeChildProcess,
} from './helpers/node-child-process.js';
export { createNodeChildProcess } from './helpers/node-child-process.js';
export type { NodeCrypto, NodeHash } from './helpers/node-crypto.js';
export { nodeCrypto } from './helpers/node-crypto.js';
export { nodeEvents } from './helpers/node-events.js';
export type { NodeOs } from './helpers/node-os.js';
export { createNodeOs, DEFAULT_HOME, nodeOs } from './helpers/node-os.js';
export type { NodePath, NodePathParsed } from './helpers/node-path.js';
export { nodePath } from './helpers/node-path.js';
export { nodeStream } from './helpers/node-stream.js';
export { nodeTty } from './helpers/node-tty.js';
export type { NodeUrl } from './helpers/node-url.js';
export { nodeUrl } from './helpers/node-url.js';
export type { NodeInspectOptions, NodeUtil } from './helpers/node-util.js';
export { nodeUtil } from './helpers/node-util.js';
export type { NodeZlib } from './helpers/node-zlib.js';
export { nodeZlib } from './helpers/node-zlib.js';
export type { ParsedFlags } from './helpers/parse-flags.js';
export { attachArgvParseFlags, parseFlags } from './helpers/parse-flags.js';
export type { PoolFn } from './helpers/pool.js';
export { pool } from './helpers/pool.js';
export type { TimeApi } from './helpers/time.js';
export { time } from './helpers/time.js';
