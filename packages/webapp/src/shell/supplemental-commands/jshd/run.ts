import type { CommandContext } from 'just-bash';
import type { ProcessManager } from '../../../kernel/process-manager.js';
import type { RealmFactory } from '../../../kernel/realm/realm-runner.js';
import type { ScriptCatalog } from '../../script-catalog.js';
import { parseKnownFlags } from '../subcommand-flags.js';
import { isHelpRequest, subcommandHelpText } from '../subcommand-help.js';
import { JSHD_HELP } from './help.js';
import { parseStartArgs } from './parse-start.js';
import { resolveUnitScript } from './resolve-script.js';
import { listUnitRecords, readUnitLog, readUnitRecord } from './store.js';
import { getJshdSupervisor, type JshdLickSink, type JshdSupervisor } from './supervisor.js';
import type { JshdUnitRecord, JshdUnitStatus } from './types.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

export interface JshdRunOptions {
  processManager?: ProcessManager;
  scriptCatalog?: ScriptCatalog;
  realmFactory?: RealmFactory;
}

const START_VALUE_FLAGS = ['-n', '--name', '--restart', '--cwd', '--env'] as const;
const LOGS_VALUE_FLAGS = ['-n', '--lines'] as const;

export async function runJshd(
  args: string[],
  ctx: CommandContext,
  options: JshdRunOptions = {}
): Promise<CmdResult> {
  if (args.length === 0 || isHelpRequest(args, { valueFlags: START_VALUE_FLAGS })) {
    return ok(JSHD_HELP.endsWith('\n') ? JSHD_HELP : `${JSHD_HELP}\n`);
  }
  const sub = args[0];
  const rest = args.slice(1);
  if (isHelpRequest(rest, { valueFlags: sub === 'logs' ? LOGS_VALUE_FLAGS : START_VALUE_FLAGS })) {
    return ok(subcommandHelpText('jshd', sub, JSHD_HELP));
  }

  switch (sub) {
    case 'start':
      return handleStart(rest, ctx, options);
    case 'ls':
      return handleLs(rest, ctx, options);
    case 'status':
      return handleStatus(rest, ctx, options);
    case 'stop':
      return handleNamed('stop', rest, ctx, options);
    case 'restart':
      return handleNamed('restart', rest, ctx, options);
    case 'rm':
      return handleNamed('rm', rest, ctx, options);
    case 'logs':
      return handleLogs(rest, ctx, options);
    case 'enable':
      return handleEnable(rest, ctx, options, true);
    case 'disable':
      return handleEnable(rest, ctx, options, false);
    default:
      return fail(`unknown command: ${sub}`);
  }
}

async function handleStart(
  args: string[],
  ctx: CommandContext,
  options: JshdRunOptions
): Promise<CmdResult> {
  const parsed = parseStartArgs(args, { cwd: ctx.cwd, env: ctx.env });
  if (!parsed.ok) return fail(parsed.error);
  const resolved = await resolveUnitScript(parsed.record.argv[0], ctx, options.scriptCatalog);
  if ('error' in resolved) return fail(resolved.error);
  const existing = await readUnitRecord(ctx.fs, parsed.record.name);
  const record: JshdUnitRecord = {
    ...parsed.record,
    argv: [resolved.path, ...parsed.record.argv.slice(1)],
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    enabled: parsed.record.enabled || (existing?.enabled ?? false),
  };
  const supervisor = supervisorOf(ctx, options);
  if (!supervisor) return fail('kernel host has not booted yet — try again in a moment');
  try {
    const { pid, durable } = await supervisor.start(record);
    const durableNote = durable ? '' : ' (not durable in this runtime: no DedicatedWorker)\n';
    return ok(`jshd: started '${record.name}' (pid ${pid})${durableNote}\n`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

async function handleLs(
  args: string[],
  ctx: CommandContext,
  options: JshdRunOptions
): Promise<CmdResult> {
  const parsed = parseKnownFlags(args, { bool: ['--json'] });
  if ('error' in parsed) return fail(parsed.error);
  const supervisor = supervisorOf(ctx, options);
  const live = supervisor?.list() ?? [];
  const records = await listUnitRecords(ctx.fs);
  const rows = mergeLs(records, live, supervisor?.isDurable() ?? typeof Worker !== 'undefined');
  if (parsed.bools.has('--json')) {
    return ok(`${JSON.stringify(rows)}\n`);
  }
  if (rows.length === 0) return ok('no jshd units\n');
  const lines = ['NAME            PID     STATE     RESTARTS  UP     ENABLED  DURABLE'];
  for (const row of rows) lines.push(formatLsRow(row));
  if (rows.some((row) => !row.durable)) {
    lines.push('note: units are not durable here (no DedicatedWorker); ls reports that.');
  }
  return ok(`${lines.join('\n')}\n`);
}

async function handleStatus(
  args: string[],
  ctx: CommandContext,
  options: JshdRunOptions
): Promise<CmdResult> {
  const name = args[0];
  if (!name) return fail('missing unit name');
  const supervisor = supervisorOf(ctx, options);
  const live = supervisor?.status(name);
  const record = live ? null : await readUnitRecord(ctx.fs, name);
  if (!live && !record) return fail(`unknown unit '${name}'`);
  const status =
    live ?? statusFromRecord(record!, supervisor?.isDurable() ?? typeof Worker !== 'undefined');
  return ok(
    [
      `name: ${status.name}`,
      `pid: ${status.pid ?? '-'}`,
      `state: ${status.state}`,
      `restarts: ${status.restarts}`,
      `uptime: ${formatUptime(status.uptimeMs)}`,
      `enabled: ${status.enabled}`,
      `restart: ${status.restart}`,
      `durable: ${status.durable}`,
      `cwd: ${status.cwd}`,
      `argv: ${status.argv.join(' ')}`,
      status.lastExitCode !== null ? `last-exit: ${status.lastExitCode}` : null,
    ]
      .filter(Boolean)
      .join('\n') + '\n'
  );
}

async function handleNamed(
  verb: 'stop' | 'restart' | 'rm',
  args: string[],
  ctx: CommandContext,
  options: JshdRunOptions
): Promise<CmdResult> {
  const name = args[0];
  if (!name) return fail('missing unit name');
  const supervisor = supervisorOf(ctx, options);
  if (!supervisor) return fail('kernel host has not booted yet — try again in a moment');
  if (verb === 'stop') {
    const stopped = await supervisor.stop(name);
    if (!stopped) {
      const record = await readUnitRecord(ctx.fs, name);
      if (!record) return fail(`unknown unit '${name}'`);
      return ok(`jshd: unit '${name}' is not running\n`);
    }
    return ok(`jshd: stopped '${name}'\n`);
  }
  if (verb === 'restart') {
    const result = await supervisor.restart(name);
    if (!result) return fail(`unknown unit '${name}'`);
    return ok(`jshd: restarted '${name}' (pid ${result.pid})\n`);
  }
  const record = await readUnitRecord(ctx.fs, name);
  if (!record && !supervisor.status(name)) return fail(`unknown unit '${name}'`);
  await supervisor.rm(name);
  return ok(`jshd: removed '${name}'\n`);
}

async function handleLogs(
  args: string[],
  ctx: CommandContext,
  options: JshdRunOptions
): Promise<CmdResult> {
  const parsed = parseKnownFlags(args, { value: LOGS_VALUE_FLAGS, bool: ['-f', '--follow'] });
  if ('error' in parsed) return fail(parsed.error);
  const name = parsed.positionals[0];
  if (!name) return fail('missing unit name');
  const follow = parsed.bools.has('-f') || parsed.bools.has('--follow');
  const linesRaw = parsed.values.get('-n') ?? parsed.values.get('--lines');
  const tail = linesRaw !== undefined ? Number.parseInt(linesRaw, 10) : undefined;
  if (linesRaw !== undefined && (!Number.isFinite(tail) || (tail as number) < 0)) {
    return fail(`-n must be a non-negative integer`);
  }
  const body = await readUnitLog(ctx.fs, name);
  const text = tail === undefined ? body : lastLines(body, tail);
  if (!follow) return ok(text.endsWith('\n') || text.length === 0 ? text : `${text}\n`);
  const signal = abortSignalOf(ctx);
  if (!signal) return ok(text.endsWith('\n') || text.length === 0 ? text : `${text}\n`);
  return followLogs(ctx, name, text, signal);
}

async function handleEnable(
  args: string[],
  ctx: CommandContext,
  options: JshdRunOptions,
  enabled: boolean
): Promise<CmdResult> {
  const name = args[0];
  if (!name) return fail('missing unit name');
  const supervisor = supervisorOf(ctx, options);
  const record = supervisor
    ? await supervisor.setEnabled(name, enabled)
    : await enableOnDisk(ctx, name, enabled);
  if (!record) return fail(`unknown unit '${name}'`);
  return ok(`jshd: ${enabled ? 'enabled' : 'disabled'} '${name}'\n`);
}

async function enableOnDisk(
  ctx: CommandContext,
  name: string,
  enabled: boolean
): Promise<JshdUnitRecord | null> {
  const record = await readUnitRecord(ctx.fs, name);
  if (!record) return null;
  const next = { ...record, enabled };
  const { writeUnitRecord } = await import('./store.js');
  await writeUnitRecord(ctx.fs, next);
  return next;
}

function supervisorOf(ctx: CommandContext, options: JshdRunOptions): JshdSupervisor | null {
  const pm = options.processManager ?? lookupGlobalPm();
  if (!pm) return null;
  const lick = lookupLickManager();
  return getJshdSupervisor({
    fs: ctx.fs,
    processManager: pm,
    ...(lick ? { lickManager: lick } : {}),
    ...(options.realmFactory ? { realmFactory: options.realmFactory } : {}),
    buildContext: (record) => overlayContext(ctx, record),
  });
}

function overlayContext(ctx: CommandContext, record: JshdUnitRecord): CommandContext {
  const env = new Map(ctx.env);
  for (const [key, value] of Object.entries(record.env)) env.set(key, value);
  return { ...ctx, cwd: record.cwd, env };
}

function mergeLs(
  records: JshdUnitRecord[],
  live: JshdUnitStatus[],
  durable: boolean
): JshdUnitStatus[] {
  const byName = new Map(live.map((row) => [row.name, row]));
  const names = new Set([...records.map((r) => r.name), ...byName.keys()]);
  return [...names].sort().map((name) => {
    const running = byName.get(name);
    if (running) return running;
    const record = records.find((item) => item.name === name);
    return statusFromRecord(record!, durable);
  });
}

function statusFromRecord(record: JshdUnitRecord, durable: boolean): JshdUnitStatus {
  return {
    name: record.name,
    pid: null,
    state: 'stopped',
    restarts: 0,
    uptimeMs: null,
    enabled: record.enabled,
    restart: record.restart,
    argv: record.argv,
    cwd: record.cwd,
    durable,
    lastExitCode: null,
  };
}

function formatLsRow(row: JshdUnitStatus): string {
  const pid = row.pid === null ? '-' : String(row.pid);
  const up = formatUptime(row.uptimeMs);
  return [
    row.name.padEnd(15),
    pid.padEnd(7),
    row.state.padEnd(9),
    String(row.restarts).padEnd(9),
    up.padEnd(6),
    String(row.enabled).padEnd(8),
    String(row.durable),
  ].join(' ');
}

function formatUptime(ms: number | null): string {
  if (ms === null) return '-';
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

function lastLines(text: string, n: number): string {
  if (n === 0) return '';
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return `${parts.slice(-n).join('\n')}${text.endsWith('\n') ? '\n' : ''}`;
}

async function followLogs(
  ctx: CommandContext,
  name: string,
  initial: string,
  signal: AbortSignal
): Promise<CmdResult> {
  let seen = initial.length;
  const chunks = [initial];
  while (!signal.aborted) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 200);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
    if (signal.aborted) break;
    const body = await readUnitLog(ctx.fs, name);
    if (body.length > seen) {
      chunks.push(body.slice(seen));
      seen = body.length;
    }
  }
  const text = chunks.join('');
  return ok(text.endsWith('\n') || text.length === 0 ? text : `${text}\n`);
}

function abortSignalOf(ctx: CommandContext): AbortSignal | undefined {
  const extra = ctx as CommandContext & { signal?: AbortSignal };
  return extra.signal;
}

function lookupGlobalPm(): ProcessManager | null {
  const pm = (globalThis as { __slicc_pm?: unknown }).__slicc_pm;
  if (pm && typeof pm === 'object' && typeof (pm as ProcessManager).spawn === 'function') {
    return pm as ProcessManager;
  }
  return null;
}

function lookupLickManager(): JshdLickSink | undefined {
  const mgr = (globalThis as { __slicc_lickManager?: { emitEvent?: unknown } }).__slicc_lickManager;
  if (mgr && typeof mgr.emitEvent === 'function') return mgr as JshdLickSink;
  return undefined;
}

function ok(stdout: string): CmdResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(message: string): CmdResult {
  return { stdout: '', stderr: `jshd: ${message}\n`, exitCode: 1 };
}
