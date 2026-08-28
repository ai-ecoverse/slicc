/**
 * `v86` — run an x86 virtual machine on the v86 wasm engine
 * (copy.sh/v86). Install-gated like `biome` / `esbuild` / `ffmpeg`:
 * both the JS glue and the wasm binary come from an ipk-installed
 * `v86` package (see `v86-wasm.ts`); nothing is bundled and there is
 * no CDN fallback.
 *
 * Interaction model: shell stdin is fully buffered, so the VM cannot
 * be an interactive foreground process. `v86 start` boots the guest
 * as a named background unit in the kernel worker (module-level
 * registry in `v86-vm.ts`), and every later `v86 <sub>` invocation
 * drives that running instance — screenshot → look → type/click →
 * screenshot. The VM registers with the ProcessManager so `ps` sees
 * it and `kill` stops it.
 *
 * BIOS blobs (seabios/vgabios) are NOT in the npm tarball; they are
 * user-supplied VFS files (default `/workspace/.v86/{seabios,vgabios}.bin`,
 * overridable via `-bios` / `-vgabios`). Guest images (ISO / raw disk)
 * are VFS files too.
 */

import type { Command, CommandContext, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { ProcessManager } from '../../kernel/process-manager.js';
import { createProxiedFetch } from '../proxied-fetch.js';
import { scratchDir } from '../tmpdir-env.js';
import { GLOBAL_IPK_ADD } from './shared.js';
import { isHelpRequest, stripOptionTerminator, subcommandHelpText } from './subcommand-help.js';
import {
  captureFrame,
  DEFAULT_MEMORY_MIB,
  dumpTextScreen,
  getVm,
  instrumentVm,
  listVms,
  MAX_MEMORY_MIB,
  registerVm,
  stopServe,
  unregisterVm,
  type VmRecord,
} from './v86-vm.js';
import {
  getV86Module,
  type IpkResolutionContext,
  makeWasmFn,
  tryLoadV86FromNodeModules,
  V86_NOT_INSTALLED,
  V86_PINNED_VERSION,
  type V86Emulator,
  type V86Module,
} from './v86-wasm.js';

type CmdResult = { stdout: string; stderr: string; exitCode: number };

const DEFAULT_VM_NAME = 'vm0';
const DEFAULT_BIOS_DIR = '/workspace/.v86';

/** SVGA/VBE video memory bounds (MiB). v86's Bochs-dispi VBE modes are
 * limited by `vga_memory_size` — 8 MiB covers 1600x1200x32; bigger
 * VESA modes need more. */
export const DEFAULT_VGA_MEMORY_MIB = 8;
export const MAX_VGA_MEMORY_MIB = 64;

const HELP = `v86 - run an x86 virtual machine (v86 wasm engine)

Requires: ${GLOBAL_IPK_ADD} v86@${V86_PINNED_VERSION}

Usage:
  v86 start [boot options]                Boot a VM in the background (prints pid)
  v86 ls                                  List running VMs
  v86 type [-n name] <text>               Type text on the keyboard ('\\n' = Enter)
  v86 key [-n name] <chord> [...]         Send key chords: enter, tab, esc, f1..f12,
                                          ctrl-alt-del, ctrl-c, alt-tab, ...
  v86 mouse [-n name] move <dx> <dy>      Move pointer (relative)
  v86 mouse [-n name] click [left|right|middle] [--double]
  v86 mouse [-n name] --to <x>,<y>        Best-effort absolute positioning
  v86 screenshot [-n name] [<file.png>]   VGA output -> PNG (default /tmp/v86-<name>.png)
  v86 text [-n name]                      Dump text-mode screen as plain text
  v86 serve [-n name] [--fps <1-10>]      Stream the screen into $TMPDIR/v86-serve-<name>/
  v86 serve [-n name] --stop              (viewer index.html + live frames; mint an
                                          iframe-able URL with \`serve <that dir>\`)
  v86 serial [-n name] --send <text>      Write to the guest serial console
  v86 serial [-n name] [--tail <lines>]   Read buffered serial output
  v86 state [-n name] save|load <file>    Save / restore full VM state
  v86 stop [-n name] [--force]            Power off (--force hard-kills)
  v86 --version                           Engine version

Boot options (QEMU-flavored):
  -n, -name <name>    VM name (default: ${DEFAULT_VM_NAME})
  -m <MiB>            Guest RAM (default ${DEFAULT_MEMORY_MIB}, max ${MAX_MEMORY_MIB})
  -cdrom <vfs-path>   ISO image          -hda <vfs-path>   Raw disk image
  -fda <vfs-path>     Floppy image       -boot <a|c|d>     Boot order
  -kernel <path> -initrd <path> -append <cmdline>          Direct Linux boot
  -state <vfs-path>   Resume from a saved state snapshot (.zst ok)
  -fs9p <url>         Attach a 9p network filesystem (guest root=host9p)
  -net <ne2k|virtio>[,relay=fetch]  Guest NIC model (must match a -state
                      snapshot's NIC); relay=fetch answers guest DNS in-engine
                      and routes guest HTTP (port 80) through the SLICC fetch
                      proxy — no gateway needed, https upstream via the proxy
  -vga <MiB>          SVGA/VBE video memory (default ${DEFAULT_VGA_MEMORY_MIB}, max ${MAX_VGA_MEMORY_MIB}) —
                      raise for high-res VESA modes (1080p32 needs ~9)
  -bios <path> -vgabios <path>  BIOS blobs (default ${DEFAULT_BIOS_DIR}/{seabios,vgabios}.bin)
  -nographic          Serial-only guest (skip VGA)

Notes:
  - x86 only, no KVM: expect a fraction of native speed. Small guests
    (Alpine, FreeDOS, Buildroot Linux) work best.
  - The copy.sh Arch Linux image boots via -state + -fs9p; see the v86 skill.
  - BIOS blobs are not bundled; download once:
      mkdir -p ${DEFAULT_BIOS_DIR}
      curl -o ${DEFAULT_BIOS_DIR}/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
      curl -o ${DEFAULT_BIOS_DIR}/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
`;

const BIOS_MISSING_HINT = `v86: BIOS images not found. Download them once:
  mkdir -p ${DEFAULT_BIOS_DIR}
  curl -o ${DEFAULT_BIOS_DIR}/seabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/seabios.bin
  curl -o ${DEFAULT_BIOS_DIR}/vgabios.bin https://raw.githubusercontent.com/copy/v86/master/bios/vgabios.bin
or pass -bios / -vgabios with explicit VFS paths.`;

/** Boot configuration parsed from QEMU-flavored `v86 start` args. */
export interface ParsedStartArgs {
  name: string;
  memoryMib: number;
  vgaMemoryMib: number;
  cdrom?: string;
  hda?: string;
  fda?: string;
  boot?: 'a' | 'c' | 'd';
  kernel?: string;
  initrd?: string;
  append?: string;
  state?: string;
  fs9p?: string;
  net?: 'ne2k' | 'virtio';
  netRelay?: 'fetch';
  bios?: string;
  vgabios?: string;
  nographic: boolean;
}

export type StartParseResult = { ok: true; parsed: ParsedStartArgs } | { ok: false; error: string };

/** Per-flag setters: apply the flag's value or return an error string. */
const START_FLAG_SETTERS: Record<string, (parsed: ParsedStartArgs, v: string) => string | null> = {
  '-n': setVmName,
  '-name': setVmName,
  '--name': setVmName,
  '-m': (parsed, v) => {
    const mib = Number.parseInt(v, 10);
    if (!Number.isFinite(mib) || mib <= 0) return '-m requires a positive MiB value';
    if (mib > MAX_MEMORY_MIB) return `-m ${mib} exceeds the ${MAX_MEMORY_MIB} MiB cap`;
    parsed.memoryMib = mib;
    return null;
  },
  '-vga': (parsed, v) => {
    const mib = Number.parseInt(v, 10);
    if (!Number.isFinite(mib) || mib <= 0) return '-vga requires a positive MiB value';
    if (mib > MAX_VGA_MEMORY_MIB) return `-vga ${mib} exceeds the ${MAX_VGA_MEMORY_MIB} MiB cap`;
    parsed.vgaMemoryMib = mib;
    return null;
  },
  '-cdrom': (parsed, v) => setPath(parsed, 'cdrom', v),
  '-hda': (parsed, v) => setPath(parsed, 'hda', v),
  '-fda': (parsed, v) => setPath(parsed, 'fda', v),
  '-kernel': (parsed, v) => setPath(parsed, 'kernel', v),
  '-initrd': (parsed, v) => setPath(parsed, 'initrd', v),
  '-append': (parsed, v) => setPath(parsed, 'append', v),
  '-bios': (parsed, v) => setPath(parsed, 'bios', v),
  '-vgabios': (parsed, v) => setPath(parsed, 'vgabios', v),
  '-state': (parsed, v) => setPath(parsed, 'state', v),
  '-fs9p': (parsed, v) => {
    if (!/^https?:\/\//u.test(v)) return '-fs9p requires an http(s) base URL';
    parsed.fs9p = v;
    return null;
  },
  '-net': (parsed, v) => {
    const [model, ...opts] = v.split(',');
    if (model !== 'ne2k' && model !== 'virtio') return '-net requires ne2k or virtio';
    for (const opt of opts) {
      if (opt !== 'relay=fetch') return `-net: unknown option '${opt}' (only relay=fetch)`;
      parsed.netRelay = 'fetch';
    }
    parsed.net = model;
    return null;
  },
  '-boot': (parsed, v) => {
    if (v !== 'a' && v !== 'c' && v !== 'd') return '-boot requires a, c, or d';
    parsed.boot = v;
    return null;
  },
};

function setVmName(parsed: ParsedStartArgs, v: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return `invalid VM name '${v}'`;
  parsed.name = v;
  return null;
}

function setPath(
  parsed: ParsedStartArgs,
  key: 'cdrom' | 'hda' | 'fda' | 'kernel' | 'initrd' | 'append' | 'bios' | 'vgabios' | 'state',
  v: string
): null {
  parsed[key] = v;
  return null;
}

/** Parse `v86 start` boot options. Exported for unit tests. */
/**
 * Flags that consume the next token. Passed to `isHelpRequest` so a value
 * that happens to look like a help flag (`-append --help`) stays a value.
 */
const V86_VALUE_FLAGS: readonly string[] = [
  ...Object.keys(START_FLAG_SETTERS),
  '--fps',
  '--tail',
  '--send',
  '--to',
];

export function parseStartArgs(args: readonly string[]): StartParseResult {
  const parsed: ParsedStartArgs = {
    name: DEFAULT_VM_NAME,
    memoryMib: DEFAULT_MEMORY_MIB,
    vgaMemoryMib: DEFAULT_VGA_MEMORY_MIB,
    nographic: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-nographic') {
      parsed.nographic = true;
      continue;
    }
    const setter = Object.hasOwn(START_FLAG_SETTERS, a) ? START_FLAG_SETTERS[a] : undefined;
    if (!setter) return { ok: false, error: `unknown option '${a}'` };
    const v = i + 1 < args.length ? args[i + 1] : null;
    if (v === null) return { ok: false, error: `${a} requires a value` };
    const error = setter(parsed, v);
    if (error) return { ok: false, error };
    i++;
  }
  if (!parsed.cdrom && !parsed.hda && !parsed.fda && !parsed.kernel && !parsed.state) {
    return {
      ok: false,
      error: 'no bootable media (-cdrom, -hda, -fda, -kernel, or -state required)',
    };
  }
  return { ok: true, parsed };
}

// ---------------------------------------------------------------------------
// Key chords
// ---------------------------------------------------------------------------

/** PS/2 set-1 make codes for the named keys used in chords. */
const KEY_CODES: Record<string, number[]> = {
  enter: [0x1c],
  tab: [0x0f],
  esc: [0x01],
  escape: [0x01],
  space: [0x39],
  backspace: [0x0e],
  delete: [0xe0, 0x53],
  up: [0xe0, 0x48],
  down: [0xe0, 0x50],
  left: [0xe0, 0x4b],
  right: [0xe0, 0x4d],
  home: [0xe0, 0x47],
  end: [0xe0, 0x4f],
  pageup: [0xe0, 0x49],
  pagedown: [0xe0, 0x51],
  insert: [0xe0, 0x52],
  f1: [0x3b],
  f2: [0x3c],
  f3: [0x3d],
  f4: [0x3e],
  f5: [0x3f],
  f6: [0x40],
  f7: [0x41],
  f8: [0x42],
  f9: [0x43],
  f10: [0x44],
  f11: [0x57],
  f12: [0x58],
};

const MODIFIER_CODES: Record<string, number[]> = {
  ctrl: [0x1d],
  alt: [0x38],
  shift: [0x2a],
};

/** ASCII → set-1 make code for single-character chord components. */
function charMakeCode(ch: string): number[] | null {
  const row = '1234567890'.indexOf(ch);
  if (row !== -1) return [row === 9 ? 0x0b : 0x02 + row];
  const letters = 'qwertyuiopasdfghjklzxcvbnm';
  const scan = [
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23,
    0x24, 0x25, 0x26, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32,
  ];
  const idx = letters.indexOf(ch.toLowerCase());
  return idx === -1 ? null : [scan[idx]];
}

/**
 * Translate a chord like `ctrl-alt-del`, `alt-tab`, `ctrl-c`, or
 * `enter` into press+release scancode sequences. Exported for tests.
 */
export function chordToScancodes(chord: string): number[] | null {
  const parts = chord.toLowerCase().split(/[-+]/u).filter(Boolean);
  if (parts.length === 0) return null;
  const modifiers: number[][] = [];
  const finals: number[][] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    if (!isLast && MODIFIER_CODES[part]) {
      modifiers.push(MODIFIER_CODES[part]);
      continue;
    }
    const named = KEY_CODES[part] ?? (part === 'del' ? KEY_CODES.delete : undefined);
    const code = named ?? MODIFIER_CODES[part] ?? (part.length === 1 ? charMakeCode(part) : null);
    if (!code) return null;
    finals.push(code);
  }
  if (finals.length === 0) return null;
  const press = (make: number[]) => make;
  const release = (make: number[]) =>
    make.length === 2 ? [make[0], make[1] | 0x80] : [make[0] | 0x80];
  const codes: number[] = [];
  for (const m of modifiers) codes.push(...press(m));
  for (const f of finals) codes.push(...press(f), ...release(f));
  for (const m of [...modifiers].reverse()) codes.push(...release(m));
  return codes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an {@link IpkResolutionContext} from a command's `ctx`.
 * Mirrors `createIpkContextFromCtx` in `ffmpeg-command.ts` /
 * `tsc-command.ts` so every float wires the loader the same way.
 */
export function createIpkContextFromCtx(ctx: CommandContext): IpkResolutionContext {
  return {
    reader: {
      exists: (path) => ctx.fs.exists(path),
      isDirectory: async (path) => {
        try {
          return (await ctx.fs.stat(path)).isDirectory;
        } catch {
          return false;
        }
      },
      readFile: (path) => ctx.fs.readFile(path),
    },
    readBytes: (path) => ctx.fs.readFileBuffer(path),
    fromDir: ctx.cwd,
  };
}

function fail(msg: string): CmdResult {
  return { stdout: '', stderr: `v86: ${msg}\n`, exitCode: 1 };
}

function ok(msg = ''): CmdResult {
  return { stdout: msg, stderr: '', exitCode: 0 };
}

/** Pull a `-n <name>` / `--name <name>` pair out of subcommand args. */
export function extractVmName(args: readonly string[]): { name: string; rest: string[] } {
  const rest: string[] = [];
  let name = DEFAULT_VM_NAME;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' || args[i] === '-name' || args[i] === '--name') {
      const v = args[i + 1];
      if (v) {
        name = v;
        i++;
        continue;
      }
    }
    rest.push(args[i]);
  }
  return { name, rest };
}

function requireVm(name: string): VmRecord | CmdResult {
  const record = getVm(name);
  if (!record) {
    return fail(`no VM named '${name}' — boot one with \`v86 start -n ${name} ...\``);
  }
  return record;
}

function isCmdResult(value: VmRecord | CmdResult): value is CmdResult {
  return 'exitCode' in value;
}

/**
 * Encode an RGBA frame to PNG via OffscreenCanvas (available in the
 * kernel worker on all supported floats).
 */
async function encodeFramePng(frame: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Promise<Uint8Array> {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('screenshot requires OffscreenCanvas, unavailable in this runtime');
  }
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const canvasCtx = canvas.getContext('2d');
  if (!canvasCtx) throw new Error('could not acquire 2d canvas context');
  // The cast sidesteps the `SharedArrayBuffer | ArrayBuffer` union the
  // view's backing buffer carries under newer `lib.dom.d.ts` — same
  // pattern as `compileWasmModule` in `wasm-compiler.ts`; captureFrame
  // returns a fresh copy backed by a plain ArrayBuffer.
  const pixels = frame.data as unknown as ImageDataArray;
  canvasCtx.putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function readVfsImage(
  ctx: CommandContext,
  path: string,
  label: string
): Promise<VfsImage | CmdResult> {
  const resolved = ctx.fs.resolvePath(ctx.cwd, path);
  if (!(await ctx.fs.exists(resolved))) return fail(`${label}: no such file: ${path}`);
  const bytes = await ctx.fs.readFileBuffer(resolved);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { buffer };
}

const BOOT_ORDER: Record<'a' | 'c' | 'd', number> = {
  a: 0x321, // floppy first
  c: 0x132, // hard disk first
  d: 0x213, // cd first
};

// ---------------------------------------------------------------------------
// Engine dependency injection (tests)
// ---------------------------------------------------------------------------

export interface V86CommandDeps {
  /**
   * Override the engine loader. Tests inject a mock returning a fake
   * emulator; production resolves through `getV86Module` (ipk-gated).
   */
  loadEngine?: (ipk: IpkResolutionContext) => Promise<V86Module>;
  /**
   * Inject a `ProcessManager`. When omitted, looks up
   * `globalThis.__slicc_pm` at exec time (same fallback as `ps`/`kill`).
   */
  processManager?: ProcessManager;
  /**
   * Inject the `SecureFetch` backing `-net ...,relay=fetch`. When
   * omitted, `createProxiedFetch()` (CORS-bypassing fetch proxy).
   */
  proxiedFetch?: SecureFetch;
}

/** Globals the kernel host publishes for commands that need the live PM. */
interface KernelGlobals {
  __slicc_pm?: unknown;
}

/**
 * The v86 constructor options `v86 start` populates. The engine accepts a
 * larger bag; these are the keys this command sets, from its own flags and
 * the images it stages out of the VFS. A type alias (not an interface) so it
 * stays assignable to the engine's own untyped constructor signature.
 */
type V86Options = {
  wasm_fn: (imports: WebAssembly.Imports) => Promise<WebAssembly.Exports>;
  memory_size: number;
  vga_memory_size: number;
  autostart: boolean;
  disable_speaker: boolean;
  fastboot: boolean;
  /** BIOS blobs + guest images, staged as `{ buffer }` by `readVfsImage`. */
  bios?: VfsImage;
  vga_bios?: VfsImage;
  cdrom?: VfsImage;
  hda?: VfsImage;
  fda?: VfsImage;
  bzimage?: VfsImage;
  initrd?: VfsImage;
  initial_state?: VfsImage;
  cmdline?: string;
  boot_order?: number;
  filesystem?: { baseurl: string };
  net_device?: { type: string; relay_url?: string };
};

/** A guest image read off the VFS, in the shape the engine expects. */
type VfsImage = { buffer: ArrayBuffer };

function lookupGlobalPm(): ProcessManager | null {
  const pm = (globalThis as KernelGlobals).__slicc_pm;
  return pm instanceof Object && typeof (pm as ProcessManager).signal === 'function'
    ? (pm as ProcessManager)
    : null;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function createV86Command(deps: V86CommandDeps = {}): Command {
  return defineCommand('v86', async (args, ctx) => {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
      return ok(HELP);
    }
    if (args[0] === '--version') return v86Version(ctx, deps);

    const sub = args[0];
    // Help before the handler: `stop --help` used to power the VM off,
    // `serve --help` to start the frame pump, `type --help` to type the
    // flag into the guest. `v86 type -- --help` still types it literally.
    if (isHelpRequest(args.slice(1), { valueFlags: V86_VALUE_FLAGS })) {
      return ok(subcommandHelpText('v86', sub, HELP, { prefix: 'v86' }));
    }
    const subArgs = stripOptionTerminator(args.slice(1));
    try {
      switch (sub) {
        case 'start':
          return await v86Start(subArgs, ctx, deps);
        case 'ls':
          return v86Ls();
        case 'type':
          return v86Type(subArgs);
        case 'key':
          return v86Key(subArgs);
        case 'mouse':
          return v86Mouse(subArgs);
        case 'screenshot':
          return await v86Screenshot(subArgs, ctx);
        case 'text':
          return v86Text(subArgs);
        case 'serve':
          return await v86Serve(subArgs, ctx);
        case 'serial':
          return v86Serial(subArgs);
        case 'state':
          return await v86State(subArgs, ctx);
        case 'stop':
          return await v86Stop(subArgs, deps);
        default:
          return fail(`unknown subcommand '${sub}' — see \`v86 --help\``);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });
}

/**
 * `v86 --version` is gated behind an ipk-installed `v86` for parity
 * with `ffmpeg -version` — reporting a version without the engine
 * present would lie. Resolves without booting the emulator.
 */
async function v86Version(ctx: CommandContext, deps: V86CommandDeps): Promise<CmdResult> {
  if (deps.loadEngine) {
    const mod = await deps.loadEngine(createIpkContextFromCtx(ctx));
    return ok(`v86 ${mod.version} (qemu-flavored CLI)\n`);
  }
  const loaded = await tryLoadV86FromNodeModules(createIpkContextFromCtx(ctx));
  if (!loaded) return fail(V86_NOT_INSTALLED);
  return ok(`v86 ${loaded.version} (qemu-flavored CLI)\n`);
}

/**
 * Stage BIOS blobs from the VFS. Explicit flags win; otherwise the
 * conventional /workspace/.v86/ pair. Direct-kernel boots still need
 * seabios; `-state` resumes skip the BIOS entirely (the snapshot
 * already contains the machine state) unless a blob is passed
 * explicitly — same rule as the copy.sh loader.
 */
async function stageBios(
  parsed: ParsedStartArgs,
  ctx: CommandContext,
  options: V86Options
): Promise<CmdResult | null> {
  if (parsed.state && !parsed.bios && !parsed.vgabios) return null;
  const bios = await readVfsImage(ctx, parsed.bios ?? `${DEFAULT_BIOS_DIR}/seabios.bin`, '-bios');
  if ('exitCode' in bios)
    return parsed.bios ? bios : fail(BIOS_MISSING_HINT.replace(/^v86: /u, ''));
  options.bios = bios;
  if (parsed.nographic) return null;
  const vgabios = await readVfsImage(
    ctx,
    parsed.vgabios ?? `${DEFAULT_BIOS_DIR}/vgabios.bin`,
    '-vgabios'
  );
  if ('exitCode' in vgabios) {
    return parsed.vgabios ? vgabios : fail(BIOS_MISSING_HINT.replace(/^v86: /u, ''));
  }
  options.vga_bios = vgabios;
  return null;
}

/**
 * Stage BIOS blobs + guest images from the VFS into v86 constructor
 * options. Returns a CmdResult error when anything is missing.
 */
async function stageBootImages(
  parsed: ParsedStartArgs,
  ctx: CommandContext,
  options: V86Options
): Promise<CmdResult | null> {
  const biosError = await stageBios(parsed, ctx, options);
  if (biosError) return biosError;

  for (const [flag, key] of [
    ['cdrom', 'cdrom'],
    ['hda', 'hda'],
    ['fda', 'fda'],
    ['kernel', 'bzimage'],
    ['initrd', 'initrd'],
  ] as const) {
    const path = parsed[flag];
    if (!path) continue;
    const image = await readVfsImage(ctx, path, `-${flag}`);
    if ('exitCode' in image) return image;
    options[key] = image;
  }
  if (parsed.append) options.cmdline = parsed.append;
  if (parsed.boot) options.boot_order = BOOT_ORDER[parsed.boot];

  // `-state`: a saved snapshot (from `v86 state save` or a published
  // copy.sh image). `.zst` payloads are detected by magic and
  // decompressed inside the engine wasm — pass the bytes through.
  if (parsed.state) {
    const state = await readVfsImage(ctx, parsed.state, '-state');
    if ('exitCode' in state) return state;
    options.initial_state = state;
  }
  // `-fs9p`: network-backed 9p root (copy.sh-style baseurl trees).
  // Guest files are fetched on demand; the host must send CORS headers.
  if (parsed.fs9p) options.filesystem = { baseurl: parsed.fs9p };
  // `-net`: NIC model. A `-state` snapshot only resumes cleanly with
  // the same device set it was saved with (copy.sh Arch uses virtio).
  // `relay=fetch` picks v86's fetch-based network relay: DNS is answered
  // in-engine (dns_method: static) and guest HTTP becomes host fetch()
  // calls, which v86Start reroutes through the SLICC fetch proxy.
  if (parsed.net) {
    options.net_device =
      parsed.netRelay === 'fetch' ? { type: parsed.net, relay_url: 'fetch' } : { type: parsed.net };
  }
  return null;
}

/** Cap on waiting for the engine's async init (wasm bring-up + state
 * decompress + 9p basefs index fetch all happen inside the constructor). */
const ENGINE_INIT_TIMEOUT_MS = 60_000;

/**
 * The `V86` constructor returns immediately but initializes async —
 * `emulator.v86` (the runtime core) and `screen_adapter` only exist
 * once the bus fires `emulator-loaded`. An already-initialized engine
 * (mock, or hypothetical sync path) is detected via `emulator.v86`.
 */
function waitForEmulatorLoaded(emulator: V86Emulator): Promise<void> {
  if (emulator.v86) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`engine init timed out after ${ENGINE_INIT_TIMEOUT_MS / 1000}s`)),
      ENGINE_INIT_TIMEOUT_MS
    );
    emulator.add_listener('emulator-loaded', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Reroute the fetch-relay network adapter's host fetch through the
 * SLICC fetch proxy. The relay's HTTP handler calls the adapter's
 * per-instance `fetch` own property — set to the global `fetch` by the
 * adapter constructor (a plain own prop, NOT a get/set-asymmetric
 * proxy) — and consumes a Response-shaped result. The kernel worker's
 * direct `fetch` would fail CORS on almost every guest target, so
 * replace it with a `SecureFetch`-backed shim (same proxy `curl` uses).
 */
function patchRelayFetch(emulator: V86Emulator, deps: V86CommandDeps): CmdResult | null {
  const adapter = emulator.network_adapter;
  if (!adapter || typeof adapter.fetch !== 'function') {
    return fail('relay=fetch: engine exposed no fetch-relay network adapter');
  }
  const proxied = deps.proxiedFetch ?? createProxiedFetch();
  adapter.fetch = async (url, init) => {
    // The guest only speaks plain HTTP to the relay; upgrade external
    // hosts to https (the rewrite v86 itself applies under a secure
    // page origin) so github.com & co. don't need a redirect hop.
    // localhost stays http — that's the relay's `<port>.external` path.
    const target = url.replace(/^http:\/\/(?!localhost[:/]|127\.0\.0\.1[:/])/u, 'https://');
    const headers: Record<string, string> = {};
    init?.headers?.forEach((value, key) => {
      headers[key] = value;
    });
    let body: string | undefined;
    if (init?.body) {
      // Latin1-encode: the SecureFetch `body: string` contract
      // (`prepareRequestBody` recovers the raw bytes downstream).
      let latin1 = '';
      for (const byte of init.body) latin1 += String.fromCharCode(byte);
      body = latin1;
    }
    const resp = await proxied(target, { method: init?.method, headers, body });
    const bytes = resp.body;
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    return {
      status: resp.status,
      statusText: resp.statusText,
      // Wrap the proxy's plain record in a real Headers: today the relay
      // does `new Headers(resp.headers)` itself (HeadersInit accepts a
      // record), but a genuine Headers also survives direct iteration.
      headers: new Headers(resp.headers),
      redirected: false,
      url: resp.url,
      arrayBuffer: async () => buffer,
    };
  };
  return null;
}

async function v86Start(
  args: readonly string[],
  ctx: CommandContext,
  deps: V86CommandDeps
): Promise<CmdResult> {
  const result = parseStartArgs(args);
  if (!result.ok) return fail(result.error);
  const parsed = result.parsed;
  if (getVm(parsed.name)) {
    return fail(`VM '${parsed.name}' already running — stop it first or pick another -n name`);
  }

  const ipk = createIpkContextFromCtx(ctx);
  const engine = deps.loadEngine ? await deps.loadEngine(ipk) : await getV86Module({ ipk });

  const options: V86Options = {
    wasm_fn: makeWasmFn(engine.wasmModule),
    memory_size: parsed.memoryMib * 1024 * 1024,
    // Sizes the Bochs-dispi SVGA/VBE framebuffer — high-res VESA modes
    // need more than the 8 MiB default (raise via `-vga`).
    vga_memory_size: parsed.vgaMemoryMib * 1024 * 1024,
    autostart: false,
    disable_speaker: true,
    fastboot: true,
  };
  const stageError = await stageBootImages(parsed, ctx, options);
  if (stageError) return stageError;

  const emulator = new engine.V86(options);
  const record: VmRecord = {
    name: parsed.name,
    emulator,
    engineVersion: engine.version,
    pid: null,
    startedAt: Date.now(),
    bootArgv: ['v86', 'start', ...args],
    serial: { buffer: '' },
    screen: { mode: 'text', width: 0, height: 0, frame: null },
    serve: null,
  };

  // Register with the ProcessManager so `ps` sees the VM and
  // `kill <pid>` powers it off (via the abort signal).
  const pm = deps.processManager ?? lookupGlobalPm();
  if (pm) {
    const proc = pm.spawn({
      kind: 'net',
      argv: record.bootArgv,
      cwd: ctx.cwd,
      owner: { kind: 'system' },
    });
    record.pid = proc.pid;
    proc.abort.signal.addEventListener('abort', () => {
      void teardownVm(record, pm);
    });
  }

  registerVm(record);
  try {
    // The constructor kicks off async wasm init; `run()` dereferences
    // internals (`this.v86`, screen adapter) that only exist once the
    // engine fires `emulator-loaded`. Wait for it before instrumenting
    // (the DummyScreenAdapter is also created during init) and booting.
    await waitForEmulatorLoaded(emulator);
    if (parsed.netRelay === 'fetch') {
      const relayError = patchRelayFetch(emulator, deps);
      if (relayError) {
        await teardownVm(record, pm);
        return relayError;
      }
    }
    instrumentVm(record);
    await emulator.run();
  } catch (err) {
    await teardownVm(record, pm);
    return fail(`boot failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const pidNote = record.pid !== null ? ` (pid ${record.pid})` : '';
  return ok(
    `VM '${parsed.name}' booting in the background${pidNote}.\n` +
      `Drive it with: v86 text -n ${parsed.name} | v86 screenshot -n ${parsed.name} | v86 type -n ${parsed.name} "..."\n`
  );
}

async function teardownVm(record: VmRecord, pm: ProcessManager | null): Promise<void> {
  stopServe(record);
  unregisterVm(record.name);
  try {
    if (record.emulator.is_running()) await record.emulator.stop();
  } catch {
    // Best-effort — a wedged guest may refuse to stop.
  }
  try {
    // Always attempt destroy, even when stop() rejected: skipping it
    // would leak the live wasm instance (and its guest RAM) after the
    // record has already been unregistered.
    await record.emulator.destroy();
  } catch {
    // Best-effort — the emulator may already be gone.
  }
  if (pm && record.pid !== null) pm.exit(record.pid, null);
}

function v86Ls(): CmdResult {
  const vms = listVms();
  if (vms.length === 0) return ok('no VMs running\n');
  const lines = ['NAME       PID    STATE     UP        BOOT'];
  for (const vm of vms) {
    const up = Math.round((Date.now() - vm.startedAt) / 1000);
    const upText = up >= 60 ? `${Math.floor(up / 60)}m${up % 60}s` : `${up}s`;
    lines.push(
      `${vm.name.padEnd(10)} ${String(vm.pid ?? '-').padEnd(6)} ` +
        `${(vm.emulator.is_running() ? 'running' : 'stopped').padEnd(9)} ${upText.padEnd(9)} ` +
        vm.bootArgv.slice(2).join(' ')
    );
  }
  return ok(`${lines.join('\n')}\n`);
}

function v86Type(args: readonly string[]): CmdResult {
  const { name, rest } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;
  if (rest.length === 0) return fail('type: no text supplied');
  // Interpret the usual escapes so agents can send Enter as '\n'.
  const text = rest.join(' ').replace(/\\n/gu, '\n').replace(/\\t/gu, '\t');
  record.emulator.keyboard_send_text(text);
  return ok();
}

function v86Key(args: readonly string[]): CmdResult {
  const { name, rest } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;
  if (rest.length === 0) return fail('key: no chord supplied');
  const sequences: number[][] = [];
  for (const chord of rest) {
    const codes = chordToScancodes(chord);
    if (!codes) return fail(`key: unknown chord '${chord}'`);
    sequences.push(codes);
  }
  for (const codes of sequences) record.emulator.keyboard_send_scancodes(codes);
  return ok();
}

const MOUSE_BUTTONS = ['left', 'middle', 'right'] as const;

function sendClick(record: VmRecord, button: 'left' | 'middle' | 'right'): void {
  const state = [button === 'left', button === 'middle', button === 'right'];
  record.emulator.bus.send('mouse-click', state);
  record.emulator.bus.send('mouse-click', [false, false, false]);
}

function v86Mouse(args: readonly string[]): CmdResult {
  const { name, rest } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;

  // `--to x,y` best-effort absolute positioning: re-home to the
  // top-left corner with a huge relative sweep, then move to x,y.
  const toIdx = rest.indexOf('--to');
  if (toIdx !== -1) {
    const spec = rest[toIdx + 1];
    const match = spec ? /^(\d+),(\d+)$/u.exec(spec) : null;
    if (!match) return fail('mouse: --to requires <x>,<y>');
    const [x, y] = [Number(match[1]), Number(match[2])];
    record.emulator.bus.send('mouse-delta', [-16384, 16384]);
    record.emulator.bus.send('mouse-delta', [x, -y]);
    return ok();
  }

  const action = rest[0];
  if (action === 'move') {
    const dx = Number.parseInt(rest[1] ?? '', 10);
    const dy = Number.parseInt(rest[2] ?? '', 10);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
      return fail('mouse: move requires <dx> <dy>');
    }
    // Screen y grows downward; PS/2 y grows upward.
    record.emulator.bus.send('mouse-delta', [dx, -dy]);
    return ok();
  }
  if (action === 'click') {
    const button = (rest[1] ?? 'left') as (typeof MOUSE_BUTTONS)[number];
    if (!MOUSE_BUTTONS.includes(button)) return fail(`mouse: unknown button '${rest[1]}'`);
    sendClick(record, button);
    if (rest.includes('--double')) sendClick(record, button);
    return ok();
  }
  return fail('mouse: expected move <dx> <dy>, click [button], or --to <x>,<y>');
}

async function v86Screenshot(args: readonly string[], ctx: CommandContext): Promise<CmdResult> {
  const { name, rest } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;
  const frame = captureFrame(record);
  if (!frame) {
    return fail(
      `no graphical frame for '${name}' — the guest is in text mode; use \`v86 text -n ${name}\``
    );
  }
  const outPath = ctx.fs.resolvePath(ctx.cwd, rest[0] ?? `${scratchDir(ctx.env)}/v86-${name}.png`);
  const png = await encodeFramePng(frame);
  await ctx.fs.writeFile(outPath, png);
  return ok(`${outPath} (${frame.width}x${frame.height})\n`);
}

function v86Text(args: readonly string[]): CmdResult {
  const { name } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;
  const dump = dumpTextScreen(record);
  if (dump === null) {
    return fail(
      record.screen.mode === 'graphical'
        ? `'${name}' is in graphical mode — use \`v86 screenshot -n ${name}\``
        : `text screen unavailable for '${name}'`
    );
  }
  return ok(`${dump}\n`);
}

/** Serve pump rates (frames/second) — VFS writes are not free. */
const SERVE_DEFAULT_FPS = 2;
const SERVE_MAX_FPS = 10;

/**
 * Static viewer page dropped into the serve directory. Polls
 * `state.json` at the pump rate and swaps in `frame.png` (graphical
 * mode) or `screen.txt` (text mode). Self-contained so `serve <dir>`
 * can host it for an iframe.
 */
function serveViewerHtml(name: string, fps: number): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>v86 — ${name}</title><style>
  html,body{margin:0;height:100%;background:#111;color:#ddd;font-family:monospace}
  body{display:flex;align-items:center;justify-content:center}
  img{max-width:100%;max-height:100%;image-rendering:pixelated}
  pre{margin:0;padding:8px;font-size:14px;line-height:1.15;white-space:pre}
  .off{opacity:.4}
</style></head><body>
<img id="fb" alt="v86 screen" hidden><pre id="txt" hidden></pre>
<script>
const fb = document.getElementById('fb'), txt = document.getElementById('txt');
let seq = -1;
async function tick() {
  try {
    const s = await (await fetch('state.json?t=' + Date.now(), {cache:'no-store'})).json();
    if (s.seq !== seq) {
      seq = s.seq;
      if (s.mode === 'graphical') {
        fb.src = 'frame.png?t=' + seq; fb.hidden = false; txt.hidden = true;
      } else {
        txt.textContent = await (await fetch('screen.txt?t=' + seq, {cache:'no-store'})).text();
        txt.hidden = false; fb.hidden = true;
      }
    }
    fb.classList.remove('off'); txt.classList.remove('off');
  } catch {
    fb.classList.add('off'); txt.classList.add('off');
  }
  setTimeout(tick, ${Math.round(1000 / fps)});
}
tick();
</script></body></html>
`;
}

/** One serve-pump tick: snapshot the screen into the serve directory. */
async function pumpServeFrame(
  record: VmRecord,
  ctx: CommandContext,
  dir: string,
  seq: number
): Promise<void> {
  let mode: 'text' | 'graphical' = 'text';
  const frame = record.screen.mode === 'graphical' ? captureFrame(record) : null;
  if (frame) {
    await ctx.fs.writeFile(`${dir}/frame.png`, await encodeFramePng(frame));
    mode = 'graphical';
  } else {
    const dump = dumpTextScreen(record);
    await ctx.fs.writeFile(`${dir}/screen.txt`, dump ?? '(no screen output yet)');
  }
  const state = { name: record.name, mode, seq, ts: Date.now() };
  await ctx.fs.writeFile(`${dir}/state.json`, JSON.stringify(state));
}

/**
 * `v86 serve` — stream the VM screen into a VFS directory as a static
 * viewer (index.html + frame.png/screen.txt + state.json) refreshed by
 * a kernel-worker interval. Pair with the `serve` command to mint a
 * worker-hosted URL a sprinkle can iframe.
 */
async function v86Serve(args: readonly string[], ctx: CommandContext): Promise<CmdResult> {
  const { name, rest } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;

  if (rest.includes('--stop')) {
    if (!record.serve) return fail(`serve: no screen serve running for '${name}'`);
    const dir = record.serve.dir;
    stopServe(record);
    return ok(`screen serve for '${name}' stopped (${dir} left in place)\n`);
  }
  if (record.serve) {
    return fail(`serve: already serving '${name}' at ${record.serve.dir} — --stop first`);
  }

  let fps = SERVE_DEFAULT_FPS;
  const fpsIdx = rest.indexOf('--fps');
  if (fpsIdx !== -1) {
    fps = Number.parseInt(rest[fpsIdx + 1] ?? '', 10);
    if (!Number.isFinite(fps) || fps < 1 || fps > SERVE_MAX_FPS) {
      return fail(`serve: --fps requires 1-${SERVE_MAX_FPS}`);
    }
  }

  const dir = `${scratchDir(ctx.env)}/v86-serve-${name}`;
  await ctx.fs.mkdir(dir, { recursive: true });
  await ctx.fs.writeFile(`${dir}/index.html`, serveViewerHtml(name, fps));

  let seq = 0;
  let busy = false;
  const timer = setInterval(
    () => {
      // Skip a tick rather than queueing when encoding falls behind.
      if (busy) return;
      busy = true;
      pumpServeFrame(record, ctx, dir, seq++)
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    },
    Math.round(1000 / fps)
  );
  record.serve = { dir, fps, timer };
  await pumpServeFrame(record, ctx, dir, seq++).catch(() => {});

  return ok(
    `serving '${name}' screen at ${dir} (${fps} fps).\n` +
      `Mint an iframe-able URL with: serve ${dir}\n` +
      `Stop with: v86 serve -n ${name} --stop\n`
  );
}

function v86Serial(args: readonly string[]): CmdResult {
  const { name, rest } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;

  const sendIdx = rest.indexOf('--send');
  if (sendIdx !== -1) {
    const text = rest
      .slice(sendIdx + 1)
      .join(' ')
      .replace(/\\n/gu, '\n');
    if (!text) return fail('serial: --send requires text');
    record.emulator.serial0_send(text);
    return ok();
  }

  const tailIdx = rest.indexOf('--tail');
  if (tailIdx !== -1) {
    const n = Number.parseInt(rest[tailIdx + 1] ?? '25', 10);
    const lines = record.serial.buffer.split('\n');
    return ok(`${lines.slice(-Math.max(1, n)).join('\n')}\n`);
  }
  return ok(record.serial.buffer ? `${record.serial.buffer}\n` : '');
}

async function v86State(args: readonly string[], ctx: CommandContext): Promise<CmdResult> {
  const { name, rest } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;
  const [action, file] = rest;
  if ((action !== 'save' && action !== 'load') || !file) {
    return fail('state: expected save|load <file>');
  }
  const path = ctx.fs.resolvePath(ctx.cwd, file);
  if (action === 'save') {
    const state = await record.emulator.save_state();
    await ctx.fs.writeFile(path, new Uint8Array(state));
    return ok(`${path} (${state.byteLength} bytes)\n`);
  }
  if (!(await ctx.fs.exists(path))) return fail(`state: no such file: ${file}`);
  const bytes = await ctx.fs.readFileBuffer(path);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  await record.emulator.restore_state(buffer);
  return ok();
}

async function v86Stop(args: readonly string[], deps: V86CommandDeps): Promise<CmdResult> {
  const { name, rest } = extractVmName(args);
  const record = requireVm(name);
  if (isCmdResult(record)) return record;
  const pm = deps.processManager ?? lookupGlobalPm();
  if (rest.includes('--force') && pm && record.pid !== null) {
    // SIGKILL through the PM — the abort listener runs the teardown.
    pm.signal(record.pid, 'SIGKILL');
    return ok(`VM '${name}' killed\n`);
  }
  await teardownVm(record, pm);
  return ok(`VM '${name}' stopped\n`);
}
