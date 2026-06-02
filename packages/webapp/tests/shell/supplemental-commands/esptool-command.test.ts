import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalSub,
  createEsptoolCommand,
  parseEsptoolArgs,
} from '../../../src/shell/supplemental-commands/esptool-command.js';

const PORT = { handle: 'serial1', usbVendorId: 0x303a, usbProductId: 0x1001, opened: false };
const CHIP = {
  chip: 'ESP32',
  description: 'ESP32-D0WD-V3 (revision v3.0)',
  features: ['Wi-Fi', 'BT'],
  crystalMHz: 40,
  mac: 'aa:bb:cc:dd:ee:ff',
};

interface RpcCall {
  op: string;
  payload: unknown;
  opts?: { timeoutMs?: number };
}

function cannedResult(op: string): unknown {
  switch (op) {
    case 'serial-request':
    case 'serial-device-info':
      return { device: PORT };
    case 'esptool-chip-info':
      return CHIP;
    case 'esptool-read-mac':
      return { mac: CHIP.mac };
    default:
      return { done: true };
  }
}

function installMockRpc(): { calls: RpcCall[]; emit: (payload: unknown) => void } {
  const calls: RpcCall[] = [];
  let progressHandler: ((payload: unknown) => void) | null = null;
  const call = vi.fn(async (op: string, payload: unknown, opts?: { timeoutMs?: number }) => {
    calls.push({ op, payload, opts });
    // Simulate a page-side progress line mid-flash so stdout streaming is covered.
    if (op === 'esptool-flash')
      progressHandler?.({ handle: 'serial1', line: 'Writing at 0x10000... (100%)' });
    return cannedResult(op);
  });
  const onEvent = vi.fn((channel: string, handler: (payload: unknown) => void) => {
    if (channel === 'esptool-progress') progressHandler = handler;
    return () => {
      progressHandler = null;
    };
  });
  (globalThis as any).__slicc_panelRpc = { call, onEvent, dispose: vi.fn() };
  return { calls, emit: (p) => progressHandler?.(p) };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    stdin: '',
    cwd: '/workspace',
    fs: {
      resolvePath: (base: string, p: string) => (p.startsWith('/') ? p : `${base}/${p}`),
      readFileBuffer: vi.fn(async () => new Uint8Array([0xe9, 0x01, 0x02, 0x03])),
    },
    ...overrides,
  } as any;
}

describe('esptool command — arg parsing', () => {
  it('splits positionals, value-flags, and bool flags', () => {
    const parsed = parseEsptoolArgs([
      'write_flash',
      '0x1000',
      'fw.bin',
      '--baud',
      '460800',
      '--erase',
    ]);
    expect(parsed.positionals).toEqual(['write_flash', '0x1000', 'fw.bin']);
    expect(parsed.flags.get('--baud')).toBe('460800');
    expect(parsed.bools.has('--erase')).toBe(true);
  });

  it('canonicalizes subcommand aliases', () => {
    expect(canonicalSub('chip-id')).toBe('chip_id');
    expect(canonicalSub('chip_info')).toBe('chip_id');
    expect(canonicalSub('id')).toBe('chip_id');
    expect(canonicalSub('read-mac')).toBe('read_mac');
    expect(canonicalSub('erase_flash')).toBe('erase_flash');
  });
});

describe('esptool command — help', () => {
  it('prints help with no args and with flags', async () => {
    const noArgs = await createEsptoolCommand().execute([], ctx());
    expect(noArgs.exitCode).toBe(0);
    expect(noArgs.stdout).toContain('esptool - flash ESP32');
    const help = await createEsptoolCommand().execute(['--help'], ctx());
    expect(help.stdout).toContain('Usage: esptool');
  });
});

describe('esptool command — bridged panel-rpc envelopes', () => {
  let calls: RpcCall[];
  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    ({ calls } = installMockRpc());
  });
  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('chip_id with --port skips the picker and renders chip + MAC', async () => {
    const result = await createEsptoolCommand().execute(['--port', 'serial1', 'chip_id'], ctx());
    expect(result.exitCode).toBe(0);
    expect(calls.map((c) => c.op)).toEqual(['esptool-chip-info']);
    expect(calls[0].payload).toEqual({ handle: 'serial1', baudRate: 115200 });
    expect(result.stdout).toContain('Chip type: ESP32');
    expect(result.stdout).toContain('MAC: aa:bb:cc:dd:ee:ff');
  });

  it('chip_id without --port requests a port first', async () => {
    await createEsptoolCommand().execute(['chip_id', '--vid', '0x303a'], ctx());
    expect(calls[0]).toMatchObject({
      op: 'serial-request',
      payload: { filters: [{ usbVendorId: 0x303a }] },
    });
    expect(calls[1]).toMatchObject({ op: 'esptool-chip-info', payload: { handle: 'serial1' } });
  });

  it('read_mac → esptool-read-mac and prints the MAC', async () => {
    const result = await createEsptoolCommand().execute(['--port', 'serial1', 'read_mac'], ctx());
    expect(calls[0].op).toBe('esptool-read-mac');
    expect(result.stdout.trim()).toBe('MAC: aa:bb:cc:dd:ee:ff');
  });

  it('erase_flash → esptool-erase-flash', async () => {
    await createEsptoolCommand().execute(['--port', 'serial1', 'erase_flash'], ctx());
    expect(calls[0]).toMatchObject({ op: 'esptool-erase-flash', payload: { handle: 'serial1' } });
  });

  it('write_flash reads the file, forwards a segment, and streams progress', async () => {
    const c = ctx();
    const result = await createEsptoolCommand().execute(
      ['--port', 'serial1', '--baud', '460800', 'write_flash', '0x1000', 'fw.bin', '--erase'],
      c
    );
    expect(c.fs.readFileBuffer).toHaveBeenCalledWith('/workspace/fw.bin');
    expect(calls[0].op).toBe('esptool-flash');
    const payload = calls[0].payload as {
      handle: string;
      baudRate: number;
      eraseAll: boolean;
      segments: Array<{ address: number; bytes: ArrayBuffer }>;
    };
    expect(payload).toMatchObject({ handle: 'serial1', baudRate: 460800, eraseAll: true });
    expect(payload.segments[0].address).toBe(0x1000);
    expect(new Uint8Array(payload.segments[0].bytes)).toEqual(
      new Uint8Array([0xe9, 0x01, 0x02, 0x03])
    );
    expect(result.stdout).toContain('Writing at 0x10000... (100%)');
  });
});

describe('esptool command — error paths', () => {
  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });
  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('reports an unavailable environment when no backend exists', async () => {
    delete (globalThis as any).__slicc_panelRpc;
    const result = await createEsptoolCommand().execute(['chip_id'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Web Serial is unavailable');
  });

  it('rejects an unknown subcommand', async () => {
    installMockRpc();
    const result = await createEsptoolCommand().execute(['frobnicate'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });

  it('rejects write_flash without addr/file pairs', async () => {
    installMockRpc();
    const result = await createEsptoolCommand().execute(
      ['--port', 'serial1', 'write_flash', '0x1000'],
      ctx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('addr');
  });

  it('maps a rejected picker to a cancellation message', async () => {
    const err = new Error('No port selected.');
    err.name = 'NotFoundError';
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn().mockRejectedValue(err),
      onEvent: vi.fn(() => () => {}),
      dispose: vi.fn(),
    };
    const result = await createEsptoolCommand().execute(['chip_id'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cancelled');
  });
});
