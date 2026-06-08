import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHidCommand,
  parseHidArgs,
  parseHidFilters,
  parseIntArg,
} from '../../../src/shell/supplemental-commands/hid-command.js';

const INFO = {
  handle: 'hid1',
  vendorId: 0x046d,
  productId: 0xc31c,
  productName: 'USB Keyboard',
  opened: false,
};

function cannedResult(op: string, payload?: unknown): unknown {
  switch (op) {
    case 'hid-list':
      return { devices: [INFO] };
    case 'hid-request': {
      const filters = (payload as { filters?: Array<Record<string, number>> } | undefined)?.filters;
      // Mimic a multi-interface device: when no filter narrows the
      // pick we return two distinct interfaces sharing one vid/pid.
      if (!filters || filters.length === 0 || filters[0]?.vendorId === undefined) {
        return { devices: [INFO] };
      }
      return { devices: [INFO] };
    }
    case 'hid-device-info':
      return { device: INFO };
    case 'hid-receive-feature-report':
      return { reportId: 3, bytes: new Uint8Array([0xaa, 0xbb]).buffer };
    default:
      return { done: true };
  }
}

interface RpcCall {
  op: string;
  payload: unknown;
  opts?: { timeoutMs?: number };
}

function installMockRpc(): {
  calls: RpcCall[];
  call: ReturnType<typeof vi.fn>;
  fireEvent: (channel: string, payload: unknown) => void;
} {
  const calls: RpcCall[] = [];
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const call = vi.fn(async (op: string, payload: unknown, opts?: { timeoutMs?: number }) => {
    calls.push({ op, payload, opts });
    return cannedResult(op, payload);
  });
  const onEvent = (channel: string, handler: (payload: unknown) => void) => {
    let set = handlers.get(channel);
    if (!set) {
      set = new Set();
      handlers.set(channel, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  };
  const fireEvent = (channel: string, payload: unknown) => {
    for (const h of handlers.get(channel) ?? []) h(payload);
  };
  (globalThis as any).__slicc_panelRpc = { call, onEvent, dispose: vi.fn() };
  return { calls, call, fireEvent };
}

function ctx(stdin = '', signal?: AbortSignal) {
  return { stdin, cwd: '/workspace', fs: {}, signal } as any;
}

describe('hid command — arg parsing', () => {
  it('splits positionals, value-flags, and bool flags', () => {
    const parsed = parseHidArgs(['request', '--vid', '0x046d', '--raw']);
    expect(parsed.positionals).toEqual(['request']);
    expect(parsed.flags.get('--vid')).toBe('0x046d');
    expect(parsed.bools.has('--raw')).toBe(true);
  });

  it('parses hex and decimal integers, rejecting garbage', () => {
    expect(parseIntArg('0x046d', 'vid')).toBe(0x046d);
    expect(parseIntArg('64', 'len')).toBe(64);
    expect(() => parseIntArg('nope', 'vid')).toThrow(/invalid vid/);
  });

  it('builds filters from vid/pid/usage flags', () => {
    const flags = new Map([
      ['--vid', '0x046d'],
      ['--pid', '0xc31c'],
      ['--usage-page', '1'],
      ['--usage', '6'],
    ]);
    expect(parseHidFilters(flags)).toEqual([
      { vendorId: 0x046d, productId: 0xc31c, usagePage: 1, usage: 6 },
    ]);
  });

  it('returns an empty filter list when no filter flags are given', () => {
    expect(parseHidFilters(new Map())).toEqual([]);
  });
});

describe('hid command — help', () => {
  it('prints help with no args', async () => {
    const result = await createHidCommand().execute([], ctx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hid - access HID devices');
    expect(result.stdout).toContain('watch');
    expect(result.stdout).toContain('query');
  });

  it('prints help with --help and -h', async () => {
    for (const flag of ['--help', '-h']) {
      const result = await createHidCommand().execute([flag], ctx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: hid');
    }
  });
});

describe('hid command — bridged panel-rpc envelopes', () => {
  let calls: RpcCall[];
  let fireEvent: (channel: string, payload: unknown) => void;

  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    ({ calls, fireEvent } = installMockRpc());
  });

  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('list → hid-list and renders a device row', async () => {
    const result = await createHidCommand().execute(['list'], ctx());
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toMatchObject({ op: 'hid-list', payload: undefined });
    expect(result.stdout).toContain('hid1');
    expect(result.stdout).toContain('0x046d');
  });

  it('request → hid-request with parsed filters and a long timeout', async () => {
    const result = await createHidCommand().execute(['request', '--vid', '0x046d'], ctx());
    expect(result.exitCode).toBe(0);
    expect(calls[0].op).toBe('hid-request');
    expect(calls[0].payload).toEqual({ filters: [{ vendorId: 0x046d }] });
    expect(calls[0].opts?.timeoutMs).toBeGreaterThan(60_000);
    expect(result.stdout).toContain('hid1');
  });

  it('request with --__resolved fetches info instead of prompting', async () => {
    await createHidCommand().execute(['request', '--__resolved', 'hid1'], ctx());
    expect(calls[0]).toMatchObject({ op: 'hid-device-info', payload: { handle: 'hid1' } });
  });

  it('request with --__resolved <h1,h2,h3> renders every gesture-acquired interface', async () => {
    // RemoteTerminalView's gesture bridge registers every granted
    // interface and forwards them all on the rewrite. The worker must
    // render each one — losing siblings hides the raw-HID 0xFF60
    // interface on a VIA/QMK keyboard.
    const INFOS: Record<string, Record<string, unknown>> = {
      hid1: {
        handle: 'hid1',
        vendorId: 0x320f,
        productId: 0x5000,
        productName: 'Keychron Q1',
        opened: false,
        usagePage: 1,
        usage: 6,
      },
      hid2: {
        handle: 'hid2',
        vendorId: 0x320f,
        productId: 0x5000,
        productName: 'Keychron Q1',
        opened: false,
        usagePage: 0x0c,
        usage: 1,
      },
      hid3: {
        handle: 'hid3',
        vendorId: 0x320f,
        productId: 0x5000,
        productName: 'Keychron Q1',
        opened: false,
        usagePage: 0xff60,
        usage: 0x61,
      },
    };
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn(async (op: string, payload: unknown) => {
        if (op === 'hid-device-info') {
          const handle = (payload as { handle: string }).handle;
          return { device: INFOS[handle] };
        }
        return { done: true };
      }),
      onEvent: (_c: string, _h: (p: unknown) => void) => () => {},
      dispose: vi.fn(),
    };
    const result = await createHidCommand().execute(
      ['request', '--__resolved', 'hid1,hid2,hid3', '--usage-page', '0xff60'],
      ctx()
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    // --usage-page 0xff60 reorders the raw-HID interface to the top.
    expect(lines[0]).toContain('hid3');
    expect(lines[0]).toContain('0xff60');
  });

  it('open and close forward the handle', async () => {
    await createHidCommand().execute(['open', 'hid1'], ctx());
    await createHidCommand().execute(['close', 'hid1'], ctx());
    expect(calls[0]).toMatchObject({ op: 'hid-open', payload: { handle: 'hid1' } });
    expect(calls[1]).toMatchObject({ op: 'hid-close', payload: { handle: 'hid1' } });
  });

  it('send reads stdin bytes into an output report', async () => {
    const result = await createHidCommand().execute(['send', 'hid1', '0'], ctx('\x00\xff'));
    expect(result.exitCode).toBe(0);
    expect(calls[0].op).toBe('hid-send-report');
    const payload = calls[0].payload as { handle: string; reportId: number; bytes: ArrayBuffer };
    expect(payload.handle).toBe('hid1');
    expect(payload.reportId).toBe(0);
    expect(new Uint8Array(payload.bytes)).toEqual(new Uint8Array([0x00, 0xff]));
  });

  it('feature-send forwards the report id and stdin bytes', async () => {
    await createHidCommand().execute(['feature-send', 'hid1', '5'], ctx('\x01\x02'));
    expect(calls[0].op).toBe('hid-send-feature-report');
    const payload = calls[0].payload as { reportId: number; bytes: ArrayBuffer };
    expect(payload.reportId).toBe(5);
    expect(new Uint8Array(payload.bytes)).toEqual(new Uint8Array([0x01, 0x02]));
  });

  it('feature-get hex-dumps by default and emits raw bytes with --raw', async () => {
    const hex = await createHidCommand().execute(['feature-get', 'hid1', '3'], ctx());
    expect(calls[0]).toMatchObject({
      op: 'hid-receive-feature-report',
      payload: { handle: 'hid1', reportId: 3 },
    });
    expect(hex.stdout.trim()).toBe('aa bb');
    const raw = await createHidCommand().execute(['feature-get', 'hid1', '3', '--raw'], ctx());
    expect(raw.stdout).toBe('\xaa\xbb');
  });

  it('query resolves with the first input report and unsubscribes', async () => {
    const promise = createHidCommand().execute(['query', 'hid1', '0'], ctx('\x01'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent('hid-input-report', {
      handle: 'hid1',
      reportId: 4,
      bytes: new Uint8Array([0xfe, 0xed]).buffer,
    });
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('04 fe ed\n');
    expect(calls.some((c) => c.op === 'hid-subscribe-input-reports')).toBe(true);
    expect(calls.some((c) => c.op === 'hid-send-report')).toBe(true);
    expect(calls.some((c) => c.op === 'hid-unsubscribe-input-reports')).toBe(true);
  });

  it('query times out with a non-zero exit and still unsubscribes', async () => {
    const result = await createHidCommand().execute(
      ['query', 'hid1', '0', '--timeout', '5'],
      ctx('\x01')
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no input report within 5ms');
    expect(calls.some((c) => c.op === 'hid-unsubscribe-input-reports')).toBe(true);
  });

  it('query honors --raw and emits raw bytes on success', async () => {
    const promise = createHidCommand().execute(['query', 'hid1', '0', '--raw'], ctx('\x01'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent('hid-input-report', {
      handle: 'hid1',
      reportId: 7,
      bytes: new Uint8Array([0xaa, 0xbb]).buffer,
    });
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('\xaa\xbb');
    expect(calls.some((c) => c.op === 'hid-unsubscribe-input-reports')).toBe(true);
  });

  it('watch subscribes, accumulates fired reports for the handle, and unsubscribes on abort', async () => {
    const controller = new AbortController();
    const promise = createHidCommand().execute(['watch', 'hid1'], ctx('', controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent('hid-input-report', {
      handle: 'hid1',
      reportId: 1,
      bytes: new Uint8Array([0xde, 0xad]).buffer,
    });
    fireEvent('hid-input-report', {
      handle: 'hid1',
      reportId: 2,
      bytes: new Uint8Array([0xbe, 0xef]).buffer,
    });
    // A report for a different handle must be ignored.
    fireEvent('hid-input-report', {
      handle: 'hid2',
      reportId: 9,
      bytes: new Uint8Array([0x00]).buffer,
    });
    controller.abort();
    const result = await promise;
    expect(calls.some((c) => c.op === 'hid-subscribe-input-reports')).toBe(true);
    expect(calls.some((c) => c.op === 'hid-unsubscribe-input-reports')).toBe(true);
    expect(result.stdout).toBe('01 de ad\n02 be ef\n');
  });
});

describe('hid command — multi-interface request', () => {
  let calls: RpcCall[];
  let cannedRequest: unknown;

  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
    calls = [];
    cannedRequest = { devices: [INFO] };
    const onEvent = (_c: string, _h: (p: unknown) => void) => () => {};
    const call = vi.fn(async (op: string, payload: unknown, opts?: { timeoutMs?: number }) => {
      calls.push({ op, payload, opts });
      if (op === 'hid-request') return cannedRequest;
      if (op === 'hid-list') {
        return { devices: (cannedRequest as { devices: unknown[] }).devices };
      }
      if (op === 'hid-device-info') return { device: INFO };
      return { done: true };
    });
    (globalThis as any).__slicc_panelRpc = { call, onEvent, dispose: vi.fn() };
  });

  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('prints every granted interface with usage page on multi-interface grant', async () => {
    cannedRequest = {
      devices: [
        {
          handle: 'hid1',
          vendorId: 0x320f,
          productId: 0x5000,
          opened: false,
          usagePage: 1,
          usage: 6,
        },
        {
          handle: 'hid2',
          vendorId: 0x320f,
          productId: 0x5000,
          opened: false,
          usagePage: 0x0c,
          usage: 1,
        },
        {
          handle: 'hid3',
          vendorId: 0x320f,
          productId: 0x5000,
          opened: false,
          usagePage: 0xff60,
          usage: 0x61,
        },
      ],
    };
    const result = await createHidCommand().execute(['request', '--vid', '0x320f'], ctx());
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('hid1');
    expect(lines[2]).toContain('hid3');
    expect(lines[2]).toContain('0xff60');
  });

  it('reorders the matching --usage-page interface to the top', async () => {
    cannedRequest = {
      devices: [
        {
          handle: 'hid1',
          vendorId: 0x320f,
          productId: 0x5000,
          opened: false,
          usagePage: 1,
          usage: 6,
        },
        {
          handle: 'hid3',
          vendorId: 0x320f,
          productId: 0x5000,
          opened: false,
          usagePage: 0xff60,
          usage: 0x61,
        },
      ],
    };
    const result = await createHidCommand().execute(
      ['request', '--vid', '0x320f', '--usage-page', '0xff60'],
      ctx()
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toContain('hid3');
    expect(lines[0]).toContain('0xff60');
  });
});

describe('hid command — error paths', () => {
  beforeEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });
  afterEach(() => {
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('reports an unavailable environment when no backend exists', async () => {
    delete (globalThis as any).__slicc_panelRpc;
    const result = await createHidCommand().execute(['list'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('WebHID is unavailable');
  });

  it('surfaces an invalid-handle error from the bridge', async () => {
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn().mockRejectedValue(new Error("unknown hid handle 'hidX'")),
      onEvent: vi.fn(() => () => {}),
      dispose: vi.fn(),
    };
    const result = await createHidCommand().execute(['open', 'hidX'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown hid handle 'hidX'");
  });

  it('maps a rejected picker to a cancellation message', async () => {
    const err = new Error('No device selected.');
    err.name = 'NotFoundError';
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn().mockRejectedValue(err),
      onEvent: vi.fn(() => () => {}),
      dispose: vi.fn(),
    };
    const result = await createHidCommand().execute(['request'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cancelled');
  });

  it('rejects a subcommand missing its required arguments', async () => {
    installMockRpc();
    const result = await createHidCommand().execute(['send', 'hid1'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('report-id required');
  });

  it('rejects an unknown subcommand', async () => {
    installMockRpc();
    const result = await createHidCommand().execute(['frobnicate'], ctx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });
});
