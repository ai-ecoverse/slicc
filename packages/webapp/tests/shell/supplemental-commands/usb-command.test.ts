import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createUsbCommand,
  parseControlSetup,
  parseIntArg,
  parseUsbArgs,
  parseUsbFilters,
} from '../../../src/shell/supplemental-commands/usb-command.js';

const INFO = {
  handle: 'usb1',
  vendorId: 0x2e8a,
  productId: 0x0003,
  productName: 'RP2040',
  manufacturerName: 'Raspberry Pi',
  serialNumber: 'ABC123',
  opened: false,
};

function cannedResult(op: string): unknown {
  switch (op) {
    case 'usb-list':
      return { devices: [INFO] };
    case 'usb-request':
    case 'usb-device-info':
      return { device: INFO };
    case 'usb-transfer-in':
    case 'usb-control-transfer-in':
      return { status: 'ok', bytes: new Uint8Array([0xaa, 0xbb]).buffer };
    case 'usb-transfer-out':
    case 'usb-control-transfer-out':
      return { status: 'ok', bytesWritten: 2 };
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

describe('usb command — arg parsing', () => {
  it('splits positionals, value-flags, and bool flags', () => {
    const parsed = parseUsbArgs(['request', '--vid', '0x2e8a', '--raw']);
    expect(parsed.positionals).toEqual(['request']);
    expect(parsed.flags.get('--vid')).toBe('0x2e8a');
    expect(parsed.bools.has('--raw')).toBe(true);
  });

  it('parses hex and decimal integers, rejecting garbage', () => {
    expect(parseIntArg('0x2e8a', 'vid')).toBe(0x2e8a);
    expect(parseIntArg('64', 'len')).toBe(64);
    expect(() => parseIntArg('nope', 'vid')).toThrow(/invalid vid/);
  });

  it('builds filters from vid/pid/class flags', () => {
    const flags = new Map([
      ['--vid', '0x2e8a'],
      ['--pid', '0x0003'],
      ['--class', '3'],
    ]);
    expect(parseUsbFilters(flags)).toEqual([{ vendorId: 0x2e8a, productId: 0x0003, classCode: 3 }]);
  });

  it('returns an empty filter list when no filter flags are given', () => {
    expect(parseUsbFilters(new Map())).toEqual([]);
  });

  it('parses control setup with defaults and validates enums', () => {
    expect(parseControlSetup(new Map())).toEqual({
      requestType: 'vendor',
      recipient: 'device',
      request: 0,
      value: 0,
      index: 0,
    });
    expect(() => parseControlSetup(new Map([['--request-type', 'bogus']]))).toThrow(
      /invalid --request-type/
    );
  });
});

describe('usb command — help', () => {
  it('prints help with no args', async () => {
    const result = await createUsbCommand().execute([], ctx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usb - access USB devices');
    expect(result.stdout).toContain('transfer-in');
  });

  it('prints help with --help and -h', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await createUsbCommand().execute([flag], ctx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: usb');
    }
  });
});

describe('usb command — bridged panel-rpc envelopes', () => {
  let calls: RpcCall[];

  beforeEach(() => {
    // No DOM in the node test realm → command picks the bridged backend.
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    ({ calls } = installMockRpc());
  });

  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('list → usb-list and renders a device row', async () => {
    const result = await createUsbCommand().execute(['list'], ctx());
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toMatchObject({ op: 'usb-list', payload: undefined });
    expect(result.stdout).toContain('usb1');
    expect(result.stdout).toContain('0x2e8a');
  });

  it('request → usb-request with parsed filters and a long timeout', async () => {
    const result = await createUsbCommand().execute(['request', '--vid', '0x2e8a'], ctx());
    expect(result.exitCode).toBe(0);
    expect(calls[0].op).toBe('usb-request');
    expect(calls[0].payload).toEqual({ filters: [{ vendorId: 0x2e8a }] });
    expect(calls[0].opts?.timeoutMs).toBeGreaterThan(60_000);
    expect(result.stdout).toContain('usb1');
  });

  it('request with --__resolved fetches info instead of prompting', async () => {
    await createUsbCommand().execute(['request', '--__resolved', 'usb1'], ctx());
    expect(calls[0]).toMatchObject({ op: 'usb-device-info', payload: { handle: 'usb1' } });
  });

  it('open/close/reset send the handle', async () => {
    await createUsbCommand().execute(['open', 'usb1'], ctx());
    await createUsbCommand().execute(['close', 'usb1'], ctx());
    await createUsbCommand().execute(['reset', 'usb1'], ctx());
    expect(calls.map((c) => c.op)).toEqual(['usb-open', 'usb-close', 'usb-reset']);
    expect(calls[0].payload).toEqual({ handle: 'usb1' });
  });

  it('claim and select-config carry numeric args', async () => {
    await createUsbCommand().execute(['claim', 'usb1', '0'], ctx());
    await createUsbCommand().execute(['select-config', 'usb1', '1'], ctx());
    expect(calls[0]).toMatchObject({
      op: 'usb-claim-interface',
      payload: { handle: 'usb1', interfaceNumber: 0 },
    });
    expect(calls[1]).toMatchObject({
      op: 'usb-select-configuration',
      payload: { handle: 'usb1', configurationValue: 1 },
    });
  });

  it('transfer-in → usb-transfer-in and renders hex by default', async () => {
    const result = await createUsbCommand().execute(['transfer-in', 'usb1', '1', '64'], ctx());
    expect(calls[0]).toMatchObject({
      op: 'usb-transfer-in',
      payload: { handle: 'usb1', endpointNumber: 1, length: 64 },
    });
    expect(result.stdout.trim()).toBe('aa bb');
  });

  it('transfer-in --raw emits raw bytes', async () => {
    const result = await createUsbCommand().execute(
      ['transfer-in', 'usb1', '1', '64', '--raw'],
      ctx()
    );
    expect(result.stdout).toBe('\xaa\xbb');
  });

  it('transfer-out reads stdin bytes into an ArrayBuffer', async () => {
    const result = await createUsbCommand().execute(['transfer-out', 'usb1', '1'], ctx('\xaa\xbb'));
    expect(result.exitCode).toBe(0);
    expect(calls[0].op).toBe('usb-transfer-out');
    const payload = calls[0].payload as { endpointNumber: number; bytes: ArrayBuffer };
    expect(payload.endpointNumber).toBe(1);
    expect(new Uint8Array(payload.bytes)).toEqual(new Uint8Array([0xaa, 0xbb]));
    expect(result.stdout).toContain('2 bytes written');
  });

  it('control-in passes a setup packet from flags', async () => {
    await createUsbCommand().execute(
      ['control-in', 'usb1', '8', '--request', '6', '--value', '0x0100'],
      ctx()
    );
    expect(calls[0].op).toBe('usb-control-transfer-in');
    expect(calls[0].payload).toMatchObject({
      handle: 'usb1',
      length: 8,
      setup: { requestType: 'vendor', recipient: 'device', request: 6, value: 0x0100, index: 0 },
    });
  });
});

describe('usb command — error paths', () => {
  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });
  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('reports an unavailable environment when no backend exists', async () => {
    delete (globalThis as any).__slicc_panelRpc;
    const result = await createUsbCommand().execute(['list'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('WebUSB is unavailable');
  });

  it('surfaces an invalid-handle error from the bridge', async () => {
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn().mockRejectedValue(new Error("unknown usb handle 'usbX'")),
      dispose: vi.fn(),
    };
    const result = await createUsbCommand().execute(['open', 'usbX'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown usb handle 'usbX'");
  });

  it('maps a rejected picker to a cancellation message', async () => {
    const err = new Error('No device selected.');
    err.name = 'NotFoundError';
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn().mockRejectedValue(err),
      dispose: vi.fn(),
    };
    const result = await createUsbCommand().execute(['request', '--vid', '0x2e8a'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cancelled');
  });

  it('rejects transfers above the 4 MiB cap before calling the bridge', async () => {
    const { calls } = installMockRpc();
    const result = await createUsbCommand().execute(
      ['transfer-in', 'usb1', '1', String(5 * 1024 * 1024)],
      ctx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('4 MiB');
    expect(calls).toHaveLength(0);
  });

  it('rejects an unknown subcommand', async () => {
    installMockRpc();
    const result = await createUsbCommand().execute(['frobnicate'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });
});
