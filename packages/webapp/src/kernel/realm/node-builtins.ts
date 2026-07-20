/**
 * Single source-of-truth for the complete set of Node built-in module names
 * and the browser-unavailable subset, shared by BOTH the realm require shim
 * (`realm-module-system.ts`) and the host-side module-graph walker
 * (`shell/ipk/resolver.ts`).
 *
 * Why one list serves two roles: the resolver must treat EVERY bare Node
 * built-in (and its `node:`-prefixed form) as graph-external so it is never
 * routed through `node_modules` resolution — otherwise a real npm package that
 * internally does `require('crypto')` would surface a misleading
 * `Cannot find module 'crypto' (run: ipk install crypto)` (or be shadowed by a
 * node_modules folder). The realm require shim then SERVES the available
 * built-ins and HARD-FAILS the rest with the browser-unavailable message.
 */

/** Bare Node built-ins the realm serves directly (never from `node_modules`). */
export const NODE_BUILTIN_AVAILABLE: ReadonlySet<string> = new Set([
  'child_process',
  'events',
  'fs',
  'fs/promises',
  'os',
  'path',
  'stream',
  'url',
  'crypto',
  'process',
  'buffer',
  'assert',
  'assert/strict',
  'util',
]);

/**
 * The complete set of public Node built-in module names (without the `node:`
 * scheme), including the common subpath modules Node ships. Mirrors
 * `require('module').builtinModules` minus the internal underscore-prefixed
 * entries.
 */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  'assert',
  'assert/strict',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'dns/promises',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'inspector/promises',
  'module',
  'net',
  'os',
  'path',
  'path/posix',
  'path/win32',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'readline/promises',
  'repl',
  'stream',
  'stream/consumers',
  'stream/promises',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'timers/promises',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'util/types',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

/**
 * Node built-ins NOT available in the browser realm: every built-in the realm
 * does not serve directly. Derived from {@link NODE_BUILTINS} minus
 * {@link NODE_BUILTIN_AVAILABLE} so the two lists can never drift.
 */
export const NODE_BUILTINS_UNAVAILABLE: ReadonlySet<string> = new Set(
  [...NODE_BUILTINS].filter((name) => !NODE_BUILTIN_AVAILABLE.has(name))
);

/** Strip a leading `node:` scheme from a specifier. */
export function stripNodeScheme(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier;
}

/** True when `specifier` (bare or `node:`-prefixed) names a Node built-in. */
export function isNodeBuiltin(specifier: string): boolean {
  return NODE_BUILTINS.has(stripNodeScheme(specifier));
}
