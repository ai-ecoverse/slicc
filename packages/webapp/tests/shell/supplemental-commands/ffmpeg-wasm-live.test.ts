/**
 * Live canary for the ipk-installed `@ffmpeg/core` the `ffmpeg` command boots.
 *
 * Every other ffmpeg test drives the loader over a synthetic file map, so
 * they all keep passing when the real package changes shape underneath us —
 * exactly how the magick 0.0.43 bump (PR #2744) shipped a broken `convert`
 * behind a green unit suite. This test walks the REAL installed
 * `node_modules/@ffmpeg/core`, mirrors whatever files it actually contains
 * into a VFS `ipk` context (nothing here hardcodes `dist/esm`), runs the
 * loader's real resolution over it, then boots the glue + wasm the loader
 * handed back and runs a real encode through them.
 *
 * What it covers: the package's on-disk layout against `FFMPEG_CORE_LAYOUTS`,
 * the ESM glue's default export the wrapper worker relies on, the glue/wasm
 * pairing (a real `-f lavfi` → WAV encode plus `-version`), and the core API
 * surface `@ffmpeg/ffmpeg`'s worker calls (`exec`, `ffprobe`, `setLogger`,
 * `setProgress`, `setTimeout`, `reset`, `FS`, `ret`).
 *
 * What it does NOT cover: the `@ffmpeg/ffmpeg` wrapper itself. It needs a
 * real `Worker`, which Node lacks, so `getFfmpeg` (blob-URL materialization,
 * postMessage plumbing) is not on this path and stays unit-tested with
 * fakes. `@ffmpeg/core-mt` is not covered either: it is not a devDependency,
 * and its pthread pool needs real workers too.
 *
 * Cost is ~100 ms: Node compiles the 31 MB wasm lazily and the encode is a
 * 10 ms silent clip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_FFMPEG_CORE_VERSION,
  type IpkResolutionContext,
  type LoadedFfmpegCore,
  selectFfmpegCore,
} from '../../../src/shell/supplemental-commands/ffmpeg-wasm.js';

const PKG_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../node_modules/@ffmpeg/core'
);

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/@ffmpeg/core`;

/** The slice of the emscripten `Module` that `@ffmpeg/ffmpeg`'s worker drives. */
interface FfmpegCore {
  exec(...args: string[]): number;
  ffprobe(...args: string[]): number;
  setLogger(logger: (log: { type: string; message: string }) => void): void;
  setProgress(handler: (progress: { progress: number; time: number }) => void): void;
  setTimeout(timeout: number): void;
  reset(): void;
  ret: number;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
}

/** Every file under `dir` as a path relative to it, e.g. `dist/esm/ffmpeg-core.js`. */
function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]
  );
}

/**
 * Mirror the real install into the VFS the loader walks, file for file. The
 * file list comes from the disk, not from this test, so a package that moves
 * its assets is reflected faithfully and the loader is the only thing left
 * that can be wrong about where they are.
 */
function mirrorInstalledPackage(): { ipk: IpkResolutionContext; files: string[] } {
  const files = walk(PKG_DIR);
  const vfsFiles = new Set(files.map((file) => `${VFS_PKG}/${file}`));
  const dirs = new Set([VFS_ROOT, `${VFS_ROOT}/node_modules`, `${VFS_ROOT}/node_modules/@ffmpeg`]);
  for (const file of vfsFiles) {
    for (let dir = posix.dirname(file); !dirs.has(dir); dir = posix.dirname(dir)) dirs.add(dir);
  }
  const onDisk = (vfsPath: string) => join(PKG_DIR, vfsPath.slice(VFS_PKG.length + 1));
  const mustExist = (vfsPath: string) => {
    if (!vfsFiles.has(vfsPath)) throw new Error(`ENOENT: ${vfsPath}`);
  };
  return {
    files,
    ipk: {
      fromDir: VFS_ROOT,
      reader: {
        exists: async (path) => vfsFiles.has(path) || dirs.has(path),
        isDirectory: async (path) => dirs.has(path),
        readFile: async (path) => {
          mustExist(path);
          return readFileSync(onDisk(path), 'utf8');
        },
      },
      readBytes: async (path) => {
        mustExist(path);
        return new Uint8Array(readFileSync(onDisk(path)));
      },
    },
  };
}

describe('ffmpeg-core live boot (real installed package)', () => {
  let loaded: LoadedFfmpegCore;
  let core: FfmpegCore;
  const logs: { type: string; message: string }[] = [];

  beforeAll(async () => {
    const { ipk, files } = mirrorInstalledPackage();
    const resolved = await selectFfmpegCore(ipk, false);
    expect(
      resolved,
      `the loader found no usable @ffmpeg/core in the installed package; it contains ` +
        `[${files.join(', ')}] — the package changed shape; update FFMPEG_CORE_LAYOUTS in ` +
        `ffmpeg-wasm.ts to match`
    ).not.toBeNull();
    loaded = resolved as LoadedFfmpegCore;

    // The glue is compiled for `ENVIRONMENT=worker` only: at import it reads
    // `self.location.href` for its script directory. Give it a `self` that
    // falls through to Node's globals and carries a location; `wasmBinary`
    // below keeps it from ever fetching against that location.
    const workerSelf: { location: { href: string } } = Object.create(globalThis);
    workerSelf.location = { href: 'blob:ffmpeg-wasm-live' };
    vi.stubGlobal('self', workerSelf);

    // The loader hands the wrapper a `blob:` URL of `coreSource`. Node cannot
    // import `blob:` but does import `data:`, which is the same idea — the
    // module text the loader produced, not a path back into node_modules — so
    // this is the exact source the wrapper worker would `import()`.
    const glueUrl = `data:text/javascript;base64,${Buffer.from(loaded.coreSource).toString('base64')}`;
    const glue = (await import(/* @vite-ignore */ glueUrl)) as {
      default?: (options: { wasmBinary: Uint8Array }) => Promise<FfmpegCore>;
    };
    // Exactly what `@ffmpeg/ffmpeg/dist/esm/worker.js` does after `import()`;
    // a UMD-shaped glue fails here, not deep inside the worker.
    expect(typeof glue.default, 'ffmpeg-core.js has no default export').toBe('function');
    core = await (glue.default as NonNullable<typeof glue.default>)({
      wasmBinary: loaded.wasmBytes,
    });
    core.setLogger((log) => logs.push(log));
  }, 60_000);

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('resolves the single-threaded core at the version the install guidance pins', async () => {
    expect(loaded.pkg).toBe('@ffmpeg/core');
    expect(loaded.workerSource).toBeUndefined();
    const manifest = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(manifest.version).toBe(BUNDLED_FFMPEG_CORE_VERSION);
  });

  it('runs a real encode through the real wasm', () => {
    logs.length = 0;
    const versionRet = core.exec('-version');
    expect(versionRet).toBe(0);
    expect(logs[0]?.message).toMatch(/^ffmpeg version /);

    // No input file: lavfi synthesizes 10 ms of silence, the muxer writes a
    // WAV into the emscripten FS. That exercises the demuxer/encoder/muxer
    // pipeline and the FS the wrapper's `readFile` reads results from.
    core.reset();
    const encodeRet = core.exec(
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono',
      '-t',
      '0.01',
      '-f',
      'wav',
      'out.wav'
    );
    expect(encodeRet).toBe(0);
    const wav = core.FS.readFile('out.wav');
    core.FS.unlink('out.wav');
    const ascii = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
  });

  it('exposes the core API surface the @ffmpeg/ffmpeg worker calls', () => {
    for (const member of ['exec', 'ffprobe', 'setLogger', 'setProgress', 'setTimeout', 'reset']) {
      expect(typeof core[member as keyof FfmpegCore], `core.${member} is not a function`).toBe(
        'function'
      );
    }
    for (const member of ['writeFile', 'readFile', 'unlink']) {
      expect(typeof core.FS[member as keyof FfmpegCore['FS']], `core.FS.${member}`).toBe(
        'function'
      );
    }
    // The worker reads `ret` after every exec and clears it with `reset`.
    core.reset();
    expect(core.ret).toBe(-1);
  });
});
