/**
 * Shared v86 loader. Unlike `ffmpeg-wasm.ts` / `magick-wasm.ts`, NOTHING
 * is statically bundled: both the `libv86.mjs` JS glue and the
 * `v86.wasm` binary come from an ipk-installed `v86` package in the VFS
 * `node_modules`. The glue is materialized as a `blob:` URL and
 * dynamically imported (same pattern as the pyodide core loader in
 * `py-realm-shared.ts`); the wasm bytes compile through the shared
 * `compileWasmModule` host primitive and are handed to the emulator via
 * its `wasm_fn` constructor option, so v86 never fetches anything
 * itself. There is no CDN fallback — uninstalled calls throw the
 * canonical `ipk add` guidance error which the `v86` command surfaces
 * verbatim. ZERO network in the not-installed path.
 *
 * `v86` IS a webapp devDependency, but only so the version pin can be
 * baked from `package.json` (the `__V86_VERSION__` define, same mechanism
 * as the magick / biome / ffmpeg pins) and so the live canary
 * (`tests/shell/supplemental-commands/v86-wasm-live.test.ts`) has a real
 * installed package to probe. No source file may import it — that would
 * drag the ~350 kB glue into the kernel worker's cold-boot graph — and
 * `v86-wasm.test.ts` pins that at the source level. Bumping the
 * devDependency is how the pin moves; the canary then checks the
 * installed package's layout, exports and the internal surfaces
 * `v86-vm.ts` instruments, and the agent skill's `ipk add` line must move
 * with it, so a Renovate bump still gets a human re-verification rather
 * than a silent auto-merge.
 */

import { splitPath } from '../../fs/path-utils.js';
import { compileWasmModule } from '../../kernel/realm/wasm-compiler.js';
import { resolve as ipkResolve, type ModuleReader } from '../ipk/resolver.js';
import { GLOBAL_IPK_ADD, isNodeRuntime } from './shared.js';

/**
 * The npm `v86` release the command is pinned to — the exact webapp
 * devDependency, baked in at build time so the install guidance and the
 * package the canary verifies can never disagree (it used to be a source
 * literal edited by hand alongside every bump).
 *
 * There is deliberately no `assertMagickVersionMatch`-style guard on the
 * version an ipk install actually carries. magick needs one because its
 * glue is bundled here while its wasm comes from the VFS, so a bare
 * `ipk add` mixes two releases and emscripten hangs for 30 s. v86 ships
 * glue and wasm in the same tarball, so whatever is installed is
 * self-consistent and boots. The only exposure of a drifted install is a
 * release renaming one of the OPTIONAL internals `v86-vm.ts` wraps
 * (`screen_adapter.update_buffer`, `get_text_screen`, ...): those are
 * optional-chained, so `screenshot` / `text` would go empty rather than
 * hang, and `v86 --version` prints the installed release to make that
 * diagnosable.
 */
export const V86_PINNED_VERSION = __V86_VERSION__;

export const V86_NOT_INSTALLED = `v86 is not installed in node_modules: run \`${GLOBAL_IPK_ADD} v86@${V86_PINNED_VERSION}\` (no network fallback)`;

/**
 * Read-only VFS context the loader needs to read an ipk-installed
 * `v86` glue + engine pair (see `V86_LAYOUT_CANDIDATES`). Mirrors the
 * `IpkResolutionContext` shape used by `esbuild-wasm.ts` /
 * `ffmpeg-wasm.ts` so every float wires the loader the same way.
 */
export interface IpkResolutionContext {
  reader: ModuleReader;
  readBytes(absolutePath: string): Promise<Uint8Array>;
  fromDir: string;
}

/** One dirty-rect layer handed to a screen adapter's `update_buffer`. */
export interface V86ScreenLayer {
  image_data: { data: Uint8ClampedArray; width: number; height: number };
  screen_x: number;
  screen_y: number;
  buffer_x: number;
  buffer_y: number;
  buffer_width: number;
  buffer_height: number;
}

/**
 * The subset of the (headless) screen adapter surface the `v86` command
 * instruments. With no `screen.container` option the emulator picks its
 * DummyScreenAdapter, whose methods are per-instance function properties
 * — safe to wrap post-construction (NOT a get/set-asymmetric proxy).
 */
export interface V86ScreenAdapter {
  set_mode?: (isGraphical: boolean) => void;
  set_size_graphical?: (w: number, h: number, vw: number, vh: number) => void;
  update_buffer?: (layers: V86ScreenLayer[]) => void;
  get_text_screen?: () => string[];
}

/**
 * Response shape the fetch-relay network adapter's HTTP handler
 * consumes — the Response-compatible subset it reads before writing
 * the reply back onto the guest's TCP stream.
 */
export interface V86RelayFetchResponse {
  status: number;
  statusText: string;
  headers: Headers | Record<string, string>;
  redirected: boolean;
  url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The fetch-relay network adapter (`net_device.relay_url: "fetch"`).
 * `fetch` is a per-instance own property the constructor sets to the
 * global `fetch` — safe to replace post-construction (NOT a
 * get/set-asymmetric proxy), which is how the `v86` command reroutes
 * guest HTTP through the SLICC fetch proxy.
 */
export interface V86NetworkAdapter {
  fetch?: (
    url: string,
    init?: { method?: string; headers?: Headers; body?: Uint8Array }
  ) => Promise<V86RelayFetchResponse>;
}

/** The subset of the v86 emulator API the command drives. */
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
  /** Pre-compiled engine wasm, threaded into each VM via `wasm_fn`. */
  wasmModule: WebAssembly.Module;
  /** Version string read off the installed package's manifest. */
  version: string;
}

let v86Promise: Promise<V86Module> | null = null;

/**
 * Public entry point. Idempotent across calls within a session — the
 * imported glue + compiled wasm module are shared; each `v86 start`
 * constructs a fresh emulator instance from them.
 */
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

/**
 * Where the glue + engine pair lives inside an ipk-installed `v86`,
 * relative to the package root, in probe order. Explicit so a future
 * layout move is a one-line addition here instead of a silent "not
 * installed" — the failure mode `@imagemagick/magick-wasm` 0.0.43 caused
 * when it moved `magick.wasm` under `dist/x86/` and every
 * filesystem-mocking test stayed green (PR #2744).
 *
 * Surveyed 2026-09-02: every official copy/v86 release on npm — 0.5.10
 * (March 2025) through 0.5.456 — ships `build/libv86.mjs` (the manifest's
 * `main`) next to `build/v86.wasm`. The layout has never moved. The
 * `build/index.js` + `build/v86.wasm` shape of the 2022-2023 `v86` 0.3.x /
 * 0.4.x publications is deliberately NOT a candidate: those were a
 * third-party fork (giulioz/v86-module) with a different API, so
 * resolving them would trade the clean guidance error for a constructor
 * failure one step later. The `-debug` / `-fallback` engine variants that
 * ship alongside are not candidates either; the emulator is always handed
 * the primary build via `wasm_fn`.
 */
export const V86_LAYOUT_CANDIDATES: readonly { readonly js: string; readonly wasm: string }[] = [
  { js: 'build/libv86.mjs', wasm: 'build/v86.wasm' },
];

/**
 * First candidate layout whose glue AND engine both exist under `pkgDir`,
 * or `null` for a partial install / an unknown future layout (the caller
 * turns that into the canonical guidance error).
 */
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

/**
 * Try to read the glue + engine pair (see `V86_LAYOUT_CANDIDATES`) and
 * the manifest version from an ipk-installed `v86` in the VFS. Returns
 * `null` on any resolution / read miss so the caller surfaces the
 * canonical guidance error. Exported so resolution is unit-testable
 * without booting the emulator.
 */
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
    // Node / vitest never boots the emulator — lifecycle tests inject a
    // mock engine via `createV86Command({ engine })`. Surface a clear
    // error if a caller still tries.
    throw new Error('v86 is not available in Node runtime');
  }
  if (!ipk) throw new Error(V86_NOT_INSTALLED);
  const loaded = await tryLoadV86FromNodeModules(ipk);
  if (!loaded) throw new Error(V86_NOT_INSTALLED);

  // Materialize the glue as a blob URL and import it dynamically. The
  // `/* @vite-ignore */` keeps Vite from trying to resolve the runtime
  // URL at build time (same pattern as the pyodide core loader).
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

  // Compile host-side through the shared primitive (same path as
  // biome / esbuild / magick), then hand the module to each emulator
  // via `wasm_fn` so v86 never fetches `v86.wasm` itself.
  const wasmModule = await compileWasmModule(loaded.wasmBytes);
  return { V86, wasmModule, version: loaded.version };
}

/**
 * Build the `wasm_fn` constructor option from the shared pre-compiled
 * module: instantiate per-VM (each VM needs its own memory) and hand
 * back the exports, exactly what v86 expects.
 */
export function makeWasmFn(
  wasmModule: WebAssembly.Module
): (imports: WebAssembly.Imports) => Promise<WebAssembly.Exports> {
  return async (imports) => {
    const instance = await WebAssembly.instantiate(wasmModule, imports);
    return instance.exports;
  };
}

/**
 * Drop the cached module promise so the next `getV86Module` call
 * rebuilds from scratch. Test-only.
 */
export function resetV86ForTests(): void {
  v86Promise = null;
}
