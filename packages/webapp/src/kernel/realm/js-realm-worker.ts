/**
 * `js-realm-worker.ts` — DedicatedWorker entry hosting the
 * `kind:'js'` realm in standalone mode (where extension CSP is
 * irrelevant — `script-src 'self' 'wasm-unsafe-eval'` doesn't apply
 * to standalone, so the worker can use `AsyncFunction(userCode)`
 * directly).
 *
 * The worker:
 *   1. Waits for a `realm-init` message.
 *   2. Pre-fetches `require()` specifiers via `import('https://esm.sh/...')`.
 *   3. Runs the user code inside an `AsyncFunction` with the same
 *      Node-like shims as `node-command`/`jsh-executor` had:
 *      `console`, `process`, `fs` (via VFS RPC), `exec` (via shell
 *      RPC), `fetch` (via host RPC so SecureFetch substitution
 *      stays on the kernel side), `require` (npm module cache from
 *      the pre-fetch).
 *   4. Posts `realm-done` with stdout / stderr / exitCode.
 *
 * Per-task `require` cache: accepted for v1. Each task fetches its
 * npm modules fresh. The cost is small relative to LLM round-trips
 * and avoids introducing a kernel-side require RPC.
 *
 * Hard-kill: the kernel runner calls `worker.terminate()` on
 * SIGKILL. The `await fn(...)` here never resolves on terminate —
 * fine, the worker is gone.
 */

/// <reference lib="webworker" />

import { RealmRpcClient } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmErrorMsg,
  RealmInitMsg,
  SerializedFetchResponse,
} from './realm-types.js';

declare const self: DedicatedWorkerGlobalScope;

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

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'realm-init') return;
  const init = event.data as RealmInitMsg;
  if (init.kind !== 'js') return;
  void runJs(init).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const errMsg: RealmErrorMsg = { type: 'realm-error', message };
    self.postMessage(errMsg);
  });
});

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

async function runJs(init: RealmInitMsg): Promise<void> {
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

  const processShim = {
    argv: init.argv,
    env: init.env,
    cwd: () => init.cwd,
    exit: (codeValue?: number) => {
      const normalized = Number.isFinite(codeValue) ? Number(codeValue) : 0;
      throw new NodeExitError(normalized);
    },
    stdout: { write: writeStdout },
    stderr: { write: writeStderr },
  };

  // Wire RPC against the host. `self` (the DedicatedWorker global)
  // posts to / receives from the kernel via the worker's port.
  const rpc = new RealmRpcClient({
    postMessage: (msg, transfer) =>
      transfer ? self.postMessage(msg, transfer) : self.postMessage(msg),
    addEventListener: (type, handler) => self.addEventListener(type, handler),
    removeEventListener: (type, handler) => self.removeEventListener(type, handler),
  });

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

  // Reconstruct a Web Fetch API `Response` from the host's
  // serialized payload. The user code keeps its native `Response`-
  // shaped interactions (`.ok`, `.json()`, `.text()`, etc.).
  async function realmFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.toString()
          : String(input);
    const serialized: SerializedFetchResponse = await rpc.call('fetch', 'request', [
      url,
      serializeRequestInit(init, input),
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
    // Patch `url` since Response can't be constructed with one.
    Object.defineProperty(response, 'url', { value: serialized.url || url });
    return response;
  }

  // Pre-fetch require specifiers via esm.sh, same path the legacy
  // node-command runtime used. Failures become deferred — the
  // require shim throws the original esm.sh error if user code
  // tries to consume an unresolved specifier.
  const specifiers = extractRequireSpecifiers(init.code);
  const filteredSpecifiers = specifiers
    .map((s) => (s.startsWith('node:') ? s.slice(5) : s))
    .filter((s) => !BUILTINS_LOCAL.has(s) && !NODE_BUILTINS_UNAVAILABLE.has(s));
  const requireCache: Record<string, unknown> = Object.create(null);
  if (filteredSpecifiers.length > 0) {
    const results = await Promise.allSettled(
      filteredSpecifiers.map(async (id) => {
        const mod = (await import(/* @vite-ignore */ 'https://esm.sh/' + id)) as Record<
          string,
          unknown
        >;
        const val = mod && 'default' in mod ? mod.default : mod;
        requireCache[id] = val;
      })
    );
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
        writeStderr(`Warning: failed to pre-load require('${filteredSpecifiers[i]}'): ${reason}\n`);
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
      fetch: typeof realmFetch
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
      realmFetch
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
  self.postMessage(done);
}

function serializeRequestInit(
  init: RequestInit | undefined,
  input: string | URL | Request
): RequestInit | undefined {
  // The host's `dispatchFetch` accepts a plain `RequestInit` and
  // hands it to `createNodeFetchAdapter`. Strings / Headers /
  // URLSearchParams cross postMessage cleanly; FormData / streams
  // do not — convert to string body to keep the bridge simple. If
  // a user sends a `Request`, copy the method/headers/body since
  // the adapter accepts an init bag with overrides.
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

export {};
