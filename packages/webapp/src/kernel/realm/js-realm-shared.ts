/**
 * `js-realm-shared.ts` — JS realm execution logic factored out so
 * both `js-realm-worker.ts` (DedicatedWorker entry, standalone) and
 * an in-process test factory can drive the same code path.
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
import { createCli, createColor, createNodeChildProcess } from './js-realm-helpers.js';
import { createSliccyAgentModule } from './realm-agent-module.js';
import { createBrowserBridge, serializeRequestInit } from './realm-browser-bridge.js';
import { createExecBridge } from './realm-exec-bridge.js';
import { createFsBridge, createSyncFsBridge } from './realm-fs-bridge.js';
import {
  buildShimmedPackages,
  buildSliccyModules,
  createModuleSystem,
  loadModuleGraph,
  runUserCode,
} from './realm-module-system.js';
import {
  createNodeConsole,
  createProcessShim,
  dirnameOf,
  NodeExitError,
} from './realm-node-shims.js';
import { type RealmPortLike, RealmRpcClient } from './realm-rpc.js';
import type {
  RealmDoneMsg,
  RealmInitMsg,
  RealmRpcChannel,
  SerializedFetchResponse,
} from './realm-types.js';
import { createSkillGlobal, type SkillFsBridge } from './skill-global.js';
import { SyncFsCache, type SyncFsSnapshot } from './sync-fs-cache.js';
import { createSyncFsXhrBridge, type SyncFsXhrBridge } from './sync-fs-xhr-bridge.js';

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
function resolveSyncFsBridge(init: RealmInitMsg): SyncFsXhrBridge | undefined {
  return init.syncFsToken ? createSyncFsXhrBridge(init.syncFsToken) : undefined;
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

  const syncFs = await initSyncFsCache(rpc, init.cwd, syncFsSnapshotErrorSink(init, writeStderr));
  Object.assign(fsBridge, createSyncFsBridge(syncFs, init.cwd, resolveSyncFsBridge(init)));

  const execBridge = createExecBridge(rpc, syncFs, init.cwd, writeStderr);
  const agentModule = createSliccyAgentModule(execBridge, { cwd: init.cwd });

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
    processShim,
    childProcess: createNodeChildProcess(execBridge), // per-realm `child_process` shim over `exec`
    nodeConsole,
    sliccyModules,
    shimmedPackages: buildShimmedPackages(rpc),
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
  // floats without the bridge (e.g. the in-process test realm) cleanly fall
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
