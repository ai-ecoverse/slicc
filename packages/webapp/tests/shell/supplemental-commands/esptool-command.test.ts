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
    case 'esptool-read-flash':
      return { bytes: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]).buffer };
    case 'esptool-read-reg':
      return { value: 0xdeadbeef };
    case 'esptool-flash-id':
      return { flashId: 0x164020, manufacturer: 0x20, device: 0x4016, flashSize: '4MB' };
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
      writeFile: vi.fn(async () => undefined),
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
    expect(canonicalSub('read-flash')).toBe('read_flash');
    expect(canonicalSub('read-reg')).toBe('read_reg');
    expect(canonicalSub('flash-id')).toBe('flash_id');
    expect(canonicalSub('erase-region')).toBe('erase_region');
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

  it('read_flash forwards addr/size and writes the returned bytes to the VFS', async () => {
    const c = ctx();
    const result = await createEsptoolCommand().execute(
      ['--port', 'serial1', 'read_flash', '0x1000', '0x4', 'dump.bin'],
      c
    );
    expect(calls[0]).toMatchObject({
      op: 'esptool-read-flash',
      payload: { handle: 'serial1', address: 0x1000, size: 4 },
    });
    expect(c.fs.writeFile).toHaveBeenCalledTimes(1);
    const writeArgs = c.fs.writeFile.mock.calls[0];
    expect(writeArgs[0]).toBe('/workspace/dump.bin');
    expect(writeArgs[1]).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]));
    expect(result.stdout).toContain('Wrote 4 bytes to /workspace/dump.bin');
  });

  it('read_reg prints the value as a zero-padded hex string', async () => {
    const result = await createEsptoolCommand().execute(
      ['--port', 'serial1', 'read_reg', '0x3ff5a000'],
      ctx()
    );
    expect(calls[0]).toMatchObject({
      op: 'esptool-read-reg',
      payload: { handle: 'serial1', address: 0x3ff5a000 },
    });
    expect(result.stdout).toContain('0x3ff5a000 = 0xdeadbeef');
  });

  it('flash_id renders manufacturer / device / detected size', async () => {
    const result = await createEsptoolCommand().execute(['--port', 'serial1', 'flash_id'], ctx());
    expect(calls[0]).toMatchObject({ op: 'esptool-flash-id', payload: { handle: 'serial1' } });
    expect(result.stdout).toContain('Manufacturer: 0x20');
    expect(result.stdout).toContain('Device: 0x4016');
    expect(result.stdout).toContain('Detected flash size: 4MB');
  });

  it('erase_region forwards addr/size', async () => {
    await createEsptoolCommand().execute(
      ['--port', 'serial1', 'erase_region', '0x9000', '0x1000'],
      ctx()
    );
    expect(calls[0]).toMatchObject({
      op: 'esptool-erase-region',
      payload: { handle: 'serial1', address: 0x9000, size: 0x1000 },
    });
  });

  it('run forwards an esptool-run envelope', async () => {
    await createEsptoolCommand().execute(['--port', 'serial1', 'run'], ctx());
    expect(calls[0]).toMatchObject({ op: 'esptool-run', payload: { handle: 'serial1' } });
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

  it('rejects read_flash without all three positionals', async () => {
    installMockRpc();
    const result = await createEsptoolCommand().execute(
      ['--port', 'serial1', 'read_flash', '0x1000', '0x4'],
      ctx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('read_flash');
  });

  it('rejects read_reg without an address', async () => {
    installMockRpc();
    const result = await createEsptoolCommand().execute(['--port', 'serial1', 'read_reg'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('read_reg');
  });

  it('rejects erase_region without addr/size', async () => {
    installMockRpc();
    const result = await createEsptoolCommand().execute(
      ['--port', 'serial1', 'erase_region', '0x9000'],
      ctx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('erase_region');
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
