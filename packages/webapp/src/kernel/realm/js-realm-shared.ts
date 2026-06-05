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

import { esmShUrl } from '../../shell/supplemental-commands/cdn-url-builder.js';
import { createHttpGlobal } from './http-global.js';
import {
  attachArgvParseFlags,
  createCli,
  createColor,
  fmt,
  pool,
  time,
} from './js-realm-helpers.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmInitMsg,
  SerializedFetchResponse,
  TabHandle,
  WsSelector,
  WsSink,
  WsSubscriberInfo,
} from './realm-types.js';
import {
  NODE_NATIVE_PACKAGES,
  nativePackageError,
  resolveLoadModuleTimeoutMs,
  withTimeout,
} from './require-guards.js';
import { createSkillGlobal } from './skill-global.js';

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
 * use a dynamic `import()` against the esm.sh CDN reliably under
 * sandbox CSP) can substitute its own fetch + Function fallback.
 * The default is a dynamic `import()` against esm.sh — the
 * standalone worker path.
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
  //
  // Exposed exclusively via `process.stdin` to avoid burning a top-level
  // identifier. Earlier drafts also injected `stdin` as an AsyncFunction
  // parameter for ergonomics, but `stdin` is a common user variable name
  // (more so than `fs` / `exec` / `fetch`); reserving it would have
  // turned any pre-existing `let stdin = …` into a strict-mode
  // SyntaxError. Scripts that want the short form can alias it
  // themselves: `const { stdin } = process; const data = stdin.read();`.
  //
  // EOF semantics match Node's `Readable.read()`: the first `read()`
  // returns the full buffer, subsequent calls return `null`. A single
  // `consumed` flag is shared with the async iterator, so
  // `for await (const c of process.stdin)` after a `read()` (or a
  // second iteration) yields nothing — same as Node where `'end'`
  // fires once. `toString()` always returns the original buffer
  // because it's a view (`String(process.stdin)`), not a consumer.
  // `process.stdin.isTTY` is always `false`; there's no terminal.
  const stdinBuffer = init.stdin ?? '';
  let stdinConsumed = false;
  const stdinShim = {
    isTTY: false,
    read(): string | null {
      if (stdinConsumed) return null;
      stdinConsumed = true;
      return stdinBuffer;
    },
    toString(): string {
      return stdinBuffer;
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        async next(): Promise<IteratorResult<string>> {
          if (stdinConsumed) return { value: undefined, done: true };
          stdinConsumed = true;
          return { value: stdinBuffer, done: false };
        },
      };
    },
  };

  // `process.argv` carries a non-enumerable `parseFlags()` method so the
  // per-skill argv-loop reinvention (~25 LoC × every skill) collapses to a
  // single call. See `js-realm-helpers.ts` for the spec.
  const argvWithParseFlags = attachArgvParseFlags(init.argv);
  // `stdout.isTTY` matches the shell's TTY policy: realm output is captured
  // and replayed verbatim, so we treat stdout as a TTY unless `NO_COLOR` is
  // explicitly set in the realm env. The `c` global also honors `NO_COLOR`.
  const noColor = !!init.env?.NO_COLOR;
  const processShim = {
    argv: argvWithParseFlags,
    env: init.env,
    cwd: () => init.cwd,
    exit: (codeValue?: number) => {
      const normalized = Number.isFinite(codeValue) ? Number(codeValue) : 0;
      throw new NodeExitError(normalized);
    },
    stdin: stdinShim,
    stdout: { write: writeStdout, isTTY: !noColor },
    stderr: { write: writeStderr, isTTY: !noColor },
  };

  // `c` / `cli` are constructed together so cli.die/warn can call into c
  // without skills having to wire their own colorizer.
  const colorApi = createColor({ isTTY: !noColor, noColor });
  const cliApi = createCli({
    writeStdout,
    writeStderr,
    exit: (code: number): never => {
      throw new NodeExitError(code);
    },
    color: colorApi,
  });

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

  // `exec(string)` parses the command through the shell — convenient
  // for one-liners but punishing for anyone constructing commands
  // programmatically (the spec called out the bespoke `shellQuote()`
  // helpers skills kept reinventing). `exec.spawn(argv[])` mirrors
  // `child_process.spawn(cmd, args)` and bypasses shell parsing on
  // every arg, killing the quoting-trap class of bugs.
  type ExecResult = { stdout: string; stderr: string; exitCode: number };
  const execRun = (command: string): Promise<ExecResult> => rpc.call('exec', 'run', [command]);
  const execBridge = Object.assign(execRun, {
    spawn: (argv: string[]): Promise<ExecResult> => rpc.call('exec', 'spawn', [argv]),
  });

  // `skill` is computed once at boot from argv[1] and frozen. It exposes
  // the script-relative path helpers and the skill-scoped config/token
  // store; see `skill-global.ts` for the surface and rationale.
  const skillGlobal = createSkillGlobal({ argv: init.argv, fs: fsBridge, exec: execBridge });

  // `browser` is the kernel-side CDP bridge — wraps the same
  // BrowserAPI playwright-cli uses, so standalone and extension
  // floats share one realm surface. Accepts a `TabHandle` (from
  // `findTab` / `ensureTab`) or a bare `targetId` string for ops
  // that don't need a fresh listPages round-trip. `eval` / `evalAsync`
  // serialize functions to a string call expression so realm code
  // can pass a closure as ergonomically as a string.
  const browserBridge = {
    findTab: (query: { domain?: string; urlMatch?: string | RegExp }): Promise<TabHandle | null> =>
      rpc.call('browser', 'findTab', [normalizeUrlMatchQuery(query)]),
    ensureTab: (url: string, options: { matchUrl?: string | RegExp } = {}): Promise<TabHandle> =>
      rpc.call('browser', 'ensureTab', [url, normalizeMatchUrl(options)]),
    eval: (tab: TabHandle | string, fnOrCode: ((..._args: unknown[]) => unknown) | string) =>
      rpc.call('browser', 'eval', [resolveTargetId(tab), serializeEvalSource(fnOrCode, false)]),
    evalAsync: (tab: TabHandle | string, fnOrCode: ((..._args: unknown[]) => unknown) | string) =>
      rpc.call('browser', 'evalAsync', [resolveTargetId(tab), serializeEvalSource(fnOrCode, true)]),
    cookie: (tab: TabHandle | string, name: string): Promise<string | null> =>
      rpc.call('browser', 'cookie', [resolveTargetId(tab), name]),
    localStorage: (tab: TabHandle | string, key: string): Promise<string | null> =>
      rpc.call('browser', 'localStorage', [resolveTargetId(tab), key]),
    fetch: (
      tab: TabHandle | string,
      url: string,
      opts: BrowserFetchOptions = {}
    ): Promise<BrowserFetchResult> =>
      rpc.call('browser', 'evalAsync', [
        resolveTargetId(tab),
        buildBrowserFetchScript(url, opts),
      ]) as Promise<BrowserFetchResult>,
    websocket: createWsObserverApi(rpc),
  };

  // `http` is the standard API-client builder; see `http-global.ts`. It
  // wraps `realmFetch` so it inherits the kernel-side fetch-proxy + the
  // secret masking that goes with it. The realm needs only one instance:
  // `http.client(config)` is what builds the per-API surface.
  const httpGlobal = createHttpGlobal({ fetch: realmFetch });

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
  const loadModuleTimeoutMs = resolveLoadModuleTimeoutMs(init.env);
  if (loadableSpecifiers.length > 0) {
    const results = await Promise.allSettled(
      loadableSpecifiers.map(async (id) => {
        const mod = await withTimeout(loadModule(id), loadModuleTimeoutMs, `require('${id}')`);
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
      `require('${id}'): module not pre-loaded. Use a string literal so it can be pre-fetched, or use \`await import('${esmShUrl(id).toString()}')\` directly.`
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
      skill: typeof skillGlobal,
      http: typeof httpGlobal,
      browser: typeof browserBridge,
      cli: typeof cliApi,
      c: typeof colorApi,
      timeApi: typeof time,
      fmtApi: typeof fmt,
      poolApi: typeof pool
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
      'skill',
      'http',
      'browser',
      'cli',
      'c',
      'time',
      'fmt',
      'pool',
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
      skillGlobal,
      httpGlobal,
      browserBridge,
      cliApi,
      colorApi,
      time,
      fmt,
      pool
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
  return (await import(/* @vite-ignore */ esmShUrl(id).toString())) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// `browser` global helpers
// ---------------------------------------------------------------------------

/** Accept either a `TabHandle` (from `findTab`/`ensureTab`) or a bare targetId. */
function resolveTargetId(tab: TabHandle | string): string {
  if (typeof tab === 'string') return tab;
  if (tab && typeof tab === 'object' && typeof tab.targetId === 'string') return tab.targetId;
  throw new TypeError('browser: expected a tab handle or targetId string');
}

/**
 * Serialize a function or string into a self-calling expression
 * suitable for `Runtime.evaluate`. For functions we emit
 * `(<fn.toString()>)()` so the page sees an IIFE; for strings we
 * pass them through verbatim so user-authored snippets keep working.
 * `awaitPromise` is purely a CDP-side flag — the source string is
 * the same either way, but we keep the parameter explicit so a
 * future tweak to wrap async function bodies has a hook.
 */
function serializeEvalSource(
  source: ((..._args: unknown[]) => unknown) | string,
  _awaitPromise: boolean
): string {
  if (typeof source === 'function') {
    return `(${source.toString()})()`;
  }
  if (typeof source === 'string') return source;
  throw new TypeError('browser.eval/evalAsync: source must be a function or string');
}

/**
 * Options accepted by `browser.fetch(tab, url, opts)`. Mirrors the
 * `RequestInit` subset that round-trips cleanly as JSON through the
 * page-context bridge — non-serializable shapes (FormData, Blob,
 * AbortSignal, ReadableStream) are intentionally out of scope. Body
 * may be a string (sent verbatim) or any JSON-encodable value (the
 * bridge stringifies it and defaults Content-Type to application/json).
 */
export interface BrowserFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  credentials?: 'include' | 'same-origin' | 'omit';
  mode?: string;
  cache?: string;
  redirect?: string;
  referrer?: string;
  referrerPolicy?: string;
  integrity?: string;
  keepalive?: boolean;
}

/**
 * Structured result returned by `browser.fetch`. `body` is parsed
 * JSON when the response Content-Type contains `application/json`,
 * otherwise raw text. Binary responses are out of scope (the script
 * returns the text decoding the page applies).
 */
export interface BrowserFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Build the self-contained page-context script that `browser.fetch`
 * injects via `evalAsync`. All request shaping (method/credentials/
 * headers/body) is baked into the script via `JSON.stringify` so the
 * page side does nothing but call `fetch()` and assemble the
 * structured response. Credentials default to `'include'` so session
 * cookies travel automatically — that's the whole reason
 * `browser.fetch` exists rather than the realm-side `fetch`. Body
 * objects become a JSON string and force Content-Type unless the
 * caller already set one. Plain string bodies are passed through.
 *
 * Exported so `realm-iframe`/parity tests can assert the injected
 * script is a single function (no temp file, no base64 chunking).
 */
export function buildBrowserFetchScript(url: string, opts: BrowserFetchOptions = {}): string {
  const headers: Record<string, string> = {};
  const rawHeaders = opts.headers ?? {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v === 'string') headers[k] = v;
  }
  const method = typeof opts.method === 'string' ? opts.method : 'GET';
  const credentials =
    opts.credentials === 'same-origin' || opts.credentials === 'omit'
      ? opts.credentials
      : 'include';
  let body: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === 'string') {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
      if (!hasCt) headers['Content-Type'] = 'application/json';
    }
  }
  const init: Record<string, unknown> = { method, credentials, headers };
  if (body !== undefined) init.body = body;
  const passthrough = [
    'mode',
    'cache',
    'redirect',
    'referrer',
    'referrerPolicy',
    'integrity',
    'keepalive',
  ] as const;
  for (const k of passthrough) {
    const v = opts[k];
    if (v !== undefined) init[k] = v;
  }
  // Single self-contained async IIFE — runs entirely in the page,
  // returns a structured-cloneable object that CDP returnByValue
  // round-trips back to the realm host as-is. Keep this stringly
  // typed (no template-literal substitutions inside the function
  // body) so JSON.stringify is the only escape boundary.
  return (
    '(async () => {' +
    'const r = await fetch(' +
    JSON.stringify(url) +
    ', ' +
    JSON.stringify(init) +
    ');' +
    'const h = {};' +
    'r.headers.forEach((v, k) => { h[k] = v; });' +
    "const ct = r.headers.get('content-type') || '';" +
    'let b;' +
    "if (ct.indexOf('application/json') !== -1) {" +
    'try { b = await r.json(); } catch (e) { b = await r.text(); }' +
    '} else { b = await r.text(); }' +
    'return { ok: r.ok, status: r.status, headers: h, body: b };' +
    '})()'
  );
}

/**
 * Coerce the realm-side `urlMatch` (RegExp or string) into the
 * pattern source the host expects. Allowing both lets realm code
 * write the natural literal-RegExp form without losing the
 * structured-clone safety of a string crossing the port.
 */
function normalizeUrlMatchQuery(query: { domain?: string; urlMatch?: string | RegExp }): {
  domain?: string;
  urlMatch?: string;
} {
  const out: { domain?: string; urlMatch?: string } = {};
  if (query.domain !== undefined) out.domain = query.domain;
  if (query.urlMatch !== undefined) {
    out.urlMatch = query.urlMatch instanceof RegExp ? query.urlMatch.source : query.urlMatch;
  }
  return out;
}

function normalizeMatchUrl(options: { matchUrl?: string | RegExp }): { matchUrl?: string } {
  if (options.matchUrl === undefined) return {};
  return {
    matchUrl: options.matchUrl instanceof RegExp ? options.matchUrl.source : options.matchUrl,
  };
}

// ---------------------------------------------------------------------------
// `browser.websocket` — declarative WebSocket observer
// ---------------------------------------------------------------------------

/**
 * Builder for a `browser.websocket.on(tab, opts)` chain. The selector
 * (`.filter`) and sink (`.forward`) are collected on the builder; the
 * actual subscriber is created by the await on `.forward(...)`, which
 * resolves to a {@link WsSubscriberHandle}.
 */
interface WsObserverBuilder {
  filter(selector: WsSelector): WsObserverBuilder;
  forward(sink: WsSink): Promise<WsSubscriberHandle>;
}

interface WsSubscriberHandle extends WsSubscriberInfo {
  update(patch: {
    urlMatch?: string | RegExp | null;
    filter?: WsSelector | null;
  }): Promise<WsSubscriberInfo>;
  close(): Promise<boolean>;
}

interface WsObserverApi {
  on(tab: TabHandle | string, opts?: { urlMatch?: string | RegExp }): WsObserverBuilder;
  list(): Promise<WsSubscriberInfo[]>;
}

/**
 * Construct the realm-side `browser.websocket` chainable API. All
 * actual work happens host-side; this file just shapes the builder
 * surface and forwards JSON-safe payloads over the `browser` RPC
 * channel.
 */
function createWsObserverApi(rpc: RealmRpcClient): WsObserverApi {
  function makeHandle(info: WsSubscriberInfo): WsSubscriberHandle {
    return {
      ...info,
      async update(patch): Promise<WsSubscriberInfo> {
        const wire: { urlMatch?: string | null; filter?: WsSelector | null } = {};
        if (patch.urlMatch !== undefined) {
          wire.urlMatch =
            patch.urlMatch === null
              ? null
              : patch.urlMatch instanceof RegExp
                ? patch.urlMatch.source
                : patch.urlMatch;
        }
        if (patch.filter !== undefined) wire.filter = patch.filter;
        return rpc.call<WsSubscriberInfo>('browser', 'wsUpdate', [info.id, wire]);
      },
      async close(): Promise<boolean> {
        return rpc.call<boolean>('browser', 'wsClose', [info.id]);
      },
    };
  }

  return {
    on(tab, opts = {}) {
      const targetId = resolveTargetId(tab);
      const urlMatch =
        opts.urlMatch === undefined
          ? undefined
          : opts.urlMatch instanceof RegExp
            ? opts.urlMatch.source
            : opts.urlMatch;
      let selector: WsSelector | undefined;
      const builder: WsObserverBuilder = {
        filter(next) {
          if (typeof next === 'function' || typeof next === 'string') {
            throw new TypeError(
              'browser.websocket: filter must be a declarative JSON object, not a function or string'
            );
          }
          selector = next;
          return builder;
        },
        async forward(sink) {
          const info = await rpc.call<WsSubscriberInfo>('browser', 'wsObserve', [
            { targetId, urlMatch, filter: selector, forward: sink },
          ]);
          return makeHandle(info);
        },
      };
      return builder;
    },
    async list() {
      return rpc.call<WsSubscriberInfo[]>('browser', 'wsList', []);
    },
  };
}
