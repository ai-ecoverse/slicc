import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerV86Computer,
  unregisterV86Computer,
  V86ComputerBackend,
  v86ComputerId,
} from '../../../src/computers/adapters/v86.js';
import { MINIMAL_JPEG } from '../../../src/computers/encode-frame.js';
import {
  ComputerRegistry,
  resetComputerRegistryForTests,
} from '../../../src/computers/registry.js';
import type { VmRecord } from '../../../src/shell/supplemental-commands/v86-vm.js';
import type { V86Emulator } from '../../../src/shell/supplemental-commands/v86-wasm.js';

type FakeEmulator = V86Emulator & {
  busSends: Array<[string, unknown]>;
  running: boolean;
};

function makeFakeEmulator(): FakeEmulator {
  const fake: FakeEmulator = {
    busSends: [],
    running: true,
    run: vi.fn(async () => {
      fake.running = true;
    }),
    stop: vi.fn(async () => {
      fake.running = false;
    }),
    destroy: vi.fn(async () => {}),
    add_listener: vi.fn(),
    is_running: () => fake.running,
    save_state: vi.fn(async () => new ArrayBuffer(0)),
    restore_state: vi.fn(async () => {}),
    keyboard_send_text: vi.fn(),
    keyboard_send_scancodes: vi.fn(),
    serial0_send: vi.fn(),
    bus: {
      send: (name: string, data?: unknown) => {
        fake.busSends.push([name, data]);
      },
    },
    screen_adapter: {
      get_text_screen: () => ['login:           ', 'ok               '],
    },
    v86: {},
  };
  return fake;
}

function makeRecord(overrides: Partial<VmRecord> = {}): {
  emulator: FakeEmulator;
  record: VmRecord;
} {
  const emulator = (overrides.emulator as FakeEmulator | undefined) ?? makeFakeEmulator();
  const record: VmRecord = {
    name: 'vm0',
    engineVersion: 'test',
    pid: 42,
    startedAt: Date.now(),
    bootArgv: ['v86', 'start'],
    serial: { buffer: '' },
    screen: { mode: 'text', width: 0, height: 0, frame: null },
    serve: null,
    ...overrides,
    emulator,
  };
  return { emulator, record };
}

afterEach(() => {
  resetComputerRegistryForTests();
});

describe('V86ComputerBackend', () => {
  it('describes v86:<name> with relative mouse and live/paused state', () => {
    const { emulator, record } = makeRecord();
    const backend = new V86ComputerBackend(record);
    expect(backend.describe()).toMatchObject({
      id: 'v86:vm0',
      kind: 'v86',
      title: 'vm0',
      pid: 42,
      state: 'live',
      capabilities: { mouse: 'relative', text: true, frames: 'poll' },
    });
    emulator.running = false;
    expect(backend.describe().state).toBe('paused');
    expect(v86ComputerId('box')).toBe('v86:box');
  });

  it('refuses screenshot in text mode and dumps the text grid', async () => {
    const { record } = makeRecord();
    const backend = new V86ComputerBackend(record);
    await expect(backend.screenshot({ format: 'jpeg' })).rejects.toThrow(/text mode/);
    expect(await backend.text()).toBe('login:\nok');
  });

  it('encodes a graphical frame as JPEG', async () => {
    const { record } = makeRecord({
      screen: {
        mode: 'graphical',
        width: 2,
        height: 2,
        frame: { data: new Uint8ClampedArray(2 * 2 * 4), width: 2, height: 2 },
      },
    });
    const backend = new V86ComputerBackend(record);
    const shot = await backend.screenshot({ format: 'jpeg' });
    expect(shot).toMatchObject({ mime: 'image/jpeg', width: 2, height: 2, seq: 1 });
    expect(shot.bytes.length).toBeGreaterThan(0);
    expect(shot.bytes[0]).toBe(MINIMAL_JPEG[0]);
    const scaled = await backend.screenshot({ format: 'jpeg', maxWidth: 1 });
    expect(scaled.width).toBe(1);
    expect(scaled.height).toBe(1);
  });

  it('maps relative/absolute mouse, click, and inverted scroll onto the bus', async () => {
    const { emulator, record } = makeRecord();
    const backend = new V86ComputerBackend(record);
    await backend.input([
      { type: 'mousemove', x: 4, y: 2, relative: true },
      { type: 'mousemove', x: 10, y: 8 },
      { type: 'click', button: 3, count: 1, x: 12, y: 9 },
      { type: 'scroll', dx: 1, dy: 3 },
    ]);
    expect(emulator.busSends).toEqual([
      ['mouse-delta', [4, -2]],
      ['mouse-delta', [6, -6]],
      ['mouse-delta', [2, -1]],
      ['mouse-click', [false, false, true]],
      ['mouse-click', [false, false, false]],
      ['mouse-wheel', [1, -3]],
    ]);
  });

  it('sends full, down-only, and up-only scancodes plus typed text', async () => {
    const { emulator, record } = makeRecord();
    const backend = new V86ComputerBackend(record);
    await backend.input([{ type: 'key', keysym: 'ctrl-c' }]);
    expect(emulator.keyboard_send_scancodes).toHaveBeenCalledWith([0x1d, 0x2e, 0xae, 0x9d]);
    await backend.input([{ type: 'key', keysym: 'enter', down: true }]);
    expect(emulator.keyboard_send_scancodes).toHaveBeenCalledWith([0x1c]);
    await backend.input([{ type: 'key', keysym: 'enter', down: false }]);
    expect(emulator.keyboard_send_scancodes).toHaveBeenCalledWith([0x9c]);
    await backend.input([{ type: 'text', text: 'hi' }]);
    expect(emulator.keyboard_send_text).toHaveBeenCalledWith('hi');
    await expect(backend.input([{ type: 'key', keysym: 'not-a-key' }])).rejects.toThrow(
      /unknown keysym/
    );
  });

  it('close() detaches without stopping the guest', async () => {
    const { emulator, record } = makeRecord();
    const backend = new V86ComputerBackend(record);
    await backend.close();
    expect(emulator.stop).not.toHaveBeenCalled();
    expect(emulator.destroy).not.toHaveBeenCalled();
    expect(emulator.is_running()).toBe(true);
  });

  it('registerV86Computer adopts the VM pid; unregister does not power off', async () => {
    const { emulator, record } = makeRecord();
    const registry = new ComputerRegistry(null);
    const desc = registerV86Computer(record, registry);
    expect(desc).toMatchObject({ id: 'v86:vm0', pid: 42 });
    expect(registry.get('v86:vm0')).toBeInstanceOf(V86ComputerBackend);
    unregisterV86Computer('vm0', registry);
    await vi.waitFor(() => {
      expect(registry.get('v86:vm0')).toBeNull();
    });
    expect(emulator.stop).not.toHaveBeenCalled();
    expect(emulator.is_running()).toBe(true);
  });
});
