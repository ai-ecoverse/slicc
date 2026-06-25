/**
 * `hid` — WebHID access from the shell.
 *
 * Runs in any float: a DOM realm (panel terminal / extension shell)
 * talks to `navigator.hid` directly; the kernel worker forwards every
 * op over panel-RPC to the page-side handlers. Device handles are
 * opaque strings (`hid1`, `hid2`, …) backed by a page-side registry —
 * `HIDDevice` objects never cross the worker boundary.
 *
 * The `hid request` chooser requires a user gesture. When typed in the
 * panel terminal, `RemoteTerminalView` runs the picker on the Enter
 * keystroke and forwards a rewritten command carrying `--__resolved`.
 *
 * `hid watch` subscribes to a device's input reports and accumulates
 * them as hex lines until SIGINT (`ctx.signal`), then prints them. Live
 * per-report streaming awaits the terminal protocol's future chunked
 * emission mode; the event plumbing already pushes each report to the
 * worker as it arrives.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import {
  getNavigatorHid,
  getSharedHidRegistry,
  type HidDeviceFilter,
  type HidDeviceInfo,
  MAX_HID_REPORT_BYTES,
} from '../../kernel/hid-device-registry.js';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import { getToolExecutionContext } from '../../tools/tool-ui.js';
import { parseFlagArgs } from '../arg-parser.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';
import { type HidBackend, type HidInputReport, resolveHidBackend } from './hid-backends.js';
import { runDevicePickerApproval } from './picker-approval.js';

type HidCtx = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CmdResult = { stdout: string; stderr: string; exitCode: number };

const VALUE_FLAGS = new Set([
  '--vid',
  '--pid',
  '--usage-page',
  '--usage',
  '--__resolved',
  '--timeout',
]);

const DEFAULT_QUERY_TIMEOUT_MS = 1000;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/** Split argv into positionals, value-flags, and boolean flags. */
export function parseHidArgs(args: string[]): ParsedArgs {
  return parseFlagArgs(args, VALUE_FLAGS);
}

/** Parse a `0x`-prefixed hex or decimal integer; throws on garbage. */
export function parseIntArg(value: string, label: string): number {
  const n = /^0x/i.test(value) ? parseInt(value, 16) : parseInt(value, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) {
    throw new Error(`invalid ${label}: '${value}'`);
  }
  return n;
}

/** Build the WebHID filter list from `--vid/--pid/--usage-page/--usage` flags. */
export function parseHidFilters(flags: Map<string, string>): HidDeviceFilter[] {
  const filter: HidDeviceFilter = {};
  if (flags.has('--vid')) filter.vendorId = parseIntArg(flags.get('--vid')!, 'vid');
  if (flags.has('--pid')) filter.productId = parseIntArg(flags.get('--pid')!, 'pid');
  if (flags.has('--usage-page'))
    filter.usagePage = parseIntArg(flags.get('--usage-page')!, 'usage-page');
  if (flags.has('--usage')) filter.usage = parseIntArg(flags.get('--usage')!, 'usage');
  return Object.keys(filter).length > 0 ? [filter] : [];
}

function stdinBytes(ctx: HidCtx): Uint8Array {
  const latin1 = stdinAsLatin1(ctx.stdin);
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i) & 0xff;
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

function hex4(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`;
}

function formatDeviceInfo(info: HidDeviceInfo): string {
  const name = info.productName || '(unknown)';
  const state = info.opened ? ' [open]' : '';
  // Multi-interface devices (e.g. VIA/QMK keyboards) need the first
  // collection's usagePage/usage in the display so users can tell which
  // handle is the raw-HID interface (`FF60:0061`). Omitted when the
  // device exposes no collections.
  const usage =
    info.usagePage !== undefined ? `\t${hex4(info.usagePage)}:${hex4(info.usage ?? 0)}` : '';
  return `${info.handle}\t${hex4(info.vendorId)}:${hex4(info.productId)}${usage}\t${name}${state}`;
}

/**
 * Re-order a freshly-granted device list so the entry matching the
 * caller's `--usage-page` / `--usage` filter sits first. The picker
 * doesn't honor those flags as a hard pre-select (Chromium's chooser
 * shows the device as a single line), so the shell command surfaces
 * the matched interface as the primary handle on output instead.
 */
function pickPrimaryAndOrder(
  devices: HidDeviceInfo[],
  filter: HidDeviceFilter | undefined
): HidDeviceInfo[] {
  const wantPage = filter?.usagePage;
  const wantUsage = filter?.usage;
  if (wantPage === undefined && wantUsage === undefined) return devices;
  const matchIdx = devices.findIndex(
    (d) =>
      (wantPage === undefined || d.usagePage === wantPage) &&
      (wantUsage === undefined || d.usage === wantUsage)
  );
  if (matchIdx <= 0) return devices;
  const out = devices.slice();
  const [match] = out.splice(matchIdx, 1);
  out.unshift(match);
  return out;
}

function formatDeviceList(devices: HidDeviceInfo[]): string {
  return `${devices.map(formatDeviceInfo).join('\n')}\n`;
}

function formatReport(report: HidInputReport): string {
  return `${hex2(report.reportId)} ${toHex(report.bytes)}`.trimEnd();
}

function ok(stdout: string): CmdResult {
  return { stdout, stderr: '', exitCode: 0 };
}
function fail(message: string): CmdResult {
  return { stdout: '', stderr: `hid: ${message}\n`, exitCode: 1 };
}

const HELP = `hid - access HID devices via WebHID

Usage: hid <subcommand> [options]

Subcommands:
  list                              List currently-granted devices
  request [--vid 0x.. --pid 0x.. --usage-page N --usage N]
                                    Open the device picker; prints a handle
  open <handle>                     Open a device
  close <handle>                    Close a device
  send <handle> <report-id>         Send an output report (payload from stdin)
  query <handle> <report-id>        Send an output report and await one input
                                    report (VIA-style request/response)
  feature-send <handle> <report-id> Send a feature report (payload from stdin)
  feature-get <handle> <report-id> <length>
                                    Receive a feature report
  watch <handle>                    Stream input reports as hex until Ctrl+C

Options:
  --raw            Emit raw bytes (feature-get, query); default is hex dump
  --timeout <ms>   query: wait this long for an input report (default 1000)
  -h, --help

Report payloads are capped at ${MAX_HID_REPORT_BYTES} bytes (4 MiB).
`;

function emitBytes(bytes: Uint8Array, raw: boolean): CmdResult {
  if (raw) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return ok(s);
  }
  return ok(bytes.length ? `${toHex(bytes)}\n` : '');
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

async function cmdList(backend: HidBackend): Promise<CmdResult> {
  const devices = await backend.list();
  if (devices.length === 0) return ok('no granted HID devices\n');
  return ok(`${devices.map(formatDeviceInfo).join('\n')}\n`);
}

async function cmdRequest(flags: Map<string, string>, backend: HidBackend): Promise<CmdResult> {
  const resolved = flags.get('--__resolved');
  const filters = parseHidFilters(flags);
  const filter = filters[0];
  if (resolved) {
    // `RemoteTerminalView` runs the chooser on the Enter-keystroke
    // gesture and forwards every granted interface as a comma-
    // separated handle list so multi-interface devices (e.g. a
    // VIA/QMK keyboard) print every collection, not just the first.
    const handles = resolved.split(',').filter((h) => h.length > 0);
    if (handles.length === 0) return fail('request: missing resolved handle');
    const infos = await Promise.all(handles.map((h) => backend.info(h)));
    return ok(formatDeviceList(pickPrimaryAndOrder(infos, filter)));
  }
  const toolCtx = getToolExecutionContext();
  if (toolCtx) {
    return cmdRequestViaApproval(filters, filter, toolCtx, backend);
  }
  const devices = await backend.request(filters);
  return ok(formatDeviceList(pickPrimaryAndOrder(devices, filter)));
}

async function cmdRequestViaApproval(
  filters: HidDeviceFilter[],
  filter: HidDeviceFilter | undefined,
  toolCtx: NonNullable<ReturnType<typeof getToolExecutionContext>>,
  backend: HidBackend
): Promise<CmdResult> {
  // Cone path: surface approval card; click drives chooser via
  // dip (standalone) or unified popup (extension). After the
  // user grants, enumerate ALL handles for the picked vid/pid so
  // multi-interface devices (e.g. a VIA/QMK keyboard's raw-HID
  // 0xFF60 interface) are individually addressable.
  const approval = await runDevicePickerApproval('hid-device', filters, toolCtx);
  let primaryVid: number;
  let primaryPid: number;
  if (approval.handle) {
    const info = await backend.info(approval.handle);
    primaryVid = info.vendorId;
    primaryPid = info.productId;
  } else {
    const ident = approval.info as { vendorId: number; productId: number };
    const hid = getNavigatorHid();
    if (!hid) return fail('request: WebHID unavailable for device re-acquire');
    const devices = await hid.getDevices();
    const reg = getSharedHidRegistry();
    const matched = devices.filter(
      (d) => d.vendorId === ident.vendorId && d.productId === ident.productId
    );
    if (matched.length === 0) {
      return fail('request: granted device could not be re-acquired');
    }
    for (const d of matched) reg.register(d);
    primaryVid = ident.vendorId;
    primaryPid = ident.productId;
  }
  const all = await backend.list();
  const siblings = all.filter((d) => d.vendorId === primaryVid && d.productId === primaryPid);
  const ordered = pickPrimaryAndOrder(siblings.length > 0 ? siblings : [], filter);
  if (ordered.length === 0) return fail('request: granted device could not be re-acquired');
  return ok(formatDeviceList(ordered));
}

async function cmdOpenClose(
  sub: string,
  positionals: string[],
  backend: HidBackend
): Promise<CmdResult> {
  const handle = positionals[1];
  if (!handle) return fail(`${sub}: handle required`);
  if (sub === 'open') await backend.open(handle);
  else await backend.close(handle);
  return ok('');
}

async function cmdSend(
  sub: string,
  positionals: string[],
  ctx: HidCtx,
  backend: HidBackend
): Promise<CmdResult> {
  const [, handle, reportIdStr] = positionals;
  if (!handle || reportIdStr === undefined) {
    return fail(`${sub}: handle and report-id required`);
  }
  const reportId = parseIntArg(reportIdStr, 'report-id');
  const bytes = stdinBytes(ctx);
  if (bytes.length > MAX_HID_REPORT_BYTES) return fail(`${sub} payload exceeds 4 MiB limit`);
  if (sub === 'send') await backend.sendReport(handle, reportId, bytes);
  else await backend.sendFeatureReport(handle, reportId, bytes);
  return ok('');
}

async function cmdFeatureGet(
  positionals: string[],
  backend: HidBackend,
  raw: boolean
): Promise<CmdResult> {
  const [, handle, reportIdStr] = positionals;
  if (!handle || reportIdStr === undefined) {
    return fail('feature-get: handle and report-id required');
  }
  const r = await backend.receiveFeatureReport(handle, parseIntArg(reportIdStr, 'report-id'));
  return emitBytes(r.bytes, raw);
}

async function cmdWatch(
  positionals: string[],
  ctx: HidCtx,
  backend: HidBackend
): Promise<CmdResult> {
  const handle = positionals[1];
  if (!handle) return fail('watch: handle required');
  const lines: string[] = [];
  const unsubscribe = await backend.subscribeInputReports(handle, (report) => {
    lines.push(formatReport(report));
  });
  try {
    await waitForAbort(ctx.signal);
  } finally {
    await unsubscribe();
  }
  return ok(lines.length ? `${lines.join('\n')}\n` : '');
}

async function cmdQuery(
  positionals: string[],
  ctx: HidCtx,
  flags: Map<string, string>,
  backend: HidBackend,
  raw: boolean
): Promise<CmdResult> {
  // VIA-style request/response: subscribe, send the output report,
  // await the first input report, then always unsubscribe. The
  // subscribe call auto-opens the device (Wave 3 ensureOpen).
  const [, handle, reportIdStr] = positionals;
  if (!handle || reportIdStr === undefined) {
    return fail('query: handle and report-id required');
  }
  const reportId = parseIntArg(reportIdStr, 'report-id');
  const bytes = stdinBytes(ctx);
  if (bytes.length > MAX_HID_REPORT_BYTES) return fail('query payload exceeds 4 MiB limit');
  const timeoutMs = flags.has('--timeout')
    ? parseIntArg(flags.get('--timeout')!, 'timeout')
    : DEFAULT_QUERY_TIMEOUT_MS;
  let resolveReport: (report: HidInputReport) => void = () => {};
  const reportPromise = new Promise<HidInputReport>((resolve) => {
    resolveReport = resolve;
  });
  const unsubscribe = await backend.subscribeInputReports(handle, (report) => {
    resolveReport(report);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await backend.sendReport(handle, reportId, bytes);
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const winner = await Promise.race([reportPromise, timeoutPromise]);
    if (winner === 'timeout') {
      return fail(`query: no input report within ${timeoutMs}ms`);
    }
    return raw ? emitBytes(winner.bytes, true) : ok(`${formatReport(winner)}\n`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await unsubscribe();
  }
}

async function dispatch(args: string[], ctx: HidCtx, backend: HidBackend): Promise<CmdResult> {
  const { positionals, flags, bools } = parseHidArgs(args);
  const sub = positionals[0];
  const raw = bools.has('--raw');

  switch (sub) {
    case 'list':
      return cmdList(backend);
    case 'request':
      return cmdRequest(flags, backend);
    case 'open':
    case 'close':
      return cmdOpenClose(sub, positionals, backend);
    case 'send':
    case 'feature-send':
      return cmdSend(sub, positionals, ctx, backend);
    case 'feature-get':
      return cmdFeatureGet(positionals, backend, raw);
    case 'watch':
      return cmdWatch(positionals, ctx, backend);
    case 'query':
      return cmdQuery(positionals, ctx, flags, backend, raw);
    default:
      return fail(`unknown subcommand '${sub ?? ''}'. Try 'hid --help'.`);
  }
}

export function createHidCommand(): Command {
  return defineCommand('hid', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return ok(HELP);
    }
    const backend = resolveHidBackend(hasLocalDom(), getPanelRpcClient());
    if (!backend) {
      return fail('WebHID is unavailable in this environment');
    }
    try {
      return await dispatch(args, ctx as HidCtx, backend);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/cancelled|NotFoundError|No device selected/i.test(message)) {
        return fail('user cancelled or no device selected');
      }
      return fail(message);
    }
  });
}
