/**
 * `js-realm-shared.ts` — JS realm entry point and orchestration, factored
 * out so both `js-realm-worker.ts` (DedicatedWorker entry, standalone) and
 * an in-process test factory can drive the same code path.
 *
 * `runJsRealm(init, port)` is the entire entry point: it wires together the
 * per-concern bridge modules (`realm-fs-bridge`, `realm-exec-bridge`,
 * `realm-browser-bridge`, the device bridges, `realm-module-system`, …),
 * builds a host-resolved CJS module graph for `require()` over the `module`
 * RPC channel off the supplied `port`, runs the user code, then posts
 * `realm-done` over the same port. Only the orchestration glue
 * (`initSyncFsCache`, `createDeviceBridges`, sync-fs flush/drain helpers,
 * `realmFetch`) lives here now — each shim/bridge lives in its own
 * `realm-*.ts` sibling.
 *
 * `port` is whatever the host gave the realm — for workers it's
 * the worker's own `self` (DedicatedWorkerGlobalScope), for tests
 * it's a `MessagePort`-shaped fake.
 */

import '../../shims/buffer-polyfill.js';
import { readSliccVersion } from '../../base/slicc-version.js';
import type { EmscriptenFsForHook, EmscriptenVfsHandle } from './emscripten-vfs-hook.js';
import { createNodeReadline } from './helpers/node-readline.js';
import { createHttpGlobal } from './http-global.js';
import {
  createCli,
  createColor,
  createNodeChildProcess,
  createNodeOs,
  createNodeUtil,
} from './js-realm-helpers.js';
import { createSliccyAgentModule } from './realm-agent-module.js';
import type { BodyReadHandleTracker } from './realm-body-handles.js';
import { createBrowserBridge, serializeRequestInit } from './realm-browser-bridge.js';
import { createComputerBridge, type RealmComputerApi } from './realm-computer-bridge.js';
import { createExecBridge } from './realm-exec-bridge.js';
import { reconstructFetchResponse } from './realm-fetch-response.js';
import {
  createFsBridge,
  createSyncFsBridge,
  latin1ToBytes,
  type RealmStdioBridge,
} from './realm-fs-bridge.js';
import { createHidBridge, type RealmHidApi } from './realm-hid-bridge.js';
import {
  buildShimmedPackages,
  buildSliccyModules,
  createModuleSystem,
  loadModuleGraph,
  type ModuleExports,
  type RealmUserCodeBridges,
  runUserCode,
} from './realm-module-system.js';
import {
  createNodeConsole,
  createProcessShim,
  dirnameOf,
  installGlobalProcess,
  NodeExitError,
} from './realm-node-shims.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
import { createSerialBridge, type RealmSerialApi } from './realm-serial-bridge.js';
import { resolveSyncFsBridge, resolveSyncSabTransport } from './realm-sync-transport.js';
import { createTimerHandleTracker, type TimerHandleTracker } from './realm-timer-handles.js';
import type {
  RealmDoneMsg,
  RealmFsDeleteMsg,
  RealmFsWriteMsg,
  RealmInitMsg,
  RealmOutputMsg,
  SerializedFetchResponse,
} from './realm-types.js';
import { createUsbBridge, type RealmUsbApi } from './realm-usb-bridge.js';
import { createSkillGlobal, type SkillFsBridge } from './skill-global.js';
import { createSyncExecXhrBridge, type SyncExecXhrBridge } from './sync-exec-xhr-bridge.js';
import { SyncFsCache, type SyncFsSnapshot } from './sync-fs-cache.js';
import type { SyncFsPosixBridge } from './sync-fs-xhr-bridge.js';
import { createSyncExecSabTransport } from './sync-sab-bridge.js';

const OUTPUT_TAIL_MAX = 64 * 1024;

function appendOutputTail(current: string, chunk: string): string {
  if (!chunk) return current;
  const next = current + chunk;
  return next.length <= OUTPUT_TAIL_MAX ? next : next.slice(next.length - OUTPUT_TAIL_MAX);
}

/**
 * Request the `vfs.snapshot` RPC and build the {@link SyncFsCache} it backs.
 * Falls back to an empty cache when the host doesn't support the snapshot op
 * (e.g. a minimal fake host in a unit test) or the walk itself throws. With the
 * SW bridge enabled a genuine failure is surfaced via `onError` (see the
 * caller): a warm boot cache is still the fast path even with phase-2 metadata
 * bridging — every existsSync/statSync/readdirSync on a snapshot-covered path
 * skips the sync-XHR round-trip. readFileSync and metadata ops recover a live
 * entry via the bridge on a cache miss (ENOENT/ENOSYNC → bridge), so an empty
 * cache degrades to correct-but-slow rather than wrong; the breadcrumb keeps
 * the perf regression diagnosable (matching flushSyncFsCache /
 * resnapshotAfterExec). A no-bridge / minimal-host realm passes no `onError`,
 * so an unsupported snapshot op stays quiet (an empty cache is correct there).
 */
export async function initSyncFsCache(
  rpc: RealmRpcClient,
  cwd: string,
  onError?: (message: string) => void
): Promise<SyncFsCache> {
  let snapshot: SyncFsSnapshot;
  try {
    snapshot = await rpc.call<SyncFsSnapshot>('vfs', 'snapshot', [cwd]);
  } catch (err) {
    onError?.(err instanceof Error ? err.message : String(err));
    snapshot = { entries: [] };
  }
  return new SyncFsCache(snapshot);
}

/**
 * Breadcrumb sink for {@link initSyncFsCache}. Only a bridge-enabled realm (a
 * page-confirmed SW-controlled leader) wires one: there the host genuinely
 * supports `snapshot`, so a rejection is a real failure worth surfacing
 * (cache-only metadata would otherwise report absent for existing files). A
 * no-bridge / minimal test host passes no token → `undefined` → stays quiet.
 */
function syncFsSnapshotErrorSink(
  init: RealmInitMsg,
  writeStderr: (value: unknown) => void
): ((message: string) => void) | undefined {
  if (!init.syncFsToken) return undefined;
  return (message) =>
    writeStderr(`[sync-fs] snapshot failed, sync metadata will be incomplete: ${message}\n`);
}

/**
 * Publish `__slicc_mountVfs` (see `emscripten-vfs-hook.ts`) so an Emscripten
 * tool running in this realm can mount the live VFS into its `FS`. The hook
 * module loads on first call, keeping it off the kernel-worker boot graph.
 */
function installMountVfsHook(
  bridge: SyncFsPosixBridge,
  syncFs: SyncFsCache,
  cwd: string,
  stdio: RealmStdioBridge
): void {
  (globalThis as GlobalWithWasmCompile).__slicc_mountVfs = async (fs, opts) => {
    const { mountVfsIntoEmscripten } = await import('./emscripten-vfs-hook.js');
    return mountVfsIntoEmscripten(
      fs,
      { bridge, syncFs, cwd, warn: (m) => stdio.writeStderr(`slicc: ${m}\n`) },
      opts
    );
  };
}

/**
 * Install both synchronous bridges, built off the ONE per-realm capability
 * token. The sync `fs` shim is merged into `fsBridge`; the `child_process` sync
 * forms ride their own blocking channel but share the fs bridge and the cache,
 * so they can flush pending sync-fs mutations to the live VFS before a command
 * runs and invalidate the cache after it. Returns the exec bridge (`undefined`
 * on a realm with no token — the sync `child_process` forms then throw).
 */
function installSyncBridges(
  init: RealmInitMsg,
  port: RealmPortLike,
  syncFs: SyncFsCache,
  fsBridge: object,
  stdio: RealmStdioBridge
): SyncExecXhrBridge | undefined {
  const sab = resolveSyncSabTransport(init, port);
  const syncFsXhr = resolveSyncFsBridge(init, sab);
  const persist = {
    write: (path: string, bytes: Uint8Array): void => {
      port.postMessage({ type: 'realm-fs-write', path, bytes } satisfies RealmFsWriteMsg);
    },
    delete: (path: string): void => {
      port.postMessage({ type: 'realm-fs-delete', path } satisfies RealmFsDeleteMsg);
    },
  };
  Object.assign(fsBridge, createSyncFsBridge(syncFs, init.cwd, syncFsXhr, stdio, persist));
  if (syncFsXhr) installMountVfsHook(syncFsXhr, syncFs, init.cwd, stdio);
  if (!init.syncFsToken) return undefined;
  return createSyncExecXhrBridge(init.syncFsToken, {
    syncFs,
    ...(syncFsXhr ? { fsBridge: syncFsXhr } : {}),
    ...(sab ? { transport: createSyncExecSabTransport(sab), noDefaultDeadline: true } : {}),
  });
}

/**
 * `globalThis` narrowed to the realm-internal WASM compile bridge hook and the
 * `SLICC_VERSION` capability marker realm scripts read (see `installSliccVersion`).
 */
type GlobalWithWasmCompile = typeof globalThis & {
  __slicc_compileWasm?: (path: string) => Promise<WebAssembly.Module>;
  __slicc_mountVfs?: (
    fs: EmscriptenFsForHook,
    opts?: { cwd?: string }
  ) => Promise<EmscriptenVfsHandle>;
  SLICC_VERSION?: string;
};

/**
 * Publish the running SLICC version as `globalThis.SLICC_VERSION` so a skill or
 * script can gate on a capability without shelling out to `uname -r`. Same
 * single source as `uname` and `upgrade status`: `__SLICC_VERSION__`, baked
 * from the root `package.json` at build time. Non-enumerable and read-only so
 * user code can't leave a forged version behind for the next realm on a
 * globalThis the host also owns.
 */
export function installSliccVersion(target: typeof globalThis = globalThis): void {
  if (Object.prototype.hasOwnProperty.call(target, 'SLICC_VERSION')) return;
  Object.defineProperty(target, 'SLICC_VERSION', {
    value: readSliccVersion().version,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

/**
 * Build the realm's `c` / `cli` pair. Constructed together so cli.die/warn
 * can call into the colorizer without skills having to wire their own.
 * Extracted from `runJsRealm` purely for the function-length lint gate.
 */
function createColorAndCli(
  noColor: boolean,
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
): { colorApi: ReturnType<typeof createColor>; cliApi: ReturnType<typeof createCli> } {
  const colorApi = createColor({ isTTY: !noColor, noColor });
  const cliApi = createCli({
    writeStdout,
    writeStderr,
    exit: (code: number): never => {
      throw new NodeExitError(code);
    },
    color: colorApi,
  });
  return { colorApi, cliApi };
}

/**
 * Stdio access for the fs bridges' fd / `/dev/std*` support. Reads the stdin
 * BUFFER directly (latin1 → bytes), so `readFileSync(0)` does not consume
 * `process.stdin`'s one-shot flag; writes share the realm's stdout/stderr
 * chunk sinks with `process.stdout`/`process.stderr`.
 */
function createRealmStdio(
  init: RealmInitMsg,
  writeStdout: (value: unknown) => void,
  writeStderr: (value: unknown) => void
): RealmStdioBridge {
  return {
    readStdinBytes: () => latin1ToBytes(init.stdin ?? ''),
    writeStdout,
    writeStderr,
  };
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
  computerBridge: RealmComputerApi;
} {
  return {
    usbBridge: createUsbBridge(rpc),
    serialBridge: createSerialBridge(rpc),
    hidBridge: createHidBridge(rpc),
    computerBridge: createComputerBridge(rpc),
  };
}

/**
 * Run a `kind:'js'` realm against `port`. Posts exactly one
 * `realm-done` (or `realm-error` on a bootstrap throw, which the
 * caller is expected to surface separately), plus fire-and-forget
 * `realm-output` / `realm-fs-write` as the script prints and writes
 * so a later SIGKILL still has that evidence (#3136). Returns when
 * the `realm-done` has been posted.
 *
 * `require()` resolves synchronously from a host-built CJS module graph
 * (the `module`/`buildGraph` RPC over `port`), preserving `node:`/`sliccy:`
 * schemes and Node built-ins. There is no CDN download path — a missing bare
 * module throws `Cannot find module 'x' (run: ipk install x)` immediately.
 */
export async function runJsRealm(init: RealmInitMsg, port: RealmPortLike): Promise<void> {
  const captureOutput = init.captureOutput !== false;
  const output = { stdout: '', stderr: '' };
  const writeStream = (stream: 'stdout' | 'stderr', value: unknown): void => {
    const chunk = typeof value === 'string' ? value : String(value);
    if (stream === 'stdout') {
      output.stdout = captureOutput
        ? output.stdout + chunk
        : appendOutputTail(output.stdout, chunk);
    } else {
      output.stderr = captureOutput
        ? output.stderr + chunk
        : appendOutputTail(output.stderr, chunk);
    }
    // Stream immediately so a later SIGKILL still has this output (#3136).
    port.postMessage({ type: 'realm-output', stream, chunk } satisfies RealmOutputMsg);
  };
  const writeStdout = (value: unknown): void => {
    writeStream('stdout', value);
  };
  const writeStderr = (value: unknown): void => {
    writeStream('stderr', value);
  };

  const nodeConsole = createNodeConsole(writeStdout, writeStderr);

  const proc = createProcessShim(init, writeStdout, writeStderr);
  const noColor = !!init.env?.NO_COLOR;

  const { colorApi, cliApi } = createColorAndCli(noColor, writeStdout, writeStderr);

  const rpc = new RealmRpcClient(port);

  const stdio = createRealmStdio(init, writeStdout, writeStderr);
  const fsBridge = createFsBridge(rpc, realmFetch, stdio);

  const syncFs = await initSyncFsCache(rpc, init.cwd, syncFsSnapshotErrorSink(init, writeStderr));
  const syncExecBridge = installSyncBridges(init, port, syncFs, fsBridge, stdio);

  const execBridge = createExecBridge(rpc, syncFs, init.cwd, writeStderr);
  const agentModule = createSliccyAgentModule(execBridge, { cwd: init.cwd });

  // `skill` is computed once at boot from argv[1] and frozen. It exposes
  // skill-root `refs`/`assets` (parent of the `scripts/` path segment when
  // the script lives under it), script-dir `.config`, and the skill-scoped
  // token store; see `skill-global.ts` for the surface and rationale.
  const skillGlobal = createSkillGlobal({
    argv: init.argv,
    fs: fsBridge as unknown as SkillFsBridge,
    exec: execBridge,
  });

  const browserBridge = createBrowserBridge(rpc);

  // `usb` / `serial` / `hid` mirror the underlying WebUSB / Web Serial /
  // WebHID APIs — see `createDeviceBridges` for the shared-dual-path note.
  const { usbBridge, serialBridge, hidBridge, computerBridge } = createDeviceBridges(rpc);

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
      await serializeRequestInit(opts, input),
    ]);
    return reconstructFetchResponse(serialized, url);
  }

  const sliccyModules = buildSliccyModules({
    exec: execBridge,
    agent: agentModule,
    skill: skillGlobal,
    http: httpGlobal,
    browser: browserBridge,
    usb: usbBridge,
    serial: serialBridge,
    hid: hidBridge,
    computer: computerBridge,
    cli: cliApi,
    color: colorApi,
  });

  const filename = init.filename;
  const dirname = dirnameOf(filename);

  const graph = await loadModuleGraph(rpc, init.code, init.cwd, filename);
  const moduleSystem = createModuleSystem({
    graph,
    fsBridge,
    processShim: proc.processShim,
    childProcess: createNodeChildProcess(execBridge, syncExecBridge), // per-realm `child_process` shim over `exec`
    nodeConsole,
    sliccyModules,
    shimmedPackages: buildShimmedPackages(rpc),
    // Per-realm: question() echoes to THIS realm's stdout; onExit records a
    // process.exit(N) from a deferred 'line' handler (see createProcessShim).
    nodeReadline: createNodeReadline({ output: { write: writeStdout }, onExit: proc.recordExit }),
    // Per-realm too: `os.tmpdir()`/`os.homedir()` read the SAME `init.env`
    // that `process.env` exposes, so one script cannot see two machines.
    nodeOsModule: createNodeOs(init.env),
    // And `util`, so `util.deprecate`'s one-shot DeprecationWarning reaches
    // THIS realm's stderr instead of the kernel worker's console, and a bare
    // `util.parseArgs()` reads THIS realm's `process.argv` (at call time).
    nodeUtilModule: createNodeUtil(
      (message) => writeStderr(`${message}\n`),
      () => proc.processShim.argv.slice(2)
    ),
  });
  const requireShim = moduleSystem.require;

  const moduleShim = { exports: {} as ModuleExports, filename: init.filename };

  // The host transpiles an ESM / dynamic-import / top-level-await entry to a
  // CJS body the AsyncFunction wrapper can run (and sets `entrySource`); a
  // plain-CJS entry runs verbatim. That presence is exactly Node's CJS-vs-ESM
  // distinction, so it also selects sloppy (CJS) vs strict (ESM) execution.
  const isEsmEntry = graph.entrySource !== undefined;
  const entryCode = graph.entrySource ?? init.code;

  await finishJsRealm({
    entryCode,
    isEsmEntry,
    entryIsModule: graph.entryIsModule === true,
    filename,
    dirname,
    proc,
    nodeConsole,
    requireShim,
    moduleShim,
    realmFetch,
    writeStderr,
    rpc,
    syncFs,
    output,
    port,
  });
}

/**
 * Install the WASM compile bridge, timer-handle wrappers, and WHATWG stream
 * I/O prototype wraps (Body mixin, Blob, ReadableStream), run the entry,
 * drain Node-like handles, then post `realm-done`. Wrappers are always
 * restored so the in-process test factory cannot leak them into vitest.
 *
 * The WASM compile bridge is an internal global rather than an AsyncFunction
 * param (parity-pinned): callers feature-detect with `typeof`. The returned
 * `WebAssembly.Module` is structured-cloneable across the realm port.
 */
async function finishJsRealm(opts: {
  entryCode: string;
  isEsmEntry: boolean;
  /** Static ESM entry: no `__dirname` / `__filename` (it may declare its own). */
  entryIsModule: boolean;
  filename: string;
  dirname: string;
  proc: ReturnType<typeof createProcessShim>;
  nodeConsole: ReturnType<typeof createNodeConsole>;
  requireShim: unknown;
  moduleShim: { exports: ModuleExports; filename: string };
  realmFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  writeStderr: (value: unknown) => void;
  rpc: RealmRpcClient;
  syncFs: SyncFsCache;
  output: { stdout: string; stderr: string };
  port: RealmPortLike;
}): Promise<void> {
  const g = globalThis as GlobalWithWasmCompile;
  installSliccVersion();
  g.__slicc_compileWasm = (path: string): Promise<WebAssembly.Module> =>
    opts.rpc.call('wasm', 'compile', [path]);
  const timers = createTimerHandleTracker(globalThis, {
    onCallbackError(err) {
      // process.exit() already recorded the code; swallow so a delayed
      // exit is not an uncaught exception outside runUserCode.
      if (err instanceof NodeExitError) return;
      throw err;
    },
  });
  // Loaded on first realm run, not at kernel-worker boot — the in-process
  // factory is an eager import of this file, so a static import here would
  // grow the worker first-load graph (#3227 bundle-size).
  const { createBodyReadHandleTracker } = await import('./realm-body-handles.js');
  const bodyReads = createBodyReadHandleTracker(globalThis);
  timers.install();
  bodyReads.install();
  const restoreProcess = installGlobalProcess(globalThis, opts.proc.processShim);
  try {
    const exitCode = await runEntryThenDrain({
      entryCode: opts.entryCode,
      bridges: {
        process: opts.proc.processShim,
        console: opts.nodeConsole,
        require: opts.requireShim,
        module: opts.moduleShim,
        exports: opts.moduleShim.exports,
        fetch: opts.realmFetch,
        // An ES module has neither, and may declare its own
        // (`const __dirname = dirname(fileURLToPath(import.meta.url))`).
        ...(opts.entryIsModule ? {} : { __dirname: opts.dirname, __filename: opts.filename }),
      },
      writeStderr: opts.writeStderr,
      isEsmEntry: opts.isEsmEntry,
      rpc: opts.rpc,
      syncFs: opts.syncFs,
      proc: opts.proc,
      timers,
      bodyReads,
    });
    delete g.__slicc_compileWasm;
    delete g.__slicc_mountVfs;
    opts.rpc.dispose();
    opts.port.postMessage({
      type: 'realm-done',
      stdout: opts.output.stdout,
      stderr: opts.output.stderr,
      exitCode,
    } satisfies RealmDoneMsg);
  } finally {
    timers.clearPending();
    timers.restore();
    bodyReads.restore();
    restoreProcess();
  }
}

/**
 * Run the entry, flush sync-fs, then drain ref'd handles (RPC + timers +
 * WHATWG stream I/O) unless `process.exit()` already skipped them. A mere
 * `process.exitCode` assignment does not skip the drain — Node waits for
 * handles, then exits with that status (#3155).
 */
async function runEntryThenDrain(opts: {
  entryCode: string;
  bridges: RealmUserCodeBridges;
  writeStderr: (value: unknown) => void;
  isEsmEntry: boolean;
  rpc: RealmRpcClient;
  syncFs: SyncFsCache;
  proc: ReturnType<typeof createProcessShim>;
  timers: TimerHandleTracker;
  bodyReads: BodyReadHandleTracker;
}): Promise<number> {
  const exitCode = await runUserCode(
    opts.entryCode,
    opts.bridges,
    opts.writeStderr,
    opts.isEsmEntry
  );
  await flushSyncFsCache(opts.rpc, opts.syncFs, opts.writeStderr);
  if (opts.proc.getDidCallProcessExit()) {
    opts.timers.clearPending();
    return opts.proc.getExitCode();
  }
  await drainEventLoop(opts.rpc, opts.timers, opts.bodyReads, opts.proc);
  if (opts.proc.getDidCallProcessExit()) {
    opts.timers.clearPending();
  }
  // Delayed callbacks (setTimeout, RPC .then) may have mutated the
  // sync-fs cache after the post-entry flush. Flush again so those
  // writes are not dropped when the realm tears down.
  await flushSyncFsCache(opts.rpc, opts.syncFs, opts.writeStderr);
  // `process.exit(N)` wins. An uncaught throw from the entry is 1 (Node
  // discards a previously assigned `process.exitCode`). Otherwise honour
  // `process.exitCode`, including assignments from delayed callbacks (#3155).
  if (opts.proc.getDidCallProcessExit() || exitCode === 0) {
    return opts.proc.getExitCode();
  }
  return exitCode;
}

/**
 * Diff the {@link SyncFsCache} against its initial snapshot and flush any
 * created/modified/deleted paths back to the host via `vfs.flushWrites`.
 * Called after `runUserCode` and again after the handle drain so delayed
 * callbacks' cache-only mutations are not dropped. A no-op mutation set
 * skips the RPC entirely. Successful flushes rebase the cache baseline.
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
      // Rebase so a later flush (after drain) reports only mutations made
      // since this one — same as createExecBridge's pre-exec flush.
      syncFs.resetBaseline();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // These cache-only mutations (mkdir/rm/rename and, in non-bridge mode,
      // all sync writes) did NOT reach the live VFS. This runs after the exit
      // code is computed, so a script that returned 0 still reports success —
      // this breadcrumb is the ONLY signal, so make it a loud, specific ERROR
      // rather than a soft note. (Reflecting it in the exit code was weighed but
      // deferred: it would change exit semantics for a post-run durability
      // failure — a separate behavior decision.)
      const writes = mutations.created.length + mutations.modified.length;
      writeStderr(
        `[sync-fs] ERROR: flush failed — ${writes} write(s) + ${mutations.deleted.length} delete(s) were NOT persisted: ${msg}\n`
      );
    }
  }
}

/**
 * Keep the realm alive the way Node keeps a process alive: while there are
 * ref'd handles. I/O is `rpc.pendingCount` (fs/exec/fetch plus active
 * `onEvent` host-event subscriptions). Timers are the wrapped `setTimeout`
 * / `setInterval` set. Native WHATWG stream I/O (Request/Response/Blob body
 * methods, ReadableStream `pipeTo`/`read`) that is still a stream turn
 * counts via `bodyReads.pendingCount` (#3227). A pending Promise with no
 * handle does not count — `new Promise(() => {})` must not hang teardown.
 *
 * Sleeps on RPC/timer/stream-I/O progress instead of spinning `setTimeout(0)`.
 * A never-settling RPC or uncleared `setInterval` hangs until the host
 * SIGKILLs the realm worker, the same way hung I/O hangs real Node.
 * `process.exit()` from a delayed callback stops the drain.
 *
 * After each handle settles, hop one macrotask so the user continuation
 * (the `then` after `await fetch()`, including `await res.json()`) runs
 * before we re-check handles. Without that hop, drain can post `realm-done`
 * in the same turn the fetch RPC resolved and kill the rest of an
 * unawaited IIFE (#2862).
 */
async function drainEventLoop(
  rpc: RealmRpcClient,
  timers: TimerHandleTracker,
  bodyReads: BodyReadHandleTracker,
  proc: ReturnType<typeof createProcessShim>
): Promise<void> {
  // One macrotask hop so microtasks queued in the user body (and a single
  // setTimeout(0) already registered) run before we inspect handles.
  await timers.tick();
  while (
    !proc.getDidCallProcessExit() &&
    (rpc.pendingCount > 0 || timers.pendingCount > 0 || bodyReads.pendingCount > 0)
  ) {
    const waits: Promise<void>[] = [];
    if (rpc.pendingCount > 0) waits.push(rpc.waitForProgress());
    if (timers.pendingCount > 0) waits.push(timers.waitForProgress());
    if (bodyReads.pendingCount > 0) waits.push(bodyReads.waitForProgress());
    if (waits.length === 0) break;
    await Promise.race(waits);
    if (!proc.getDidCallProcessExit()) await timers.tick();
  }
}
