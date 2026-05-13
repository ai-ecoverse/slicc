/**
 * `js-realm-shared.ts` — JS realm execution logic factored out so
 * both `js-realm-worker.ts` (DedicatedWorker entry, standalone) and
 * an in-process test factory can drive the same code path. The
 * sandbox-iframe variant in `sandbox.html` mirrors this logic but
 * is duplicated there because the iframe runs its own bootstrap
 * script outside the TS module graph.
 *
 * `runJsRealm(init, port)` is the entire entry point: pre-fetches
 * `require()` specifiers via esm.sh, builds RPC-backed `fs` /
 * `exec` / `fetch` shims off the supplied `port`, runs the user
 * code in an `AsyncFunction`, then posts `realm-done` over the
 * same port.
 *
 * `port` is whatever the host gave the realm — for workers it's
 * the worker's own `self` (DedicatedWorkerGlobalScope), for tests
 * it's a `MessagePort`-shaped fake.
 */

import { RealmRpcClient, type RealmPortLike } from './realm-rpc.js';
import type { RealmDoneMsg, RealmInitMsg, SerializedFetchResponse } from './realm-types.js';
import {
  LOAD_MODULE_TIMEOUT_MS,
  NODE_NATIVE_PACKAGES,
  nativePackageError,
  withTimeout,
} from './require-guards.js';

const NODE_BUILTINS_UNAVAILABLE = new Set([
  'http',
  'https',
  'net',
  'tls',
  'dgram',
  'dns',
  'cluster',
  'worker_threads',
  'child_process',
  'crypto',
  'os',
  'stream',
  'zlib',
  'vm',
  'v8',
  'perf_hooks',
  'readline',
  'repl',
  'tty',
  'inspector',
]);

const BUILTINS_LOCAL = new Set(['fs', 'process', 'buffer']);

class NodeExitError extends Error {
  constructor(public readonly code: number) {
    super(`Process exited with code ${code}`);
    this.name = 'NodeExitError';
  }
}

function extractRequireSpecifiers(code: string): string[] {
  const re = /\brequire\s*\(\s*(['"`])([^'"`\s]+)\1\s*\)/g;
  const ids = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) ids.add(m[2]);
  return [...ids];
}

function formatConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Run a `kind:'js'` realm against `port`. Posts exactly one
 * `realm-done` (or `realm-error` on a bootstrap throw, which the
 * caller is expected to surface separately). Returns when the
 * `realm-done` has been posted.
 *
 * The `loadModule` hook is overridable so the iframe (which can't
 * use `import('https://esm.sh/...')` reliably under sandbox CSP)
 * can substitute its own fetch + Function fallback. The default is
 * a dynamic `import()` against esm.sh — the standalone worker
 * path.
 */
export async function runJsRealm(
  init: RealmInitMsg,
  port: RealmPortLike,
  loadModule: (id: string) => Promise<Record<string, unknown>> = defaultLoadModule
): Promise<void> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const writeStdout = (value: unknown): void => {
    stdoutChunks.push(typeof value === 'string' ? value : String(value));
  };
  const writeStderr = (value: unknown): void => {
    stderrChunks.push(typeof value === 'string' ? value : String(value));
  };

  const nodeConsole = {
    log: (...parts: unknown[]) => writeStdout(`${parts.map(formatConsoleArg).join(' ')}\n`),
    info: (...parts: unknown[]) => writeStdout(`${parts.map(formatConsoleArg).join(' ')}\n`),
    warn: (...parts: unknown[]) => writeStderr(`${parts.map(formatConsoleArg).join(' ')}\n`),
    error: (...parts: unknown[]) => writeStderr(`${parts.map(formatConsoleArg).join(' ')}\n`),
  };

  // `init.stdin` arrives as a buffered string from the kernel — pipelines
  // upstream of the realm (the WasmShell exec pipeline, the registered
  // `.jsh` command path, `node`/`node -e` via supplemental-commands) all
  // populate it before posting `realm-init`. Stdin in the realm is
  // therefore fully read-ahead; we don't model a streaming Readable.
  // Surfaces:
  //   • `stdin` — top-level AsyncFunction parameter; the ergonomic
  //     "`const lines = stdin.split('\\n')`" path for `.jsh` scripts.
  //   • `process.stdin.read()` — Node-like sync read returning the same
  //     buffered string.
  //   • `process.stdin[Symbol.asyncIterator]` — yields the buffered
  //     string once, so `for await (const chunk of process.stdin)` works
  //     for code copy-pasted from Node tutorials.
  // `process.stdin.isTTY` is always `false`; there's no terminal.
  const stdinBuffer = init.stdin ?? '';
  const stdinShim = {
    isTTY: false,
    read(): string {
      return stdinBuffer;
    },
    toString(): string {
      return stdinBuffer;
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let yielded = false;
      return {
        async next(): Promise<IteratorResult<string>> {
          if (yielded) return { value: undefined, done: true };
          yielded = true;
          return { value: stdinBuffer, done: false };
        },
      };
    },
  };

  const processShim = {
    argv: init.argv,
    env: init.env,
    cwd: () => init.cwd,
    exit: (codeValue?: number) => {
      const normalized = Number.isFinite(codeValue) ? Number(codeValue) : 0;
      throw new NodeExitError(normalized);
    },
    stdin: stdinShim,
    stdout: { write: writeStdout },
    stderr: { write: writeStderr },
  };

  const rpc = new RealmRpcClient(port);

  const fsBridge = {
    readFile: (path: string): Promise<string> => rpc.call('vfs', 'readFile', [path]),
    readFileBinary: (path: string): Promise<Uint8Array> =>
      rpc.call('vfs', 'readFileBinary', [path]),
    writeFile: (path: string, content: string): Promise<true> =>
      rpc.call('vfs', 'writeFile', [path, content]),
    writeFileBinary: (path: string, bytes: Uint8Array): Promise<true> =>
      rpc.call('vfs', 'writeFileBinary', [path, bytes]),
    readDir: (path: string): Promise<string[]> => rpc.call('vfs', 'readDir', [path]),
    exists: (path: string): Promise<boolean> => rpc.call('vfs', 'exists', [path]),
    stat: (path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> =>
      rpc.call('vfs', 'stat', [path]),
    mkdir: (path: string): Promise<true> => rpc.call('vfs', 'mkdir', [path]),
    rm: (path: string): Promise<true> => rpc.call('vfs', 'rm', [path]),
    fetchToFile: async (url: string, path: string): Promise<number> => {
      const response = await realmFetch(url);
      if (!response.ok) throw new Error(`fetch ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await rpc.call('vfs', 'writeFileBinary', [path, bytes]);
      return bytes.byteLength;
    },
  };

  const execBridge = (
    command: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
    rpc.call('exec', 'run', [command]);

  async function realmFetch(input: string | URL | Request, opts?: RequestInit): Promise<Response> {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
    const serialized: SerializedFetchResponse = await rpc.call('fetch', 'request', [
      url,
      serializeRequestInit(opts, input),
    ]);
    const body =
      serialized.body.byteLength === 0
        ? null
        : (serialized.body.buffer.slice(
            serialized.body.byteOffset,
            serialized.body.byteOffset + serialized.body.byteLength
          ) as ArrayBuffer);
    const response = new Response(body, {
      status: serialized.status,
      statusText: serialized.statusText,
      headers: serialized.headers,
    });
    Object.defineProperty(response, 'url', { value: serialized.url || url });
    return response;
  }

  // Pre-fetch require specifiers — fire one esm.sh request per
  // unique id and stash the resolved exports in `requireCache`.
  // Failures are surfaced via stderr but don't abort the run; the
  // require shim throws a descriptive error if user code tries to
  // consume a missing specifier.
  //
  // Two guard rails before the actual `loadModule` call:
  //  - Hard-fail Node-native packages (sharp, sqlite3, …): their
  //    CDN entries chain into `.node` loader fetches that hang
  //    instead of erroring, so a bare `require('sharp')` could
  //    park the realm for the full 15s timeout per specifier.
  //  - Wrap every load in `withTimeout` so a stuck transitive
  //    import can't park the realm indefinitely.
  const specifiers = extractRequireSpecifiers(init.code);
  const filteredSpecifiers = specifiers
    .map((s) => (s.startsWith('node:') ? s.slice(5) : s))
    .filter((s) => !BUILTINS_LOCAL.has(s) && !NODE_BUILTINS_UNAVAILABLE.has(s));
  const nativeSpecifiers = filteredSpecifiers.filter((s) => NODE_NATIVE_PACKAGES.has(s));
  const loadableSpecifiers = filteredSpecifiers.filter((s) => !NODE_NATIVE_PACKAGES.has(s));
  for (const id of nativeSpecifiers) {
    writeStderr(`Warning: ${nativePackageError(id, id).message}\n`);
  }
  const requireCache: Record<string, unknown> = Object.create(null);
  if (loadableSpecifiers.length > 0) {
    const results = await Promise.allSettled(
      loadableSpecifiers.map(async (id) => {
        const mod = await withTimeout(loadModule(id), LOAD_MODULE_TIMEOUT_MS, `require('${id}')`);
        const val = mod && 'default' in mod ? mod.default : mod;
        requireCache[id] = val;
      })
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        writeStderr(`Warning: failed to pre-load require('${loadableSpecifiers[i]}'): ${reason}\n`);
      }
    }
  }

  const requireShim = (id: string): unknown => {
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (bareId === 'fs') return fsBridge;
    if (bareId === 'process') return processShim;
    if (bareId === 'buffer') return { Buffer: (globalThis as Record<string, unknown>).Buffer };
    if (bareId === 'path') {
      if ('path' in requireCache) return requireCache['path'];
      if (id in requireCache) return requireCache[id];
      throw new Error(
        `require('${id}'): path module not pre-loaded. Add require('path') as a static import.`
      );
    }
    if (NODE_NATIVE_PACKAGES.has(bareId)) {
      throw nativePackageError(id, bareId);
    }
    if (NODE_BUILTINS_UNAVAILABLE.has(bareId)) {
      const hints: Record<string, string> = {
        http: ' Use fetch() instead.',
        https: ' Use fetch() instead.',
        child_process: ' Use exec() which is available as a shell bridge.',
        crypto: ' Use globalThis.crypto (Web Crypto API) instead.',
      };
      throw new Error(
        `require('${id}'): Node built-in '${bareId}' is not available in the browser environment.${hints[bareId] || ''}`
      );
    }
    if (id in requireCache) return requireCache[id];
    if (bareId in requireCache) return requireCache[bareId];
    throw new Error(
      `require('${id}'): module not pre-loaded. Use a string literal so it can be pre-fetched, or use \`await import('https://esm.sh/${id}')\` directly.`
    );
  };

  const moduleShim = { exports: {} as Record<string, unknown>, filename: init.filename };

  let exitCode = 0;
  try {
    const AsyncFn = Object.getPrototypeOf(async function () {
      /* noop */
    }).constructor as new (
      ...args: string[]
    ) => (
      fs: typeof fsBridge,
      process: typeof processShim,
      console: typeof nodeConsole,
      require: typeof requireShim,
      module: typeof moduleShim,
      exports: Record<string, unknown>,
      exec: typeof execBridge,
      fetch: typeof realmFetch,
      stdin: string
    ) => Promise<unknown>;
    const fn = new AsyncFn(
      'fs',
      'process',
      'console',
      'require',
      'module',
      'exports',
      'exec',
      'fetch',
      'stdin',
      `"use strict";\n${init.code}`
    );
    await fn(
      fsBridge,
      processShim,
      nodeConsole,
      requireShim,
      moduleShim,
      moduleShim.exports,
      execBridge,
      realmFetch,
      stdinBuffer
    );
  } catch (err: unknown) {
    if (err instanceof NodeExitError) {
      exitCode = err.code;
    } else {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      writeStderr(`${message}\n`);
      exitCode = 1;
    }
  }

  rpc.dispose();
  const done: RealmDoneMsg = {
    type: 'realm-done',
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
  port.postMessage(done);
}

function serializeRequestInit(
  init: RequestInit | undefined,
  input: string | URL | Request
): RequestInit | undefined {
  if (!init && !(input instanceof Request)) return undefined;
  const fromRequest = input instanceof Request ? input : null;
  const method = (init?.method ?? fromRequest?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  } else if (fromRequest) {
    fromRequest.headers.forEach((v, k) => {
      headers[k] = v;
    });
  }
  let body: string | undefined;
  if (init?.body !== undefined && init?.body !== null && init?.body !== '') {
    body = typeof init.body === 'string' ? init.body : String(init.body);
  }
  return { method, headers, body };
}

async function defaultLoadModule(id: string): Promise<Record<string, unknown>> {
  return (await import(/* @vite-ignore */ 'https://esm.sh/' + id)) as Record<string, unknown>;
}
