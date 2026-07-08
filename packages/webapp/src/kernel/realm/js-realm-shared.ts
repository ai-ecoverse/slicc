/**
 * `js-realm-shared.ts` — JS realm execution logic factored out so
 * both `js-realm-worker.ts` (DedicatedWorker entry, standalone) and
 * an in-process test factory can drive the same code path. The
 * sandbox-iframe variant in `sandbox.html` mirrors this logic but
 * is duplicated there because the iframe runs its own bootstrap
 * script outside the TS module graph.
 *
 * `runJsRealm(init, port)` is the entire entry point: builds a
 * host-resolved CJS module graph for `require()` over the `module`
 * RPC channel, builds RPC-backed `fs` / `exec` / `fetch` shims off
 * the supplied `port`, runs the user code in an `AsyncFunction`,
 * then posts `realm-done` over the same port.
 *
 * `port` is whatever the host gave the realm — for workers it's
 * the worker's own `self` (DedicatedWorkerGlobalScope), for tests
 * it's a `MessagePort`-shaped fake.
 */

import '../../shims/buffer-polyfill.js';
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
  nodeAssert,
  nodeAssertStrict,
  nodeCrypto,
  nodeEvents,
  nodeOs,
  nodePath,
  nodeStream,
  nodeUrl,
  nodeUtil,
  nodeZlib,
  pool,
  time,
} from './js-realm-helpers.js';
import { NODE_BUILTINS_UNAVAILABLE } from './node-builtins.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmInitMsg,
  RealmModuleGraph,
  RealmRpcChannel,
  SerializedFetchResponse,
  TabHandle,
  WsSelector,
  WsSink,
  WsSubscriberInfo,
} from './realm-types.js';
import { NODE_NATIVE_PACKAGES, nativePackageError } from './require-guards.js';
import { createSkillGlobal, type SkillFsBridge } from './skill-global.js';
import { SyncFsCache, type SyncFsSnapshot } from './sync-fs-cache.js';

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
 * Request the `vfs.snapshot` RPC and build the {@link SyncFsCache} it backs.
 * Falls back to an empty cache when the host doesn't support the snapshot op
 * (e.g. a minimal fake host in a unit test) or the walk itself throws — sync
 * fs calls against an empty cache still behave correctly (ENOENT), they just
 * can't see any pre-existing files. Only a realm that actually invokes a
 * `*Sync` method is affected.
 */
async function initSyncFsCache(rpc: RealmRpcClient, cwd: string): Promise<SyncFsCache> {
  let snapshot: SyncFsSnapshot;
  try {
    snapshot = await rpc.call<SyncFsSnapshot>('vfs', 'snapshot', [cwd]);
  } catch {
    snapshot = { entries: [] };
  }
  return new SyncFsCache(snapshot);
}

/**
 * Build the `usb` / `serial` / `hid` device bridges. `request` / `list`
 * resolve device objects whose methods carry the opaque handle and forward
 * every op over the matching realm-RPC channel — the kernel host runs the
 * real device op against the page-side registry (worker float, panel-RPC
 * bridge) or the local `navigator.*` (extension float), same dual-path as
 * `browser`. Extracted out of `runJsRealm` purely to keep that function's
 * line count under the lint gate.
 */
function createDeviceBridges(rpc: RealmRpcClient): {
  usbBridge: RealmUsbApi;
  serialBridge: RealmSerialApi;
  hidBridge: RealmHidApi;
} {
  return {
    usbBridge: createUsbBridge(rpc),
    serialBridge: createSerialBridge(rpc),
    hidBridge: createHidBridge(rpc),
  };
}

/**
 * Run a `kind:'js'` realm against `port`. Posts exactly one
 * `realm-done` (or `realm-error` on a bootstrap throw, which the
 * caller is expected to surface separately). Returns when the
 * `realm-done` has been posted.
 *
 * `require()` resolves synchronously from a host-built CJS module graph
 * (the `module`/`buildGraph` RPC over `port`), preserving `node:`/`sliccy:`
 * schemes and Node built-ins. There is no CDN download path — a missing bare
 * module throws `Cannot find module 'x' (run: ipk install x)` immediately.
 */
export async function runJsRealm(init: RealmInitMsg, port: RealmPortLike): Promise<void> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const writeStdout = (value: unknown): void => {
    stdoutChunks.push(typeof value === 'string' ? value : String(value));
  };
  const writeStderr = (value: unknown): void => {
    stderrChunks.push(typeof value === 'string' ? value : String(value));
  };

  const nodeConsole = createNodeConsole(writeStdout, writeStderr);

  const { processShim, getDidCallProcessExit } = createProcessShim(init, writeStdout, writeStderr);
  const noColor = !!init.env?.NO_COLOR;

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

  const syncFs = await initSyncFsCache(rpc, init.cwd);
  Object.assign(fsBridge, createSyncFsBridge(syncFs, init.cwd));

  const execBridge = createExecBridge(rpc);

  // `skill` is computed once at boot from argv[1] and frozen. It exposes
  // the script-relative path helpers and the skill-scoped config/token
  // store; see `skill-global.ts` for the surface and rationale.
  const skillGlobal = createSkillGlobal({
    argv: init.argv,
    fs: fsBridge as unknown as SkillFsBridge,
    exec: execBridge,
  });

  const browserBridge = createBrowserBridge(rpc);

  // `usb` / `serial` / `hid` mirror the underlying WebUSB / Web Serial /
  // WebHID APIs — see `createDeviceBridges` for the shared-dual-path note.
  const { usbBridge, serialBridge, hidBridge } = createDeviceBridges(rpc);

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

  const filename = init.filename;
  const dirname = dirnameOf(filename);

  const graph = await loadModuleGraph(rpc, init.code, init.cwd, filename);
  const moduleSystem = createModuleSystem({
    graph,
    fsBridge,
    processShim,
    nodeConsole,
    sliccyModules,
  });
  const requireShim = moduleSystem.require;

  const moduleShim = { exports: {} as Record<string, unknown>, filename: init.filename };

  // The host transpiles an ESM / dynamic-import / top-level-await entry to a
  // CJS body the AsyncFunction wrapper can run (and sets `entrySource`); a
  // plain-CJS entry runs verbatim. That presence is exactly Node's CJS-vs-ESM
  // distinction, so it also selects sloppy (CJS) vs strict (ESM) execution.
  const isEsmEntry = graph.entrySource !== undefined;
  const entryCode = graph.entrySource ?? init.code;

  // Host-side WASM compile bridge. Realm code (e.g. the baked biome helper)
  // routes `WebAssembly.compile` of a VFS path to the kernel host so a large
  // module compiles in the high-headroom kernel-worker context instead of
  // OOM-ing this per-task realm worker. Exposed as an internal global rather
  // than a require()-able shim so it stays out of the AsyncFunction param list
  // (parity-pinned) and callers can feature-detect with a `typeof` guard —
  // floats without the bridge (the cross-origin iframe realm) cleanly fall
  // back to in-realm compile. The returned `WebAssembly.Module` is
  // structured-cloneable, so it round-trips over the realm port.
  const g = globalThis as Record<string, unknown>;
  g.__slicc_compileWasm = (path: string): Promise<WebAssembly.Module> =>
    rpc.call('wasm', 'compile', [path]);

  const exitCode = await runUserCode(
    entryCode,
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
    writeStderr,
    isEsmEntry
  );

  await flushSyncFsCache(rpc, syncFs, writeStderr);

  if (!getDidCallProcessExit()) {
    await drainPendingRpcs(rpc);
  }
  delete g.__slicc_compileWasm;
  rpc.dispose();
  port.postMessage({
    type: 'realm-done',
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    exitCode,
  } satisfies RealmDoneMsg);
}

/**
 * Diff the {@link SyncFsCache} against its initial snapshot and flush any
 * created/modified/deleted paths back to the host via `vfs.flushWrites`.
 * Called unconditionally after `runUserCode` — even on a script crash — so
 * partial sync-fs progress is never silently dropped. A no-op mutation set
 * skips the RPC entirely.
 */
async function flushSyncFsCache(
  rpc: RealmRpcClient,
  syncFs: SyncFsCache,
  writeStderr: (value: unknown) => void
): Promise<void> {
  const mutations = syncFs.getMutations();
  if (mutations.created.length || mutations.modified.length || mutations.deleted.length) {
    try {
      await rpc.call('vfs', 'flushWrites', [mutations]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      writeStderr(`[sync-fs] flush failed: ${msg}\n`);
    }
  }
}

/**
 * Yield the event loop to let in-flight callbacks settle before teardown:
 * RPC-backed `.then` chains (fetch/exec) AND fire-and-forget dynamic-import
 * `.then` chains (pure microtasks, no pending RPC — e.g.
 * `import('pkg').then(m => ...)`). We always tick at least once: a single
 * macrotask boundary fully drains the microtask queue, so a non-awaited
 * dynamic import settles before `realm-done` captures stdout — matching Node,
 * which drains microtasks before exit. Bounded by a tick count and a
 * wall-clock ceiling so a never-settling promise cannot hang disposal.
 */
async function drainPendingRpcs(rpc: RealmRpcClient): Promise<void> {
  const maxTicks = 50;
  const deadline = Date.now() + 1000;
  let ticks = 0;
  do {
    await new Promise<void>((r) => setTimeout(r, 0));
    ticks++;
  } while (rpc.pendingCount > 0 && ticks < maxTicks && Date.now() < deadline);
}

function createNodeConsole(
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
) {
  return {
    log: (...parts: unknown[]) =>
      writeStdout(`${parts.map(formatConsoleArg).join(' ')}
`),
    info: (...parts: unknown[]) =>
      writeStdout(`${parts.map(formatConsoleArg).join(' ')}
`),
    warn: (...parts: unknown[]) =>
      writeStderr(`${parts.map(formatConsoleArg).join(' ')}
`),
    error: (...parts: unknown[]) =>
      writeStderr(`${parts.map(formatConsoleArg).join(' ')}
`),
  };
}

function createProcessShim(
  init: RealmInitMsg,
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
): { processShim: Record<string, unknown>; getDidCallProcessExit: () => boolean } {
  const noColor = !!init.env?.NO_COLOR;
  const stdinShim = createStdinShim(init.stdin ?? '');
  const argvWithParseFlags = attachArgvParseFlags(init.argv);
  let didCallProcessExit = false;
  const processShim = {
    argv: argvWithParseFlags,
    env: init.env,
    cwd: () => init.cwd,
    exit: (codeValue?: number) => {
      didCallProcessExit = true;
      const normalized = Number.isFinite(codeValue) ? Number(codeValue) : 0;
      throw new NodeExitError(normalized);
    },
    stdin: stdinShim,
    stdout: { write: writeStdout, isTTY: !noColor },
    stderr: { write: writeStderr, isTTY: !noColor },
  };
  return { processShim, getDidCallProcessExit: () => didCallProcessExit };
}

type ExecResult = { stdout: string; stderr: string; exitCode: number };

function createExecBridge(rpc: RealmRpcClient): ((cmd: string) => Promise<ExecResult>) & {
  spawn: (argv: string[]) => Promise<ExecResult>;
  exec: (cmd: string) => Promise<ExecResult>;
} {
  const execRun = (command: string): Promise<ExecResult> => rpc.call('exec', 'run', [command]);
  const execBridge = Object.assign(execRun, {
    spawn: (argv: string[]): Promise<ExecResult> => rpc.call('exec', 'spawn', [argv]),
  }) as ((cmd: string) => Promise<ExecResult>) & {
    spawn: (argv: string[]) => Promise<ExecResult>;
    exec: typeof execRun;
  };
  execBridge.exec = execBridge;
  return execBridge;
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
  function toBytes(data: unknown): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) {
      const v = data as ArrayBufferView;
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new TextEncoder().encode(typeof data === 'string' ? data : String(data));
  }

  async function readFile(
    path: string,
    opts?: string | { encoding?: string | null } | null
  ): Promise<unknown> {
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    // null encoding explicitly requests raw bytes (Buffer); no opts or any
    // string encoding returns decoded text. This keeps backwards compat with
    // existing .jsh scripts while matching Node's readFile(path, null) → Buffer.
    if (encoding === null || encoding === 'buffer') {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [path]);
      const B = (globalThis as Record<string, unknown>).Buffer as
        | { from: (data: Uint8Array) => unknown }
        | undefined;
      return B ? B.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) : bytes;
    }
    return rpc.call('vfs', 'readFile', [path]);
  }

  async function writeFile(path: string, data: unknown): Promise<true> {
    if (typeof data === 'string') {
      return rpc.call('vfs', 'writeFile', [path, data]);
    }
    return rpc.call('vfs', 'writeFileBinary', [path, toBytes(data)]);
  }

  async function appendFile(path: string, data: unknown): Promise<void> {
    let existing: Uint8Array = new Uint8Array(0);
    const fileExists = await rpc.call<boolean>('vfs', 'exists', [path]);
    if (fileExists) {
      const raw = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [path]);
      existing = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    }
    const suffix = toBytes(data);
    const out = new Uint8Array(existing.byteLength + suffix.byteLength);
    out.set(existing);
    out.set(suffix, existing.byteLength);
    await rpc.call('vfs', 'writeFileBinary', [path, out]);
  }

  async function cp(src: string, dest: string, opts?: { recursive?: boolean }): Promise<void> {
    const srcStat = await rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>(
      'vfs',
      'stat',
      [src]
    );
    if (srcStat.isFile) {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [src]);
      await rpc.call('vfs', 'writeFileBinary', [dest, bytes]);
      return;
    }
    if (!srcStat.isDirectory || !opts?.recursive) {
      throw new Error(`cp: '${src}' is a directory (use {recursive: true})`);
    }
    await mkdirSafe(dest);
    const entries = await rpc.call<string[]>('vfs', 'readDir', [src]);
    for (const entry of entries) {
      await cp(`${src}/${entry}`, `${dest}/${entry}`, opts);
    }
  }

  async function rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<true> {
    if (opts?.force) {
      const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
      if (!exists) return true;
    }
    const stat = await rpc.call<{ isDirectory: boolean; isFile: boolean; size: number }>(
      'vfs',
      'stat',
      [path]
    );
    if (stat.isFile) return rpc.call('vfs', 'rm', [path]);
    if (!opts?.recursive) throw new Error(`rm: '${path}' is a directory (use {recursive: true})`);
    const entries = await rpc.call<string[]>('vfs', 'readDir', [path]);
    for (const entry of entries) {
      await rm(`${path}/${entry}`, opts);
    }
    return rpc.call('vfs', 'rm', [path]);
  }

  async function mkdirSafe(path: string): Promise<void> {
    await rpc.call('vfs', 'mkdir', [path]);
  }

  async function mkdtemp(prefix: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix =
        Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
      const path = `${prefix}${suffix}`;
      const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
      if (!exists) {
        await rpc.call('vfs', 'mkdir', [path]);
        return path;
      }
    }
    throw new Error('mkdtemp: failed to create unique directory after 5 attempts');
  }

  async function rename(oldPath: string, newPath: string): Promise<void> {
    // Use native VFS rename when available; fall back to copy+delete.
    try {
      await rpc.call('vfs', 'rename', [oldPath, newPath]);
    } catch {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [oldPath]);
      await rpc.call('vfs', 'writeFileBinary', [newPath, bytes]);
      await rpc.call('vfs', 'rm', [oldPath]);
    }
  }

  async function access(path: string): Promise<void> {
    const exists = await rpc.call<boolean>('vfs', 'exists', [path]);
    if (!exists)
      throw Object.assign(new Error(`ENOENT: no such file or directory, access '${path}'`), {
        code: 'ENOENT',
      });
  }

  const bridge = {
    readFile,
    readFileBinary: (path: string): Promise<Uint8Array> =>
      rpc.call('vfs', 'readFileBinary', [path]),
    writeFile,
    writeFileBinary: (path: string, bytes: Uint8Array): Promise<true> =>
      rpc.call('vfs', 'writeFileBinary', [path, bytes]),
    appendFile,
    cp,
    rm,
    readDir: (path: string): Promise<string[]> => rpc.call('vfs', 'readDir', [path]),
    readdir: (path: string): Promise<string[]> => rpc.call('vfs', 'readDir', [path]),
    exists: (path: string): Promise<boolean> => rpc.call('vfs', 'exists', [path]),
    stat: (path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> =>
      rpc.call('vfs', 'stat', [path]),
    mkdir: (path: string, _opts?: { recursive?: boolean }): Promise<true> =>
      rpc.call('vfs', 'mkdir', [path]),
    mkdtemp,
    rename,
    access,
    unlink: (path: string): Promise<true> => rpc.call('vfs', 'rm', [path]),
    rmdir: (path: string): Promise<true> => rpc.call('vfs', 'rm', [path]),
    copyFile: async (src: string, dest: string): Promise<void> => {
      const bytes = await rpc.call<Uint8Array>('vfs', 'readFileBinary', [src]);
      await rpc.call('vfs', 'writeFileBinary', [dest, bytes]);
    },
    fetchToFile: async (url: string, path: string): Promise<number> => {
      const response = await realmFetch(url);
      if (!response.ok) throw new Error(`fetch ${response.status} ${response.statusText}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await rpc.call('vfs', 'writeFileBinary', [path, bytes]);
      return bytes.byteLength;
    },
    promises: null as unknown,
  };
  bridge.promises = bridge;
  return bridge;
}

/**
 * Synchronous `fs` API surface (`readFileSync`, `writeFileSync`, etc.) backed
 * by the pre-loaded {@link SyncFsCache}. These are plain synchronous
 * functions — the realm's AsyncFunction wrapper cannot `await` an RPC
 * round-trip from a sync call site, so the cache is populated once via a
 * `vfs.snapshot` RPC before user code runs, and mutations are diffed and
 * flushed back via `vfs.flushWrites` after user code completes (see
 * `runJsRealm`). Merged onto `fsBridge` so `require('fs')` exposes both the
 * async and sync method sets, matching Node's `fs` module shape.
 */
function createSyncFsBridge(syncFs: SyncFsCache, cwd: string) {
  function resolve(p: string): string {
    if (p.startsWith('/')) return p;
    return cwd + (cwd.endsWith('/') ? '' : '/') + p;
  }

  return {
    readFileSync(path: string, opts?: string | { encoding?: string | null } | null): unknown {
      const encoding = typeof opts === 'string' ? opts : opts?.encoding;
      const bytes = syncFs.readFile(resolve(path));
      if (encoding === 'utf8' || encoding === 'utf-8') {
        return new TextDecoder().decode(bytes);
      }
      // Return Buffer if available (realm polyfill), else Uint8Array
      const B = (globalThis as Record<string, unknown>).Buffer as
        | { from: (data: Uint8Array) => unknown }
        | undefined;
      return B ? B.from(bytes) : bytes;
    },
    writeFileSync(path: string, data: unknown): void {
      let bytes: Uint8Array;
      if (typeof data === 'string') {
        bytes = new TextEncoder().encode(data);
      } else if (data instanceof Uint8Array) {
        bytes = data;
      } else if (ArrayBuffer.isView(data)) {
        bytes = new Uint8Array(
          (data as ArrayBufferView).buffer,
          (data as ArrayBufferView).byteOffset,
          (data as ArrayBufferView).byteLength
        );
      } else {
        bytes = new TextEncoder().encode(String(data));
      }
      syncFs.writeFile(resolve(path), bytes);
    },
    existsSync(path: string): boolean {
      return syncFs.exists(resolve(path));
    },
    mkdirSync(path: string, opts?: { recursive?: boolean }): void {
      syncFs.mkdir(resolve(path), opts?.recursive);
    },
    statSync(path: string): { isFile: () => boolean; isDirectory: () => boolean; size: number } {
      const s = syncFs.stat(resolve(path));
      return { isFile: () => s.isFile, isDirectory: () => s.isDirectory, size: s.size };
    },
    readdirSync(path: string): string[] {
      return syncFs.readdir(resolve(path));
    },
    rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void {
      const resolved = resolve(path);
      if (opts?.force && !syncFs.exists(resolved)) return;
      syncFs.rm(resolved, opts?.recursive);
    },
    copyFileSync(src: string, dest: string): void {
      syncFs.copyFile(resolve(src), resolve(dest));
    },
    mkdtempSync(prefix: string): string {
      return syncFs.mkdtemp(resolve(prefix));
    },
    unlinkSync(path: string): void {
      syncFs.unlink(resolve(path));
    },
    renameSync(oldPath: string, newPath: string): void {
      syncFs.rename(resolve(oldPath), resolve(newPath));
    },
  };
}

/**
 * The directory a script's top-level relative `require()`/`import`s resolve
 * against: the script's own directory for a real file path, else the realm cwd
 * (the `node -e` / `<eval>` case).
 */
function entryFromDir(filename: string, cwd: string): string {
  return filename?.startsWith('/') ? dirnameOf(filename) : cwd;
}

/**
 * Cheap pre-check: does the entry code reference any `require`/`import` at all?
 * When it does not, there is nothing for the host to resolve or transpile, so
 * the no-module fast path skips the `module`/buildGraph RPC entirely.
 */
function mightNeedModuleGraph(code: string): boolean {
  return code.includes('require') || code.includes('import');
}

/**
 * Build the host-resolved CJS module graph from the realm's ENTRY CODE via the
 * `module`/`buildGraph` RPC. The host extracts the entry's tagged
 * `require`/`import` specifiers, resolves them per access path, transpiles ESM
 * modules + the entry itself (`entrySource`), and returns the ordered graph.
 * Returns an empty graph (no RPC) when the entry references no module at all.
 */
async function loadModuleGraph(
  rpc: RealmRpcClient,
  code: string,
  cwd: string,
  filename: string
): Promise<RealmModuleGraph> {
  if (!mightNeedModuleGraph(code)) return { files: [], entryMap: {}, edges: {}, errors: {} };
  return rpc.call<RealmModuleGraph>('module', 'buildGraph', [
    code,
    entryFromDir(filename, cwd),
    filename,
  ]);
}

/**
 * Node-faithful CJS default interop: `import def from 'cjs'` binds `def` to the
 * whole `module.exports` REGARDLESS of `__esModule`. Both transpilers honor a
 * Babel-style `__esModule` shim and read a real own `.default` (esbuild's
 * `__toESM` does not synthesize one when `__esModule` is truthy; TS's
 * `__importDefault` returns the module as-is), so a transpiled-CJS module that
 * sets `__esModule:true` but exposes no own `default` (e.g. uuid@9's
 * Babel-compiled `dist/index.js`) would bind `default` to `undefined`. Attach a
 * non-enumerable, configurable, self-referential `default` so esbuild's
 * `__copyProps` (own prop NAMES, incl. non-enumerable) and TS's `__importDefault`
 * both resolve `default` to the whole module. Non-enumerable keeps it invisible
 * to `Object.keys`/`JSON.stringify`; the extensibility guard + try/catch keep a
 * frozen/sealed exports object from throwing. Called ONLY for modules whose
 * origin kind is `cjs` (the `kindByPath` guard in `requireFile`): a
 * host-transpiled ESM module also carries `__esModule:true` with no own
 * `default` when its source declares none (e.g. nanoid@5), and synthesizing a
 * default there would wrongly make `require('nanoid').default` the whole
 * namespace instead of `undefined` (require-of-ESM is Node-faithful with no
 * default). Mirrored in `packages/chrome-extension/sandbox.html`.
 */
function synthesizeEsModuleDefault(exp: unknown): void {
  if (exp === null || typeof exp !== 'object') return;
  const obj = exp as Record<string, unknown>;
  if (!obj.__esModule) return;
  if (Object.prototype.hasOwnProperty.call(obj, 'default')) return;
  if (!Object.isExtensible(obj)) return;
  try {
    Object.defineProperty(obj, 'default', { value: obj, enumerable: false, configurable: true });
  } catch {
    // Frozen/sealed exports: leave as-is (defineProperty would throw).
  }
}

/**
 * Construct the realm's synchronous CJS module system over a preloaded graph.
 * `require` follows the host-resolved `edges`, lazily evaluating each module
 * once and caching `module.exports` so repeated requires return one shared
 * singleton (CJS cache semantics). Module evaluation is synchronous CJS via a
 * `Function` wrapper (Node's `Module._compile` shape). Schemes/built-ins are
 * served first; an unresolved bare specifier throws the install-hint error.
 */
function createModuleSystem(opts: {
  graph: RealmModuleGraph;
  fsBridge: unknown;
  processShim: unknown;
  nodeConsole: unknown;
  sliccyModules: Record<string, unknown>;
}): { require: (id: string) => unknown } {
  const { graph, fsBridge, processShim, nodeConsole, sliccyModules } = opts;
  const sourceByPath = new Map(graph.files.map((f) => [f.path, f.cjsSource]));
  const kindByPath = new Map(graph.files.map((f) => [f.path, f.kind]));
  const cache = new Map<string, { exports: Record<string, unknown> }>();

  const resolveBuiltin = (id: string): { hit: boolean; value?: unknown } => {
    if (typeof id === 'string' && id.startsWith(SLICCY_SCHEME)) {
      return { hit: true, value: resolveSliccyModule(id, sliccyModules) };
    }
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    const served = resolveServedBuiltin(bareId, fsBridge, processShim);
    if (served.hit) return served;
    if (NODE_NATIVE_PACKAGES.has(bareId)) throw nativePackageError(id, bareId);
    if (NODE_BUILTINS_UNAVAILABLE.has(bareId)) throw unavailableBuiltinError(id, bareId);
    return { hit: false };
  };

  const requireFromEdges = (edgeMap: Record<string, string> | undefined, id: string): unknown => {
    const builtin = resolveBuiltin(id);
    if (builtin.hit) return builtin.value;
    const targetPath = edgeMap?.[id];
    if (targetPath) return requireFile(targetPath);
    if (id in graph.errors) throw new Error(graph.errors[id]);
    throw cannotFindModuleError(id);
  };

  function requireFile(path: string): Record<string, unknown> {
    const cached = cache.get(path);
    if (cached) return cached.exports;
    const source = sourceByPath.get(path);
    if (source === undefined) throw new Error(`Cannot find module '${path}'`);
    const moduleObj = { exports: {} as Record<string, unknown> };
    // Register before evaluation so a require cycle sees the partial exports.
    cache.set(path, moduleObj);
    const childRequire = (id: string): unknown => requireFromEdges(graph.edges[path], id);
    const moduleDir = dirnameOf(path);
    const compiled = new Function(
      'module',
      'exports',
      'require',
      '__dirname',
      '__filename',
      'process',
      'console',
      'Buffer',
      'global',
      source
    ) as (...args: unknown[]) => void;
    compiled(
      moduleObj,
      moduleObj.exports,
      childRequire,
      moduleDir,
      path,
      processShim,
      nodeConsole,
      (globalThis as Record<string, unknown>).Buffer,
      globalThis
    );
    if (kindByPath.get(path) === 'cjs') synthesizeEsModuleDefault(moduleObj.exports);
    return moduleObj.exports;
  }

  return {
    require: (id: string): unknown => requireFromEdges(graph.entryMap, id),
  };
}

/**
 * Build the Node `Cannot find module` error for a specifier with no graph
 * edge. Bare package specifiers carry the actionable `ipk install` hint;
 * relative/absolute/`node:` specifiers do not (matching the host resolver).
 */
/**
 * Resolve a bare (scheme-stripped) built-in id to the value the realm serves
 * for it, or `{ hit: false }` when the realm does not serve it directly.
 * Extracted from `resolveBuiltin` so the per-builtin `bareId === '…'` chain
 * stays a flat, low-complexity lookup (and the `node-command-loadmodule` /
 * `js-realm-helpers` parity tests keep matching the literal branches here).
 */
function resolveServedBuiltin(
  bareId: string,
  fsBridge: unknown,
  processShim: unknown
): { hit: boolean; value?: unknown } {
  if (bareId === 'fs') return { hit: true, value: fsBridge };
  // Same object — fsBridge is already Promise-based; callback/sync APIs are not shimmed here.
  if (bareId === 'fs/promises') return { hit: true, value: fsBridge };
  if (bareId === 'path') return { hit: true, value: nodePath };
  if (bareId === 'crypto') return { hit: true, value: nodeCrypto };
  if (bareId === 'process') return { hit: true, value: processShim };
  if (bareId === 'buffer') {
    return { hit: true, value: { Buffer: (globalThis as Record<string, unknown>).Buffer } };
  }
  if (bareId === 'assert') return { hit: true, value: nodeAssert };
  if (bareId === 'assert/strict') return { hit: true, value: nodeAssertStrict };
  if (bareId === 'util') return { hit: true, value: nodeUtil };
  if (bareId === 'events') return { hit: true, value: nodeEvents };
  if (bareId === 'os') return { hit: true, value: nodeOs };
  if (bareId === 'stream') return { hit: true, value: nodeStream };
  if (bareId === 'url') return { hit: true, value: nodeUrl };
  if (bareId === 'zlib') return { hit: true, value: nodeZlib };
  return { hit: false };
}

function cannotFindModuleError(id: string): Error {
  if (id.startsWith('.') || id.startsWith('/') || id.startsWith('node:')) {
    return new Error(`Cannot find module '${id}'`);
  }
  const name = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
  return new Error(`Cannot find module '${id}' (run: ipk install ${name})`);
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

/**
 * Compile `code` into an `AsyncFunction` whose parameter names are the keys of
 * `bridges` (`fs`, `process`, `console`, …) and invoke it with their values.
 * Returns the process exit code: `NodeExitError.code` on `process.exit`, `1`
 * on any other throw (stack written to stderr), `0` otherwise.
 *
 * Node runs a CommonJS entry (a `node <script.js>` target, a `node -e`
 * snippet, an `ipx`/`npx` bin) in SLOPPY mode, but an ES-module entry in
 * STRICT mode. `isEsmEntry` carries that distinction: only an ESM-derived
 * entry (transpiled to `graph.entrySource`) gets the `"use strict"` prefix; a
 * plain-CJS entry runs without it so strict-only reserved words (e.g. a `var
 * implements`) parse as Node would. Required/dependency CJS modules are
 * evaluated sloppy elsewhere and are unaffected.
 */
async function runUserCode(
  code: string,
  bridges: Record<string, unknown>,
  writeStderr: (value: unknown) => void,
  isEsmEntry: boolean
): Promise<number> {
  const names = Object.keys(bridges);
  const values = names.map((n) => bridges[n]);
  const AsyncFn = Object.getPrototypeOf(async function () {
    /* noop */
  }).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;
  const fn = new AsyncFn(...names, `${isEsmEntry ? '"use strict";\n' : ''}${code}`);
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
