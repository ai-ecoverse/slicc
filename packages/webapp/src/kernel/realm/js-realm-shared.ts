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

function syncFsSnapshotErrorSink(
  init: RealmInitMsg,
  writeStderr: (value: unknown) => void
): ((message: string) => void) | undefined {
  if (!init.syncFsToken) return undefined;
  return (message) =>
    writeStderr(`[sync-fs] snapshot failed, sync metadata will be incomplete: ${message}\n`);
}

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

type GlobalWithWasmCompile = typeof globalThis & {
  __slicc_compileWasm?: (path: string) => Promise<WebAssembly.Module>;
  __slicc_mountVfs?: (
    fs: EmscriptenFsForHook,
    opts?: { cwd?: string }
  ) => Promise<EmscriptenVfsHandle>;
  SLICC_VERSION?: string;
};

export function installSliccVersion(target: typeof globalThis = globalThis): void {
  if (Object.prototype.hasOwnProperty.call(target, 'SLICC_VERSION')) return;
  Object.defineProperty(target, 'SLICC_VERSION', {
    value: readSliccVersion().version,
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

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

  const skillGlobal = createSkillGlobal({
    argv: init.argv,
    fs: fsBridge as unknown as SkillFsBridge,
    exec: execBridge,
  });

  const browserBridge = createBrowserBridge(rpc);

  const { usbBridge, serialBridge, hidBridge, computerBridge } = createDeviceBridges(rpc);

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
    childProcess: createNodeChildProcess(execBridge, syncExecBridge),
    nodeConsole,
    sliccyModules,
    shimmedPackages: buildShimmedPackages(rpc),

    nodeReadline: createNodeReadline({ output: { write: writeStdout }, onExit: proc.recordExit }),

    nodeOsModule: createNodeOs(init.env),

    nodeUtilModule: createNodeUtil(
      (message) => writeStderr(`${message}\n`),
      () => proc.processShim.argv.slice(2)
    ),
  });
  const requireShim = moduleSystem.require;

  const moduleShim = { exports: {} as ModuleExports, filename: init.filename };

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

async function finishJsRealm(opts: {
  entryCode: string;
  isEsmEntry: boolean;

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
      if (err instanceof NodeExitError) return;
      throw err;
    },
  });

  const { createBodyReadHandleTracker } = await import('./realm-body-handles.js');
  const bodyReads = createBodyReadHandleTracker(globalThis);
  timers.install();
  bodyReads.install();
  const restoreProcess = installGlobalProcess(globalThis, opts.proc.processShim);
  const { watchUnhandledRejections } = await import('./realm-unhandled-rejections.js');
  const rejections = watchUnhandledRejections(globalThis, {
    writeStderr: opts.writeStderr,
    didExit: opts.proc.getDidCallProcessExit,
    recordExit: opts.proc.recordExit,
  });
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

        ...(opts.entryIsModule ? {} : { __dirname: opts.dirname, __filename: opts.filename }),
      },
      writeStderr: opts.writeStderr,
      isEsmEntry: opts.isEsmEntry,
      rpc: opts.rpc,
      syncFs: opts.syncFs,
      proc: opts.proc,
      timers,
      bodyReads,
      fatal: rejections.fatal,
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
    rejections.dispose();
    timers.clearPending();
    timers.restore();
    bodyReads.restore();
    restoreProcess();
  }
}

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

  fatal: Promise<void>;
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
  await drainEventLoop(opts.rpc, opts.timers, opts.bodyReads, opts.proc, opts.fatal);
  if (opts.proc.getDidCallProcessExit()) {
    opts.timers.clearPending();
  }

  await flushSyncFsCache(opts.rpc, opts.syncFs, opts.writeStderr);

  if (opts.proc.getDidCallProcessExit() || exitCode === 0) {
    return opts.proc.getExitCode();
  }
  return exitCode;
}

async function flushSyncFsCache(
  rpc: RealmRpcClient,
  syncFs: SyncFsCache,
  writeStderr: (value: unknown) => void
): Promise<void> {
  const mutations = syncFs.getMutations();
  if (mutations.created.length || mutations.modified.length || mutations.deleted.length) {
    try {
      await rpc.call('vfs', 'flushWrites', [mutations]);

      syncFs.resetBaseline();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      const writes = mutations.created.length + mutations.modified.length;
      writeStderr(
        `[sync-fs] ERROR: flush failed — ${writes} write(s) + ${mutations.deleted.length} delete(s) were NOT persisted: ${msg}\n`
      );
    }
  }
}

const IDLE_SETTLE_HOPS = 2;

async function drainEventLoop(
  rpc: RealmRpcClient,
  timers: TimerHandleTracker,
  bodyReads: BodyReadHandleTracker,
  proc: ReturnType<typeof createProcessShim>,
  fatal: Promise<void>
): Promise<void> {
  await timers.tick();
  let idleHops = 0;
  while (!proc.getDidCallProcessExit() && idleHops < IDLE_SETTLE_HOPS) {
    const waits: Promise<void>[] = [];
    if (rpc.pendingCount > 0) waits.push(rpc.waitForProgress());
    if (timers.pendingCount > 0) waits.push(timers.waitForProgress());
    if (bodyReads.pendingCount > 0) waits.push(bodyReads.waitForProgress());
    if (waits.length === 0) {
      idleHops += 1;
      await timers.tick();
      continue;
    }
    idleHops = 0;

    waits.push(fatal);
    await Promise.race(waits);
    if (!proc.getDidCallProcessExit()) await timers.tick();
  }
}
