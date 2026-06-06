import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSerialCommand,
  parseHexBytes,
  parseIntArg,
  parseOpenOptions,
  parseOutputSignals,
  parseReadOptions,
  parseSerialArgs,
  parseSerialFilters,
} from '../../../src/shell/supplemental-commands/serial-command.js';

const INFO = { handle: 'serial1', usbVendorId: 0x2e8a, usbProductId: 0x0005, opened: false };
const SIGNALS = {
  clearToSend: true,
  dataCarrierDetect: false,
  dataSetReady: true,
  ringIndicator: false,
};

function cannedResult(op: string): unknown {
  switch (op) {
    case 'serial-list':
      return { devices: [INFO] };
    case 'serial-request':
    case 'serial-device-info':
      return { device: INFO };
    case 'serial-read':
      return { bytes: new Uint8Array([0x3e, 0x3e, 0x3e]).buffer };
    case 'serial-write':
      return { bytesWritten: 3 };
    case 'serial-get-signals':
      return { signals: SIGNALS };
    default:
      return { done: true };
  }
}

interface RpcCall {
  op: string;
  payload: unknown;
  opts?: { timeoutMs?: number };
}

function installMockRpc(): { calls: RpcCall[]; call: ReturnType<typeof vi.fn> } {
  const calls: RpcCall[] = [];
  const call = vi.fn(async (op: string, payload: unknown, opts?: { timeoutMs?: number }) => {
    calls.push({ op, payload, opts });
    return cannedResult(op);
  });
  (globalThis as any).__slicc_panelRpc = { call, dispose: vi.fn() };
  return { calls, call };
}

function ctx(stdin = '') {
  return { stdin, cwd: '/workspace', fs: {} } as any;
}

describe('serial command — arg parsing', () => {
  it('splits positionals, value-flags, and bool flags', () => {
    const parsed = parseSerialArgs(['read', 'serial1', '--bytes', '256', '--hex']);
    expect(parsed.positionals).toEqual(['read', 'serial1']);
    expect(parsed.flags.get('--bytes')).toBe('256');
    expect(parsed.bools.has('--hex')).toBe(true);
  });

  it('parses hex and decimal integers, rejecting garbage', () => {
    expect(parseIntArg('0x2e8a', 'vid')).toBe(0x2e8a);
    expect(parseIntArg('115200', 'baud')).toBe(115200);
    expect(() => parseIntArg('nope', 'baud')).toThrow(/invalid baud/);
  });

  it('parses hex byte strings in several notations', () => {
    expect(parseHexBytes('3e3e3e')).toEqual(new Uint8Array([0x3e, 0x3e, 0x3e]));
    expect(parseHexBytes('0x0d 0x0a')).toEqual(new Uint8Array([0x0d, 0x0a]));
    expect(parseHexBytes('')).toEqual(new Uint8Array(0));
    expect(() => parseHexBytes('xyz')).toThrow(/invalid hex/);
  });

  it('builds filters from vid/pid flags', () => {
    const flags = new Map([
      ['--vid', '0x2e8a'],
      ['--pid', '0x0005'],
    ]);
    expect(parseSerialFilters(flags)).toEqual([{ usbVendorId: 0x2e8a, usbProductId: 0x0005 }]);
    expect(parseSerialFilters(new Map())).toEqual([]);
  });

  it('builds open options with a baud default and validates enums', () => {
    expect(parseOpenOptions(new Map())).toEqual({ baudRate: 9600 });
    expect(parseOpenOptions(new Map([['--baud', '115200']]))).toEqual({ baudRate: 115200 });
    expect(() => parseOpenOptions(new Map([['--parity', 'bogus']]))).toThrow(/invalid --parity/);
  });

  it('builds read options and output signals from flags', () => {
    expect(parseReadOptions(new Map([['--timeout-ms', '500']]))).toMatchObject({ timeoutMs: 500 });
    expect(parseOutputSignals(new Map([['--dtr', 'on']]))).toEqual({ dataTerminalReady: true });
    expect(() => parseOutputSignals(new Map([['--rts', 'maybe']]))).toThrow(/invalid rts/);
  });
});

describe('serial command — help', () => {
  it('prints help with no args and with flags', async () => {
    const noArgs = await createSerialCommand().execute([], ctx());
    expect(noArgs.exitCode).toBe(0);
    expect(noArgs.stdout).toContain('serial - access serial ports');
    for (const flag of ['--help', '-h']) {
      const result = await createSerialCommand().execute([flag], ctx());
      expect(result.stdout).toContain('Usage: serial');
    }
  });
});

describe('serial command — bridged panel-rpc envelopes', () => {
  let calls: RpcCall[];

  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    ({ calls } = installMockRpc());
  });

  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('list → serial-list and renders a port row', async () => {
    const result = await createSerialCommand().execute(['list'], ctx());
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toMatchObject({ op: 'serial-list', payload: undefined });
    expect(result.stdout).toContain('serial1');
    expect(result.stdout).toContain('0x2e8a');
  });

  it('request → serial-request with parsed filters and a long timeout', async () => {
    const result = await createSerialCommand().execute(['request', '--vid', '0x2e8a'], ctx());
    expect(calls[0].op).toBe('serial-request');
    expect(calls[0].payload).toEqual({ filters: [{ usbVendorId: 0x2e8a }] });
    expect(calls[0].opts?.timeoutMs).toBeGreaterThan(60_000);
    expect(result.stdout).toContain('serial1');
  });

  it('request with --__resolved fetches info instead of prompting', async () => {
    await createSerialCommand().execute(['request', '--__resolved', 'serial1'], ctx());
    expect(calls[0]).toMatchObject({ op: 'serial-device-info', payload: { handle: 'serial1' } });
  });

  it('open carries parsed open options; close sends the handle', async () => {
    await createSerialCommand().execute(['open', 'serial1', '--baud', '115200'], ctx());
    await createSerialCommand().execute(['close', 'serial1'], ctx());
    expect(calls[0]).toMatchObject({
      op: 'serial-open',
      payload: { handle: 'serial1', options: { baudRate: 115200 } },
    });
    expect(calls[1]).toMatchObject({ op: 'serial-close', payload: { handle: 'serial1' } });
  });

  it('read → serial-read and renders raw bytes by default, hex with --hex', async () => {
    const raw = await createSerialCommand().execute(['read', 'serial1'], ctx());
    expect(calls[0].op).toBe('serial-read');
    expect(raw.stdout).toBe('>>>');
    const hex = await createSerialCommand().execute(['read', 'serial1', '--hex'], ctx());
    expect(hex.stdout.trim()).toBe('3e 3e 3e');
  });

  it('read forwards --until as an ArrayBuffer and --timeout-ms', async () => {
    await createSerialCommand().execute(
      ['read', 'serial1', '--until', '0d0a', '--timeout-ms', '500'],
      ctx()
    );
    const payload = calls[0].payload as { until: ArrayBuffer; timeoutMs: number };
    expect(new Uint8Array(payload.until)).toEqual(new Uint8Array([0x0d, 0x0a]));
    expect(payload.timeoutMs).toBe(500);
  });

  it('write reads stdin bytes into an ArrayBuffer', async () => {
    const result = await createSerialCommand().execute(['write', 'serial1'], ctx('\x03\r\n'));
    expect(calls[0].op).toBe('serial-write');
    const payload = calls[0].payload as { handle: string; bytes: ArrayBuffer };
    expect(new Uint8Array(payload.bytes)).toEqual(new Uint8Array([0x03, 0x0d, 0x0a]));
    expect(result.stdout).toContain('3 bytes written');
  });

  it('signals get renders the input signals; set forwards parsed flags', async () => {
    const get = await createSerialCommand().execute(['signals', 'serial1', 'get'], ctx());
    expect(calls[0].op).toBe('serial-get-signals');
    expect(get.stdout).toContain('cts=1');
    expect(get.stdout).toContain('dsr=1');
    await createSerialCommand().execute(['signals', 'serial1', 'set', '--dtr', 'on'], ctx());
    expect(calls[1]).toMatchObject({
      op: 'serial-set-signals',
      payload: { handle: 'serial1', signals: { dataTerminalReady: true } },
    });
  });
});

describe('serial command — error paths', () => {
  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });
  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('reports an unavailable environment when no backend exists', async () => {
    delete (globalThis as any).__slicc_panelRpc;
    const result = await createSerialCommand().execute(['list'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Web Serial is unavailable');
  });

  it('surfaces an invalid-handle error from the bridge', async () => {
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn().mockRejectedValue(new Error("unknown serial handle 'serialX'")),
      dispose: vi.fn(),
    };
    const result = await createSerialCommand().execute(['open', 'serialX'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown serial handle 'serialX'");
  });

  it('maps a rejected picker to a cancellation message', async () => {
    const err = new Error('No port selected.');
    err.name = 'NotFoundError';
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn().mockRejectedValue(err),
      dispose: vi.fn(),
    };
    const result = await createSerialCommand().execute(['request'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cancelled');
  });

  it('rejects a read above the 4 MiB cap before calling the bridge', async () => {
    const { calls } = installMockRpc();
    const result = await createSerialCommand().execute(
      ['read', 'serial1', '--bytes', String(5 * 1024 * 1024)],
      ctx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('4 MiB');
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown subcommand', async () => {
    installMockRpc();
    const result = await createSerialCommand().execute(['frobnicate'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });
});
