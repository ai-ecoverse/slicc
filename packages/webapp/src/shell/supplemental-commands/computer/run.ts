/**
 * `computer` command body — chained xdotool verbs plus Anthropic aliases.
 * Loaded lazily from `computer-command.ts`.
 */

import type { ComputerDescriptor, ComputerInputEvent, ComputerMouseButton } from '@slicc/shared-ts';
import { uint8ToBase64 } from '@slicc/shared-ts';
import type { CommandContext } from 'just-bash';
import { getToolExecutionContext } from '../../../base/tool-execution-context.js';
import type { SshProbe } from '../../../computers/adapters/ssh.js';
import {
  BridgedTabComputerBackend,
  LocalTabComputerBackend,
  refuseSliccAppTab,
  resolveTabPage,
} from '../../../computers/adapters/tab.js';
import type { ComputerBackend } from '../../../computers/backend.js';
import {
  computerTargetLine,
  frozenFrameLine,
  writeFrozenFrame,
} from '../../../computers/frames.js';
import { getComputersHost } from '../../../computers/host.js';
import { unsupportedInputReason } from '../../../computers/input-guard.js';
import {
  type ComputerRegistry,
  getComputerRegistry,
  installComputerRegistry,
} from '../../../computers/registry.js';
import {
  formatScaleLine,
  mapPoint,
  parseSizeSpec,
  scaleFromEncoded,
  toLastShot,
} from '../../../computers/scale.js';
import type { BrowserAPI } from '../../../kernel/browser-api.js';
import type { PanelRpcClient } from '../../../kernel/panel-rpc.js';
import { getPanelRpcClient, PANEL_RPC_DEFAULT_TIMEOUT_MS } from '../../../kernel/panel-rpc.js';
import type { ProcessManager } from '../../../kernel/process-manager.js';
import { sudoRefusalMessage } from '../../../sudo/approval-timeout.js';
import type { SudoBroker } from '../../../sudo/types.js';
import type { ComputerCommandDeps } from '../computer-command.js';
import { type ConnectedFollowerInfo, getConnectedFollowersWithFallback } from '../host-command.js';
import { clampVideoDurationMs } from '../screencapture-media-shared.js';
import { isHelpRequest, subcommandHelpText } from '../subcommand-help.js';
import { COMPUTER_HELP, COMPUTER_VALUE_FLAGS } from './help.js';
import {
  chainVerbs,
  flagValue,
  hasFlag,
  parseAtFlag,
  parseGlobals,
  parseIntFlag,
  positionals,
  type VerbCall,
} from './parse.js';
import {
  COMPUTER_RECORD_DEFAULT_FPS,
  COMPUTER_RECORD_MAX_FPS,
  COMPUTER_RECORD_MAX_WIDTH,
  recordPolledClip,
} from './record.js';
import { runScreenShareApproval } from './screen-approval.js';
import { resolveComputerId } from './target.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

function fail(msg: string): CmdResult {
  return { stdout: '', stderr: `computer: ${msg}\n`, exitCode: 1 };
}

function ok(msg = ''): CmdResult {
  return { stdout: msg, stderr: '', exitCode: 0 };
}

interface KernelGlobals {
  __slicc_pm?: ProcessManager;
  __slicc_browser?: BrowserAPI;
  __slicc_panelRpc?: PanelRpcClient;
}

function lookupPm(): ProcessManager | null {
  return (globalThis as KernelGlobals).__slicc_pm ?? null;
}

function lookupBrowser(deps: ComputerCommandDeps): BrowserAPI | null {
  return deps.browser ?? (globalThis as KernelGlobals).__slicc_browser ?? null;
}

function lookupRpc(deps: ComputerCommandDeps): PanelRpcClient | null {
  return deps.panelRpc ?? (globalThis as KernelGlobals).__slicc_panelRpc ?? getPanelRpcClient();
}

function lookupSudo(deps: ComputerCommandDeps): SudoBroker | null {
  if (deps.sudoBroker) return deps.sudoBroker;
  const hook = (globalThis as { __slicc_sudo?: SudoBroker }).__slicc_sudo;
  return hook ?? null;
}

function nativeChannelFromRpc(
  deps: ComputerCommandDeps,
  runtimeId: string
): ReturnType<NonNullable<ComputerCommandDeps['nativeComputer']>> | undefined {
  const rpc = lookupRpc(deps);
  if (!rpc) return undefined;
  return {
    async capture(opts) {
      const result = await rpc.call(
        'tray-computer-native',
        {
          runtimeId,
          action: 'capture',
          fps: opts.fps,
          maxWidth: opts.maxWidth,
          watch: opts.watch,
        },
        { timeoutMs: 60_000 }
      );
      if (!result.jpeg) throw new Error('empty native screenshot from follower');
      const { bytesFromBase64 } = await import('../../../computers/encode-frame.js');
      return {
        bytes: bytesFromBase64(result.jpeg),
        mime: 'image/jpeg' as const,
        width: result.width ?? 0,
        height: result.height ?? 0,
        nativeWidth: result.nativeWidth ?? result.width ?? 0,
        nativeHeight: result.nativeHeight ?? result.height ?? 0,
      };
    },
    unwatch() {
      void rpc.call('tray-computer-native', { runtimeId, action: 'unwatch' }).catch(() => {});
    },
    async input(events) {
      await rpc.call('tray-computer-native', { runtimeId, action: 'input', events });
    },
  };
}

function listFollowers(deps: ComputerCommandDeps): ConnectedFollowerInfo[] {
  return deps.listFollowers?.() ?? getConnectedFollowersWithFallback();
}

const NATIVE_FALLBACK_PROBE: SshProbe = {
  platform: 'darwin',
  tools: [],
  capture: null,
  input: 'none',
};

type SshExecFn = (
  command: string,
  opts?: { timeoutMs?: number }
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

async function probeForSshAdd(
  exec: SshExecFn,
  sim: string | undefined,
  hasExec: boolean,
  native: boolean,
  probeSsh: (exec: SshExecFn, sim?: string) => Promise<SshProbe>
): Promise<SshProbe | { error: string }> {
  if (!hasExec) return NATIVE_FALLBACK_PROBE;
  try {
    return await probeSsh(exec, sim);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (native) return NATIVE_FALLBACK_PROBE;
    return { error: msg.startsWith('add ssh:') ? msg : `add ssh: ${msg}` };
  }
}

async function gateSshAllowInput(
  deps: ComputerCommandDeps,
  follower: ConnectedFollowerInfo,
  sim: string | undefined,
  native: boolean,
  probeInput: string
): Promise<CmdResult | null> {
  if (probeInput === 'none' && !native) {
    return fail(
      'add ssh: --allow-input needs cliclick, xdotool, ydotool, or idb on the follower (screenshot-only otherwise)'
    );
  }
  const broker = lookupSudo(deps);
  if (!broker) return fail('add ssh: --allow-input needs sudo approval (not configured)');
  const decision = await broker.requestApproval({
    kind: 'command',
    detail: `computer add ssh ${follower.runtimeId}${sim ? ` --sim ${sim}` : ''} --allow-input`,
    reason: 'grant pointer and keyboard control of the follower desktop',
  });
  if (decision.decision === 'deny') return fail(sudoRefusalMessage('add ssh', decision));
  return null;
}

async function execOnFollower(
  deps: ComputerCommandDeps,
  runtimeId: string,
  command: string,
  timeoutMs?: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (deps.sshExec) return deps.sshExec(runtimeId, command, timeoutMs);
  const rpc = lookupRpc(deps);
  if (!rpc) throw new Error('no panel RPC in this float');
  const timeout = timeoutMs ?? 30_000;
  const result = await rpc.call(
    'tray-exec',
    {
      runtimeId,
      command,
      execToken: `computer-ssh-${Date.now().toString(36)}`,
      timeoutMs: timeout,
    },
    { timeoutMs: timeout + PANEL_RPC_DEFAULT_TIMEOUT_MS }
  );
  if (result.error) throw new Error(result.error);
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function resolveSshFollower(
  query: string,
  followers: ConnectedFollowerInfo[]
): ConnectedFollowerInfo | { error: string } {
  const capable = followers.filter((f) => f.exec || f.computer);
  const exact = capable.find((f) => f.runtimeId === query);
  if (exact) return exact;
  const hits = capable.filter((f) => f.runtimeId.endsWith(query) || f.runtimeId.includes(query));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { error: `add ssh: ambiguous follower '${query}'` };
  return {
    error: `add ssh: no exec-capable or computer-capable follower '${query}' — try \`ssh --list\``,
  };
}

function lsExtras(c: ComputerDescriptor): string {
  const bits: string[] = [];
  if (c.kind === 'screen') bits.push('display slot');
  if (c.kind === 'ssh') bits.push(c.capabilities.inputAllowed ? 'input' : 'view-only');
  return bits.length > 0 ? ` [${bits.join(', ')}]` : '';
}

function registryOf(deps: ComputerCommandDeps): ComputerRegistry {
  if (deps.registry) return deps.registry;
  return getComputerRegistry() ?? installComputerRegistry(deps.processManager ?? lookupPm());
}

export async function runComputer(
  args: readonly string[],
  ctx: CommandContext,
  deps: ComputerCommandDeps = {}
): Promise<CmdResult> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    return ok(COMPUTER_HELP);
  }
  const globals = parseGlobals(args);
  if (globals.rest.length === 0) return ok(COMPUTER_HELP);
  const first = globals.rest[0];
  if (isHelpRequest(globals.rest.slice(1), { valueFlags: [...COMPUTER_VALUE_FLAGS] })) {
    return ok(subcommandHelpText('computer', first, COMPUTER_HELP, { prefix: 'computer' }));
  }
  let calls: VerbCall[];
  try {
    calls = chainVerbs(globals.rest);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const registry = registryOf(deps);
  const chunks: string[] = [];
  const warnings: string[] = [];
  for (const call of calls) {
    try {
      const result = await runVerb(call, globals, ctx, deps, registry);
      if (result.exitCode !== 0) return result;
      if (result.stdout) chunks.push(result.stdout.replace(/\n$/u, ''));
      if (result.stderr) warnings.push(result.stderr.replace(/\n$/u, ''));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  const text = chunks.filter(Boolean).join('\n');
  const stamped = stampTargetLine(text, calls, registry, globals.computer, ctx, globals.json);
  return {
    stdout: stamped ? `${stamped}\n` : '',
    stderr: warnings.length ? `${warnings.join('\n')}\n` : '',
    exitCode: 0,
  };
}

async function runVerb(
  call: VerbCall,
  globals: { computer: string | undefined; json: boolean; native: boolean },
  ctx: CommandContext,
  deps: ComputerCommandDeps,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const verb = call.verb;
  switch (verb) {
    case 'ls':
      return verbLs(registry, globals.json);
    case 'add':
      return verbAdd(call.args, ctx, deps, registry);
    case 'rm':
      return verbRm(call.args, globals.computer, ctx, registry);
    case 'use':
      return verbUse(call.args, registry);
    case 'info':
      return verbInfo(globals, ctx, registry);
    case 'screenshot':
      return verbScreenshot(call.args, globals, ctx, registry);
    case 'text':
      return verbText(globals, ctx, registry);
    case 'watch':
      return verbWatch(call.args, globals, ctx, registry, deps);
    case 'record':
      return verbRecord(call.args, globals, ctx, registry, deps);
    case 'exec':
      return verbExec(call.args, globals, ctx, registry);
    default:
      return verbInput(call, globals, ctx, registry, deps);
  }
}

function verbLs(registry: ComputerRegistry, json: boolean): CmdResult {
  const list = registry.list();
  if (json) return ok(`${JSON.stringify(list)}\n`);
  if (list.length === 0) return ok('no computers registered\n');
  const lines = ['ID                   KIND   STATE     TITLE'];
  for (const c of list) {
    lines.push(
      `${c.id.padEnd(20)} ${c.kind.padEnd(6)} ${c.state.padEnd(9)} ${c.title}${lsExtras(c)}`
    );
  }
  return ok(`${lines.join('\n')}\n`);
}

async function verbAdd(
  args: string[],
  ctx: CommandContext,
  deps: ComputerCommandDeps,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const kind = args[0];
  if (kind === 'tab') return verbAddTab(args, ctx, deps, registry);
  if (kind === 'screen') return verbAddScreen(args, ctx, deps, registry);
  if (kind === 'ssh') return verbAddSsh(args, ctx, deps, registry);
  if (kind === 'url') return verbAddUrl(args, ctx, deps, registry);
  return fail(
    `add: unknown kind '${kind ?? ''}' — phase 3 supports \`computer add tab\`, \`computer add screen\`, \`computer add ssh\`, and \`computer add url\``
  );
}

async function resolveUrlFetch(
  deps: ComputerCommandDeps
): Promise<NonNullable<ComputerCommandDeps['urlFetch']>> {
  if (deps.urlFetch) return deps.urlFetch;
  const { createProxiedFetch } = await import('../../proxied-fetch.js');
  const { wrapUrlComputerFetch } = await import('../../../computers/adapters/url.js');
  const sf = createProxiedFetch();
  return wrapUrlComputerFetch((url, init) => sf(url, init as Parameters<typeof sf>[1]));
}

async function verbAddUrl(
  args: string[],
  ctx: CommandContext,
  deps: ComputerCommandDeps,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const name = flagValue(args, ['-n', '--name']);
  const spec = positionals(args).slice(1)[0];
  if (!spec) return fail('add url: requires <http(s)://base>');
  const { UrlComputerBackend, probeUrlComputer, normalizeComputerBase } = await import(
    '../../../computers/adapters/url.js'
  );
  let base: string;
  try {
    base = normalizeComputerBase(spec);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`add url: ${msg}`);
  }
  const fetchImpl = await resolveUrlFetch(deps);
  let desc;
  try {
    desc = await probeUrlComputer(fetchImpl, base);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(msg.startsWith('add url:') ? msg : `add url: ${msg}`);
  }
  if (name) desc = { ...desc, title: name };
  const backend = new UrlComputerBackend(fetchImpl, base, desc);
  const registered = registry.register(backend);
  registry.use(registered.id);
  void ctx;
  return ok(`registered ${registered.id} (${registered.title})\n`);
}

async function verbAddSsh(
  args: string[],
  ctx: CommandContext,
  deps: ComputerCommandDeps,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const name = flagValue(args, ['-n', '--name']);
  const sim = flagValue(args, ['--sim']);
  const allowInput = hasFlag(args, '--allow-input');
  const query = positionals(args).slice(1)[0];
  if (!query) return fail('add ssh: requires <follower>');
  const follower = resolveSshFollower(query, listFollowers(deps));
  if ('error' in follower) return fail(follower.error);
  if (follower.floatType === 'ios') {
    return fail(
      'add ssh: the iOS follower itself is not a driven computer (a real iPhone is out of scope; pass --sim <udid> on a Mac follower)'
    );
  }
  if (sim && !follower.exec) {
    return fail('add ssh: --sim needs an exec-capable Mac follower');
  }
  const { SshComputerBackend, probeSsh } = await import('../../../computers/adapters/ssh.js');
  const native = follower.computer
    ? (deps.nativeComputer?.(follower.runtimeId) ?? nativeChannelFromRpc(deps, follower.runtimeId))
    : undefined;
  const exec = follower.exec
    ? (command: string, opts?: { timeoutMs?: number }) =>
        execOnFollower(deps, follower.runtimeId, command, opts?.timeoutMs)
    : async () => {
        throw new Error('follower has no exec capability');
      };
  const probe = await probeForSshAdd(exec, sim, Boolean(follower.exec), Boolean(native), probeSsh);
  if ('error' in probe) return fail(probe.error);
  if (allowInput) {
    const blocked = await gateSshAllowInput(deps, follower, sim, Boolean(native), probe.input);
    if (blocked) return blocked;
  }
  const title = name ?? (sim ? `${follower.runtimeId} sim ${sim}` : follower.runtimeId);
  const backend = new SshComputerBackend(exec, {
    runtimeId: follower.runtimeId,
    title,
    probe,
    inputAllowed: allowInput,
    sim,
    native,
  });
  const desc = registry.register(backend);
  registry.use(desc.id);
  void ctx;
  return ok(`registered ${desc.id} (${desc.title})\n`);
}

async function verbAddTab(
  args: string[],
  ctx: CommandContext,
  deps: ComputerCommandDeps,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const name = flagValue(args, ['-n', '--name']);
  const spec = positionals(args).slice(1)[0];
  if (!spec) return fail('add tab: requires <targetId|url>');
  const browser = lookupBrowser(deps);
  if (!browser) return fail('add tab: no browser API in this float');
  const pages = await browser.listAllTargets();
  const page = resolveTabPage(pages, spec);
  if ('error' in page) return fail(page.error);
  try {
    refuseSliccAppTab(page);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const info = { title: page.title, url: page.url, ...(name ? { name } : {}) };
  const browserForced = Boolean(deps.browser) && !deps.panelRpc;
  const rpc = browserForced ? null : lookupRpc(deps);
  const backend = rpc
    ? new BridgedTabComputerBackend(rpc, page.targetId, info)
    : new LocalTabComputerBackend(browser, page.targetId, info);
  const desc = registry.register(backend);
  registry.use(desc.id);
  void ctx;
  return ok(`registered ${desc.id} (${desc.title})\n`);
}

async function verbAddScreen(
  args: string[],
  ctx: CommandContext,
  deps: ComputerCommandDeps,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const name = flagValue(args, ['-n', '--name']);
  const resolved = flagValue(args, ['--__resolved']);
  let handle = resolved;
  if (!handle) {
    if (!getToolExecutionContext()) {
      return fail(
        'add screen: needs a user gesture — type `computer add screen` in the panel terminal, or run it from a cone tool call so an approval card can open the picker'
      );
    }
    try {
      handle = (await runScreenShareApproval()).handle;
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  const rpc = lookupRpc(deps);
  if (!rpc) return fail('add screen: no panel RPC in this float');
  const { BridgedScreenComputerBackend, screenComputerId } = await import(
    '../../../computers/adapters/screen.js'
  );
  const backend = new BridgedScreenComputerBackend(
    rpc,
    handle,
    {
      title: name ?? 'Display',
    },
    () => {
      registry.refresh(screenComputerId(handle));
    }
  );
  const desc = registry.register(backend);
  registry.use(desc.id);
  void ctx;
  return ok(`registered ${desc.id} (${desc.title})\n`);
}

async function verbRm(
  args: string[],
  computer: string | undefined,
  ctx: CommandContext,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const query = positionals(args)[0] ?? computer;
  const resolved = resolveComputerId(registry, query, envMap(ctx));
  if ('error' in resolved) return fail(resolved.error);
  const okRm = await registry.unregister(resolved.id);
  return okRm ? ok(`unregistered ${resolved.id}\n`) : fail(`unknown computer '${resolved.id}'`);
}

function verbUse(args: string[], registry: ComputerRegistry): CmdResult {
  const query = positionals(args)[0];
  if (!query) return fail('use: requires <id>');
  const resolved = resolveComputerId(registry, query, new Map());
  if ('error' in resolved) return fail(resolved.error);
  registry.use(resolved.id);
  return ok(`using ${resolved.id}\n`);
}

function verbInfo(
  globals: { computer: string | undefined; json: boolean },
  ctx: CommandContext,
  registry: ComputerRegistry
): CmdResult {
  const resolved = resolveComputerId(registry, globals.computer, envMap(ctx));
  if ('error' in resolved) return fail(resolved.error);
  const entry = registry.getEntry(resolved.id);
  if (!entry) return fail(`unknown computer '${resolved.id}'`);
  if (globals.json) return ok(`${JSON.stringify(entry.descriptor)}\n`);
  const d = entry.descriptor;
  const size = d.size ? `${d.size.width}x${d.size.height}` : '-';
  return ok(
    `id: ${d.id}\nkind: ${d.kind}\ntitle: ${d.title}\nstate: ${d.state}\nsize: ${size}\npid: ${d.pid ?? '-'}\n`
  );
}

async function verbScreenshot(
  args: string[],
  globals: { computer: string | undefined; json: boolean; native: boolean },
  ctx: CommandContext,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const target = requireTarget(registry, globals.computer, ctx);
  if ('exitCode' in target) return target;
  const maxWidth = parseSizeSpec(flagValue(args, ['--size']));
  const frame = await target.backend.screenshot({ format: 'jpeg', maxWidth });
  const native = target.backend.describe().size ?? { width: frame.width, height: frame.height };
  const mapping = scaleFromEncoded(native, { width: frame.width, height: frame.height });
  registry.rememberShot(target.id, toLastShot(mapping, Date.now()), frame);
  const seq = frame.seq > 0 ? frame.seq : registry.nextSeq(target.id);
  const path = await writeFrozenFrame({
    fs: ctx.fs,
    cwd: ctx.cwd,
    env: ctx.env,
    name: fileName(target.descriptor),
    seq,
    frame,
  });
  const file = positionals(args)[0];
  if (file) {
    const dest = ctx.fs.resolvePath(ctx.cwd, file);
    await ctx.fs.writeFile(dest, frame.bytes);
  }
  const lines = [formatScaleLine(mapping), frozenFrameLine(path)];
  if (hasFlag(args, '--view') || hasFlag(args, '-v')) {
    lines.push(`<img:data:${frame.mime};base64,${uint8ToBase64(frame.bytes)}>`);
  }
  if (globals.json) {
    return ok(`${JSON.stringify({ id: target.id, path, mapping })}\n`);
  }
  return ok(`${lines.join('\n')}\n`);
}

async function verbText(
  globals: { computer: string | undefined },
  ctx: CommandContext,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const target = requireTarget(registry, globals.computer, ctx);
  if ('exitCode' in target) return target;
  if (!target.backend.text) return fail(`text: '${target.id}' has no text dump`);
  const dump = await target.backend.text();
  if (dump === null) return fail(`text: unavailable for '${target.id}'`);
  return ok(`${dump}\n`);
}

async function verbWatch(
  args: string[],
  globals: { computer: string | undefined },
  ctx: CommandContext,
  registry: ComputerRegistry,
  deps: ComputerCommandDeps
): Promise<CmdResult> {
  const target = requireTarget(registry, globals.computer, ctx);
  if ('exitCode' in target) return target;
  const host = resolveWatchControl(deps);
  if (!host) return fail('watch: computers host is not running');
  if (hasFlag(args, '--stop')) {
    host.unwatch(target.id);
    return ok(`unwatched ${target.id}\n`);
  }
  const fps = parseIntFlag(args, '--fps') ?? 2;
  const maxWidth = parseSizeSpec(flagValue(args, ['--size']));
  host.watch(target.id, fps, maxWidth);
  return ok(`watching ${target.id} at ${fps} fps\n`);
}

interface ScreenClipper {
  recordClip(durationMs: number): Promise<{
    bytes: Uint8Array;
    mime: string;
    width: number;
    height: number;
    durationMs?: number;
  }>;
}

function hasRecordClip(backend: ComputerBackend): backend is ComputerBackend & ScreenClipper {
  return 'recordClip' in backend && typeof (backend as ScreenClipper).recordClip === 'function';
}

function durationSeconds(args: string[]): number {
  const raw = flagValue(args, ['-V', '--duration']);
  if (raw === undefined) return 5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('-V/--duration requires a positive number of seconds');
  }
  return n;
}

async function verbRecord(
  args: string[],
  globals: { computer: string | undefined; json: boolean },
  ctx: CommandContext,
  registry: ComputerRegistry,
  deps: ComputerCommandDeps
): Promise<CmdResult> {
  const target = requireTarget(registry, globals.computer, ctx);
  if ('exitCode' in target) return target;
  let seconds: number;
  let fps: number;
  try {
    seconds = durationSeconds(args);
    fps = parseIntFlag(args, '--fps') ?? COMPUTER_RECORD_DEFAULT_FPS;
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (fps <= 0) return fail('--fps requires a positive number');
  if (fps > COMPUTER_RECORD_MAX_FPS) {
    return fail(`--fps exceeds ${COMPUTER_RECORD_MAX_FPS}`);
  }
  const durationMs = clampVideoDurationMs(seconds * 1000);
  const file = positionals(args)[0] ?? 'clip.webm';
  const dest = ctx.fs.resolvePath(ctx.cwd, file);
  let clip: {
    bytes: Uint8Array;
    mime: string;
    width: number;
    height: number;
    durationMs?: number;
    truncated?: boolean;
  };
  try {
    clip = hasRecordClip(target.backend)
      ? await target.backend.recordClip(durationMs)
      : await recordWorkerHostedClip(target.backend, durationMs, fps, dest, ctx, deps);
  } catch (err) {
    return fail(`record: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (clip.bytes.byteLength > 0) await ctx.fs.writeFile(dest, clip.bytes);
  const elapsed = clip.durationMs ?? durationMs;
  if (globals.json) {
    return ok(
      `${JSON.stringify({
        id: target.id,
        path: dest,
        durationMs: elapsed,
        mime: clip.mime,
        ...(clip.truncated ? { truncated: true } : {}),
      })}\n`
    );
  }
  const note = clip.truncated ? ' (truncated)' : '';
  return ok(`recorded ${elapsed}ms ${clip.width}x${clip.height}${note} → ${dest}\n`);
}

async function recordWorkerHostedClip(
  backend: ComputerBackend,
  durationMs: number,
  fps: number,
  dest: string,
  ctx: CommandContext,
  deps: ComputerCommandDeps
) {
  return recordPolledClip({
    screenshot: () => backend.screenshot({ format: 'jpeg', maxWidth: COMPUTER_RECORD_MAX_WIDTH }),
    durationMs,
    fps,
    dest,
    ctx,
    encode: deps.encodeRecordedFrames,
  });
}

function resolveWatchControl(deps: ComputerCommandDeps): {
  watch: (id: string, fps: number, maxWidth: number) => void;
  unwatch: (id: string) => void;
} | null {
  if (deps.watch) {
    return { watch: deps.watch, unwatch: deps.unwatch ?? (() => undefined) };
  }
  const host = getComputersHost();
  return host ? { watch: host.watch, unwatch: host.unwatch } : null;
}

async function verbExec(
  args: string[],
  globals: { computer: string | undefined },
  ctx: CommandContext,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const target = requireTarget(registry, globals.computer, ctx);
  if ('exitCode' in target) return target;
  if (!target.backend.exec) return fail(`exec: '${target.id}' does not support exec`);
  const command = args.join(' ');
  if (!command) return fail('exec: requires a command');
  const result = await target.backend.exec(command);
  const out = [result.stdout, result.stderr].filter(Boolean).join('\n');
  return { stdout: out ? `${out}\n` : '', stderr: '', exitCode: result.exitCode };
}

async function verbInput(
  call: VerbCall,
  globals: { computer: string | undefined; native: boolean },
  ctx: CommandContext,
  registry: ComputerRegistry,
  deps: ComputerCommandDeps
): Promise<CmdResult> {
  const target = requireTarget(registry, globals.computer, ctx);
  if ('exitCode' in target) return target;
  const events = buildEvents(call, globals.native, target.descriptor);
  const blocked = unsupportedInputReason(target.descriptor.capabilities, events);
  if (blocked) return fail(`${call.verb}: ${blocked}`);
  try {
    await target.backend.input(events);
  } catch (err) {
    return fail(`${call.verb}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return writePostActionFrame(target, ctx, registry, deps);
}

const POST_ACTION_TIMEOUT_MS = 5_000;

function isComputerWatching(id: string, deps: ComputerCommandDeps): boolean {
  if (deps.isWatching) return deps.isWatching(id);
  return getComputersHost()?.isWatching(id) ?? false;
}

function pullScreenshot(
  target: { backend: ComputerBackend; descriptor: ComputerDescriptor },
  maxWidth: number
) {
  const push = target.descriptor.capabilities.frames === 'push';
  return target.backend.screenshot({
    format: 'jpeg',
    maxWidth,
    ...(push ? { pull: true } : {}),
  });
}

async function capturePostActionFrame(
  target: { id: string; backend: ComputerBackend; descriptor: ComputerDescriptor },
  maxWidth: number,
  deps: ComputerCommandDeps
) {
  const push = target.descriptor.capabilities.frames === 'push';
  const watching = push && isComputerWatching(target.id, deps);
  if (!watching) return pullScreenshot(target, maxWidth);
  const abort = new AbortController();
  const timeoutMs = deps.postActionTimeoutMs ?? POST_ACTION_TIMEOUT_MS;
  try {
    return await raceTimeout(
      target.backend.screenshot({ format: 'jpeg', maxWidth, signal: abort.signal }),
      timeoutMs
    );
  } catch {
    abort.abort();
    return pullScreenshot(target, maxWidth);
  }
}

async function writePostActionFrame(
  target: { id: string; backend: ComputerBackend; descriptor: ComputerDescriptor },
  ctx: CommandContext,
  registry: ComputerRegistry,
  deps: ComputerCommandDeps
): Promise<CmdResult> {
  const maxWidth = target.descriptor.lastShot?.width ?? 768;
  let frame;
  try {
    frame = await capturePostActionFrame(target, maxWidth, deps);
  } catch (err) {
    return {
      stdout: '',
      stderr: `computer: screenshot failed after input: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 0,
    };
  }
  const seq = registry.nextSeq(target.id);
  const stamped = { ...frame, seq };
  // The frozen frame is a transcript side effect the model never sees as a
  // reference image, so it must not redefine `lastShot` (the coordinate
  // space). Only a model-facing screenshot / `--view` output does that,
  // otherwise coordinates drift each poke (issue #3297).
  registry.rememberFrame(target.id, stamped);
  const path = await writeFrozenFrame({
    fs: ctx.fs,
    cwd: ctx.cwd,
    env: ctx.env,
    name: fileName(target.descriptor),
    seq,
    frame: stamped,
  });
  return ok(`${frozenFrameLine(path)}\n`);
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

type PointMap = (x: number, y: number) => { x: number; y: number };

function buildEvents(
  call: VerbCall,
  native: boolean,
  descriptor: ComputerDescriptor
): ComputerInputEvent[] {
  const map: PointMap = (x, y) => mapPoint(x, y, descriptor.lastShot, native);
  switch (call.verb) {
    case 'mousemove':
      return eventsMousemove(call.args, map);
    case 'click':
    case 'mousedown':
    case 'mouseup':
      return eventsClickFamily(call.verb, call.args, map);
    case 'drag':
      return eventsDrag(call.args, map, descriptor.capabilities.mouse);
    case 'scroll':
      return eventsScroll(call.args, map);
    case 'key':
    case 'keydown':
    case 'keyup':
      return eventsKey(call.verb, call.args);
    case 'type':
      return eventsType(call.args);
    case 'wait':
      return eventsWait(call.args);
    default:
      throw new Error(`internal: ${call.verb} is not an input verb`);
  }
}

function eventsMousemove(args: string[], map: PointMap): ComputerInputEvent[] {
  const pos = positionals(args);
  const x = Number(pos[0]);
  const y = Number(pos[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('mousemove: requires <x> <y>');
  }
  const relative = hasFlag(args, '--relative');
  const p = relative ? { x, y } : map(x, y);
  return [{ type: 'mousemove', x: p.x, y: p.y, relative }];
}

function eventsClickFamily(
  verb: 'click' | 'mousedown' | 'mouseup',
  args: string[],
  map: PointMap
): ComputerInputEvent[] {
  const pos = positionals(args);
  const { button, skip } = parseButtonAndSkip(pos);
  const coords = parseAtFlag(args) ?? twoCoords(pos, skip);
  const mapped = coords ? map(coords.x, coords.y) : undefined;
  if (verb === 'mousedown') return [{ type: 'button', button, down: true, ...xy(mapped) }];
  if (verb === 'mouseup') return [{ type: 'button', button, down: false, ...xy(mapped) }];
  const holdMs = parseIntFlag(args, '--hold');
  return [
    {
      type: 'click',
      button,
      count: parseIntFlag(args, '--repeat') ?? 1,
      ...(holdMs !== undefined ? { holdMs } : {}),
      ...xy(mapped),
    },
  ];
}

function eventsDrag(
  args: string[],
  map: PointMap,
  mouse: ComputerDescriptor['capabilities']['mouse']
): ComputerInputEvent[] {
  const nums = positionals(args).map(Number);
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error('drag: requires <x1> <y1> <x2> <y2>');
  }
  const from = map(nums[0], nums[1]);
  const to = map(nums[2], nums[3]);
  if (mouse === 'touch') {
    return [{ type: 'drag', x1: from.x, y1: from.y, x2: to.x, y2: to.y }];
  }
  return [
    { type: 'mousemove', x: from.x, y: from.y },
    { type: 'button', button: 1, down: true, x: from.x, y: from.y },
    { type: 'mousemove', x: to.x, y: to.y },
    { type: 'button', button: 1, down: false, x: to.x, y: to.y },
  ];
}

function eventsScroll(args: string[], map: PointMap): ComputerInputEvent[] {
  const pos = positionals(args);
  const dx = Number(pos[0]);
  const dy = Number(pos[1]);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new Error('scroll: requires <dx> <dy>');
  }
  const at = parseAtFlag(args);
  const mapped = at ? map(at.x, at.y) : undefined;
  return [{ type: 'scroll', dx, dy, ...xy(mapped) }];
}

function eventsKey(verb: 'key' | 'keydown' | 'keyup', args: string[]): ComputerInputEvent[] {
  if (verb === 'key') {
    if (args.length === 0) throw new Error('key: no keysym supplied');
    return args.map((keysym) => ({ type: 'key' as const, keysym }));
  }
  const keysym = positionals(args)[0];
  if (!keysym) throw new Error(`${verb}: no keysym supplied`);
  return [{ type: 'key', keysym, down: verb === 'keydown' }];
}

function eventsType(args: string[]): ComputerInputEvent[] {
  const text = args.join(' ').replace(/\\n/gu, '\n').replace(/\\t/gu, '\t');
  if (!text) throw new Error('type: no text supplied');
  return [{ type: 'text', text }];
}

function eventsWait(args: string[]): ComputerInputEvent[] {
  const ms = Number(positionals(args)[0]);
  if (!Number.isFinite(ms)) throw new Error('wait: requires <ms>');
  return [{ type: 'wait', ms }];
}

function parseButtonAndSkip(pos: string[]): { button: ComputerMouseButton; skip: number } {
  if (pos[0] === undefined) return { button: 1, skip: 0 };
  if (
    pos[0] === 'left' ||
    pos[0] === 'middle' ||
    pos[0] === 'right' ||
    pos[0] === '1' ||
    pos[0] === '2' ||
    pos[0] === '3'
  ) {
    return { button: parseButton(pos[0]), skip: 1 };
  }
  return { button: 1, skip: 0 };
}

function parseButton(raw: string | undefined): ComputerMouseButton {
  if (!raw || raw === 'left' || raw === '1') return 1;
  if (raw === 'middle' || raw === '2') return 2;
  if (raw === 'right' || raw === '3') return 3;
  const n = Number.parseInt(raw, 10);
  if (n === 1 || n === 2 || n === 3) return n;
  throw new Error(`unknown button '${raw}' (use 1|2|3)`);
}

function twoCoords(pos: string[], skip: number): { x: number; y: number } | undefined {
  const a = Number(pos[skip]);
  const b = Number(pos[skip + 1]);
  if (Number.isFinite(a) && Number.isFinite(b)) return { x: a, y: b };
  return undefined;
}

function xy(p: { x: number; y: number } | undefined): { x?: number; y?: number } {
  return p ? { x: p.x, y: p.y } : {};
}

const NO_TARGET_STAMP = new Set(['ls', 'add', 'rm', 'use']);

function stampTargetLine(
  text: string,
  calls: VerbCall[],
  registry: ComputerRegistry,
  query: string | undefined,
  ctx: CommandContext,
  json: boolean
): string {
  if (json) return text;
  if (!calls.some((c) => !NO_TARGET_STAMP.has(c.verb))) return text;
  const resolved = resolveComputerId(registry, query, envMap(ctx));
  if ('error' in resolved) return text;
  const line = computerTargetLine(resolved.id);
  if (text.split('\n').some((l) => l.trim() === line)) return text;
  return text ? `${line}\n${text}` : line;
}

function requireTarget(
  registry: ComputerRegistry,
  query: string | undefined,
  ctx: CommandContext
): { id: string; backend: ComputerBackend; descriptor: ComputerDescriptor } | CmdResult {
  const resolved = resolveComputerId(registry, query, envMap(ctx));
  if ('error' in resolved) return fail(resolved.error);
  const entry = registry.getEntry(resolved.id);
  if (!entry) return fail(`unknown computer '${resolved.id}'`);
  return { id: resolved.id, backend: entry.backend, descriptor: entry.descriptor };
}

function envMap(ctx: CommandContext): Map<string, string> {
  const env = ctx.env;
  if (env instanceof Map) return env;
  const map = new Map<string, string>();
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env as Record<string, string | undefined>)) {
      if (v !== undefined) map.set(k, v);
    }
  }
  return map;
}

function fileName(d: ComputerDescriptor): string {
  return d.id.replace(/[/:]/gu, '_');
}
