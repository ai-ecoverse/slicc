import type { CommandContext } from 'just-bash';
import { createLogger } from '../../base/logger.js';
import type { BrowserAPI } from '../../cdp/browser-api.js';
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
import { mintSyncFsToken, revokeSyncFsToken } from './sync-fs-token-registry.js';
import type { SyncFsToken } from './sync-fs-wire.js';
import { attachSyncSabResponder } from './sync-sab-responder.js';
import { compileWasmFromVfs } from './wasm-compiler.js';
import type { WsSubscriberRegistry } from './ws-subscribers.js';

const log = createLogger('realm-host');

export interface RealmHostHandle {
  dispose(): void;

  syncFsToken?: SyncFsToken;
}

export interface RealmHostOptions {
  browser?: BrowserAPI;

  wsSubscribers?: WsSubscriberRegistry;

  scoopJid?: string;

  usbBackend?: UsbBackend;
  serialBackend?: SerialBackend;
  hidBackend?: HidBackend;

  pm?: ProcessManager;
  owner?: ProcessOwner;

  ppid?: number;

  syncFsBridgeEnabled?: boolean;

  syncSab?: SharedArrayBuffer;
}

export function attachRealmHost(
  port: RealmPortLike,
  ctx: CommandContext,
  opts: RealmHostOptions = {}
): RealmHostHandle {
  const hidSubscriptions = new Map<string, () => void | Promise<void>>();

  const syncFsToken = opts.syncFsBridgeEnabled
    ? mintSyncFsToken({ fs: ctx.fs, ...(ctx.exec ? { exec: ctx.exec } : {}), cwd: ctx.cwd })
    : undefined;
  let disposed = false;
  const pushEvent = (msg: RealmEventMsg, transfer: Transferable[] = []): void => {
    if (disposed) return;
    try {
      port.postMessage(msg, transfer);
    } catch {}
  };
  const hidCtx: HidDispatchCtx = { subscriptions: hidSubscriptions, pushEvent };

  const execSpawns = new Map<number, { controller: AbortController; pid: number }>();
  const execCtx: ExecDispatchCtx = { spawns: execSpawns, opts };
  const handler = (event: MessageEvent): void => {
    const data = event.data as { type?: string };
    if (data?.type !== 'realm-rpc-req') return;
    const req = event.data as RealmRpcRequest;
    void respond(port, req, ctx, opts, hidCtx, execCtx);
  };
  port.addEventListener('message', handler);

  const sabResponder =
    syncFsToken && opts.syncSab
      ? attachSyncSabResponder(port, opts.syncSab, syncFsToken)
      : undefined;
  port.start?.();
  return {
    syncFsToken,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      sabResponder?.dispose();
      if (syncFsToken) revokeSyncFsToken(syncFsToken);
      port.removeEventListener('message', handler);

      for (const { controller } of execSpawns.values()) {
        try {
          if (!controller.signal.aborted) controller.abort();
        } catch {}
      }
      execSpawns.clear();

      for (const unsub of hidSubscriptions.values()) {
        try {
          void Promise.resolve(unsub()).catch(() => {});
        } catch {}
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

function resolveBrowser(opts: RealmHostOptions): BrowserAPI {
  if (opts.browser) return opts.browser;
  const g = globalThis as { __slicc_browser?: BrowserAPI };
  if (g.__slicc_browser) return g.__slicc_browser;
  throw new Error('browser is not available in this runtime');
}

function resolveWsSubscribers(opts: RealmHostOptions): WsSubscriberRegistry {
  if (opts.wsSubscribers) return opts.wsSubscribers;
  const g = globalThis as { __slicc_wsSubscribers?: WsSubscriberRegistry };
  if (g.__slicc_wsSubscribers) return g.__slicc_wsSubscribers;
  throw new Error('browser.websocket is not available in this runtime');
}

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

const SYNC_FS_MAX_FILES = 500;
const SYNC_FS_MAX_FILE_BYTES = 1048576;
const SYNC_FS_MAX_TOTAL_BYTES = 10485760;

const SYNC_FS_MAX_ENTRIES = 20000;

interface SnapshotBudget {
  entries: SyncFsSnapshot['entries'];
  totalBytes: number;
  fileCount: number;
}

function contentBudgetExhausted(budget: SnapshotBudget): boolean {
  return budget.fileCount >= SYNC_FS_MAX_FILES || budget.totalBytes >= SYNC_FS_MAX_TOTAL_BYTES;
}

function entryBudgetExhausted(budget: SnapshotBudget): boolean {
  return budget.entries.length >= SYNC_FS_MAX_ENTRIES;
}

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

async function visitSnapshotSymlink(
  ctx: CommandContext,
  current: string,
  size: number,
  budget: SnapshotBudget
): Promise<void> {
  let target = '';
  try {
    target = await ctx.fs.readlink(current);
  } catch {
    return;
  }
  budget.entries.push({
    path: current,
    content: new Uint8Array(0),
    isDirectory: false,
    isSymbolicLink: true,
    symlinkTarget: target,
    size,
  });
}

async function visitSnapshotFile(
  ctx: CommandContext,
  current: string,
  size: number,
  budget: SnapshotBudget,
  stack: string[]
): Promise<void> {
  if (
    size > SYNC_FS_MAX_FILE_BYTES ||
    contentBudgetExhausted(budget) ||
    budget.totalBytes + size > SYNC_FS_MAX_TOTAL_BYTES
  ) {
    budget.entries.push({
      path: current,
      content: new Uint8Array(0),
      isDirectory: false,
      truncated: true,
      size,
    });
    return;
  }
  let content: Uint8Array;
  try {
    content = await ctx.fs.readFileBuffer(current);
  } catch {
    await recoverPoisonedSnapshotEntry(ctx, current, stack, budget);
    return;
  }
  budget.entries.push({ path: current, content, isDirectory: false });
  budget.fileCount += 1;
  budget.totalBytes += content.byteLength;
}

async function recoverPoisonedSnapshotEntry(
  ctx: CommandContext,
  current: string,
  stack: string[],
  budget: SnapshotBudget
): Promise<void> {
  let st: { isDirectory: boolean; isFile: boolean; size: number };
  try {
    st = await ctx.fs.stat(current);
  } catch {
    return;
  }
  if (st.isDirectory) {
    await visitSnapshotDir(ctx, current, stack, budget);
    return;
  }
  budget.entries.push({
    path: current,
    content: new Uint8Array(0),
    isDirectory: false,
    truncated: true,
    size: st.size,
  });
}

async function walkSnapshotRoot(
  ctx: CommandContext,
  rootPath: string,
  budget: SnapshotBudget
): Promise<void> {
  if (entryBudgetExhausted(budget)) return;
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    if (entryBudgetExhausted(budget)) return;
    const current = stack.pop()!;
    let lst: { isSymbolicLink?: boolean; size: number } | undefined;
    try {
      lst = await ctx.fs.lstat(current);
    } catch {}
    if (lst?.isSymbolicLink) {
      await visitSnapshotSymlink(ctx, current, lst.size, budget);
      continue;
    }
    let st: { isDirectory: boolean; isFile: boolean; size: number };
    try {
      st = await ctx.fs.stat(current);
    } catch {
      continue;
    }
    if (st.isDirectory) {
      await visitSnapshotDir(ctx, current, stack, budget);
    } else if (st.isFile) {
      await visitSnapshotFile(ctx, current, st.size, budget, stack);
    }
  }
}

async function buildSyncFsSnapshot(ctx: CommandContext, root: string): Promise<SyncFsSnapshot> {
  const budget: SnapshotBudget = { entries: [], totalBytes: 0, fileCount: 0 };

  await walkSnapshotRoot(ctx, root, budget);
  if (root !== '/tmp') {
    await walkSnapshotRoot(ctx, '/tmp', budget);
  }

  return { entries: budget.entries };
}

async function applySyncFsMutations(
  ctx: CommandContext,
  mutations: SyncFsMutations
): Promise<void> {
  const failures: string[] = [];
  const attempt = async (path: string, op: () => Promise<void>): Promise<void> => {
    try {
      await op();
    } catch (err) {
      failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  for (const path of mutations.deleted) {
    await attempt(path, () => ctx.fs.rm(path, { recursive: true }));
  }
  for (const entry of mutations.created) {
    if (entry.isSymbolicLink) {
      await attempt(entry.path, () => ctx.fs.symlink(entry.symlinkTarget ?? '', entry.path));
    } else if (entry.isDirectory) {
      await attempt(entry.path, () => ctx.fs.mkdir(entry.path, { recursive: true }));
    } else {
      await attempt(entry.path, () => ctx.fs.writeFile(entry.path, entry.content));
    }
  }
  for (const entry of mutations.modified) {
    await attempt(entry.path, () => ctx.fs.writeFile(entry.path, entry.content));
  }
  if (failures.length > 0) {
    throw new Error(`sync-fs flush failed for ${failures.length} path(s): ${failures.join('; ')}`);
  }
}

interface ExecDispatchCtx {
  spawns: Map<number, { controller: AbortController; pid: number }>;
  opts: RealmHostOptions;
}

const EXEC_KILL_SIGNALS: ReadonlySet<Signal> = new Set<Signal>([
  'SIGINT',
  'SIGTERM',
  'SIGKILL',
  'SIGSTOP',
  'SIGCONT',
]);

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

type ExecStartCallOptions = {
  stdin?: string;
  stdinKind?: 'text' | 'bytes';
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type CtxExecCallOptions = {
  cwd: string;
  signal: AbortSignal;
  stdin?: string;
  stdinKind?: 'text' | 'bytes';
  args?: string[];
  env?: Record<string, string>;
  replaceEnv?: boolean;
};

function assertExecStartOptions(opts: {
  stdin?: unknown;
  stdinKind?: unknown;
  args?: unknown;
  cwd?: unknown;
  env?: unknown;
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
  if (opts.cwd !== undefined && (typeof opts.cwd !== 'string' || opts.cwd.length === 0)) {
    throw new Error('exec.start: cwd must be a non-empty string');
  }
  if (opts.env !== undefined) {
    if (opts.env === null || typeof opts.env !== 'object' || Array.isArray(opts.env)) {
      throw new Error('exec.start: env must be a string record');
    }
    const bag = opts.env as { [key: string]: string | undefined };
    for (const key of Object.keys(bag)) {
      const value = bag[key];
      if (value !== undefined && typeof value !== 'string') {
        throw new Error('exec.start: env values must be strings');
      }
    }
  }
}

function parseExecStartArgv(commandOrArgv: unknown): {
  cmd: string;
  argvTail?: string[];
  procArgv: string[];
} {
  if (Array.isArray(commandOrArgv)) {
    if (commandOrArgv.length === 0 || !commandOrArgv.every((a) => typeof a === 'string')) {
      throw new Error('exec.start: argv must be a non-empty string[]');
    }
    const [cmd, ...argvTail] = commandOrArgv as string[];
    return { cmd: cmd!, argvTail, procArgv: commandOrArgv.slice() as string[] };
  }
  if (typeof commandOrArgv === 'string') {
    return { cmd: commandOrArgv, procArgv: [commandOrArgv] };
  }
  throw new Error('exec.start: command must be a string or a non-empty string[]');
}

function buildCtxExecOptions(
  opts: ExecStartCallOptions,
  argvTail: string[] | undefined,
  cwd: string,
  signal: AbortSignal
): CtxExecCallOptions {
  const execOptions: CtxExecCallOptions = { cwd, signal };
  if (opts.stdin !== undefined) execOptions.stdin = opts.stdin;
  if (opts.stdinKind !== undefined) execOptions.stdinKind = opts.stdinKind;
  if (argvTail !== undefined) execOptions.args = argvTail;
  else if (opts.args !== undefined) execOptions.args = opts.args;
  if (opts.env !== undefined) {
    execOptions.env = opts.env;
    execOptions.replaceEnv = true;
  }
  return execOptions;
}

async function dispatchExecStart(
  args: unknown[],
  ctx: CommandContext,
  execCtx: ExecDispatchCtx
): Promise<unknown> {
  const [spawnId, commandOrArgv, options] = args as [
    number,
    string | string[],
    ExecStartCallOptions | undefined,
  ];
  if (typeof spawnId !== 'number') {
    throw new Error('exec.start: spawnId must be a number');
  }

  if (execCtx.spawns.has(spawnId)) {
    throw new Error(`exec.start: spawnId ${spawnId} is already in use`);
  }
  const { cmd, argvTail, procArgv } = parseExecStartArgv(commandOrArgv);

  const opts = options ?? {};

  assertExecStartOptions(opts);
  const childCwd = opts.cwd ?? ctx.cwd;
  const controller = new AbortController();
  const { pm, owner } = execCtx.opts;
  let pid = 0;
  if (pm && owner) {
    const proc = pm.spawn({
      kind: 'shell',
      argv: procArgv,
      cwd: childCwd,
      owner,
      ...(execCtx.opts.ppid !== undefined ? { ppid: execCtx.opts.ppid } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      adoptAbort: controller,
    });
    pid = proc.pid;
  }
  execCtx.spawns.set(spawnId, { controller, pid });

  let result: { stdout: string; stderr: string; exitCode: number } | undefined;
  try {
    result = await ctx.exec!(cmd, buildCtxExecOptions(opts, argvTail, childCwd, controller.signal));
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  } finally {
    execCtx.spawns.delete(spawnId);
    if (pm && pid) {
      const proc = pm.get(pid);
      pm.exit(pid, proc?.terminatedBy ? null : (result?.exitCode ?? 1));
    }
  }
}

function dispatchExecKill(args: unknown[], execCtx: ExecDispatchCtx): boolean {
  const [spawnId, rawSig] = args as [number, string | undefined];
  const entry = execCtx.spawns.get(spawnId);
  if (!entry) return false;
  const sig: Signal =
    typeof rawSig === 'string' && EXEC_KILL_SIGNALS.has(rawSig as Signal)
      ? (rawSig as Signal)
      : 'SIGTERM';

  if (EXEC_TERMINATING_SIGNALS.has(sig) && !entry.controller.signal.aborted) {
    entry.controller.abort();
  }
  const { pm } = execCtx.opts;
  if (pm && entry.pid) return pm.signal(entry.pid, sig);

  return true;
}

async function dispatchFetch(
  op: string,
  args: unknown[],
  ctx: CommandContext
): Promise<SerializedFetchResponse> {
  if (op !== 'request') throw new Error(`realm-host: unknown fetch op '${op}'`);
  const [url, init] = args as [string, RequestInit | undefined];

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

async function dispatchModule(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  if (op !== 'buildGraph') throw new Error(`realm-host: unknown module op '${op}'`);
  const entryCode = typeof args[0] === 'string' ? (args[0] as string) : '';
  const fromDir = typeof args[1] === 'string' && args[1] ? (args[1] as string) : ctx.cwd;
  const entryFilename = typeof args[2] === 'string' ? (args[2] as string) : '';
  const reader = createCtxModuleReader(ctx);

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

async function dispatchWasm(op: string, args: unknown[], ctx: CommandContext): Promise<unknown> {
  if (op !== 'compile') throw new Error(`realm-host: unknown wasm op '${op}'`);
  const path = typeof args[0] === 'string' ? (args[0] as string) : null;
  if (path === null) throw new Error('realm-host: wasm.compile requires a path argument');
  const resolved = ctx.fs.resolvePath(ctx.cwd, path);
  return compileWasmFromVfs((p) => ctx.fs.readFileBuffer(p), resolved);
}

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

      return browser.withTab(targetId, (page) => page.setViewportOverride(width, height));
    }
    case 'navigateTab': {
      const targetId = args[0] as string;
      const url = args[1] as string;
      return browser.withTab(targetId, (page) => page.navigate(url));
    }
    case 'screenshotTab': {
      const targetId = args[0] as string;
      const screenshotOpts = args[1] as { fullPage?: boolean } | undefined;
      return browser.withTab(targetId, async (page) => {
        await page.bringToFront();
        return page.screenshot(screenshotOpts);
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

  return { targetId, url, title: '' };
}

async function evalInTab(
  browser: BrowserAPI,
  targetId: string,
  code: string,
  awaitPromise: boolean
): Promise<unknown> {
  return browser.withTab(targetId, async (page) => {
    const value = await page.evaluate(code, { awaitPromise, returnByValue: true });
    return unwrapEvalResult(value);
  });
}

function unwrapEvalResult(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const first = tryParseJson(value);
  if (first === undefined) return value;
  if (first !== null && typeof first === 'object') return first;
  if (typeof first === 'string') {
    const trimmed = first.trim();
    if (trimmed.length > 0 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      const second = tryParseJson(first);
      if (second !== null && typeof second === 'object') return second;
    }
    return first;
  }

  return value;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();

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

async function waitForLoadState(
  browser: BrowserAPI,
  targetId: string,
  state: string | undefined
): Promise<void> {
  if (state !== 'networkidle') {
    return;
  }
  return browser.withTab(targetId, async (page) => {
    const maxAttempts = 20;
    const pollIntervalMs = 250;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const idle = await page.evaluate(
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
    }
  });
}

async function getCookie(
  browser: BrowserAPI,
  targetId: string,
  name: string
): Promise<string | null> {
  return browser.withTab(targetId, async (page) => {
    const result = await page.send('Network.getCookies');
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
  return browser.withTab(targetId, async (page) => {
    const raw = await page.evaluate(
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
    case 'clearHalt':
      return backend.clearHalt(args[0] as string, args[1] as 'in' | 'out', args[2] as number);
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

interface HidDispatchCtx {
  subscriptions: Map<string, () => void | Promise<void>>;
  pushEvent(msg: RealmEventMsg, transfer?: Transferable[]): void;
}

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
