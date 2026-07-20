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
import {
  createCli,
  createColor,
  createNodeChildProcess,
  fmt,
  type NodeChildProcess,
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
import { createPlaywrightShim } from './playwright-shim.js';
import { createExecBridge, type ExecBridge } from './realm-exec-bridge.js';
import { createFsBridge, createSyncFsBridge } from './realm-fs-bridge.js';
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
import { createSyncFsXhrBridge, type SyncFsXhrBridge } from './sync-fs-xhr-bridge.js';

const SLICCY_SCHEME = 'sliccy:';

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

/** Options accepted by the `sliccy:agent` callable and its `.spawn` variant. */
interface SliccyAgentOptions {
  /** Model id override forwarded as `--model`. */
  model?: string;
  /** Reasoning level forwarded as `--thinking` (off|minimal|low|medium|high|xhigh). */
  thinking?: string;
  /** StructuredOutput contract; base64-encoded JSON forwarded as `--schema-b64`. */
  schema?: unknown;
  /** Spawned scoop's writable cwd; defaults to the realm cwd. */
  cwd?: string;
  /** Comma-separated allowed bash commands; defaults to `*`. */
  allowedCommands?: string;
  /** Read-only VFS paths (array or CSV) forwarded as `--read-only`; defaults to `/workspace/`. */
  readOnly?: string | string[];
}

/** Non-throwing result shape returned by `agent.spawn`. */
interface SliccyAgentSpawnResult {
  finalText: string;
  exitCode: number;
  stderr: string;
}

/** The `sliccy:agent` module: a callable with a non-throwing `.spawn` sibling. */
type SliccyAgentModule = ((prompt: string, opts?: SliccyAgentOptions) => Promise<unknown>) & {
  spawn: (prompt: string, opts?: SliccyAgentOptions) => Promise<SliccyAgentSpawnResult>;
};

/**
 * Base64-encode a UTF-8 string for `--schema-b64`. Same byte-for-byte shape as
 * the workflow-DSL `__b64` helper in `workflow-prelude.ts` (TextEncoder →
 * String.fromCharCode → btoa), so the `agent` command's `atob`/`TextDecoder`
 * decode path round-trips identically.
 */
function agentSchemaToB64(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Build the `agent` command argv. Mirrors the workflow-DSL `agent()` in
 * `workflow-prelude.ts`: flags (`--model` / `--thinking` / `--schema-b64`)
 * first, then the `--read-only <csv>` flag and the three positionals
 * `<cwd> <allowedCommands> <prompt>`.
 */
function buildAgentArgv(prompt: string, opts: SliccyAgentOptions, realmCwd: string): string[] {
  const flags: string[] = [];
  if (opts.model) flags.push('--model', String(opts.model));
  if (opts.thinking) flags.push('--thinking', String(opts.thinking));
  if (opts.schema) flags.push('--schema-b64', agentSchemaToB64(JSON.stringify(opts.schema)));
  const readOnly =
    opts.readOnly === undefined
      ? '/workspace/'
      : Array.isArray(opts.readOnly)
        ? opts.readOnly.join(',')
        : String(opts.readOnly);
  const cwd = opts.cwd !== undefined ? String(opts.cwd) : realmCwd || '.';
  const allowed = opts.allowedCommands !== undefined ? String(opts.allowedCommands) : '*';
  return ['agent', ...flags, '--read-only', readOnly, cwd, allowed, String(prompt)];
}

/**
 * `sliccy:agent` — client-side sugar over the `exec` bridge that shells out to
 * the `agent` supplemental command (spawn a sub-scoop, feed it a task, block
 * until the agent loop completes). Option A: no host/RPC channel; argv
 * construction mirrors the workflow-DSL `agent()` in `workflow-prelude.ts`.
 *
 * The callable `agent(prompt, opts?)` resolves to trimmed stdout (JSON-parsed
 * when `opts.schema` is set) and REJECTS with an Error (message carries stderr
 * + exitCode) on a non-zero exit or a schema parse failure. `agent.spawn` is
 * the non-throwing variant — resolves `{ finalText, exitCode, stderr }`
 * regardless of exit code.
 */
export function createSliccyAgentModule(
  execBridge: ExecBridge,
  opts: { cwd: string }
): SliccyAgentModule {
  const realmCwd = opts.cwd;
  const spawn = async (
    prompt: string,
    agentOpts?: SliccyAgentOptions
  ): Promise<SliccyAgentSpawnResult> => {
    const o = agentOpts ?? {};
    const r = await execBridge.spawn(buildAgentArgv(prompt, o, realmCwd));
    const exitCode = typeof r.exitCode === 'number' ? r.exitCode : 0;
    const finalText = String(r.stdout ?? '').replace(/\n+$/, '');
    const stderr = String(r.stderr ?? '').replace(/\n+$/, '');
    return { finalText, exitCode, stderr };
  };
  const agent = (async (prompt: string, agentOpts?: SliccyAgentOptions): Promise<unknown> => {
    const o = agentOpts ?? {};
    const res = await spawn(prompt, o);
    if (res.exitCode !== 0) {
      throw new Error(
        `agent: exited with code ${res.exitCode}${res.stderr ? `: ${res.stderr}` : ''}`
      );
    }
    if (o.schema) {
      try {
        return JSON.parse(res.finalText);
      } catch {
        throw new Error(
          `agent: schema response was not valid JSON (exit ${res.exitCode}): ${res.finalText.slice(0, 200)}`
        );
      }
    }
    return res.finalText;
  }) as SliccyAgentModule;
  agent.spawn = spawn;
  return agent;
}

function buildSliccyModules(bridges: Record<string, unknown>): Record<string, unknown> {
  return { ...bridges, time, fmt, pool };
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
 * default).
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
 * Bare-specifier packages the realm resolver serves in place of a real npm
 * install. `createPlaywrightShim(rpc)` is a Playwright-shaped API backed by
 * SLICC's existing CDP connection — see `playwright-shim.ts`. Consulted by
 * `resolveBuiltin` inside `createModuleSystem` after the node builtins /
 * native-package guards, so `require('playwright')` resolves here instead of
 * throwing "Cannot find module".
 */
function buildShimmedPackages(rpc: RealmRpcClient): Record<string, unknown> {
  return {
    playwright: createPlaywrightShim(rpc),
  };
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
  childProcess: NodeChildProcess;
  nodeConsole: unknown;
  sliccyModules: Record<string, unknown>;
  shimmedPackages?: Record<string, unknown>;
}): { require: (id: string) => unknown } {
  const {
    graph,
    fsBridge,
    processShim,
    childProcess,
    nodeConsole,
    sliccyModules,
    shimmedPackages = {},
  } = opts;
  const sourceByPath = new Map(graph.files.map((f) => [f.path, f.cjsSource]));
  const kindByPath = new Map(graph.files.map((f) => [f.path, f.kind]));
  const cache = new Map<string, { exports: Record<string, unknown> }>();

  const resolveBuiltin = (id: string): { hit: boolean; value?: unknown } => {
    if (typeof id === 'string' && id.startsWith(SLICCY_SCHEME)) {
      return { hit: true, value: resolveSliccyModule(id, sliccyModules) };
    }
    const bareId = id.startsWith('node:') ? id.slice(5) : id;
    const served = resolveServedBuiltin(bareId, fsBridge, processShim, childProcess);
    if (served.hit) return served;
    if (NODE_NATIVE_PACKAGES.has(bareId)) throw nativePackageError(id, bareId);
    if (NODE_BUILTINS_UNAVAILABLE.has(bareId)) throw unavailableBuiltinError(id, bareId);
    if (bareId in shimmedPackages) return { hit: true, value: shimmedPackages[bareId] };
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
  processShim: unknown,
  childProcess: NodeChildProcess
): { hit: boolean; value?: unknown } {
  if (bareId === 'fs') return { hit: true, value: fsBridge };
  // Same object — fsBridge is already Promise-based; callback/sync APIs are not shimmed here.
  if (bareId === 'fs/promises') return { hit: true, value: fsBridge };
  if (bareId === 'path') return { hit: true, value: nodePath };
  if (bareId === 'crypto') return { hit: true, value: nodeCrypto };
  if (bareId === 'child_process') return { hit: true, value: childProcess };
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
      buildBrowserFetchScript(url, opts).then((script) =>
        rpc.call('browser', 'evalAsync', [resolveTargetId(tab), script])
      ) as Promise<BrowserFetchResult>,
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
 * `RequestInit` subset the page-context bridge can carry. `body` may be:
 * - a string — sent verbatim, no Content-Type forced;
 * - a `URLSearchParams` — serialized to a form-urlencoded string with a
 *   default `application/x-www-form-urlencoded` Content-Type (caller wins);
 * - an `ArrayBuffer` / typed array / `Blob` — base64-encoded across the
 *   bridge and reconstructed as real binary in the page before `fetch`
 *   (caller Content-Type preserved; a `Blob`'s own type carries over);
 * - a `FormData` — string fields and `File`/`Blob` parts are carried
 *   (files base64-encoded) and rebuilt as a real `FormData` in the page
 *   so `fetch` sets the multipart boundary itself;
 * - any other JSON-encodable value — stringified with a default
 *   `application/json` Content-Type (caller wins).
 * `AbortSignal` / `ReadableStream` bodies are still out of scope.
 */
export interface BrowserFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?:
    | string
    | URLSearchParams
    | ArrayBuffer
    | ArrayBufferView
    | Blob
    | FormData
    | Record<string, unknown>
    | unknown[]
    | number
    | boolean
    | null;
  credentials?: 'include' | 'same-origin' | 'omit';
  mode?: string;
  cache?: string;
  redirect?: string;
  referrer?: string;
  referrerPolicy?: string;
  integrity?: string;
  keepalive?: boolean;
  /**
   * How the response body should be decoded:
   * - `'text'` — always return the raw text body (no JSON parse);
   * - `'json'` — always `JSON.parse` the text body (null on empty);
   * - `'binary'` — return the body base64-encoded with
   *   `bodyEncoding: 'base64'` on the result;
   * - omitted (default) — auto-detect: JSON Content-Type → parsed JSON,
   *   a conservative binary Content-Type allowlist → base64, else text.
   */
  responseType?: 'text' | 'json' | 'binary';
}

/**
 * Structured result returned by `browser.fetch`. `body` is parsed
 * JSON when the response Content-Type contains `application/json`,
 * otherwise raw text. Binary responses (via `responseType: 'binary'`
 * or a binary Content-Type) return the body base64-encoded with
 * `bodyEncoding: 'base64'` set; the caller decodes with `atob`.
 */
export interface BrowserFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** Set to `'base64'` when `body` is a base64-encoded binary payload. */
  bodyEncoding?: 'base64';
}

/**
 * Wire descriptor for a request body that cannot ride the bridge as
 * plain JSON. Binary payloads are base64-encoded here and rebuilt as
 * real `Uint8Array` / `Blob` / `FormData` in the page (see
 * `buildBrowserFetchScript`). Kept minimal + JSON-safe on purpose.
 */
type BrowserFetchBodyDescriptor =
  | { kind: 'bytes'; data: string }
  | { kind: 'blob'; data: string; type: string }
  | { kind: 'formdata'; entries: BrowserFetchFormEntry[] };

type BrowserFetchFormEntry =
  | { name: string; value: string }
  | { name: string; file: { data: string; filename: string; type: string } };

/**
 * Base64-encode bytes without blowing the argument stack on large
 * payloads (`String.fromCharCode(...bytes)` throws past ~100K). Runs
 * in the builder (realm/worker/page) context, where `btoa` exists.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

/** Serialize a `FormData` into JSON-safe entries (files base64-encoded). */
async function serializeBrowserFetchFormData(form: FormData): Promise<BrowserFetchBodyDescriptor> {
  const entries: BrowserFetchFormEntry[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      entries.push({ name, value });
      continue;
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    entries.push({
      name,
      file: {
        data: bytesToBase64(bytes),
        filename: typeof (value as File).name === 'string' ? (value as File).name : 'blob',
        type: value.type || '',
      },
    });
  }
  return { kind: 'formdata', entries };
}

/**
 * Turn a request body into either an inline `body` string or a base64
 * `descriptor` the page reconstructs. Default Content-Type headers are
 * set in place; a caller-provided Content-Type always wins.
 */
async function serializeBrowserFetchBody(
  raw: NonNullable<BrowserFetchOptions['body']>,
  headers: Record<string, string>
): Promise<{ body?: string; descriptor?: BrowserFetchBodyDescriptor }> {
  const hasContentType = (): boolean =>
    Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
  if (typeof raw === 'string') return { body: raw };
  if (raw instanceof URLSearchParams) {
    if (!hasContentType()) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return { body: raw.toString() };
  }
  if (raw instanceof Blob) {
    const bytes = new Uint8Array(await raw.arrayBuffer());
    return { descriptor: { kind: 'blob', data: bytesToBase64(bytes), type: raw.type || '' } };
  }
  if (raw instanceof ArrayBuffer) {
    return { descriptor: { kind: 'bytes', data: bytesToBase64(new Uint8Array(raw)) } };
  }
  if (ArrayBuffer.isView(raw)) {
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    return { descriptor: { kind: 'bytes', data: bytesToBase64(bytes) } };
  }
  if (raw instanceof FormData) {
    return { descriptor: await serializeBrowserFetchFormData(raw) };
  }
  if (!hasContentType()) headers['Content-Type'] = 'application/json';
  return { body: JSON.stringify(raw) };
}

/**
 * Page-side reconstruction snippet for a binary/FormData body. Returns
 * the empty string when there's no descriptor so string/object/
 * URLSearchParams scripts stay byte-identical to the pre-binary shape
 * (no `atob`). Rebuilds bytes/Blob/FormData onto `__init.body`.
 */
function buildBodyReconstructionScript(descriptor: BrowserFetchBodyDescriptor | undefined): string {
  if (!descriptor) return '';
  return (
    'const __b64 = (s) => { const bin = atob(s); const n = bin.length; ' +
    'const u = new Uint8Array(n); for (let i = 0; i < n; i++) u[i] = bin.charCodeAt(i); return u; };' +
    'const __body = ' +
    JSON.stringify(descriptor) +
    ';' +
    "if (__body.kind === 'bytes') { __init.body = __b64(__body.data); }" +
    "else if (__body.kind === 'blob') { __init.body = new Blob([__b64(__body.data)], { type: __body.type }); }" +
    "else if (__body.kind === 'formdata') { const __fd = new FormData(); " +
    'for (const e of __body.entries) { ' +
    'if (e.file) { __fd.append(e.name, new Blob([__b64(e.file.data)], { type: e.file.type }), e.file.filename); } ' +
    'else { __fd.append(e.name, e.value); } } __init.body = __fd; }'
  );
}

/**
 * Page-side response-assembly snippet. Follows the `fetch(...)` line and
 * consumes `r` (the Response). Handles three body shapes driven by
 * `responseType` and, when omitted, a conservative Content-Type
 * allowlist:
 * - binary (`responseType: 'binary'` OR an allowlisted binary
 *   Content-Type) → read `arrayBuffer`, base64-encode with `btoa`, and
 *   return `{ ..., body: <base64>, bodyEncoding: 'base64' }`. The
 *   allowlist NEVER matches `text/*`, `application/json`, `*+json`,
 *   `application/xml`, or `*+xml`, so text payloads are never corrupted;
 * - JSON (`responseType: 'json'` OR a JSON Content-Type when not forced
 *   to text) → `JSON.parse` the text (null on empty body);
 * - text (everything else, or `responseType: 'text'`) → raw text.
 *
 * The body is read exactly once (either `arrayBuffer` or `text`, never
 * both) so the single-consumption stream is respected. Kept stringly
 * typed so `JSON.stringify` stays the only escape boundary.
 */
function buildResponseHandlingScript(responseType: BrowserFetchOptions['responseType']): string {
  return (
    'const h = {};' +
    'r.headers.forEach((v, k) => { h[k] = v; });' +
    "const ct = r.headers.get('content-type') || '';" +
    'const __rt = ' +
    JSON.stringify(responseType ?? null) +
    ';' +
    'const __ctl = ct.toLowerCase();' +
    "const __binPrefixes = ['image/','audio/','video/','application/octet-stream'," +
    "'application/pdf','application/protobuf','application/x-protobuf','application/wasm','application/zip'];" +
    "const __isXml = __ctl.indexOf('+xml') !== -1 || __ctl.indexOf('application/xml') === 0 || __ctl.indexOf('text/xml') === 0;" +
    "const __isBinary = __rt === 'binary' || (__rt !== 'text' && __rt !== 'json' && !__isXml && " +
    '__binPrefixes.some((p) => __ctl.indexOf(p) === 0));' +
    'if (__isBinary) {' +
    'const __u = new Uint8Array(await r.arrayBuffer());' +
    "let __s = ''; const __cs = 0x8000;" +
    'for (let __i = 0; __i < __u.length; __i += __cs) { ' +
    '__s += String.fromCharCode.apply(null, __u.subarray(__i, __i + __cs)); }' +
    "return { ok: r.ok, status: r.status, headers: h, body: btoa(__s), bodyEncoding: 'base64' };" +
    '}' +
    'const t = await r.text();' +
    'let b;' +
    "const __jsonWanted = __rt === 'json' || (__rt !== 'text' && ct.indexOf('application/json') !== -1);" +
    'if (__jsonWanted) { if (!t) { b = null; } else { try { b = JSON.parse(t); } catch (e) { b = t; } } }' +
    'else { b = t; }' +
    'return { ok: r.ok, status: r.status, headers: h, body: b };'
  );
}

/**
 * Build the self-contained page-context script that `browser.fetch`
 * injects via `evalAsync`. All request shaping (method/credentials/
 * headers/body) is baked into the script via `JSON.stringify` so the
 * page side does nothing but call `fetch()` and assemble the
 * structured response. Credentials default to `'include'` so session
 * cookies travel automatically — that's the whole reason
 * `browser.fetch` exists rather than the realm-side `fetch`.
 *
 * Body handling: plain strings pass through verbatim; `URLSearchParams`
 * becomes a form-urlencoded string (default Content-Type, caller wins);
 * `ArrayBuffer` / typed arrays / `Blob` are base64-encoded and rebuilt
 * as real binary in the page (caller Content-Type preserved); `FormData`
 * is carried entry-by-entry (files base64-encoded) and rebuilt as a real
 * `FormData` so `fetch` sets the multipart boundary; any other value is
 * JSON-stringified with a default `application/json` Content-Type. The
 * function is async because reading `Blob`/`File` bytes is async.
 *
 * Response handling honors `opts.responseType` (`'text'`/`'json'`/
 * `'binary'`); when omitted it auto-detects JSON vs. a conservative
 * binary Content-Type allowlist (see {@link buildResponseHandlingScript}).
 * Binary bodies come back base64-encoded with `bodyEncoding: 'base64'`.
 *
 * Exported so tests can assert the injected script is a single
 * function (no temp file, no base64 chunking). The
 * only escape boundary is `JSON.stringify`; base64 uses `btoa`/`atob`,
 * never a VFS temp file or `fs.` write.
 */
export async function buildBrowserFetchScript(
  url: string,
  opts: BrowserFetchOptions = {}
): Promise<string> {
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
  const raw = opts.body;
  const { body, descriptor } =
    raw === undefined || raw === null ? {} : await serializeBrowserFetchBody(raw, headers);
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
  const reconstruct = buildBodyReconstructionScript(descriptor);
  const responseHandling = buildResponseHandlingScript(opts.responseType);
  // Single self-contained async IIFE — runs entirely in the page,
  // returns a structured-cloneable object that CDP returnByValue
  // round-trips back to the realm host as-is. Keep this stringly
  // typed (no template-literal substitutions inside the function
  // body) so JSON.stringify is the only escape boundary.
  return (
    '(async () => {' +
    'const __init = ' +
    JSON.stringify(init) +
    ';' +
    reconstruct +
    'const r = await fetch(' +
    JSON.stringify(url) +
    ', __init);' +
    responseHandling +
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
