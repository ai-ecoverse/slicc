/**
 * `realm-host.ts` — kernel-side server for realm RPC. Wires the
 * realm's `realm-rpc-req` traffic into the calling
 * `CommandContext`'s `fs` / `exec` / `fetch`.
 *
 * Critical secret-injection invariant: the `fetch` channel proxies
 * through `ctx.fetch` (just-bash `SecureFetch`) when present, NOT
 * `globalThis.fetch`. CLI mode routes outbound requests through
 * `/api/fetch-proxy` so masked secret values get substituted
 * server-side; falling back to the worker / page's native `fetch`
 * sends the literal masked value upstream and breaks every secret-
 * gated API call. Pinned in `realm-rpc.test.ts`.
 */

import type { CommandContext } from 'just-bash';
import type { BrowserAPI } from '../../cdp/browser-api.js';
import { createLogger } from '../../core/logger.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../scoops/tray-runtime-config.js';
import { createEntryTranspile, createEsmTranspile } from '../../shell/ipk/esm-transpile.js';
import { buildRealmModuleGraph } from '../../shell/ipk/module-loader.js';
import type { ModuleReader } from '../../shell/ipk/resolver.js';
import {
  type HidBackend,
  resolveHidBackend,
} from '../../shell/supplemental-commands/hid-backends.js';
import { createNodeFetchAdapter } from '../../shell/supplemental-commands/node-fetch-adapter.js';
import {
  resolveSerialBackend,
  type SerialBackend,
} from '../../shell/supplemental-commands/serial-backends.js';
import {
  resolveUsbBackend,
  type UsbBackend,
} from '../../shell/supplemental-commands/usb-backends.js';
import type { HidDeviceFilter } from '../hid-device-registry.js';
import { getPanelRpcClient, hasLocalDom } from '../panel-rpc.js';
import type { ProcessManager, ProcessOwner, Signal } from '../process-manager.js';
import type {
  SerialFilter,
  SerialOpenOptions,
  SerialOutputSignals,
} from '../serial-port-registry.js';
import type { UsbControlSetup, UsbDeviceFilter } from '../usb-device-registry.js';
import type { RealmPortLike } from './realm-rpc.js';
import type {
  RealmEventMsg,
  RealmRpcRequest,
  RealmRpcResponse,
  SerializedFetchResponse,
  TabHandle,
  WsObserveRequest,
  WsSelector,
  WsSubscriberInfo,
} from './realm-types.js';
import type { SyncFsMutations, SyncFsSnapshot } from './sync-fs-cache.js';
import { compileWasmFromVfs } from './wasm-compiler.js';
import type { WsSubscriberRegistry } from './ws-subscribers.js';

const log = createLogger('realm-host');

export interface RealmHostHandle {
  /** Detach the message listener. Idempotent. */
  dispose(): void;
}

/**
 * Optional dependencies injected into the realm host. `browser` is
 * resolved via this hook for tests; production callers can omit it
 * and the host falls back to `globalThis.__slicc_browser` (the
 * BrowserAPI published by `kernel/host.ts` at boot).
 */
export interface RealmHostOptions {
  browser?: BrowserAPI;
  /**
   * Optional override for the WebSocket subscriber registry used by
   * `browser.websocket.*`. Production callers omit it and the host
   * falls back to `globalThis.__slicc_wsSubscribers` (constructed in
   * `kernel/host.ts`). Tests inject an in-memory registry directly.
   */
  wsSubscribers?: WsSubscriberRegistry;
  /**
   * Owning scoop's `jid`. Stamped onto every `wsObserve` so the
   * registry can auto-clean up subscribers on `scoop drop`. Realm
   * callers cannot supply this themselves — it must come from the
   * trusted host side.
   */
  scoopJid?: string;
  /**
   * Optional overrides for the WebUSB / Web Serial / WebHID backends
   * used by the `usb` / `serial` / `hid` channels. Production callers
   * omit them and the host resolves the same dual-path backend the
   * shell commands use (`resolve*Backend(hasLocalDom, getPanelRpcClient)`):
   * the local `navigator.*` in a DOM realm, the panel-RPC bridge in the
   * kernel worker. Tests inject in-memory backends directly.
   */
  usbBackend?: UsbBackend;
  serialBackend?: SerialBackend;
  hidBackend?: HidBackend;
  /**
   * Process manager + owner used by the `exec.start` / `exec.kill` ops so
   * each realm-spawned command shows up as a real PM process (`ps` / `kill`
   * / terminal Ctrl-C fan-out see it) and a `kill` op can fan a signal out
   * to it. Threaded through by `realm-runner.ts` from the realm's own
   * `RunInRealmOptions`. When omitted (e.g. the RPC unit tests), `start`
   * still runs the command and `kill` still aborts the in-flight
   * `ctx.exec` via its `AbortController` — there just isn't a PM record.
   */
  pm?: ProcessManager;
  owner?: ProcessOwner;
  /**
   * Parent pid for `exec.start`-spawned PM processes — the realm's own
   * pid, so a signal to the realm fans out to its realm-backed children.
   */
  ppid?: number;
}

/**
 * Attach an RPC server to a realm port. Returns a handle whose
 * `dispose()` removes the listener — the runner calls it when the
 * realm exits or is force-terminated so the port doesn't keep
 * answering after the realm is gone.
 */
export function attachRealmHost(
  port: RealmPortLike,
  ctx: CommandContext,
  opts: RealmHostOptions = {}
): RealmHostHandle {
  // Per-port HID `inputreport` subscriptions, keyed by device handle.
  // The realm side calls `hid.subscribeInputReports(h)` to start the
  // backend listener and `unsubscribeInputReports(h)` to stop it;
  // `dispose()` drains the map so realm teardown can never leak a
  // page-side `inputreport` listener (DOD: "no leaked subscriptions
  // on realm teardown").
  const hidSubscriptions = new Map<string, () => void | Promise<void>>();
  let disposed = false;
  const pushEvent = (msg: RealmEventMsg, transfer: Transferable[] = []): void => {
    if (disposed) return;
    try {
      port.postMessage(msg, transfer);
    } catch {
      // Disposed ports / detached transferables — best-effort, the
      // listener-cleanup happens via `dispose()`.
    }
  };
  const hidCtx: HidDispatchCtx = { subscriptions: hidSubscriptions, pushEvent };
  // Live `exec.start` spawns keyed by the realm-allocated `spawnId`.
  // `kill` looks up the entry to abort the in-flight `ctx.exec` and fan a
  // signal out via `pm`; `start` cleans its own entry on settle. `dispose()`
  // aborts any leftover in-flight execs so a terminated realm can't strand a
  // running host-side command.
  const execSpawns = new Map<number, { controller: AbortController; pid: number }>();
  const execCtx: ExecDispatchCtx = { spawns: execSpawns, opts };
  const handler = (event: MessageEvent): void => {
    const data = event.data as { type?: string };
    if (data?.type !== 'realm-rpc-req') return;
    const req = event.data as RealmRpcRequest;
    void respond(port, req, ctx, opts, hidCtx, execCtx);
  };
  port.addEventListener('message', handler);
  port.start?.();
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', handler);
      // Abort any in-flight `exec.start` commands so a terminated realm
      // doesn't leave a host-side `ctx.exec` running with no consumer for
      // its result. The `start` handler's `finally` still runs the PM
      // cleanup once the aborted exec settles.
      for (const { controller } of execSpawns.values()) {
        try {
          if (!controller.signal.aborted) controller.abort();
        } catch {
          /* swallow — realm teardown must not throw */
        }
      }
      execSpawns.clear();
      // Drain HID subscriptions best-effort; sync and async unsubscribes
      // are both honored. We don't await — `dispose()` is sync, and the
      // backend's unsubscribe surface accepts fire-and-forget here.
      for (const unsub of hidSubscriptions.values()) {
        try {
          void Promise.resolve(unsub()).catch(() => {});
        } catch {
          /* swallow — realm teardown must not throw */
        }
      }
      hidSubscriptions.clear();
    },
  };
}

async function respond(
  port: RealmPortLike,
  req: RealmRpcRequest,
  ctx: CommandContext,
  opts: RealmHostOptions,
  hidCtx: HidDispatchCtx,
  execCtx: ExecDispatchCtx
): Promise<void> {
  try {
    const result = await dispatch(req, ctx, opts, hidCtx, execCtx);
    const res: RealmRpcResponse = { type: 'realm-rpc-res', id: req.id, result };
    // Body bytes need to be transferred so we don't structured-clone
    // potentially-large response bodies on every fetch.
    const transfer = collectTransferables(result);
    port.postMessage(res, transfer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const res: RealmRpcResponse = { type: 'realm-rpc-res', id: req.id, error: message };
    port.postMessage(res);
  }
}

async function dispatch(
  req: RealmRpcRequest,
  ctx: CommandContext,
  opts: RealmHostOptions,
  hidCtx: HidDispatchCtx,
  execCtx: ExecDispatchCtx
): Promise<unknown> {
  switch (req.channel) {
    case 'vfs':
      return dispatchVfs(req.op, req.args, ctx);
    case 'exec':
      return dispatchExec(req.op, req.args, ctx, execCtx);
    case 'fetch':
      return dispatchFetch(req.op, req.args, ctx);
    case 'browser':
      return dispatchBrowser(req.op, req.args, resolveBrowser(opts), opts);
    case 'usb':
      return dispatchUsb(req.op, req.args, resolveUsbBackendForHost(opts));
    case 'serial':
      return dispatchSerial(req.op, req.args, resolveSerialBackendForHost(opts));
    case 'hid':
      return dispatchHid(req.op, req.args, resolveHidBackendForHost(opts), hidCtx);
    case 'module':
      return dispatchModule(req.op, req.args, ctx);
    case 'wasm':
      return dispatchWasm(req.op, req.args, ctx);
    default:
      throw new Error(`realm-host: unknown channel '${req.channel}'`);
  }
}

/**
 * Resolve the BrowserAPI to use for the `browser` channel. Tests
 * inject one through `opts`; production paths read the one published
 * on `globalThis` by `kernel/host.ts`. A missing browser throws a
 * clear "unavailable in this runtime" error rather than a generic
 * undefined-method crash.
 */
function resolveBrowser(opts: RealmHostOptions): BrowserAPI {
  if (opts.browser) return opts.browser;
  const g = globalThis as { __slicc_browser?: BrowserAPI };
  if (g.__slicc_browser) return g.__slicc_browser;
  throw new Error('browser is not available in this runtime');
}

/**
 * Resolve the WS subscriber registry used by `browser.websocket.*`.
 * Production callers leave `opts.wsSubscribers` unset and the host
 * picks up the singleton wired in `kernel/host.ts`; tests inject one
 * directly. Missing registry throws a clear runtime error rather
 * than crashing with `undefined.observe is not a function`.
 */
function resolveWsSubscribers(opts: RealmHostOptions): WsSubscriberRegistry {
  if (opts.wsSubscribers) return opts.wsSubscribers;
  const g = globalThis as { __slicc_wsSubscribers?: WsSubscriberRegistry };
  if (g.__slicc_wsSubscribers) return g.__slicc_wsSubscribers;
  throw new Error('browser.websocket is not available in this runtime');
}

/**
 * Resolve the WebUSB / Web Serial / WebHID backend for the device
 * channels. Tests inject one through `opts`; production paths resolve
 * the same dual-path backend the shell commands use — the local
 * `navigator.*` in a DOM realm (extension), the panel-RPC bridge in the
 * kernel worker (standalone). A missing backend throws a clear
 * "unavailable in this runtime" error.
 */
function resolveUsbBackendForHost(opts: RealmHostOptions): UsbBackend {
  if (opts.usbBackend) return opts.usbBackend;
  const backend = resolveUsbBackend(hasLocalDom(), getPanelRpcClient());
  if (!backend) throw new Error('usb is not available in this runtime');
  return backend;
}

function resolveSerialBackendForHost(opts: RealmHostOptions): SerialBackend {
  if (opts.serialBackend) return opts.serialBackend;
  const backend = resolveSerialBackend(hasLocalDom(), getPanelRpcClient());
  if (!backend) throw new Error('serial is not available in this runtime');
  return backend;
}

function resolveHidBackendForHost(opts: RealmHostOptions): HidBackend {
  if (opts.hidBackend) return opts.hidBackend;
  const backend = resolveHidBackend(hasLocalDom(), getPanelRpcClient());
  if (!backend) throw new Error('hid is not available in this runtime');
  return backend;
}

// ---------------------------------------------------------------------------
// Channel: vfs
// ---------------------------------------------------------------------------

async function dispatchVfs(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  const path = typeof args[0] === 'string' ? (args[0] as string) : null;
  const resolved = path !== null ? ctx.fs.resolvePath(ctx.cwd, path) : null;
  switch (op) {
    case 'readFile':
      return ctx.fs.readFile(resolved!);
    case 'readFileBinary':
      return ctx.fs.readFileBuffer(resolved!);
    case 'writeFile':
      await ctx.fs.writeFile(resolved!, args[1] as string);
      return true;
    case 'writeFileBinary':
      await ctx.fs.writeFile(resolved!, args[1] as Uint8Array);
      return true;
    case 'readDir':
      return ctx.fs.readdir(resolved!);
    case 'exists':
      return ctx.fs.exists(resolved!);
    case 'stat': {
      const st = await ctx.fs.stat(resolved!);
      return { isDirectory: st.isDirectory, isFile: st.isFile, size: st.size };
    }
    case 'mkdir':
      await ctx.fs.mkdir(resolved!, { recursive: true });
      return true;
    case 'rm':
      await ctx.fs.rm(resolved!, { recursive: true });
      return true;
    case 'rename': {
      const newPath = ctx.fs.resolvePath(ctx.cwd, args[1] as string);
      const fs = ctx.fs as { rename?: (a: string, b: string) => Promise<void> };
      if (fs.rename) {
        await fs.rename(resolved!, newPath);
      } else {
        const content = await ctx.fs.readFileBuffer(resolved!);
        await ctx.fs.writeFile(newPath, content);
        await ctx.fs.rm(resolved!, { recursive: true });
      }
      return true;
    }
    case 'resolvePath':
      return ctx.fs.resolvePath(ctx.cwd, args[0] as string);
    case 'invalidatePaths': {
      const paths = args[0] as string[];
      const vfs = ctx.fs as { invalidatePaths?: (paths: string[]) => void };
      if (vfs.invalidatePaths) {
        vfs.invalidatePaths(paths);
      }
      return true;
    }
    case 'snapshot': {
      const root = typeof args[0] === 'string' ? (args[0] as string) : ctx.cwd;
      return buildSyncFsSnapshot(ctx, root);
    }
    case 'flushWrites': {
      const mutations = args[0] as SyncFsMutations;
      await applySyncFsMutations(ctx, mutations);
      return true;
    }
    default:
      throw new Error(`realm-host: unknown vfs op '${op}'`);
  }
}

// ---------------------------------------------------------------------------
// Sync FS cache: host-side snapshot builder + mutation flush
// ---------------------------------------------------------------------------

const SYNC_FS_MAX_FILES = 500;
const SYNC_FS_MAX_FILE_BYTES = 1048576; // 1MB
const SYNC_FS_MAX_TOTAL_BYTES = 10485760; // 10MB

/** Mutable accumulator threaded through the iterative snapshot walk. */
interface SnapshotBudget {
  entries: SyncFsSnapshot['entries'];
  totalBytes: number;
  fileCount: number;
}

function budgetExhausted(budget: SnapshotBudget): boolean {
  return budget.fileCount >= SYNC_FS_MAX_FILES || budget.totalBytes >= SYNC_FS_MAX_TOTAL_BYTES;
}

/** Visit one directory node during the walk: record it and push its children. */
async function visitSnapshotDir(
  ctx: CommandContext,
  current: string,
  stack: string[],
  budget: SnapshotBudget
): Promise<void> {
  budget.entries.push({ path: current, content: new Uint8Array(0), isDirectory: true });
  let names: string[];
  try {
    names = await ctx.fs.readdir(current);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'node_modules') continue;
    stack.push(current === '/' ? `/${name}` : `${current}/${name}`);
  }
}

/** Visit one file node during the walk: record its content if within budget. */
async function visitSnapshotFile(
  ctx: CommandContext,
  current: string,
  size: number,
  budget: SnapshotBudget
): Promise<void> {
  // Oversized files still need a placeholder entry so `existsSync`/`statSync`
  // behave correctly for them; only the content read is skipped. Without
  // this, a file over budget silently disappears from the sync cache and
  // `existsSync` incorrectly reports `false` for a file that really exists.
  if (size > SYNC_FS_MAX_FILE_BYTES) {
    budget.entries.push({
      path: current,
      content: new Uint8Array(0),
      isDirectory: false,
      truncated: true,
    });
    return;
  }
  if (budget.totalBytes + size > SYNC_FS_MAX_TOTAL_BYTES) {
    budget.entries.push({
      path: current,
      content: new Uint8Array(0),
      isDirectory: false,
      truncated: true,
    });
    return;
  }
  const content = await ctx.fs.readFileBuffer(current);
  budget.entries.push({ path: current, content, isDirectory: false });
  budget.fileCount += 1;
  budget.totalBytes += content.byteLength;
}

/**
 * Iteratively walk `rootPath`, feeding files/directories into `budget` until
 * either the tree is exhausted or a budget limit is hit. An explicit stack
 * (rather than recursive calls) avoids stack overflow on deep trees.
 * `node_modules` directories are skipped entirely.
 */
async function walkSnapshotRoot(
  ctx: CommandContext,
  rootPath: string,
  budget: SnapshotBudget
): Promise<void> {
  if (budgetExhausted(budget)) return;
  if (!(await ctx.fs.exists(rootPath))) return;
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    if (budgetExhausted(budget)) return;
    const current = stack.pop()!;
    let st: { isDirectory: boolean; isFile: boolean; size: number };
    try {
      st = await ctx.fs.stat(current);
    } catch {
      continue;
    }
    if (st.isDirectory) {
      await visitSnapshotDir(ctx, current, stack, budget);
    } else if (st.isFile) {
      await visitSnapshotFile(ctx, current, st.size, budget);
    }
  }
}

/**
 * Walk `root` (and `/tmp`, if present) iteratively, collecting files and
 * directories into a `SyncFsSnapshot` for the realm's `SyncFsCache`. Bounded
 * by file count and byte budgets (combined across both roots) so a huge tree
 * can't blow the realm worker's memory or the postMessage payload.
 */
async function buildSyncFsSnapshot(ctx: CommandContext, root: string): Promise<SyncFsSnapshot> {
  const budget: SnapshotBudget = { entries: [], totalBytes: 0, fileCount: 0 };

  await walkSnapshotRoot(ctx, root, budget);
  if (root !== '/tmp') {
    await walkSnapshotRoot(ctx, '/tmp', budget);
  }

  return { entries: budget.entries };
}

/** Apply the realm's diffed sync-fs mutations back to the real VFS. */
async function applySyncFsMutations(
  ctx: CommandContext,
  mutations: SyncFsMutations
): Promise<void> {
  // Order matters: a path that was deleted then recreated with a different
  // type (e.g. `rm -rf dir && mkdir dir/file` semantics, or a file replaced
  // by a directory of the same name) must tear down the old node BEFORE the
  // new one is written, or the create step can throw/merge against stale
  // state. `deleted` first, then `created`, then `modified`.
  for (const path of mutations.deleted) {
    await ctx.fs.rm(path, { recursive: true });
  }
  for (const entry of mutations.created) {
    if (entry.isDirectory) {
      await ctx.fs.mkdir(entry.path, { recursive: true });
    } else {
      await ctx.fs.writeFile(entry.path, entry.content);
    }
  }
  for (const entry of mutations.modified) {
    await ctx.fs.writeFile(entry.path, entry.content);
  }
}

// ---------------------------------------------------------------------------
// Channel: exec
// ---------------------------------------------------------------------------

/**
 * Per-host state for the `exec.start` / `exec.kill` ops. Lives in
 * `attachRealmHost`'s closure. `spawns` maps each realm-allocated
 * `spawnId` to the in-flight command's `AbortController` (+ PM pid when
 * a `pm`/`owner` were threaded in) so a concurrent `kill` op can abort
 * the `ctx.exec` and fan a signal out. `opts` carries the `pm`/`owner`/
 * `ppid` used to register a real PM process per spawn.
 */
interface ExecDispatchCtx {
  spawns: Map<number, { controller: AbortController; pid: number }>;
  opts: RealmHostOptions;
}

/** Signals `exec.kill` accepts; anything else is coerced to SIGTERM. */
const EXEC_KILL_SIGNALS: ReadonlySet<Signal> = new Set<Signal>([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGSTOP',
  'SIGCONT',
]);

/**
 * Terminating signals that cancel the in-flight `ctx.exec` via
 * `controller.abort()`. SIGSTOP / SIGCONT are pause/resume — they drive the
 * PM `Gate` (`pm.signal`) only and must NOT abort, or a pause would terminate
 * the buffered command instead of holding it.
 */
const EXEC_TERMINATING_SIGNALS: ReadonlySet<Signal> = new Set<Signal>([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
]);

async function dispatchExec(
  op: string,
  args: unknown[],
  ctx: CommandContext,
  execCtx: ExecDispatchCtx
): Promise<unknown> {
  if (!ctx.exec) throw new Error('exec is not available in this runtime');
  if (op === 'run') {
    const command = args[0] as string;
    const result = await ctx.exec(command, { cwd: ctx.cwd });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
  if (op === 'spawn') {
    // Shell-free variant — mirrors `child_process.spawnSync(cmd, args)`.
    // Passes `argv.slice(1)` through just-bash's `args` option, which
    // bypasses shell parsing / globbing / quoting entirely. argv[0] is
    // the bare executable name (no metas) so the shell sees a single
    // word and the rest are appended verbatim. Eliminates the
    // `shellQuote()` boilerplate skills used to keep around.
    const argv = args[0];
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      throw new Error('exec.spawn: argv must be a non-empty string[]');
    }
    const [cmd, ...rest] = argv as string[];
    const result = await ctx.exec(cmd, { cwd: ctx.cwd, args: rest });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }
  if (op === 'start') return dispatchExecStart(args, ctx, execCtx);
  if (op === 'kill') return dispatchExecKill(args, execCtx);
  throw new Error(`realm-host: unknown exec op '${op}'`);
}

/**
 * Validate the `exec.start` options envelope: `stdin` must be a string,
 * `stdinKind` must be `'text' | 'bytes'`, and `args` a `string[]`. Throws a
 * clear error on any bad shape so a malformed client payload can't corrupt
 * the downstream `ctx.exec` call.
 */
function assertExecStartOptions(opts: {
  stdin?: unknown;
  stdinKind?: unknown;
  args?: unknown;
}): void {
  if (opts.stdin !== undefined && typeof opts.stdin !== 'string') {
    throw new Error('exec.start: stdin must be a string');
  }
  if (opts.stdinKind !== undefined && opts.stdinKind !== 'text' && opts.stdinKind !== 'bytes') {
    throw new Error("exec.start: stdinKind must be 'text' or 'bytes'");
  }
  if (
    opts.args !== undefined &&
    (!Array.isArray(opts.args) || !opts.args.every((a) => typeof a === 'string'))
  ) {
    throw new Error('exec.start: args must be a string[]');
  }
}

/**
 * `exec.start` — the killable, buffered-stdin spawn. Accepts a
 * realm-allocated monotonic `spawnId`, a command string OR a shell-free
 * argv, and `{ stdin, stdinKind, args }`. Creates an `AbortController`,
 * registers a PM process (when `pm`/`owner` were threaded in), threads the
 * signal + buffered stdin into a single one-shot `ctx.exec`, and resolves
 * with the buffered `{ stdout, stderr, exitCode }`. The spawn entry + PM
 * process are cleaned up on settle (natural completion OR abort). A
 * concurrent `exec.kill [spawnId, sig]` aborts the signal and fans out to
 * the PM process.
 */
async function dispatchExecStart(
  args: unknown[],
  ctx: CommandContext,
  execCtx: ExecDispatchCtx
): Promise<unknown> {
  const [spawnId, commandOrArgv, options] = args as [
    number,
    string | string[],
    { stdin?: string; stdinKind?: 'text' | 'bytes'; args?: string[] } | undefined,
  ];
  if (typeof spawnId !== 'number') {
    throw new Error('exec.start: spawnId must be a number');
  }
  // Reject a spawnId already tracking a live spawn — overwriting it would
  // strand the in-flight command's `AbortController` (kill could never reach
  // it) and PM record. The realm allocates monotonic ids, so a collision means
  // a buggy / malicious client.
  if (execCtx.spawns.has(spawnId)) {
    throw new Error(`exec.start: spawnId ${spawnId} is already in use`);
  }
  let cmd: string;
  let argvTail: string[] | undefined;
  let procArgv: string[];
  if (Array.isArray(commandOrArgv)) {
    if (commandOrArgv.length === 0 || !commandOrArgv.every((a) => typeof a === 'string')) {
      throw new Error('exec.start: argv must be a non-empty string[]');
    }
    [cmd, ...argvTail] = commandOrArgv;
    procArgv = commandOrArgv.slice();
  } else if (typeof commandOrArgv === 'string') {
    cmd = commandOrArgv;
    procArgv = [commandOrArgv];
  } else {
    throw new Error('exec.start: command must be a string or a non-empty string[]');
  }

  const opts = options ?? {};
  // Validate the forwarded options before touching PM / `ctx.exec` so a
  // malformed shape throws a clear error instead of corrupting the just-bash
  // exec call downstream.
  assertExecStartOptions(opts);
  const controller = new AbortController();
  const { pm, owner } = execCtx.opts;
  let pid = 0;
  if (pm && owner) {
    const proc = pm.spawn({
      kind: 'shell',
      argv: procArgv,
      cwd: ctx.cwd,
      owner,
      ...(execCtx.opts.ppid !== undefined ? { ppid: execCtx.opts.ppid } : {}),
      adoptAbort: controller,
    });
    pid = proc.pid;
  }
  execCtx.spawns.set(spawnId, { controller, pid });

  let result: { stdout: string; stderr: string; exitCode: number } | undefined;
  try {
    const execOptions: {
      cwd: string;
      signal: AbortSignal;
      stdin?: string;
      stdinKind?: 'text' | 'bytes';
      args?: string[];
    } = { cwd: ctx.cwd, signal: controller.signal };
    if (opts.stdin !== undefined) execOptions.stdin = opts.stdin;
    if (opts.stdinKind !== undefined) execOptions.stdinKind = opts.stdinKind;
    // Array form's tail is the shell-free argv (wins); string form takes an
    // explicit `args` from options.
    if (argvTail !== undefined) execOptions.args = argvTail;
    else if (opts.args !== undefined) execOptions.args = opts.args;
    result = await ctx.exec!(cmd, execOptions);
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } finally {
    execCtx.spawns.delete(spawnId);
    if (pm && pid) {
      // A killed spawn derives its exit from the recorded signal (137 / 143
      // / 130); a naturally-completed one reports the command's real code.
      const proc = pm.get(pid);
      pm.exit(pid, proc?.terminatedBy ? null : (result?.exitCode ?? 1));
    }
  }
}

/**
 * `exec.kill [spawnId, sig]` — deliver `sig` to the `spawnId` spawn. A
 * terminating signal (SIGINT / SIGTERM / SIGKILL) aborts the in-flight
 * `ctx.exec`; SIGSTOP / SIGCONT are pause/resume and fan out to the PM `Gate`
 * only (no abort). Returns `true` when the spawn was live (delivered),
 * `false` when unknown / already settled — matching POSIX `kill(2)`. `sig`
 * defaults to SIGTERM; unknown signals coerce to it.
 */
function dispatchExecKill(args: unknown[], execCtx: ExecDispatchCtx): boolean {
  const [spawnId, rawSig] = args as [number, string | undefined];
  const entry = execCtx.spawns.get(spawnId);
  if (!entry) return false;
  const sig: Signal =
    typeof rawSig === 'string' && EXEC_KILL_SIGNALS.has(rawSig as Signal)
      ? (rawSig as Signal)
      : 'SIGTERM';
  // Only terminating signals cancel the buffered command; STOP/CONT leave it
  // running and rely on the PM gate for pause/resume.
  if (EXEC_TERMINATING_SIGNALS.has(sig) && !entry.controller.signal.aborted) {
    entry.controller.abort();
  }
  const { pm } = execCtx.opts;
  if (pm && entry.pid) return pm.signal(entry.pid, sig);
  // No PM record (RPC unit-test path): a terminating signal's abort above IS
  // the delivery; STOP/CONT have no local effect but still report delivered.
  return true;
}

// ---------------------------------------------------------------------------
// Channel: fetch
// ---------------------------------------------------------------------------

async function dispatchFetch(
  op: string,
  args: unknown[],
  ctx: CommandContext
): Promise<SerializedFetchResponse> {
  if (op !== 'request') throw new Error(`realm-host: unknown fetch op '${op}'`);
  const [url, init] = args as [string, RequestInit | undefined];
  // Prefer ctx.fetch (SecureFetch) — keeps secret substitution and
  // domain allow-listing on the host side. Without this, kernel-
  // realm scripts would bypass the proxy and break every
  // secret-gated API.
  const fetchFn: typeof globalThis.fetch = ctx.fetch
    ? createNodeFetchAdapter(ctx.fetch)
    : globalThis.fetch.bind(globalThis);
  const response = await fetchFn(url, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    body,
    url: response.url,
  };
}

// ---------------------------------------------------------------------------
// Channel: module
// ---------------------------------------------------------------------------

/**
 * Adapt a `CommandContext`'s VFS into the read-only {@link ModuleReader} the
 * resolver/loader need. Paths arriving from the resolver are absolute (built
 * from `fromDir`), but we still route through `resolvePath` so a relative
 * `fromDir` is anchored to the realm's cwd the same way `dispatchVfs` does.
 */
function createCtxModuleReader(ctx: CommandContext): ModuleReader {
  const resolveP = (p: string): string => ctx.fs.resolvePath(ctx.cwd, p);
  return {
    exists: (p) => ctx.fs.exists(resolveP(p)),
    isDirectory: async (p) => {
      try {
        return (await ctx.fs.stat(resolveP(p))).isDirectory;
      } catch {
        return false;
      }
    },
    readFile: async (p) => {
      const content = await ctx.fs.readFile(resolveP(p));
      return typeof content === 'string' ? content : new TextDecoder().decode(content);
    },
  };
}

/**
 * Build the host-resolved CJS module graph for the realm's ENTRY CODE
 * (architecture 4.4, §6) over the `module`/`buildGraph` RPC. The host extracts
 * the entry's tagged `require`/`import` specifiers, resolves each in isolation
 * (so a single uninstalled package surfaces as a per-entry `errors[specifier]`
 * entry — the resolver's exact `Cannot find module '<x>' (run: ipk install
 * <x>)` text — without sinking the other entries' graphs) using its access-path
 * `exports` conditions (`import` vs `require`), recursively follows nested edges
 * per kind, transpiles every ESM module to CJS, and transpiles the entry itself
 * when it uses static/dynamic `import` or top-level `await`. Modules shared
 * across entries are emitted once; the realm dedups again by path at evaluation
 * time so the CJS cache stays a singleton per module. There is NO CDN fallback —
 * an unresolved bare module never triggers a network fetch.
 */
async function dispatchModule(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  if (op !== 'buildGraph') throw new Error(`realm-host: unknown module op '${op}'`);
  const entryCode = typeof args[0] === 'string' ? (args[0] as string) : '';
  const fromDir = typeof args[1] === 'string' && args[1] ? (args[1] as string) : ctx.cwd;
  const entryFilename = typeof args[2] === 'string' ? (args[2] as string) : '';
  const reader = createCtxModuleReader(ctx);
  // ipk context for the default `getEsbuild` / `getTypeScript` loaders
  // so the browser branch can read ipk-installed packages from VFS
  // `node_modules`. Under Node runtime both loaders use the bundled
  // wrappers and the ipk context is unused.
  const ipk = {
    reader,
    readBytes: (path: string) => ctx.fs.readFileBuffer(path),
    fromDir,
  };

  return buildRealmModuleGraph({
    entryCode,
    fromDir,
    entryFilename,
    reader,
    transpile: createEsmTranspile({ ipk }),
    transpileEntry: createEntryTranspile({ ipk }),
  });
}

// ---------------------------------------------------------------------------
// Channel: wasm
// ---------------------------------------------------------------------------

/**
 * Compile WASM bytes host-side and hand the realm a ready
 * `WebAssembly.Module`. The realm passes a VFS path; the host reads the
 * bytes and runs `WebAssembly.compile` in the high-headroom kernel-worker /
 * shell context, so a large module (biome's ~37 MB `biome_wasm_bg.wasm`)
 * never OOMs the per-task realm worker the way an in-realm
 * `WebAssembly.compile` does. The resulting `WebAssembly.Module` is
 * structured-cloneable (NOT a transferable) so it round-trips over the
 * realm port via `respond`'s plain `postMessage` — `collectTransferables`
 * deliberately leaves it alone.
 */
async function dispatchWasm(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  if (op !== 'compile') throw new Error(`realm-host: unknown wasm op '${op}'`);
  const path = typeof args[0] === 'string' ? (args[0] as string) : null;
  if (path === null) throw new Error('realm-host: wasm.compile requires a path argument');
  const resolved = ctx.fs.resolvePath(ctx.cwd, path);
  return compileWasmFromVfs((p) => ctx.fs.readFileBuffer(p), resolved);
}

// ---------------------------------------------------------------------------
// Channel: browser
// ---------------------------------------------------------------------------

/**
 * Dispatch a `browser` channel RPC. All ops route through
 * `BrowserAPI` (the same surface `playwright-command.ts` uses), so
 * standalone and extension floats share one bridge — only the
 * underlying CDP transport differs. Tab-scoped ops serialize through
 * `browser.withTab` so they can't race with the panel terminal's
 * `playwright` invocations.
 */
async function dispatchBrowser(
  op: string,
  args: unknown[],
  browser: BrowserAPI,
  opts: RealmHostOptions
): Promise<unknown> {
  switch (op) {
    case 'findTab': {
      const query = (args[0] as { domain?: string; urlMatch?: string } | undefined) ?? {};
      return findTab(browser, query);
    }
    case 'ensureTab': {
      const url = args[0] as string;
      const options = (args[1] as { matchUrl?: string } | undefined) ?? {};
      return ensureTab(browser, url, options);
    }
    case 'eval': {
      const targetId = args[0] as string;
      const code = args[1] as string;
      return evalInTab(browser, targetId, code, false);
    }
    case 'evalAsync': {
      const targetId = args[0] as string;
      const code = args[1] as string;
      return evalInTab(browser, targetId, code, true);
    }
    case 'cookie': {
      const targetId = args[0] as string;
      const name = args[1] as string;
      return getCookie(browser, targetId, name);
    }
    case 'localStorage': {
      const targetId = args[0] as string;
      const key = args[1] as string;
      return getLocalStorage(browser, targetId, key);
    }
    case 'wsObserve': {
      // Realm code never supplies the owning scoop — the trusted host
      // side stamps it from `opts.scoopJid` so the registry's
      // `dropForScoop(jid)` cleanup hook can find this entry later.
      const req = { ...(args[0] as WsObserveRequest), scoopJid: opts.scoopJid };
      const info: WsSubscriberInfo = await resolveWsSubscribers(opts).observe(req);
      return info;
    }
    case 'wsUpdate': {
      const id = args[0] as string;
      const patch =
        (args[1] as { urlMatch?: string | null; filter?: WsSelector | null } | undefined) ?? {};
      return resolveWsSubscribers(opts).update(id, patch);
    }
    case 'wsClose': {
      const id = args[0] as string;
      return resolveWsSubscribers(opts).close(id);
    }
    case 'wsList': {
      return resolveWsSubscribers(opts).list();
    }
    case 'createTab': {
      const url = args[0] as string | undefined;
      return browser.createPage(url);
    }
    case 'closeTab': {
      const targetId = args[0] as string;
      return browser.closePage(targetId);
    }
    case 'setViewport': {
      const targetId = args[0] as string;
      const width = args[1] as number;
      const height = args[2] as number;
      return browser.withTab(targetId, async () => {
        await browser.sendCDP('Emulation.setDeviceMetricsOverride', {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
      });
    }
    case 'navigateTab': {
      const targetId = args[0] as string;
      const url = args[1] as string;
      return browser.withTab(targetId, async () => {
        await browser.navigate(url);
      });
    }
    case 'screenshotTab': {
      const targetId = args[0] as string;
      const screenshotOpts = args[1] as { fullPage?: boolean } | undefined;
      return browser.withTab(targetId, async () => {
        return browser.screenshot(screenshotOpts);
      });
    }
    case 'waitForLoadState': {
      const targetId = args[0] as string;
      const state = args[1] as string | undefined;
      return waitForLoadState(browser, targetId, state);
    }
    default:
      throw new Error(`realm-host: unknown browser op '${op}'`);
  }
}

/**
 * Cheap, synchronous check for whether a multi-browser tray is configured
 * (leader worker URL or follower join URL present). Reads `globalThis.localStorage`
 * — the real Storage on the page, or the page-seeded shim in the kernel worker.
 * Used to skip the `list-remote-targets` panel-RPC round-trip entirely when no
 * tray exists, so a plain (non-tray) `findTab` / `ensureTab` stays at one local
 * call. Mirrors `isTrayConfigured` in
 * `shell/supplemental-commands/playwright/snapshot.ts`.
 */
function isTrayConfigured(): boolean {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return false;
    return !!(ls.getItem(TRAY_WORKER_STORAGE_KEY) || ls.getItem(TRAY_JOIN_STORAGE_KEY));
  } catch {
    return false;
  }
}

async function listTabHandles(browser: BrowserAPI): Promise<TabHandle[]> {
  // `listAllTargets` is local-only in the kernel worker: the worker's tray
  // provider's `getTargets()` returns `[]` (it exists only to *drive* remote
  // targets, not list them). When a tray is configured, supplement the local
  // set with the federated fleet via the page-side BrowserAPI over panel-RPC
  // (`list-remote-targets`) and dedupe by targetId — exactly like
  // `getActionablePages` does for the playwright-cli surface. The
  // tray-configured gate keeps the no-tray common case to a single local call
  // (no BroadcastChannel round-trip, no 3s-timeout exposure). The composite
  // `<runtimeId>:<localTargetId>` ids surfaced here are drivable: `withTab` →
  // `attachToPage` routes them through the worker tray provider's
  // RemoteCDPTransport.
  if (typeof browser.listAllTargets !== 'function') {
    const pages = await browser.listPages();
    return pages.map((p) => ({ targetId: p.targetId, url: p.url, title: p.title }));
  }
  const pages = await browser.listAllTargets();
  const handles: TabHandle[] = pages.map((p) => ({
    targetId: p.targetId,
    url: p.url,
    title: p.title,
  }));
  const rpc = isTrayConfigured() ? getPanelRpcClient() : null;
  if (rpc) {
    try {
      const { targets } = await rpc.call('list-remote-targets', undefined, { timeoutMs: 3000 });
      const seen = new Set(handles.map((h) => h.targetId));
      for (const t of targets) {
        if (!seen.has(t.targetId)) {
          seen.add(t.targetId);
          handles.push({ targetId: t.targetId, url: t.url, title: t.title });
        }
      }
    } catch (err) {
      log.debug('panel-rpc list-remote-targets failed', { err: String(err) });
    }
  }
  return handles;
}

async function findTab(
  browser: BrowserAPI,
  query: { domain?: string; urlMatch?: string }
): Promise<TabHandle | null> {
  const tabs = await listTabHandles(browser);
  if (query.domain) {
    const wanted = query.domain.toLowerCase();
    for (const t of tabs) {
      const host = safeHostname(t.url);
      if (host && host.toLowerCase() === wanted) return t;
    }
    return null;
  }
  if (query.urlMatch) {
    let re: RegExp;
    try {
      re = new RegExp(query.urlMatch);
    } catch (err) {
      throw new Error(
        `browser.findTab: invalid urlMatch regex: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    for (const t of tabs) {
      if (re.test(t.url)) return t;
    }
    return null;
  }
  throw new Error('browser.findTab: query requires `domain` or `urlMatch`');
}

async function ensureTab(
  browser: BrowserAPI,
  url: string,
  options: { matchUrl?: string }
): Promise<TabHandle> {
  // Default match: same origin as the requested URL. Callers can
  // override with a regex (`matchUrl`) when origin equality is too
  // loose / tight (e.g. matching a path prefix or a tray target).
  const tabs = await listTabHandles(browser);
  if (options.matchUrl) {
    let re: RegExp;
    try {
      re = new RegExp(options.matchUrl);
    } catch (err) {
      throw new Error(
        `browser.ensureTab: invalid matchUrl regex: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const hit = tabs.find((t) => re.test(t.url));
    if (hit) return hit;
  } else {
    const wantedOrigin = safeOrigin(url);
    if (wantedOrigin) {
      const hit = tabs.find((t) => safeOrigin(t.url) === wantedOrigin);
      if (hit) return hit;
    }
  }
  const targetId = await browser.createPage(url);
  // `createPage` returns just the id; build a handle eagerly so the
  // caller can immediately `browser.eval(tab, ...)` without a second
  // listPages round-trip. Title may still be empty (the page hasn't
  // loaded yet) but `url` matches what the caller asked for.
  return { targetId, url, title: '' };
}

async function evalInTab(
  browser: BrowserAPI,
  targetId: string,
  code: string,
  awaitPromise: boolean
): Promise<unknown> {
  return browser.withTab(targetId, async () => {
    const value = await browser.evaluate(code, { awaitPromise, returnByValue: true });
    return unwrapEvalResult(value);
  });
}

/**
 * Transparent double-JSON unwrap. CDP `Runtime.evaluate` with
 * `returnByValue: true` already round-trips structured-cloneable
 * values directly — but the long-standing convention in
 * `playwright eval-file` scripts is to `JSON.stringify` the final
 * value so the shell can pipe it cleanly. That puts one or two
 * layers of JSON encoding between the user's value and the realm
 * caller. We peel only the layers we can prove are wrappers:
 *
 *  - If the first parse yields an object/array, the original
 *    string can only have been `JSON.stringify(obj)` — return it.
 *  - If the first parse yields a string AND that inner string
 *    itself starts with `{` or `[`, the original was a double
 *    `JSON.stringify` — peel one more layer.
 *  - Otherwise (primitive parses such as `"123"`, `"true"`,
 *    `"null"`, `"-1.5"`, or a `JSON.stringify("hello")` →
 *    `"\"hello\""` round-trip), leave the original string alone or
 *    return the single-unwrapped inner string. Primitives that the
 *    page returned as strings must keep their string type — losing
 *    that distinction would silently turn `localStorage.getItem`
 *    values into numbers/booleans.
 */
function unwrapEvalResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const first = tryParseJson(value);
  if (first === undefined) return value;
  if (first !== null && typeof first === 'object') return first;
  if (typeof first === 'string') {
    // First layer was a stringified string. Only unwrap a second
    // time when the inner string is itself a stringified
    // object/array — that's the only shape we can be sure was a
    // double wrap rather than a deliberate single `JSON.stringify`
    // of a plain string.
    const trimmed = first.trim();
    if (trimmed.length > 0 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      const second = tryParseJson(first);
      if (second !== null && typeof second === 'object') return second;
    }
    return first;
  }
  // Primitive (number / boolean / null) — keep the caller's original
  // string so a page value of `"123"` doesn't become `123`.
  return value;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  // Cheap heuristic gate: only parse strings that look like a JSON
  // literal. The check is intentionally permissive (we still need
  // to recognize stringified objects, arrays, and strings) — the
  // result-type discrimination in `unwrapEvalResult` is what
  // protects primitive payloads from getting unwrapped.
  if (trimmed.length === 0) return undefined;
  const first = trimmed[0];
  const looksJson =
    first === '{' ||
    first === '[' ||
    first === '"' ||
    first === '-' ||
    (first >= '0' && first <= '9') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null';
  if (!looksJson) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Wait for a page load-state milestone on an already-navigated tab.
 * `load` / `domcontentloaded` are already satisfied by the time
 * `navigateTab` resolves (it awaits `Page.loadEventFired`), so those
 * states resolve immediately without a round-trip. `networkidle` has
 * no direct CDP wait primitive here, so it's approximated by polling
 * `PerformanceObserver`-backed resource-timing entries in-page until
 * no new network resource has started for a short quiet window —
 * mirroring Playwright's own networkidle heuristic (no new requests
 * for ~500ms).
 */
async function waitForLoadState(
  browser: BrowserAPI,
  targetId: string,
  state: string | undefined
): Promise<void> {
  if (state !== 'networkidle') {
    // 'load' / 'domcontentloaded' (and no state at all) are already
    // satisfied post-navigate.
    return;
  }
  return browser.withTab(targetId, async () => {
    const maxAttempts = 20;
    const pollIntervalMs = 250;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const idle = await browser.evaluate(
        `(function(){
          try {
            var entries = performance.getEntriesByType('resource');
            var now = performance.now();
            var recentCutoffMs = 500;
            var busy = entries.some(function(e) {
              var finished = e.responseEnd || e.startTime;
              return (now - finished) < recentCutoffMs;
            });
            return !busy;
          } catch (e) {
            return true;
          }
        })()`,
        { returnByValue: true }
      );
      if (idle) return;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  });
}

async function getCookie(
  browser: BrowserAPI,
  targetId: string,
  name: string
): Promise<string | null> {
  return browser.withTab(targetId, async () => {
    // `Network.getCookies` (no `urls`) returns cookies visible to
    // the attached page — same surface `playwright cookie-get`
    // uses, so standalone + extension behave identically.
    const result = await browser.sendCDP('Network.getCookies');
    const cookies = (result['cookies'] as Array<{ name?: string; value?: string }>) ?? [];
    const hit = cookies.find((c) => c.name === name);
    return hit && typeof hit.value === 'string' ? hit.value : null;
  });
}

async function getLocalStorage(
  browser: BrowserAPI,
  targetId: string,
  key: string
): Promise<string | null> {
  // Read via in-page evaluate so we hit the same origin's storage
  // partition the page sees — `DOMStorage.getDOMStorageItems`
  // requires a frame ID and security origin lookup we'd otherwise
  // have to plumb, and the evaluate path matches `playwright
  // eval` semantics.
  return browser.withTab(targetId, async () => {
    const raw = await browser.evaluate(
      `(function(){try{var v=window.localStorage.getItem(${JSON.stringify(key)});return v===null?null:String(v);}catch(e){return null;}})()`,
      { returnByValue: true }
    );
    if (raw === null || raw === undefined) return null;
    return typeof raw === 'string' ? raw : String(raw);
  });
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Channels: usb / serial / hid
// ---------------------------------------------------------------------------

/**
 * Dispatch a `usb` channel RPC against the resolved backend. Op names
 * match the realm-side device-method semantics; binary results (`bytes`)
 * are handed back to the realm verbatim and transferred by
 * `collectTransferables`. The realm bridge re-wraps them as `DataView`s.
 */
async function dispatchUsb(op: string, args: unknown[], backend: UsbBackend): Promise<unknown> {
  switch (op) {
    case 'list':
      return backend.list();
    case 'request':
      return backend.request((args[0] as UsbDeviceFilter[]) ?? []);
    case 'info':
      return backend.info(args[0] as string);
    case 'open':
      return backend.open(args[0] as string);
    case 'close':
      return backend.close(args[0] as string);
    case 'reset':
      return backend.reset(args[0] as string);
    case 'selectConfig':
      return backend.selectConfig(args[0] as string, args[1] as number);
    case 'claim':
      return backend.claim(args[0] as string, args[1] as number);
    case 'release':
      return backend.release(args[0] as string, args[1] as number);
    case 'controlIn':
      return backend.controlIn(args[0] as string, args[1] as UsbControlSetup, args[2] as number);
    case 'controlOut':
      return backend.controlOut(
        args[0] as string,
        args[1] as UsbControlSetup,
        args[2] as Uint8Array
      );
    case 'transferIn':
      return backend.transferIn(args[0] as string, args[1] as number, args[2] as number);
    case 'transferOut':
      return backend.transferOut(args[0] as string, args[1] as number, args[2] as Uint8Array);
    default:
      throw new Error(`realm-host: unknown usb op '${op}'`);
  }
}

/** Dispatch a `serial` channel RPC against the resolved backend. */
async function dispatchSerial(
  op: string,
  args: unknown[],
  backend: SerialBackend
): Promise<unknown> {
  switch (op) {
    case 'list':
      return backend.list();
    case 'request':
      return backend.request((args[0] as SerialFilter[]) ?? []);
    case 'info':
      return backend.info(args[0] as string);
    case 'open':
      return backend.open(args[0] as string, args[1] as SerialOpenOptions);
    case 'close':
      return backend.close(args[0] as string);
    case 'read': {
      const params =
        (args[1] as { maxBytes?: number; until?: Uint8Array; timeoutMs?: number } | undefined) ??
        {};
      return backend.read(args[0] as string, params);
    }
    case 'write':
      return backend.write(args[0] as string, args[1] as Uint8Array);
    case 'getSignals':
      return backend.getSignals(args[0] as string);
    case 'setSignals':
      return backend.setSignals(args[0] as string, args[1] as SerialOutputSignals);
    default:
      throw new Error(`realm-host: unknown serial op '${op}'`);
  }
}

/**
 * Per-port state the HID dispatch needs beyond the backend itself:
 * the subscription map (so subscribe/unsubscribe are idempotent and
 * realm teardown can drain leftovers) and the push hook (so backend
 * `inputreport` callbacks fan back to the realm over the same port
 * the RPC arrived on). Lives in `attachRealmHost`'s closure.
 */
interface HidDispatchCtx {
  subscriptions: Map<string, () => void | Promise<void>>;
  pushEvent(msg: RealmEventMsg, transfer?: Transferable[]): void;
}

/** Dispatch a `hid` channel RPC against the resolved backend. */
async function dispatchHid(
  op: string,
  args: unknown[],
  backend: HidBackend,
  hidCtx: HidDispatchCtx
): Promise<unknown> {
  switch (op) {
    case 'list':
      return backend.list();
    case 'request':
      return backend.request((args[0] as HidDeviceFilter[]) ?? []);
    case 'info':
      return backend.info(args[0] as string);
    case 'open':
      return backend.open(args[0] as string);
    case 'close':
      return backend.close(args[0] as string);
    case 'sendReport':
      return backend.sendReport(args[0] as string, args[1] as number, args[2] as Uint8Array);
    case 'sendFeatureReport':
      return backend.sendFeatureReport(args[0] as string, args[1] as number, args[2] as Uint8Array);
    case 'receiveFeatureReport':
      return backend.receiveFeatureReport(args[0] as string, args[1] as number);
    case 'subscribeInputReports': {
      // Idempotent: a second subscribe for the same handle is a no-op so
      // a realm caller that hangs multiple listeners on one device only
      // opens one backend subscription. The matching unsubscribe runs on
      // `unsubscribeInputReports` or on realm-host `dispose()`.
      const handle = args[0] as string;
      if (hidCtx.subscriptions.has(handle)) return true;
      const off = await backend.subscribeInputReports(handle, (report) => {
        const bytes =
          report.bytes instanceof Uint8Array ? report.bytes : new Uint8Array(report.bytes);
        const msg: RealmEventMsg = {
          type: 'realm-event',
          channel: 'hid-input-report',
          payload: { handle, reportId: report.reportId, bytes },
        };
        hidCtx.pushEvent(msg, [bytes.buffer as Transferable]);
      });
      hidCtx.subscriptions.set(handle, off);
      return true;
    }
    case 'unsubscribeInputReports': {
      const handle = args[0] as string;
      const off = hidCtx.subscriptions.get(handle);
      if (!off) return true;
      hidCtx.subscriptions.delete(handle);
      await off();
      return true;
    }
    default:
      throw new Error(`realm-host: unknown hid op '${op}'`);
  }
}

// ---------------------------------------------------------------------------
// Transferables
// ---------------------------------------------------------------------------

/**
 * Collect transferable buffers from a result tree. Walks `Uint8Array` /
 * `ArrayBuffer` at the top level (e.g. `serial read`) and inside the
 * `body` (`SerializedFetchResponse`) / `bytes` (USB/HID in-transfers)
 * fields — the only places we hand back binary data today.
 */
function collectTransferables(result: unknown): Transferable[] {
  if (result instanceof Uint8Array) {
    return [result.buffer as Transferable];
  }
  if (result && typeof result === 'object') {
    const obj = result as { body?: unknown; bytes?: unknown };
    if (obj.body instanceof Uint8Array) {
      return [obj.body.buffer as Transferable];
    }
    if (obj.bytes instanceof Uint8Array) {
      return [obj.bytes.buffer as Transferable];
    }
  }
  return [];
}
