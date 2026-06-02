/**
 * `esptool` — flash ESP32 / ESP8266 chips from the shell via esptool-js.
 *
 * Runs in any float: a DOM realm (panel terminal / extension shell) drives
 * esptool-js directly; the kernel worker forwards every op over panel-RPC
 * to the page-side handlers. Ports use the same opaque handles as the
 * `serial` command — pass `--port <handle>` to reuse one, or omit it to
 * open the Web Serial picker (`serial request` flow). Subcommands mirror
 * the Python esptool CLI: `chip_id`, `read_mac`, `erase_flash`,
 * `write_flash <addr> <file>`.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import { getPanelRpcClient, hasLocalDom } from '../../kernel/panel-rpc.js';
import {
  type EsptoolBackend,
  type EsptoolFlashSegment,
  resolveEsptoolBackend,
} from './esptool-backends.js';
import { resolveSerialBackend, type SerialBackend } from './serial-backends.js';
import { parseIntArg, parseSerialFilters } from './serial-command.js';

type EsptoolCtx = Parameters<Parameters<typeof defineCommand>[1]>[1];
type CmdResult = { stdout: string; stderr: string; exitCode: number };

const VALUE_FLAGS = new Set(['--port', '--baud', '--vid', '--pid']);
const DEFAULT_BAUD = 115200;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
}

/** Split argv into positionals, value-flags, and boolean flags. */
export function parseEsptoolArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok.startsWith('-')) {
      if (VALUE_FLAGS.has(tok)) flags.set(tok, args[++i] ?? '');
      else bools.add(tok);
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags, bools };
}

/** Normalize a subcommand to its canonical underscore form. */
export function canonicalSub(sub: string): string {
  const s = sub.replace(/-/g, '_');
  if (s === 'chip_info' || s === 'id') return 'chip_id';
  return s;
}

function ok(stdout: string): CmdResult {
  return { stdout, stderr: '', exitCode: 0 };
}
function fail(message: string): CmdResult {
  return { stdout: '', stderr: `esptool: ${message}\n`, exitCode: 1 };
}

const HELP = `esptool - flash ESP32 / ESP8266 chips via esptool-js

Usage: esptool [--port H] [--baud N] <subcommand> [args]

Subcommands:
  chip_id                       Detect the chip and print its variant + MAC
  read_mac                      Print the factory MAC address
  erase_flash                   Erase the entire flash
  write_flash <addr> <file>...  Flash firmware at <addr> (addr/file pairs)

Options:
  --port H        Use an existing serial handle from 'serial request'
  --baud N        Flash baud rate (default ${DEFAULT_BAUD})
  --vid 0x..      Picker filter when --port is omitted
  --pid 0x..      Picker filter when --port is omitted
  --erase         write_flash: erase the whole chip before writing
  -h, --help

Without --port, the Web Serial picker opens (needs a user gesture).
`;

/** Resolve the serial handle to operate on: explicit --port or the picker. */
async function resolveHandle(flags: Map<string, string>, serial: SerialBackend): Promise<string> {
  const explicit = flags.get('--port');
  if (explicit) return explicit;
  const info = await serial.request(parseSerialFilters(flags));
  return info.handle;
}

/** Read addr/file pairs from `write_flash` positionals into flash segments. */
async function readSegments(
  positionals: string[],
  ctx: EsptoolCtx
): Promise<EsptoolFlashSegment[]> {
  const pairs = positionals.slice(1);
  if (pairs.length === 0 || pairs.length % 2 !== 0) {
    throw new Error('write_flash expects <addr> <file> pairs');
  }
  const segments: EsptoolFlashSegment[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const address = parseIntArg(pairs[i], 'address');
    const path = ctx.fs.resolvePath(ctx.cwd, pairs[i + 1]);
    const data = await ctx.fs.readFileBuffer(path);
    segments.push({ address, data });
  }
  return segments;
}

async function dispatch(
  args: string[],
  ctx: EsptoolCtx,
  esptool: EsptoolBackend,
  serial: SerialBackend
): Promise<CmdResult> {
  const { positionals, flags, bools } = parseEsptoolArgs(args);
  const sub = canonicalSub(positionals[0] ?? '');
  const baud = flags.has('--baud') ? parseIntArg(flags.get('--baud')!, 'baud') : DEFAULT_BAUD;
  const lines: string[] = [];
  const onLine = (line: string) => lines.push(line);

  switch (sub) {
    case 'chip_id': {
      const handle = await resolveHandle(flags, serial);
      const info = await esptool.chipInfo(handle, baud, onLine);
      lines.push(`Chip type: ${info.chip}`);
      lines.push(`Chip description: ${info.description}`);
      lines.push(`Features: ${info.features.join(', ')}`);
      lines.push(`Crystal: ${info.crystalMHz}MHz`);
      lines.push(`MAC: ${info.mac}`);
      return ok(`${lines.join('\n')}\n`);
    }
    case 'read_mac': {
      const handle = await resolveHandle(flags, serial);
      const { mac } = await esptool.readMac(handle, baud, onLine);
      lines.push(`MAC: ${mac}`);
      return ok(`${lines.join('\n')}\n`);
    }
    case 'erase_flash': {
      const handle = await resolveHandle(flags, serial);
      await esptool.eraseFlash(handle, baud, onLine);
      return ok(lines.length ? `${lines.join('\n')}\n` : 'flash erased\n');
    }
    case 'write_flash': {
      const segments = await readSegments(positionals, ctx);
      const handle = await resolveHandle(flags, serial);
      await esptool.flash(handle, baud, bools.has('--erase'), segments, onLine);
      return ok(lines.length ? `${lines.join('\n')}\n` : 'flash written\n');
    }
    default:
      return fail(`unknown subcommand '${positionals[0] ?? ''}'. Try 'esptool --help'.`);
  }
}

export function createEsptoolCommand(): Command {
  return defineCommand('esptool', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return ok(HELP);
    }
    const local = hasLocalDom();
    const rpc = getPanelRpcClient();
    const esptool = resolveEsptoolBackend(local, rpc);
    const serial = resolveSerialBackend(local, rpc);
    if (!esptool || !serial) return fail('Web Serial is unavailable in this environment');
    try {
      return await dispatch(args, ctx as EsptoolCtx, esptool, serial);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/cancelled|NotFoundError|No port selected/i.test(message)) {
        return fail('user cancelled or no port selected');
      }
      return fail(message);
    }
  });
}
