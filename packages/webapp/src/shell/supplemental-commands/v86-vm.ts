import type { V86Emulator, V86ScreenLayer } from './v86-wasm.js';

export const SERIAL_BUFFER_CAP = 256 * 1024;

export const DEFAULT_MEMORY_MIB = 128;
export const MAX_MEMORY_MIB = 512;

export interface VmScreenState {
  mode: 'text' | 'graphical';

  width: number;
  height: number;

  frame: { data: Uint8ClampedArray; width: number; height: number } | null;
}

export interface VmServeState {
  dir: string;
  fps: number;
  timer: ReturnType<typeof setInterval>;
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
  serve: VmServeState | null;

  onScreenChange?: () => void;
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

export function resetVmRegistryForTests(): void {
  for (const record of registry.values()) stopServe(record);
  registry.clear();
}

export function stopServe(record: VmRecord): void {
  if (!record.serve) return;
  clearInterval(record.serve.timer);
  record.serve = null;
}

export function instrumentVm(record: VmRecord): void {
  const { emulator } = record;
  emulator.add_listener('serial0-output-byte', (byte) => {
    record.serial.buffer += String.fromCharCode(byte as number);
    if (record.serial.buffer.length > SERIAL_BUFFER_CAP) {
      record.serial.buffer = record.serial.buffer.slice(-SERIAL_BUFFER_CAP);
    }
  });
  if (emulator.v86?.cpu?.devices?.vga?.graphical_mode) {
    record.screen.mode = 'graphical';
  }

  const adapter = emulator.screen_adapter;
  if (!adapter) return;
  const origSetMode = adapter.set_mode;
  adapter.set_mode = (isGraphical: boolean) => {
    record.screen.mode = isGraphical ? 'graphical' : 'text';
    origSetMode?.call(adapter, isGraphical);
    record.onScreenChange?.();
  };
  const origSetSize = adapter.set_size_graphical;
  adapter.set_size_graphical = (w: number, h: number, vw: number, vh: number) => {
    record.screen.width = w;
    record.screen.height = h;
    record.screen.frame = null;
    origSetSize?.call(adapter, w, h, vw, vh);
    record.onScreenChange?.();
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

export function captureFrame(
  record: VmRecord
): { data: Uint8ClampedArray; width: number; height: number } | null {
  record.emulator.v86?.cpu?.devices?.vga?.screen_fill_buffer();
  const frame = record.screen.frame;
  if (!frame || frame.width === 0 || frame.height === 0) return null;

  return {
    data: new Uint8ClampedArray(frame.data.slice(0, frame.width * frame.height * 4)),
    width: frame.width,
    height: frame.height,
  };
}

export function dumpTextScreen(record: VmRecord): string | null {
  const rows = record.emulator.screen_adapter?.get_text_screen?.();
  if (!rows) return null;
  return rows.map((row) => row.replace(/\s+$/u, '')).join('\n');
}
