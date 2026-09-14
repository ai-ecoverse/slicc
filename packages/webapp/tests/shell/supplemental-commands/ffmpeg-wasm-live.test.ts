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

const NODE_MODULES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../node_modules'
);
const PKG_DIR = join(NODE_MODULES, '@ffmpeg/core');
const MT_PKG_DIR = join(NODE_MODULES, '@ffmpeg/core-mt');

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/@ffmpeg/core`;

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

function walk(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]
  );
}

function mirrorInstalledPackage(
  pkgDir = PKG_DIR,
  vfsPkg = VFS_PKG
): { ipk: IpkResolutionContext; files: string[] } {
  const files = walk(pkgDir);
  const vfsFiles = new Set(files.map((file) => `${vfsPkg}/${file}`));
  const dirs = new Set([VFS_ROOT, `${VFS_ROOT}/node_modules`, `${VFS_ROOT}/node_modules/@ffmpeg`]);
  for (const file of vfsFiles) {
    for (let dir = posix.dirname(file); !dirs.has(dir); dir = posix.dirname(dir)) dirs.add(dir);
  }
  const onDisk = (vfsPath: string) => join(pkgDir, vfsPath.slice(vfsPkg.length + 1));
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

    const workerSelf: { location: { href: string } } = Object.create(globalThis);
    workerSelf.location = { href: 'blob:ffmpeg-wasm-live' };
    vi.stubGlobal('self', workerSelf);

    const glueUrl = `data:text/javascript;base64,${Buffer.from(loaded.coreSource).toString('base64')}`;
    const glue = (await import(/* @vite-ignore */ glueUrl)) as {
      default?: (options: { wasmBinary: Uint8Array }) => Promise<FfmpegCore>;
    };

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

    core.reset();
    expect(core.ret).toBe(-1);
  });
});

describe('ffmpeg-core-mt layout canary (real installed package)', () => {
  it('resolves glue + wasm + pthread worker at the pinned version on an isolated runtime', async () => {
    const { ipk, files } = mirrorInstalledPackage(
      MT_PKG_DIR,
      `${VFS_ROOT}/node_modules/@ffmpeg/core-mt`
    );
    const resolved = await selectFfmpegCore(ipk, true);
    expect(
      resolved,
      `the loader found no usable @ffmpeg/core-mt in the installed package; it contains ` +
        `[${files.join(', ')}] — update FFMPEG_CORE_LAYOUTS in ffmpeg-wasm.ts`
    ).not.toBeNull();
    const mt = resolved as LoadedFfmpegCore;
    expect(mt.pkg).toBe('@ffmpeg/core-mt');
    expect(mt.workerSource, 'the -mt core is unusable without ffmpeg-core.worker.js').toMatch(/\S/);
    expect(mt.wasmBytes.byteLength).toBeGreaterThan(1_000_000);

    expect(mt.coreSource).toMatch(/export default/);
    const manifest = JSON.parse(readFileSync(join(MT_PKG_DIR, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(manifest.version).toBe(BUNDLED_FFMPEG_CORE_VERSION);
  });

  it('is NOT preferred on a non-isolated runtime even when it is the only core present', async () => {
    const { ipk } = mirrorInstalledPackage(MT_PKG_DIR, `${VFS_ROOT}/node_modules/@ffmpeg/core-mt`);

    expect(await selectFfmpegCore(ipk, false)).toBeNull();
  });
});
