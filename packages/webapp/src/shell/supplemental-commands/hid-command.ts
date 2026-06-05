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
  hidDeviceToInfo,
  MAX_HID_REPORT_BYTES,
} from '../../kernel/hid-device-registry.js';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import { getToolExecutionContext } from '../../tools/tool-ui.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';
import { type HidBackend, type HidInputReport, resolveHidBackend } from './hid-backends.js';
import { runDevicePickerApproval } from './picker-approval.js';

type HidCtx = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CmdResult = { stdout: string; stderr: string; exitCode: number };

const VALUE_FLAGS = new Set(['--vid', '--pid', '--usage-page', '--usage', '--__resolved']);

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/** Split argv into positionals, value-flags, and boolean flags. */
export function parseHidArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith('-')) {
      if (VALUE_FLAGS.has(tok)) {
        flags.set(tok, args[++i] ?? '');
      } else {
        bools.add(tok);
      }
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags, bools };
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
  return `${info.handle}\t${hex4(info.vendorId)}:${hex4(info.productId)}\t${name}${state}`;
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
  feature-send <handle> <report-id> Send a feature report (payload from stdin)
  feature-get <handle> <report-id> <length>
                                    Receive a feature report
  watch <handle>                    Stream input reports as hex until Ctrl+C

Options:
  --raw     Emit raw bytes for feature-get (default: hex dump)
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

async function dispatch(args: string[], ctx: HidCtx, backend: HidBackend): Promise<CmdResult> {
  const { positionals, flags, bools } = parseHidArgs(args);
  const sub = positionals[0];
  const raw = bools.has('--raw');

  switch (sub) {
    case 'list': {
      const devices = await backend.list();
      if (devices.length === 0) return ok('no granted HID devices\n');
      return ok(`${devices.map(formatDeviceInfo).join('\n')}\n`);
    }
    case 'request': {
      const resolved = flags.get('--__resolved');
      if (resolved) return ok(`${formatDeviceInfo(await backend.info(resolved))}\n`);
      const filters = parseHidFilters(flags);
      const toolCtx = getToolExecutionContext();
      if (toolCtx) {
        // Cone path: surface approval card; click drives chooser via
        // dip (standalone) or unified popup (extension).
        const approval = await runDevicePickerApproval('hid-device', filters, toolCtx);
        if (approval.handle) {
          return ok(`${formatDeviceInfo(await backend.info(approval.handle))}\n`);
        }
        const ident = approval.info as { vendorId: number; productId: number };
        const hid = getNavigatorHid();
        if (!hid) return fail('request: WebHID unavailable for device re-acquire');
        const devices = await hid.getDevices();
        const device = devices.find(
          (d) => d.vendorId === ident.vendorId && d.productId === ident.productId
        );
        if (!device) return fail('request: granted device could not be re-acquired');
        const handle = getSharedHidRegistry().register(device);
        return ok(`${formatDeviceInfo(hidDeviceToInfo(handle, device))}\n`);
      }
      return ok(`${formatDeviceInfo(await backend.request(filters))}\n`);
    }
    case 'open':
    case 'close': {
      const handle = positionals[1];
      if (!handle) return fail(`${sub}: handle required`);
      if (sub === 'open') await backend.open(handle);
      else await backend.close(handle);
      return ok('');
    }
    case 'send':
    case 'feature-send': {
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
    case 'feature-get': {
      const [, handle, reportIdStr] = positionals;
      if (!handle || reportIdStr === undefined) {
        return fail('feature-get: handle and report-id required');
      }
      const r = await backend.receiveFeatureReport(handle, parseIntArg(reportIdStr, 'report-id'));
      return emitBytes(r.bytes, raw);
    }
    case 'watch': {
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
