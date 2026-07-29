/**
 * v86 VM registry + instance instrumentation. The registry is
 * module-level state in the kernel worker (modules are singletons per
 * worker, same persistence model as the memoized `ffmpegPromise`) so a
 * VM booted by one `v86 start` invocation is drivable by every later
 * `v86 <sub>` invocation in the session.
 *
 * Each record wraps a live emulator with:
 *  - a capped serial ring buffer (`serial0-output-byte` listener),
 *  - a shadow framebuffer fed by wrapping the DummyScreenAdapter's
 *    per-instance `set_mode` / `set_size_graphical` / `update_buffer`
 *    function properties (plain own props — NOT a get/set-asymmetric
 *    proxy, so wrapping is safe), and
 *  - the ProcessManager pid so `kill` / `/proc` work on VMs.
 */

import type { V86Emulator, V86ScreenLayer } from './v86-wasm.js';

/** Cap on buffered serial output (chars). Oldest data is dropped. */
export const SERIAL_BUFFER_CAP = 256 * 1024;

/** Guest RAM bounds (MiB) — kernel-worker headroom is finite. */
export const DEFAULT_MEMORY_MIB = 128;
export const MAX_MEMORY_MIB = 512;

export interface VmScreenState {
  mode: 'text' | 'graphical';
  /** Graphical dimensions (0 until the guest enters graphical mode). */
  width: number;
  height: number;
  /** Last whole-frame RGBA snapshot reference (view into wasm memory). */
  frame: { data: Uint8ClampedArray; width: number; height: number } | null;
}

export interface VmRecord {
  name: string;
  emulator: V86Emulator;
  engineVersion: string;
  pid: number | null;
  startedAt: number;
  bootArgv: readonly string[];
  serial: { buffer: string };
  screen: VmScreenState;
}

const registry = new Map<string, VmRecord>();

export function getVm(name: string): VmRecord | undefined {
  return registry.get(name);
}

export function listVms(): VmRecord[] {
  return [...registry.values()];
}

export function registerVm(record: VmRecord): void {
  registry.set(record.name, record);
}

export function unregisterVm(name: string): void {
  registry.delete(name);
}

/** Test-only: drop all records without touching the emulators. */
export function resetVmRegistryForTests(): void {
  registry.clear();
}

/**
 * Attach the serial listener and screen-adapter wrappers to a freshly
 * constructed emulator. Must run before `run()` so no output is missed.
 */
export function instrumentVm(record: VmRecord): void {
  const { emulator } = record;
  emulator.add_listener('serial0-output-byte', (byte) => {
    record.serial.buffer += String.fromCharCode(byte as number);
    if (record.serial.buffer.length > SERIAL_BUFFER_CAP) {
      record.serial.buffer = record.serial.buffer.slice(-SERIAL_BUFFER_CAP);
    }
  });

  const adapter = emulator.screen_adapter;
  if (!adapter) return;
  const origSetMode = adapter.set_mode;
  adapter.set_mode = (isGraphical: boolean) => {
    record.screen.mode = isGraphical ? 'graphical' : 'text';
    origSetMode?.call(adapter, isGraphical);
  };
  const origSetSize = adapter.set_size_graphical;
  adapter.set_size_graphical = (w: number, h: number, vw: number, vh: number) => {
    record.screen.width = w;
    record.screen.height = h;
    record.screen.frame = null;
    origSetSize?.call(adapter, w, h, vw, vh);
  };
  const origUpdate = adapter.update_buffer;
  adapter.update_buffer = (layers: V86ScreenLayer[]) => {
    const last = layers[layers.length - 1];
    if (last) {
      record.screen.frame = {
        data: last.image_data.data,
        width: last.image_data.width,
        height: last.image_data.height,
      };
    }
    origUpdate?.call(adapter, layers);
  };
}

/**
 * Snapshot the current graphical frame as an owned RGBA copy. Forces a
 * synchronous VGA flush (`screen_fill_buffer` → wrapped `update_buffer`)
 * so the pixels are current even though the dummy adapter has no
 * animation loop. Returns `null` when no graphical frame exists (VM
 * still in text mode, or guest never drew).
 */
export function captureFrame(
  record: VmRecord
): { data: Uint8ClampedArray; width: number; height: number } | null {
  record.emulator.v86?.cpu?.devices?.vga?.screen_fill_buffer();
  const frame = record.screen.frame;
  if (!frame || frame.width === 0 || frame.height === 0) return null;
  // Copy out of wasm memory — the source view mutates as the guest draws.
  return {
    data: new Uint8ClampedArray(frame.data.slice(0, frame.width * frame.height * 4)),
    width: frame.width,
    height: frame.height,
  };
}

/**
 * Dump the text-mode character grid via the dummy adapter's
 * `get_text_screen`. Trailing per-line whitespace is trimmed.
 */
export function dumpTextScreen(record: VmRecord): string | null {
  const rows = record.emulator.screen_adapter?.get_text_screen?.();
  if (!rows) return null;
  return rows.map((row) => row.replace(/\s+$/u, '')).join('\n');
}
