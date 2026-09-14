export const NODE_SHIM_VERSION = '20.0.0';

export const NODE_BUILTIN_AVAILABLE: ReadonlySet<string> = new Set([
  'child_process',
  'events',
  'fs',
  'fs/promises',
  'os',
  'path',
  'stream',
  'tty',
  'url',
  'crypto',
  'process',
  'buffer',
  'assert',
  'assert/strict',
  'util',
  'readline',
  'readline/promises',
  'module',
]);

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

export const NODE_BUILTINS_UNAVAILABLE: ReadonlySet<string> = new Set(
  [...NODE_BUILTINS].filter((name) => !NODE_BUILTIN_AVAILABLE.has(name))
);

export function stripNodeScheme(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice(5) : specifier;
}

export function isNodeBuiltin(specifier: string): boolean {
  return NODE_BUILTINS.has(stripNodeScheme(specifier));
}
