/**
 * `serial` — Web Serial access from the shell.
 *
 * Runs in any float: a DOM realm (panel terminal / extension shell)
 * talks to `navigator.serial` directly; the kernel worker forwards every
 * op over panel-RPC to the page-side handlers. Port handles are opaque
 * strings (`serial1`, `serial2`, …) backed by a page-side registry —
 * `SerialPort` objects never cross the worker boundary.
 *
 * The `serial request` chooser requires a user gesture. When typed in
 * the panel terminal, `RemoteTerminalView` runs the picker on the Enter
 * keystroke and forwards a rewritten command carrying `--__resolved`.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import type {
  SerialDeviceInfo,
  SerialFilter,
  SerialInputSignals,
  SerialOpenOptions,
  SerialOutputSignals,
} from '../../kernel/serial-port-registry.js';
import {
  getNavigatorSerial,
  getSharedSerialRegistry,
  MAX_SERIAL_TRANSFER_BYTES,
  deviceToInfo as serialPortToInfo,
} from '../../kernel/serial-port-registry.js';
import { getToolExecutionContext } from '../../tools/tool-ui.js';
import { parseFlagArgs } from '../arg-parser.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';
import { runDevicePickerApproval } from './picker-approval.js';
import {
  resolveSerialBackend,
  type SerialBackend,
  type SerialReadParams,
} from './serial-backends.js';

type SerialCtx = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CmdResult = { stdout: string; stderr: string; exitCode: number };

const VALUE_FLAGS = new Set([
  '--vid',
  '--pid',
  '--baud',
  '--data-bits',
  '--stop-bits',
  '--parity',
  '--flow-control',
  '--buffer-size',
  '--bytes',
  '--until',
  '--timeout-ms',
  '--dtr',
  '--rts',
  '--break',
  '--__resolved',
]);

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/** Split argv into positionals, value-flags, and boolean flags. */
export function parseSerialArgs(args: string[]): ParsedArgs {
  return parseFlagArgs(args, VALUE_FLAGS);
}

/** Parse a `0x`-prefixed hex or decimal integer; throws on garbage. */
export function parseIntArg(value: string, label: string): number {
  const n = /^0x/i.test(value) ? parseInt(value, 16) : parseInt(value, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) throw new Error(`invalid ${label}: '${value}'`);
  return n;
}

/** Parse a hex byte string (`3e3e3e`, `0x3e 0x3e`, `3e:3e`) into bytes. */
export function parseHexBytes(value: string): Uint8Array {
  const cleaned = value.replace(/0x/gi, '').replace(/[\s:,]/g, '');
  if (cleaned.length === 0) return new Uint8Array(0);
  if (cleaned.length % 2 !== 0 || /[^0-9a-f]/i.test(cleaned)) {
    throw new Error(`invalid hex string: '${value}'`);
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Build the Web Serial filter list from `--vid` / `--pid` flags. */
export function parseSerialFilters(flags: Map<string, string>): SerialFilter[] {
  const filter: SerialFilter = {};
  if (flags.has('--vid')) filter.usbVendorId = parseIntArg(flags.get('--vid')!, 'vid');
  if (flags.has('--pid')) filter.usbProductId = parseIntArg(flags.get('--pid')!, 'pid');
  return Object.keys(filter).length > 0 ? [filter] : [];
}

const PARITIES = new Set(['none', 'even', 'odd']);
const FLOW_CONTROLS = new Set(['none', 'hardware']);

/** Build `SerialPort.open()` options from flags (`--baud` etc.). */
export function parseOpenOptions(flags: Map<string, string>): SerialOpenOptions {
  const baudRate = flags.has('--baud') ? parseIntArg(flags.get('--baud')!, 'baud') : 9600;
  const options: SerialOpenOptions = { baudRate };
  if (flags.has('--data-bits'))
    options.dataBits = parseIntArg(flags.get('--data-bits')!, 'data-bits');
  if (flags.has('--stop-bits'))
    options.stopBits = parseIntArg(flags.get('--stop-bits')!, 'stop-bits');
  if (flags.has('--parity')) {
    const parity = flags.get('--parity')!;
    if (!PARITIES.has(parity)) throw new Error(`invalid --parity: '${parity}'`);
    options.parity = parity as SerialOpenOptions['parity'];
  }
  if (flags.has('--flow-control')) {
    const fc = flags.get('--flow-control')!;
    if (!FLOW_CONTROLS.has(fc)) throw new Error(`invalid --flow-control: '${fc}'`);
    options.flowControl = fc as SerialOpenOptions['flowControl'];
  }
  if (flags.has('--buffer-size')) {
    options.bufferSize = parseIntArg(flags.get('--buffer-size')!, 'buffer-size');
  }
  return options;
}

/** Build read options from `--bytes` / `--until` / `--timeout-ms`. */
export function parseReadOptions(flags: Map<string, string>): SerialReadParams {
  const params: SerialReadParams = {};
  if (flags.has('--bytes')) params.maxBytes = parseIntArg(flags.get('--bytes')!, 'bytes');
  if (flags.has('--until')) params.until = parseHexBytes(flags.get('--until')!);
  if (flags.has('--timeout-ms')) {
    params.timeoutMs = parseIntArg(flags.get('--timeout-ms')!, 'timeout-ms');
  }
  return params;
}

function parseBool(value: string, label: string): boolean {
  const v = value.toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  throw new Error(`invalid ${label}: '${value}' (use on/off)`);
}

/** Build settable control signals from `--dtr` / `--rts` / `--break`. */
export function parseOutputSignals(flags: Map<string, string>): SerialOutputSignals {
  const signals: SerialOutputSignals = {};
  if (flags.has('--dtr')) signals.dataTerminalReady = parseBool(flags.get('--dtr')!, 'dtr');
  if (flags.has('--rts')) signals.requestToSend = parseBool(flags.get('--rts')!, 'rts');
  if (flags.has('--break')) signals.break = parseBool(flags.get('--break')!, 'break');
  return signals;
}

function stdinBytes(ctx: SerialCtx): Uint8Array {
  const latin1 = stdinAsLatin1(ctx.stdin);
  const bytes = new Uint8Array(latin1.length);
  for (let i = 0; i < latin1.length; i++) bytes[i] = latin1.charCodeAt(i) & 0xff;
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function hex4(n: number): string {
  return `0x${n.toString(16).padStart(4, '0')}`;
}

function formatDeviceInfo(info: SerialDeviceInfo): string {
  const id =
    info.usbVendorId !== undefined || info.usbProductId !== undefined
      ? `${hex4(info.usbVendorId ?? 0)}:${hex4(info.usbProductId ?? 0)}`
      : '(native serial)';
  const state = info.opened ? ' [open]' : '';
  return `${info.handle}\t${id}${state}`;
}

function formatSignals(s: SerialInputSignals): string {
  return `cts=${s.clearToSend ? 1 : 0} dcd=${s.dataCarrierDetect ? 1 : 0} dsr=${s.dataSetReady ? 1 : 0} ri=${s.ringIndicator ? 1 : 0}\n`;
}

function ok(stdout: string): CmdResult {
  return { stdout, stderr: '', exitCode: 0 };
}
function fail(message: string): CmdResult {
  return { stdout: '', stderr: `serial: ${message}\n`, exitCode: 1 };
}

const HELP = `serial - access serial ports via Web Serial

Usage: serial <subcommand> [options]

Subcommands:
  list                              List currently-granted ports
  request [--vid 0x.. --pid 0x..]   Open the port picker; prints a handle
  open <handle> [open flags]        Open a port
  close <handle>                    Close a port
  read <handle> [read flags]        Read bytes (raw by default, --hex to dump)
  write <handle>                    Write stdin bytes to the port
  signals <handle> get              Print control input signals
  signals <handle> set [sig flags]  Set control output signals

Open flags:
  --baud N (default 9600)  --data-bits N  --stop-bits N
  --parity none|even|odd   --flow-control none|hardware  --buffer-size N

Read flags:
  --bytes N        Stop after N bytes (default: ${MAX_SERIAL_TRANSFER_BYTES} cap)
  --until <hex>    Stop once this byte sequence is seen
  --timeout-ms N   Stop after N ms (default 1000)
  --hex            Hex-dump the bytes instead of emitting raw

Signal flags (set):
  --dtr on|off  --rts on|off  --break on|off

Options:
  -h, --help

Reads/writes are capped at ${MAX_SERIAL_TRANSFER_BYTES} bytes (4 MiB).
`;

function emitRead(bytes: Uint8Array, hex: boolean): CmdResult {
  if (hex) return ok(bytes.length ? `${toHex(bytes)}\n` : '');
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return ok(s);
}

async function cmdList(backend: SerialBackend): Promise<CmdResult> {
  const devices = await backend.list();
  if (devices.length === 0) return ok('no granted serial ports\n');
  return ok(`${devices.map(formatDeviceInfo).join('\n')}\n`);
}

async function cmdRequest(flags: Map<string, string>, backend: SerialBackend): Promise<CmdResult> {
  const resolved = flags.get('--__resolved');
  if (resolved) return ok(`${formatDeviceInfo(await backend.info(resolved))}\n`);
  const filters = parseSerialFilters(flags);
  const toolCtx = getToolExecutionContext();
  if (toolCtx) {
    // Cone path: surface approval card; click drives chooser via
    // dip (standalone) or unified popup (extension).
    const approval = await runDevicePickerApproval('serial-port', filters, toolCtx);
    if (approval.handle) {
      return ok(`${formatDeviceInfo(await backend.info(approval.handle))}\n`);
    }
    const ident = approval.info as { usbVendorId?: number; usbProductId?: number };
    const serial = getNavigatorSerial();
    if (!serial) return fail('request: Web Serial unavailable for port re-acquire');
    const ports = await serial.getPorts();
    const port = ports.find((p) => {
      const i = typeof p.getInfo === 'function' ? p.getInfo() : {};
      return (
        (ident.usbVendorId === undefined || i.usbVendorId === ident.usbVendorId) &&
        (ident.usbProductId === undefined || i.usbProductId === ident.usbProductId)
      );
    });
    if (!port) return fail('request: granted port could not be re-acquired');
    const registry = getSharedSerialRegistry();
    const handle = registry.register(port);
    const entry = registry.get(handle);
    if (!entry) return fail('request: failed to register granted port');
    return ok(`${formatDeviceInfo(serialPortToInfo(handle, entry))}\n`);
  }
  return ok(`${formatDeviceInfo(await backend.request(filters))}\n`);
}

async function cmdOpen(
  positionals: string[],
  flags: Map<string, string>,
  backend: SerialBackend
): Promise<CmdResult> {
  const handle = positionals[1];
  if (!handle) return fail('open: handle required');
  await backend.open(handle, parseOpenOptions(flags));
  return ok('');
}

async function cmdClose(positionals: string[], backend: SerialBackend): Promise<CmdResult> {
  const handle = positionals[1];
  if (!handle) return fail('close: handle required');
  await backend.close(handle);
  return ok('');
}

async function cmdRead(
  positionals: string[],
  flags: Map<string, string>,
  bools: Set<string>,
  backend: SerialBackend
): Promise<CmdResult> {
  const handle = positionals[1];
  if (!handle) return fail('read: handle required');
  const params = parseReadOptions(flags);
  if (params.maxBytes !== undefined && params.maxBytes > MAX_SERIAL_TRANSFER_BYTES) {
    return fail('read --bytes exceeds 4 MiB limit');
  }
  const bytes = await backend.read(handle, params);
  return emitRead(bytes, bools.has('--hex'));
}

async function cmdWrite(
  positionals: string[],
  ctx: SerialCtx,
  backend: SerialBackend
): Promise<CmdResult> {
  const handle = positionals[1];
  if (!handle) return fail('write: handle required');
  const bytes = stdinBytes(ctx);
  if (bytes.length > MAX_SERIAL_TRANSFER_BYTES) return fail('write payload exceeds 4 MiB limit');
  const n = await backend.write(handle, bytes);
  return ok(`${n} bytes written\n`);
}

async function cmdSignals(
  positionals: string[],
  flags: Map<string, string>,
  backend: SerialBackend
): Promise<CmdResult> {
  const [, handle, action] = positionals;
  if (!handle || !action) return fail('signals: handle and get|set required');
  if (action === 'get') return ok(formatSignals(await backend.getSignals(handle)));
  if (action === 'set') {
    await backend.setSignals(handle, parseOutputSignals(flags));
    return ok('');
  }
  return fail(`signals: unknown action '${action}' (use get|set)`);
}

async function dispatch(
  args: string[],
  ctx: SerialCtx,
  backend: SerialBackend
): Promise<CmdResult> {
  const { positionals, flags, bools } = parseSerialArgs(args);
  const sub = positionals[0];

  switch (sub) {
    case 'list':
      return cmdList(backend);
    case 'request':
      return cmdRequest(flags, backend);
    case 'open':
      return cmdOpen(positionals, flags, backend);
    case 'close':
      return cmdClose(positionals, backend);
    case 'read':
      return cmdRead(positionals, flags, bools, backend);
    case 'write':
      return cmdWrite(positionals, ctx, backend);
    case 'signals':
      return cmdSignals(positionals, flags, backend);
    default:
      return fail(`unknown subcommand '${sub ?? ''}'. Try 'serial --help'.`);
  }
}

export function createSerialCommand(): Command {
  return defineCommand('serial', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return ok(HELP);
    }
    const backend = resolveSerialBackend(hasLocalDom(), getPanelRpcClient());
    if (!backend) return fail('Web Serial is unavailable in this environment');
    try {
      return await dispatch(args, ctx as SerialCtx, backend);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/cancelled|NotFoundError|No port selected/i.test(message)) {
        return fail('user cancelled or no port selected');
      }
      return fail(message);
    }
  });
}
