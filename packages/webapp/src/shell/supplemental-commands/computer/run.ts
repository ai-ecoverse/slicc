/**
 * `computer` command body — chained xdotool verbs plus Anthropic aliases.
 * Loaded lazily from `computer-command.ts`.
 */

import type { ComputerDescriptor, ComputerInputEvent, ComputerMouseButton } from '@slicc/shared-ts';
import { uint8ToBase64 } from '@slicc/shared-ts';
import type { CommandContext } from 'just-bash';
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
import { getPanelRpcClient } from '../../../kernel/panel-rpc.js';
import type { ProcessManager } from '../../../kernel/process-manager.js';
import type { ComputerCommandDeps } from '../computer-command.js';
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
  for (const call of calls) {
    try {
      const result = await runVerb(call, globals, ctx, deps, registry);
      if (result.exitCode !== 0) return result;
      if (result.stdout) chunks.push(result.stdout.replace(/\n$/u, ''));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  const text = chunks.filter(Boolean).join('\n');
  const stamped = stampTargetLine(text, calls, registry, globals.computer, ctx, globals.json);
  return ok(stamped ? `${stamped}\n` : '');
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
    case 'exec':
      return verbExec(call.args, globals, ctx, registry);
    default:
      return verbInput(call, globals, ctx, registry);
  }
}

function verbLs(registry: ComputerRegistry, json: boolean): CmdResult {
  const list = registry.list();
  if (json) return ok(`${JSON.stringify(list)}\n`);
  if (list.length === 0) return ok('no computers registered\n');
  const lines = ['ID                   KIND  STATE     TITLE'];
  for (const c of list) {
    lines.push(`${c.id.padEnd(20)} ${c.kind.padEnd(5)} ${c.state.padEnd(9)} ${c.title}`);
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
  if (kind !== 'tab') {
    return fail(`add: unknown kind '${kind ?? ''}' — phase 1 supports \`computer add tab\``);
  }
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
  const info = { title: name ?? page.title, url: page.url };
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
  registry: ComputerRegistry
): Promise<CmdResult> {
  const target = requireTarget(registry, globals.computer, ctx);
  if ('exitCode' in target) return target;
  const events = buildEvents(call, globals.native, target.descriptor);
  const blocked = unsupportedInputReason(target.descriptor.capabilities, events);
  if (blocked) return fail(`${call.verb}: ${blocked}`);
  await target.backend.input(events);
  return writePostActionFrame(target, ctx, registry);
}

const POST_ACTION_TIMEOUT_MS = 5_000;

async function writePostActionFrame(
  target: { id: string; backend: ComputerBackend; descriptor: ComputerDescriptor },
  ctx: CommandContext,
  registry: ComputerRegistry
): Promise<CmdResult> {
  const maxWidth = target.descriptor.lastShot?.width ?? 768;
  let frame;
  try {
    frame = await raceTimeout(
      target.backend.screenshot({ format: 'jpeg', maxWidth }),
      POST_ACTION_TIMEOUT_MS
    );
  } catch (err) {
    return fail(
      `screenshot failed after input: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const native = target.backend.describe().size ?? { width: frame.width, height: frame.height };
  const mapping = scaleFromEncoded(native, { width: frame.width, height: frame.height });
  const seq = registry.nextSeq(target.id);
  const stamped = { ...frame, seq };
  registry.rememberShot(target.id, toLastShot(mapping, Date.now()), stamped);
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
