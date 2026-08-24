/**
 * VFS locations for ipk global installs (`ipk install -g` / `npm install -g`).
 *
 * Mirrors npm's prefix layout: packages under `<prefix>/node_modules`, CLI
 * entrypoints published to `<prefix>/../bin` (here `/shared/bin`, already on
 * the default `$PATH`).
 */

/** npm-style prefix directory (holds `node_modules` + `package.json`). */
export const GLOBAL_NPM_PREFIX = '/shared/lib';

/** Global package tree root. */
export const GLOBAL_NODE_MODULES = `${GLOBAL_NPM_PREFIX}/node_modules`;

/** Directory for PATH-visible `.jsh` delegators to global bins. */
export const GLOBAL_BIN_DIR = '/shared/bin';

/** Manifest recording directly-requested global packages. */
export const GLOBAL_PACKAGE_JSON = `${GLOBAL_NPM_PREFIX}/package.json`;

/** Marker comment identifying ipk-managed delegators in `/shared/bin`. */
export const GLOBAL_BIN_DELEGATOR_MARKER = '@ipk-global-delegator';
