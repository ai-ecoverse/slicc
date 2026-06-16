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
import type { HidDeviceFilter, HidDeviceInfo } from '../hid-device-registry.js';
import type {
  SerialDeviceInfo,
  SerialFilter,
  SerialInputSignals,
  SerialOpenOptions,
  SerialOutputSignals,
} from '../serial-port-registry.js';
import type { UsbControlSetup, UsbDeviceFilter, UsbDeviceInfo } from '../usb-device-registry.js';
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
  RealmRpcChannel,
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

const SLICCY_SCHEME = 'sliccy:';

function dirnameOf(filePath: string): string {
  if (!filePath) return '';
  const idx = filePath.lastIndexOf('/');
  if (idx < 0) return '';
  if (idx === 0) return '/';
  return filePath.substring(0, idx);
}

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

  // `process.stdin` is the only stdin surface (see `createStdinShim`).
  const stdinShim = createStdinShim(init.stdin ?? '');

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

  const fsBridge = createFsBridge(rpc, realmFetch);

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
  }) as ((cmd: string) => Promise<ExecResult>) & {
    spawn: (argv: string[]) => Promise<ExecResult>;
    exec: typeof execRun;
  };
  execBridge.exec = execBridge;

  // `skill` is computed once at boot from argv[1] and frozen. It exposes
  // the script-relative path helpers and the skill-scoped config/token
  // store; see `skill-global.ts` for the surface and rationale.
  const skillGlobal = createSkillGlobal({ argv: init.argv, fs: fsBridge, exec: execBridge });

  const browserBridge = createBrowserBridge(rpc);

  // `usb` / `serial` / `hid` mirror the underlying WebUSB / Web Serial /
  // WebHID APIs. `request` / `list` resolve device objects whose methods
  // carry the opaque handle and forward every op over the matching
  // realm-RPC channel — the kernel host runs the real device op against
  // the page-side registry (worker float, panel-RPC bridge) or the local
  // `navigator.*` (extension float), same dual-path as `browser`.
  const usbBridge = createUsbBridge(rpc);
  const serialBridge = createSerialBridge(rpc);
  const hidBridge = createHidBridge(rpc);

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

  const sliccyModules = buildSliccyModules({
    exec: execBridge,
    skill: skillGlobal,
    http: httpGlobal,
    browser: browserBridge,
    usb: usbBridge,
    serial: serialBridge,
    hid: hidBridge,
    cli: cliApi,
    color: colorApi,
  });

  const requireCache = await preloadRequires(init.code, init.env, loadModule, writeStderr);
  const requireShim = createRequireShim(requireCache, fsBridge, processShim, sliccyModules);

  const moduleShim = { exports: {} as Record<string, unknown>, filename: init.filename };

  const filename = init.filename;
  const dirname = dirnameOf(filename);

  const exitCode = await runUserCode(
    init.code,
    {
      process: processShim,
      console: nodeConsole,
      require: requireShim,
      module: moduleShim,
      exports: moduleShim.exports,
      fetch: realmFetch,
      __dirname: dirname,
      __filename: filename,
    },
    writeStderr
  );

  rpc.dispose();
  const done: RealmDoneMsg = {
    type: 'realm-done',
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  };
  port.postMessage(done);
}

function buildSliccyModules(bridges: Record<string, unknown>): Record<string, unknown> {
  return { ...bridges, time, fmt, pool };
}

/**
 * `process.stdin` shim. `init.stdin` arrives as a buffered, read-ahead
 * string from the kernel (the AlmostBashShell exec pipeline, `.jsh`
 * commands, `node`/`node -e`), so there's no streaming Readable.
 *
 * EOF semantics match Node's `Readable.read()`: the first `read()` returns
 * the full buffer, subsequent calls return `null`. A single `consumed` flag
 * is shared with the async iterator so `for await (const c of process.stdin)`
 * after a `read()` (or a second iteration) yields nothing. `toString()`
 * always returns the original buffer; `isTTY` is always `false`.
 */
function createStdinShim(stdinBuffer: string) {
  let consumed = false;
  return {
    isTTY: false,
    read(): string | null {
      if (consumed) return null;
      consumed = true;
      return stdinBuffer;
    },
    toString(): string {
      return stdinBuffer;
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        async next(): Promise<IteratorResult<string>> {
          if (consumed) return { value: undefined, done: true };
          consumed = true;
          return { value: stdinBuffer, done: false };
        },
      };
    },
  };
}

/** RPC-backed `fs` bridge (the realm's `require('fs')` / `fs` global). */
function createFsBridge(
  rpc: RealmRpcClient,
  realmFetch: (input: string | URL | Request, opts?: RequestInit) => Promise<Response>
) {
  return {
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
}

/**
 * Pre-fetch require specifiers — one esm.sh request per unique id, resolved
 * exports stashed in the returned cache. Failures go to stderr but don't
 * abort the run. Node-native packages (sharp, sqlite3, …) are hard-failed up
 * front (their CDN entries chain into hanging `.node` loader fetches), and
 * every load is wrapped in `withTimeout` so a stuck import can't park the realm.
 */
async function preloadRequires(
  code: string,
  env: RealmInitMsg['env'],
  loadModule: (id: string) => Promise<Record<string, unknown>>,
  writeStderr: (value: unknown) => void
): Promise<Record<string, unknown>> {
  const specifiers = extractRequireSpecifiers(code);
  const filteredSpecifiers = specifiers
    .filter((s) => !s.startsWith(SLICCY_SCHEME))
    .map((s) => (s.startsWith('node:') ? s.slice(5) : s))
    .filter((s) => !BUILTINS_LOCAL.has(s) && !NODE_BUILTINS_UNAVAILABLE.has(s));
  const nativeSpecifiers = filteredSpecifiers.filter((s) => NODE_NATIVE_PACKAGES.has(s));
  const loadableSpecifiers = filteredSpecifiers.filter((s) => !NODE_NATIVE_PACKAGES.has(s));
  for (const id of nativeSpecifiers) {
    writeStderr(`Warning: ${nativePackageError(id, id).message}\n`);
  }
  const requireCache: Record<string, unknown> = Object.create(null);
  const loadModuleTimeoutMs = resolveLoadModuleTimeoutMs(env);
  if (loadableSpecifiers.length === 0) return requireCache;
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
  return requireCache;
}

/**
 * Resolve a `sliccy:<name>` specifier against the per-realm registry. Unknown
 * names and the empty form throw a scheme-specific error; sliccy: requires
 * NEVER consult the require cache or fall through to node-builtin handling.
 */
function resolveSliccyModule(id: string, sliccyModules: Record<string, unknown>): unknown {
  const name = id.slice(SLICCY_SCHEME.length);
  if (name === '') {
    throw new Error("require('sliccy:'): empty sliccy: module name");
  }
  if (!Object.prototype.hasOwnProperty.call(sliccyModules, name)) {
    throw new Error(
      `require('${id}'): unknown sliccy: module '${name}'. Known names: ${Object.keys(sliccyModules).sort().join(', ')}`
    );
  }
  return sliccyModules[name];
}

const UNAVAILABLE_BUILTIN_HINTS: Record<string, string> = {
  http: ' Use fetch() instead.',
  https: ' Use fetch() instead.',
  child_process: ' Use exec() which is available as a shell bridge.',
  crypto: ' Use globalThis.crypto (Web Crypto API) instead.',
};

function unavailableBuiltinError(id: string, bareId: string): Error {
  return new Error(
    `require('${id}'): Node built-in '${bareId}' is not available in the browser environment.${UNAVAILABLE_BUILTIN_HINTS[bareId] || ''}`
  );
}

function resolvePathRequire(id: string, requireCache: Record<string, unknown>): unknown {
  if ('path' in requireCache) return requireCache['path'];
  if (id in requireCache) return requireCache[id];
  throw new Error(
    `require('${id}'): path module not pre-loaded. Add require('path') as a static import.`
  );
}

/** Synchronous `require(id)` resolving from the pre-loaded cache + built-ins. */
function createRequireShim(
  requireCache: Record<string, unknown>,
  fsBridge: unknown,
  processShim: unknown,
  sliccyModules: Record<string, unknown>
): (id: string) => unknown {
  return (id: string): unknown => {
    if (typeof id === 'string' && id.startsWith(SLICCY_SCHEME)) {
      return resolveSliccyModule(id, sliccyModules);
    }
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    if (bareId === 'fs') return fsBridge;
    if (bareId === 'process') return processShim;
    if (bareId === 'buffer') return { Buffer: (globalThis as Record<string, unknown>).Buffer };
    if (bareId === 'path') return resolvePathRequire(id, requireCache);
    if (NODE_NATIVE_PACKAGES.has(bareId)) throw nativePackageError(id, bareId);
    if (NODE_BUILTINS_UNAVAILABLE.has(bareId)) throw unavailableBuiltinError(id, bareId);
    if (id in requireCache) return requireCache[id];
    if (bareId in requireCache) return requireCache[bareId];
    throw new Error(
      `require('${id}'): module not pre-loaded. Use a string literal so it can be pre-fetched, or use \`await import('${esmShUrl(id).toString()}')\` directly.`
    );
  };
}

/**
 * Compile `code` into an `AsyncFunction` whose parameter names are the keys of
 * `bridges` (`fs`, `process`, `console`, …) and invoke it with their values.
 * Returns the process exit code: `NodeExitError.code` on `process.exit`, `1`
 * on any other throw (stack written to stderr), `0` otherwise.
 */
async function runUserCode(
  code: string,
  bridges: Record<string, unknown>,
  writeStderr: (value: unknown) => void
): Promise<number> {
  const names = Object.keys(bridges);
  const values = names.map((n) => bridges[n]);
  const AsyncFn = Object.getPrototypeOf(async function () {
    /* noop */
  }).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFn(...names, `"use strict";\n${code}`);
  try {
    await fn(...values);
    return 0;
  } catch (err: unknown) {
    if (err instanceof NodeExitError) return err.code;
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    writeStderr(`${message}\n`);
    return 1;
  }
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
/**
 * Kernel-side CDP `browser` bridge — wraps the same BrowserAPI `playwright-cli`
 * uses so standalone and extension floats share one realm surface. Accepts a
 * `TabHandle` (from `findTab` / `ensureTab`) or a bare `targetId` string;
 * `eval` / `evalAsync` serialize functions to a string call expression so realm
 * code can pass a closure as ergonomically as a string.
 */
function createBrowserBridge(rpc: RealmRpcClient) {
  return {
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
}

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

// ---------------------------------------------------------------------------
// `usb` / `serial` / `hid` device globals
// ---------------------------------------------------------------------------

/**
 * Minimal RPC surface the device bridges need. A structural slice of
 * `RealmRpcClient` so tests can inject a recording mock without booting
 * a worker / port pair. `onEvent` is optional so existing callers that
 * predate the device-event channel still type-check; the HID device
 * surface degrades to no-op event delivery when it's missing (the
 * registration succeeds, but no host pushes can land).
 */
export interface DeviceRpc {
  call<T = unknown>(channel: RealmRpcChannel, op: string, args?: unknown[]): Promise<T>;
  onEvent?(channel: string, handler: (payload: unknown) => void): () => void;
}

/** Binary payloads cross the bridge as `Uint8Array`; coerce any view. */
function toRealmBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('expected an ArrayBuffer or typed array');
}

/** Wrap returned bytes as a `DataView`, mirroring the browser device APIs. */
function bytesToDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Accept a single filter object or an array; normalize to an array. */
function asFilterArray<T>(filters: T | T[] | undefined): T[] {
  if (filters === undefined || filters === null) return [];
  return Array.isArray(filters) ? filters : [filters];
}

/** Host-side in/out transfer result shapes (pre-DataView wrapping). */
interface WireInResult {
  status: string;
  bytes: Uint8Array;
}
interface WireOutResult {
  status: string;
  bytesWritten: number;
}

/** A realm-facing WebUSB device. Methods carry the opaque handle. */
export interface RealmUsbDevice extends UsbDeviceInfo {
  open(): Promise<void>;
  close(): Promise<void>;
  reset(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  controlTransferIn(
    setup: UsbControlSetup,
    length: number
  ): Promise<{ status: string; data: DataView }>;
  controlTransferOut(
    setup: UsbControlSetup,
    data: ArrayBuffer | ArrayBufferView
  ): Promise<WireOutResult>;
  transferIn(endpointNumber: number, length: number): Promise<{ status: string; data: DataView }>;
  transferOut(endpointNumber: number, data: ArrayBuffer | ArrayBufferView): Promise<WireOutResult>;
}

export interface RealmUsbApi {
  list(): Promise<RealmUsbDevice[]>;
  request(filters?: UsbDeviceFilter | UsbDeviceFilter[]): Promise<RealmUsbDevice>;
}

function makeUsbDevice(rpc: DeviceRpc, info: UsbDeviceInfo): RealmUsbDevice {
  const h = info.handle;
  const toData = (r: WireInResult) => ({ status: r.status, data: bytesToDataView(r.bytes) });
  return {
    ...info,
    open: () => rpc.call<void>('usb', 'open', [h]),
    close: () => rpc.call<void>('usb', 'close', [h]),
    reset: () => rpc.call<void>('usb', 'reset', [h]),
    selectConfiguration: (value) => rpc.call<void>('usb', 'selectConfig', [h, value]),
    claimInterface: (n) => rpc.call<void>('usb', 'claim', [h, n]),
    releaseInterface: (n) => rpc.call<void>('usb', 'release', [h, n]),
    controlTransferIn: async (setup, length) =>
      toData(await rpc.call<WireInResult>('usb', 'controlIn', [h, setup, length])),
    controlTransferOut: (setup, data) =>
      rpc.call<WireOutResult>('usb', 'controlOut', [h, setup, toRealmBytes(data)]),
    transferIn: async (ep, length) =>
      toData(await rpc.call<WireInResult>('usb', 'transferIn', [h, ep, length])),
    transferOut: (ep, data) =>
      rpc.call<WireOutResult>('usb', 'transferOut', [h, ep, toRealmBytes(data)]),
  };
}

/** Build the realm `usb` global. Exported for parity / unit tests. */
export function createUsbBridge(rpc: DeviceRpc): RealmUsbApi {
  return {
    list: async () =>
      (await rpc.call<UsbDeviceInfo[]>('usb', 'list', [])).map((i) => makeUsbDevice(rpc, i)),
    request: async (filters) =>
      makeUsbDevice(rpc, await rpc.call<UsbDeviceInfo>('usb', 'request', [asFilterArray(filters)])),
  };
}

/** Params accepted by `port.read()`. `bytes` is an alias for `maxBytes`. */
export interface RealmSerialReadParams {
  bytes?: number;
  maxBytes?: number;
  until?: ArrayBuffer | ArrayBufferView;
  timeoutMs?: number;
}

/** A realm-facing Web Serial port. Methods carry the opaque handle. */
export interface RealmSerialPort extends SerialDeviceInfo {
  open(options: SerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  read(params?: RealmSerialReadParams): Promise<Uint8Array>;
  write(data: ArrayBuffer | ArrayBufferView): Promise<number>;
  getSignals(): Promise<SerialInputSignals>;
  setSignals(signals: SerialOutputSignals): Promise<void>;
}

export interface RealmSerialApi {
  list(): Promise<RealmSerialPort[]>;
  request(filters?: SerialFilter | SerialFilter[]): Promise<RealmSerialPort>;
}

function makeSerialPort(rpc: DeviceRpc, info: SerialDeviceInfo): RealmSerialPort {
  const h = info.handle;
  return {
    ...info,
    open: (options) => rpc.call<void>('serial', 'open', [h, options]),
    close: () => rpc.call<void>('serial', 'close', [h]),
    read: (params = {}) =>
      rpc.call<Uint8Array>('serial', 'read', [
        h,
        {
          maxBytes: params.maxBytes ?? params.bytes,
          until: params.until ? toRealmBytes(params.until) : undefined,
          timeoutMs: params.timeoutMs,
        },
      ]),
    write: (data) => rpc.call<number>('serial', 'write', [h, toRealmBytes(data)]),
    getSignals: () => rpc.call<SerialInputSignals>('serial', 'getSignals', [h]),
    setSignals: (signals) => rpc.call<void>('serial', 'setSignals', [h, signals]),
  };
}

/** Build the realm `serial` global. Exported for parity / unit tests. */
export function createSerialBridge(rpc: DeviceRpc): RealmSerialApi {
  return {
    list: async () =>
      (await rpc.call<SerialDeviceInfo[]>('serial', 'list', [])).map((i) => makeSerialPort(rpc, i)),
    request: async (filters) =>
      makeSerialPort(
        rpc,
        await rpc.call<SerialDeviceInfo>('serial', 'request', [asFilterArray(filters)])
      ),
  };
}

/** Event payload delivered to `device.addEventListener('inputreport', cb)`. */
export interface RealmHidInputReportEvent {
  reportId: number;
  data: DataView;
}

/** Event payload delivered to `device.addEventListener('disconnect', cb)`. */
export interface RealmHidDisconnectEvent {
  handle: string;
}

export type RealmHidEventType = 'inputreport' | 'disconnect';
export type RealmHidInputReportListener = (event: RealmHidInputReportEvent) => void;
export type RealmHidDisconnectListener = (event: RealmHidDisconnectEvent) => void;
export type RealmHidEventListener = RealmHidInputReportListener | RealmHidDisconnectListener;

/**
 * A realm-facing WebHID device. Methods carry the opaque handle. Event
 * methods mirror `EventTarget` semantics so VIA-style request/response
 * (`addEventListener('inputreport', cb)` → `sendReport()` → cb fires)
 * runs as one script in `node -e` / `.jsh`. The first `'inputreport'`
 * listener lazily kicks the host into subscribing to backend reports;
 * the last `removeEventListener` (or realm teardown via `rpc.dispose()`)
 * unsubscribes so no leaked listeners survive. `'disconnect'` registers
 * but stays inert today — the backend has no navigator-level disconnect
 * relay yet (sibling task).
 */
export interface RealmHidDevice extends HidDeviceInfo {
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: ArrayBuffer | ArrayBufferView): Promise<void>;
  sendFeatureReport(reportId: number, data: ArrayBuffer | ArrayBufferView): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: 'inputreport', listener: RealmHidInputReportListener): void;
  addEventListener(type: 'disconnect', listener: RealmHidDisconnectListener): void;
  addEventListener(type: RealmHidEventType, listener: RealmHidEventListener): void;
  removeEventListener(type: 'inputreport', listener: RealmHidInputReportListener): void;
  removeEventListener(type: 'disconnect', listener: RealmHidDisconnectListener): void;
  removeEventListener(type: RealmHidEventType, listener: RealmHidEventListener): void;
  /** Alias for `addEventListener('inputreport', cb)`. */
  onInputReport(listener: RealmHidInputReportListener): void;
}

export interface RealmHidApi {
  list(): Promise<RealmHidDevice[]>;
  request(filters?: HidDeviceFilter | HidDeviceFilter[]): Promise<RealmHidDevice>;
}

interface HidEventPayload {
  handle: string;
  reportId: number;
  bytes: Uint8Array;
}

function makeHidDevice(rpc: DeviceRpc, info: HidDeviceInfo): RealmHidDevice {
  const h = info.handle;
  const inputListeners = new Set<RealmHidInputReportListener>();
  const disconnectListeners = new Set<RealmHidDisconnectListener>();
  // `inputSubscribed` toggles synchronously with the first/last listener
  // so concurrent `addEventListener` calls don't race the subscribe RPC.
  // A failed subscribe rolls the flag back so the next add retries.
  let inputSubscribed = false;
  let offRpcEvent: (() => void) | null = null;

  const dispatchInput = (payload: unknown): void => {
    const p = payload as HidEventPayload | null | undefined;
    if (!p || p.handle !== h) return;
    const event: RealmHidInputReportEvent = {
      reportId: p.reportId,
      data: bytesToDataView(p.bytes),
    };
    for (const cb of [...inputListeners]) {
      try {
        cb(event);
      } catch {
        // Listener faults are swallowed — mirrors the event-fan-out
        // pattern in `RealmRpcClient.onEvent` / `panel-rpc.ts`. The
        // realm host process keeps streaming reports to peers.
      }
    }
  };

  const ensureInputSubscription = (): void => {
    if (inputSubscribed) return;
    inputSubscribed = true;
    offRpcEvent = rpc.onEvent ? rpc.onEvent('hid-input-report', dispatchInput) : null;
    void rpc.call<void>('hid', 'subscribeInputReports', [h]).catch(() => {
      // Backend subscribe failed (e.g. device closed in another realm).
      // Roll back so a fresh listener add can retry; detach the local
      // RPC subscriber to avoid leaking the fan-out callback.
      inputSubscribed = false;
      offRpcEvent?.();
      offRpcEvent = null;
    });
  };

  const maybeUnsubscribeInput = (): void => {
    if (!inputSubscribed || inputListeners.size > 0) return;
    inputSubscribed = false;
    offRpcEvent?.();
    offRpcEvent = null;
    void rpc.call<void>('hid', 'unsubscribeInputReports', [h]).catch(() => {
      // Best-effort teardown — the realm-host disposer drains stragglers.
    });
  };

  return {
    ...info,
    open: () => rpc.call<void>('hid', 'open', [h]),
    close: () => rpc.call<void>('hid', 'close', [h]),
    sendReport: (reportId, data) =>
      rpc.call<void>('hid', 'sendReport', [h, reportId, toRealmBytes(data)]),
    sendFeatureReport: (reportId, data) =>
      rpc.call<void>('hid', 'sendFeatureReport', [h, reportId, toRealmBytes(data)]),
    receiveFeatureReport: async (reportId) => {
      const r = await rpc.call<{ reportId: number; bytes: Uint8Array }>(
        'hid',
        'receiveFeatureReport',
        [h, reportId]
      );
      return bytesToDataView(r.bytes);
    },
    addEventListener(type: RealmHidEventType, listener: RealmHidEventListener): void {
      if (type === 'inputreport') {
        inputListeners.add(listener as RealmHidInputReportListener);
        ensureInputSubscription();
      } else if (type === 'disconnect') {
        disconnectListeners.add(listener as RealmHidDisconnectListener);
      } else {
        throw new TypeError(`hid device: unknown event type '${String(type)}'`);
      }
    },
    removeEventListener(type: RealmHidEventType, listener: RealmHidEventListener): void {
      if (type === 'inputreport') {
        inputListeners.delete(listener as RealmHidInputReportListener);
        maybeUnsubscribeInput();
      } else if (type === 'disconnect') {
        disconnectListeners.delete(listener as RealmHidDisconnectListener);
      }
    },
    onInputReport(listener: RealmHidInputReportListener): void {
      inputListeners.add(listener);
      ensureInputSubscription();
    },
  };
}

/** Build the realm `hid` global. Exported for parity / unit tests. */
export function createHidBridge(rpc: DeviceRpc): RealmHidApi {
  return {
    list: async () =>
      (await rpc.call<HidDeviceInfo[]>('hid', 'list', [])).map((i) => makeHidDevice(rpc, i)),
    request: async (filters) => {
      // The backend grants every interface of a multi-interface device
      // (e.g. VIA/QMK keyboards) and returns the full list; the realm
      // surface keeps a single-device shape and exposes the first
      // granted interface. Realm code that needs a specific interface
      // can fall back to `hid.list()` for siblings.
      const granted = await rpc.call<HidDeviceInfo[]>('hid', 'request', [asFilterArray(filters)]);
      const info = granted[0];
      if (!info) throw new Error('No device selected.');
      return makeHidDevice(rpc, info);
    },
  };
}
