/**
 * `usb` — WebUSB access from the shell.
 *
 * Runs in any float: a DOM realm (panel terminal / extension shell)
 * talks to `navigator.usb` directly; the kernel worker forwards every
 * op over panel-RPC to the page-side handlers. Device handles are
 * opaque strings (`usb1`, `usb2`, …) backed by a page-side registry —
 * `USBDevice` objects never cross the worker boundary.
 *
 * The `usb request` chooser requires a user gesture. When typed in the
 * panel terminal, `RemoteTerminalView` runs the picker on the Enter
 * keystroke and forwards a rewritten command carrying `--__resolved`.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import {
  deviceToInfo,
  getNavigatorUsb,
  getSharedUsbRegistry,
  MAX_USB_TRANSFER_BYTES,
  type UsbControlSetup,
  type UsbDeviceFilter,
  type UsbDeviceInfo,
} from '../../kernel/usb-device-registry.js';
import { getToolExecutionContext } from '../../tools/tool-ui.js';
import { parseFlagArgs } from '../arg-parser.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';
import { runDevicePickerApproval } from './picker-approval.js';
import { resolveUsbBackend, type UsbBackend } from './usb-backends.js';

type UsbCtx = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CmdResult = { stdout: string; stderr: string; exitCode: number };

const VALUE_FLAGS = new Set([
  '--vid',
  '--pid',
  '--class',
  '--subclass',
  '--protocol',
  '--serial',
  '--request-type',
  '--recipient',
  '--request',
  '--value',
  '--index',
  '--__resolved',
]);

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/** Split argv into positionals, value-flags, and boolean flags. */
export function parseUsbArgs(args: string[]): ParsedArgs {
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

/** Build the WebUSB filter list from `--vid/--pid/--class/...` flags. */
export function parseUsbFilters(flags: Map<string, string>): UsbDeviceFilter[] {
  const filter: UsbDeviceFilter = {};
  if (flags.has('--vid')) filter.vendorId = parseIntArg(flags.get('--vid')!, 'vid');
  if (flags.has('--pid')) filter.productId = parseIntArg(flags.get('--pid')!, 'pid');
  if (flags.has('--class')) filter.classCode = parseIntArg(flags.get('--class')!, 'class');
  if (flags.has('--subclass'))
    filter.subclassCode = parseIntArg(flags.get('--subclass')!, 'subclass');
  if (flags.has('--protocol'))
    filter.protocolCode = parseIntArg(flags.get('--protocol')!, 'protocol');
  if (flags.has('--serial')) filter.serialNumber = flags.get('--serial')!;
  return Object.keys(filter).length > 0 ? [filter] : [];
}

const REQUEST_TYPES = new Set(['standard', 'class', 'vendor']);
const RECIPIENTS = new Set(['device', 'interface', 'endpoint', 'other']);

/** Build a control-transfer setup packet from flags. */
export function parseControlSetup(flags: Map<string, string>): UsbControlSetup {
  const requestType = flags.get('--request-type') ?? 'vendor';
  const recipient = flags.get('--recipient') ?? 'device';
  if (!REQUEST_TYPES.has(requestType)) throw new Error(`invalid --request-type: '${requestType}'`);
  if (!RECIPIENTS.has(recipient)) throw new Error(`invalid --recipient: '${recipient}'`);
  return {
    requestType: requestType as UsbControlSetup['requestType'],
    recipient: recipient as UsbControlSetup['recipient'],
    request: parseIntArg(flags.get('--request') ?? '0', 'request'),
    value: parseIntArg(flags.get('--value') ?? '0', 'value'),
    index: parseIntArg(flags.get('--index') ?? '0', 'index'),
  };
}

function stdinBytes(ctx: UsbCtx): Uint8Array {
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

function formatDeviceInfo(info: UsbDeviceInfo): string {
  const name = [info.manufacturerName, info.productName].filter(Boolean).join(' ') || '(unknown)';
  const serial = info.serialNumber ? ` serial=${info.serialNumber}` : '';
  const state = info.opened ? ' [open]' : '';
  return `${info.handle}\t${hex4(info.vendorId)}:${hex4(info.productId)}\t${name}${serial}${state}`;
}

function ok(stdout: string): CmdResult {
  return { stdout, stderr: '', exitCode: 0 };
}
function fail(message: string): CmdResult {
  return { stdout: '', stderr: `usb: ${message}\n`, exitCode: 1 };
}

const HELP = `usb - access USB devices via WebUSB

Usage: usb <subcommand> [options]

Subcommands:
  list                              List currently-granted devices
  request [--vid 0x.. --pid 0x.. --class N --serial S]
                                    Open the device picker; prints a handle
  open <handle>                     Open a device
  close <handle>                    Close a device
  reset <handle>                    Reset a device
  select-config <handle> <value>    Select a configuration
  claim <handle> <interface>        Claim an interface
  release <handle> <interface>      Release an interface
  control-in <handle> <length> [setup flags]
  control-out <handle> [setup flags]            (payload from stdin)
  transfer-in <handle> <endpoint> <length>
  transfer-out <handle> <endpoint>              (payload from stdin)

Control setup flags:
  --request-type standard|class|vendor   (default vendor)
  --recipient device|interface|endpoint|other (default device)
  --request N  --value N  --index N

Options:
  --raw     Emit raw bytes for *-in transfers (default: hex dump)
  -h, --help

Transfers are capped at ${MAX_USB_TRANSFER_BYTES} bytes (4 MiB).
`;

function emitIn(bytes: Uint8Array, raw: boolean): CmdResult {
  if (raw) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return ok(s);
  }
  return ok(bytes.length ? `${toHex(bytes)}\n` : '');
}

async function dispatch(args: string[], ctx: UsbCtx, backend: UsbBackend): Promise<CmdResult> {
  const { positionals, flags, bools } = parseUsbArgs(args);
  const sub = positionals[0];
  const raw = bools.has('--raw');

  switch (sub) {
    case 'list': {
      const devices = await backend.list();
      if (devices.length === 0) return ok('no granted USB devices\n');
      return ok(`${devices.map(formatDeviceInfo).join('\n')}\n`);
    }
    case 'request': {
      const resolved = flags.get('--__resolved');
      if (resolved) return ok(`${formatDeviceInfo(await backend.info(resolved))}\n`);
      const filters = parseUsbFilters(flags);
      const toolCtx = getToolExecutionContext();
      if (toolCtx) {
        // Cone path: agent-issued `usb request` arrives without a user
        // gesture, so `navigator.usb.requestDevice` would fail. Surface
        // an approval card in chat; the click drives the chooser via
        // dip (standalone) or the unified popup (extension), then either
        // returns a page-realm handle directly or identifiers we
        // re-acquire in this realm.
        const approval = await runDevicePickerApproval('usb-device', filters, toolCtx);
        if (approval.handle) {
          return ok(`${formatDeviceInfo(await backend.info(approval.handle))}\n`);
        }
        const ident = approval.info as {
          vendorId: number;
          productId: number;
          serialNumber?: string;
        };
        const usb = getNavigatorUsb();
        if (!usb) return fail('request: WebUSB unavailable for device re-acquire');
        const devices = await usb.getDevices();
        const device = devices.find(
          (d) =>
            d.vendorId === ident.vendorId &&
            d.productId === ident.productId &&
            (!ident.serialNumber || d.serialNumber === ident.serialNumber)
        );
        if (!device) return fail('request: granted device could not be re-acquired');
        const handle = getSharedUsbRegistry().register(device);
        return ok(`${formatDeviceInfo(deviceToInfo(handle, device))}\n`);
      }
      return ok(`${formatDeviceInfo(await backend.request(filters))}\n`);
    }
    case 'open':
    case 'close':
    case 'reset': {
      const handle = positionals[1];
      if (!handle) return fail(`${sub}: handle required`);
      if (sub === 'open') await backend.open(handle);
      else if (sub === 'close') await backend.close(handle);
      else await backend.reset(handle);
      return ok('');
    }
    case 'select-config': {
      const [, handle, value] = positionals;
      if (!handle || value === undefined) return fail('select-config: handle and value required');
      await backend.selectConfig(handle, parseIntArg(value, 'configuration'));
      return ok('');
    }
    case 'claim':
    case 'release': {
      const [, handle, iface] = positionals;
      if (!handle || iface === undefined) return fail(`${sub}: handle and interface required`);
      const fn = sub === 'claim' ? backend.claim : backend.release;
      await fn.call(backend, handle, parseIntArg(iface, 'interface'));
      return ok('');
    }
    case 'control-in': {
      const [, handle, lengthStr] = positionals;
      if (!handle || lengthStr === undefined) return fail('control-in: handle and length required');
      const length = parseIntArg(lengthStr, 'length');
      if (length > MAX_USB_TRANSFER_BYTES) return fail('control-in length exceeds 4 MiB limit');
      const r = await backend.controlIn(handle, parseControlSetup(flags), length);
      return emitIn(r.bytes, raw);
    }
    case 'control-out': {
      const handle = positionals[1];
      if (!handle) return fail('control-out: handle required');
      const bytes = stdinBytes(ctx);
      if (bytes.length > MAX_USB_TRANSFER_BYTES)
        return fail('control-out payload exceeds 4 MiB limit');
      const r = await backend.controlOut(handle, parseControlSetup(flags), bytes);
      return ok(`${r.bytesWritten} bytes written\n`);
    }
    case 'transfer-in': {
      const [, handle, epStr, lengthStr] = positionals;
      if (!handle || epStr === undefined || lengthStr === undefined) {
        return fail('transfer-in: handle, endpoint and length required');
      }
      const length = parseIntArg(lengthStr, 'length');
      if (length > MAX_USB_TRANSFER_BYTES) return fail('transfer-in length exceeds 4 MiB limit');
      const r = await backend.transferIn(handle, parseIntArg(epStr, 'endpoint'), length);
      return emitIn(r.bytes, raw);
    }
    case 'transfer-out': {
      const [, handle, epStr] = positionals;
      if (!handle || epStr === undefined) return fail('transfer-out: handle and endpoint required');
      const bytes = stdinBytes(ctx);
      if (bytes.length > MAX_USB_TRANSFER_BYTES)
        return fail('transfer-out payload exceeds 4 MiB limit');
      const r = await backend.transferOut(handle, parseIntArg(epStr, 'endpoint'), bytes);
      return ok(`${r.bytesWritten} bytes written\n`);
    }
    default:
      return fail(`unknown subcommand '${sub ?? ''}'. Try 'usb --help'.`);
  }
}

export function createUsbCommand(): Command {
  return defineCommand('usb', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return ok(HELP);
    }
    const backend = resolveUsbBackend(hasLocalDom(), getPanelRpcClient());
    if (!backend) {
      return fail('WebUSB is unavailable in this environment');
    }
    try {
      return await dispatch(args, ctx as UsbCtx, backend);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/cancelled|NotFoundError|No device selected/i.test(message)) {
        return fail('user cancelled or no device selected');
      }
      return fail(message);
    }
  });
}
