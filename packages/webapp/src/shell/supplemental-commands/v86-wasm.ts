import { splitPath } from '../../fs/path-utils.js';
import { compileWasmModule } from '../../kernel/realm/wasm-compiler.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { GLOBAL_IPK_ADD, isNodeRuntime } from './shared.js';

export const V86_PINNED_VERSION = __V86_VERSION__;

export const V86_NOT_INSTALLED = `v86 is not installed in node_modules: run \`${GLOBAL_IPK_ADD} v86@${V86_PINNED_VERSION}\` (no network fallback)`;

export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

export interface V86ScreenLayer {
  image_data: { data: Uint8ClampedArray; width: number; height: number };
  screen_x: number;
  screen_y: number;
  buffer_x: number;
  buffer_y: number;
  buffer_width: number;
  buffer_height: number;
}

export interface V86ScreenAdapter {
  set_mode?: (isGraphical: boolean) => void;
  set_size_graphical?: (w: number, h: number, vw: number, vh: number) => void;
  update_buffer?: (layers: V86ScreenLayer[]) => void;
  get_text_screen?: () => string[];
}

export interface V86RelayFetchResponse {
  status: number;
  statusText: string;
  headers: Headers | Record<string, string>;
  redirected: boolean;
  url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface V86NetworkAdapter {
  fetch?: (
    url: string,
    init?: { method?: string; headers?: Headers; body?: Uint8Array }
  ) => Promise<V86RelayFetchResponse>;
}

export interface V86Emulator {
  run(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
  add_listener(event: string, listener: (arg: unknown) => void): void;
  is_running(): boolean;
  save_state(): Promise<ArrayBuffer>;
  restore_state(state: ArrayBuffer): Promise<void>;
  keyboard_send_text(text: string): void;
  keyboard_send_scancodes(codes: number[]): void;
  serial0_send(data: string): void;
  bus: { send(name: string, data?: unknown): void };
  screen_adapter?: V86ScreenAdapter;
  network_adapter?: V86NetworkAdapter;
  v86?: {
    cpu?: {
      devices?: { vga?: { screen_fill_buffer(): void; graphical_mode?: boolean } };
    };
  };
}

export interface V86BootOptions {
  wasm_fn?: (imports: WebAssembly.Imports) => Promise<WebAssembly.Exports>;
  memory_size?: number;
  vga_memory_size?: number;
  autostart?: boolean;
  disable_speaker?: boolean;
  fastboot?: boolean;
  bios?: { buffer: ArrayBuffer };
  vga_bios?: { buffer: ArrayBuffer };
  cdrom?: { buffer: ArrayBuffer };
  hda?: { buffer: ArrayBuffer };
  fda?: { buffer: ArrayBuffer };
  bzimage?: { buffer: ArrayBuffer };
  initrd?: { buffer: ArrayBuffer };
  initial_state?: { buffer: ArrayBuffer };
  cmdline?: string;
  boot_order?: number;
  filesystem?: { baseurl: string };
  net_device?: { type: string; relay_url?: string };
}

export type V86Constructor = new (options: V86BootOptions) => V86Emulator;

export interface V86Module {
  V86: V86Constructor;

  wasmModule: WebAssembly.Module;

  version: string;
}

let v86Promise: Promise<V86Module> | null = null;

export async function getV86Module(
  options: { ipk?: IpkResolutionContext } = {}
): Promise<V86Module> {
  if (!v86Promise) {
    v86Promise = loadV86(options.ipk).catch((err) => {
      v86Promise = null;
      throw err;
    });
  }
  return v86Promise;
}

export const V86_LAYOUT_CANDIDATES: readonly { readonly js: string; readonly wasm: string }[] = [
  { js: 'build/libv86.mjs', wasm: 'build/v86.wasm' },
];

async function findV86Layout(
  pkgDir: string,
  reader: ModuleReader
): Promise<{ jsPath: string; wasmPath: string } | null> {
  for (const { js, wasm } of V86_LAYOUT_CANDIDATES) {
    const jsPath = `${pkgDir}/${js}`;
    const wasmPath = `${pkgDir}/${wasm}`;
    if ((await reader.exists(jsPath)) && (await reader.exists(wasmPath))) {
      return { jsPath, wasmPath };
    }
  }
  return null;
}

export async function tryLoadV86FromNodeModules(
  ipk: IpkResolutionContext
): Promise<{ jsSource: string; wasmBytes: Uint8Array; version: string } | null> {
  let resolved;
  try {
    resolved = await ipkResolve('v86/package.json', ipk.fromDir, ipk.reader);
  } catch {
    return null;
  }
  if (resolved.type !== 'file') return null;
  const layout = await findV86Layout(splitPath(resolved.path).dir, ipk.reader);
  if (!layout) return null;
  try {
    const manifest = await ipk.reader.readFile(resolved.path);
    const version = String(JSON.parse(manifest).version ?? V86_PINNED_VERSION);
    const jsSource = await ipk.reader.readFile(layout.jsPath);
    const wasmBytes = await ipk.readBytes(layout.wasmPath);
    return { jsSource, wasmBytes, version };
  } catch {
    return null;
  }
}

async function loadV86(ipk?: IpkResolutionContext): Promise<V86Module> {
  if (isNodeRuntime()) {
    throw new Error('v86 is not available in Node runtime');
  }
  if (!ipk) throw new Error(V86_NOT_INSTALLED);
  const loaded = await tryLoadV86FromNodeModules(ipk);
  if (!loaded) throw new Error(V86_NOT_INSTALLED);

  // `/* @vite-ignore */` keeps Vite from trying to resolve the runtime

  const blobUrl = URL.createObjectURL(new Blob([loaded.jsSource], { type: 'text/javascript' }));
  let glue: { V86?: V86Constructor; default?: V86Constructor };
  try {
    glue = (await import(/* @vite-ignore */ blobUrl)) as typeof glue;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  const V86 = glue.V86 ?? glue.default;
  if (typeof V86 !== 'function') {
    throw new Error('v86: installed package did not export a V86 constructor');
  }

  const wasmModule = await compileWasmModule(loaded.wasmBytes);
  return { V86, wasmModule, version: loaded.version };
}

export function makeWasmFn(
  wasmModule: WebAssembly.Module
): (imports: WebAssembly.Imports) => Promise<WebAssembly.Exports> {
  return async (imports) => {
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    return instance.exports;
  };
}

export function resetV86ForTests(): void {
  v86Promise = null;
}
