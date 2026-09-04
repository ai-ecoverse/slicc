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
import { createNodeReadline } from './helpers/node-readline.js';
import { createHttpGlobal } from './http-global.js';
import {
  createCli,
  createColor,
  createNodeChildProcess,
  createNodeOs,
} from './js-realm-helpers.js';
import { createSliccyAgentModule } from './realm-agent-module.js';
import { createBrowserBridge, serializeRequestInit } from './realm-browser-bridge.js';
import { createExecBridge } from './realm-exec-bridge.js';
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
  NodeExitError,
} from './realm-node-shims.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
import { createSerialBridge, type RealmSerialApi } from './realm-serial-bridge.js';
import { createTimerHandleTracker, type TimerHandleTracker } from './realm-timer-handles.js';
import type { RealmDoneMsg, RealmInitMsg, SerializedFetchResponse } from './realm-types.js';
import { createUsbBridge, type RealmUsbApi } from './realm-usb-bridge.js';
import { createSkillGlobal, type SkillFsBridge } from './skill-global.js';
import { createSyncExecXhrBridge, type SyncExecXhrBridge } from './sync-exec-xhr-bridge.js';
import { SyncFsCache, type SyncFsSnapshot } from './sync-fs-cache.js';
import { createSyncFsXhrBridge, type SyncFsXhrMutatingBridge } from './sync-fs-xhr-bridge.js';
import {
  createSyncExecSabTransport,
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SyncSabTransport,
} from './sync-sab-bridge.js';

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
 * Build the realm's synchronous-fs SW bridge from the init token. Present only
 * when the SW bridge is enabled for this realm (page-confirmed SW control);
 * absent (default / in-process tests / boot-before-control) → `undefined` →
 * the bounded snapshot fallback. See `sync-fs-xhr-bridge.ts` + the plan.
 */
function resolveSyncFsBridge(
  init: RealmInitMsg,
  sab: SyncSabTransport | undefined
): SyncFsXhrMutatingBridge | undefined {
  if (sab) return createSyncFsSabBridge(sab);
  return init.syncFsToken ? createSyncFsXhrBridge(init.syncFsToken) : undefined;
}

/**
 * The Atomics/SAB transport (#2043) when the host handed us a shared buffer —
 * only ever on a cross-origin-isolated leader for a realm on its own thread
 * (`Realm.isolatedThread`); `Atomics.wait` is otherwise unavailable or a
 * deadlock. The SW sync-XHR path stays the universal baseline.
 */
function resolveSyncSabTransport(
  init: RealmInitMsg,
  port: RealmPortLike
): SyncSabTransport | undefined {
  if (!init.syncSab || typeof Atomics === 'undefined' || typeof Atomics.wait !== 'function') {
    return undefined;
  }
  return createSyncSabTransport(init.syncSab, port);
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
  Object.assign(fsBridge, createSyncFsBridge(syncFs, init.cwd, syncFsXhr, stdio));
  if (!init.syncFsToken) return undefined;
  return createSyncExecXhrBridge(init.syncFsToken, {
    syncFs,
    ...(syncFsXhr ? { fsBridge: syncFsXhr } : {}),
    ...(sab ? { transport: createSyncExecSabTransport(sab) } : {}),
  });
}

/**
 * `globalThis` narrowed to the realm-internal WASM compile bridge hook and the
 * `SLICC_VERSION` capability marker realm scripts read (see `installSliccVersion`).
 */
type GlobalWithWasmCompile = typeof globalThis & {
  __slicc_compileWasm?: (path: string) => Promise<WebAssembly.Module>;
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
      await serializeRequestInit(opts, input),
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
    agent: agentModule,
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
    stdoutChunks,
    stderrChunks,
    port,
  });
}

/**
 * Install the WASM compile bridge and timer-handle wrappers, run the entry,
 * drain Node-like handles, then post `realm-done`. Timer wrappers are always
 * restored so the in-process test factory cannot leak them into vitest.
 *
 * The WASM compile bridge is an internal global rather than an AsyncFunction
 * param (parity-pinned): callers feature-detect with `typeof`. The returned
 * `WebAssembly.Module` is structured-cloneable across the realm port.
 */
async function finishJsRealm(opts: {
  entryCode: string;
  isEsmEntry: boolean;
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
  stdoutChunks: string[];
  stderrChunks: string[];
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
  timers.install();
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
        __dirname: opts.dirname,
        __filename: opts.filename,
      },
      writeStderr: opts.writeStderr,
      isEsmEntry: opts.isEsmEntry,
      rpc: opts.rpc,
      syncFs: opts.syncFs,
      proc: opts.proc,
      timers,
    });
    delete g.__slicc_compileWasm;
    opts.rpc.dispose();
    opts.port.postMessage({
      type: 'realm-done',
      stdout: opts.stdoutChunks.join(''),
      stderr: opts.stderrChunks.join(''),
      exitCode,
    } satisfies RealmDoneMsg);
  } finally {
    timers.clearPending();
    timers.restore();
  }
}

/**
 * Run the entry, flush sync-fs, then drain ref'd handles (RPC + timers)
 * unless `process.exit()` already skipped them.
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
  await drainEventLoop(opts.rpc, opts.timers, opts.proc);
  if (opts.proc.getDidCallProcessExit()) {
    opts.timers.clearPending();
  }
  // Delayed callbacks (setTimeout, RPC .then) may have mutated the
  // sync-fs cache after the post-entry flush. Flush again so those
  // writes are not dropped when the realm tears down.
  await flushSyncFsCache(opts.rpc, opts.syncFs, opts.writeStderr);
  return opts.proc.getDidCallProcessExit() ? opts.proc.getExitCode() : exitCode;
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
 * ref'd handles. I/O is `rpc.pendingCount` (fs/exec/fetch). Timers are the
 * wrapped `setTimeout` / `setInterval` set. A pending Promise with no handle
 * does not count — `new Promise(() => {})` must not hang teardown.
 *
 * Sleeps on RPC/timer progress instead of spinning `setTimeout(0)`. A
 * never-settling RPC or uncleared `setInterval` hangs until the host
 * SIGKILLs the realm worker, the same way hung I/O hangs real Node.
 * `process.exit()` from a delayed callback stops the drain.
 */
async function drainEventLoop(
  rpc: RealmRpcClient,
  timers: TimerHandleTracker,
  proc: ReturnType<typeof createProcessShim>
): Promise<void> {
  // One macrotask hop so microtasks queued in the user body (and a single
  // setTimeout(0) already registered) run before we inspect handles.
  await timers.tick();
  while (!proc.getDidCallProcessExit() && (rpc.pendingCount > 0 || timers.pendingCount > 0)) {
    const waits: Promise<void>[] = [];
    if (rpc.pendingCount > 0) waits.push(rpc.waitForProgress());
    if (timers.pendingCount > 0) waits.push(timers.waitForProgress());
    if (waits.length === 0) break;
    await Promise.race(waits);
  }
}
