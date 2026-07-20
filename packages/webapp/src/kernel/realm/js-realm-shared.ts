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
import { createHttpGlobal } from './http-global.js';
import { createCli, createColor, createNodeChildProcess } from './js-realm-helpers.js';
import { createSliccyAgentModule } from './realm-agent-module.js';
import { createBrowserBridge, serializeRequestInit } from './realm-browser-bridge.js';
import { createExecBridge } from './realm-exec-bridge.js';
import { createFsBridge, createSyncFsBridge } from './realm-fs-bridge.js';
import { createHidBridge, type RealmHidApi } from './realm-hid-bridge.js';
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
import { createSerialBridge, type RealmSerialApi } from './realm-serial-bridge.js';
import type { RealmDoneMsg, RealmInitMsg, SerializedFetchResponse } from './realm-types.js';
import { createUsbBridge, type RealmUsbApi } from './realm-usb-bridge.js';
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

