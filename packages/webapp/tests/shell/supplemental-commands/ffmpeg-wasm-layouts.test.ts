/**
 * Resolution rules of the `@ffmpeg/core` loader over synthetic installs:
 * which package layouts it accepts and which misses come back `null` (so the
 * command surfaces the install guidance instead of booting a broken core).
 * Everything here is a file map; the check against the REAL installed
 * package is `ffmpeg-wasm-live.test.ts`.
 */
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type IpkResolutionContext,
  tryLoadFfmpegCoreFromNodeModules,
} from '../../../src/shell/supplemental-commands/ffmpeg-wasm.js';

const ROOT = '/workspace';
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
const GLUE = '/* glue */ export default function () {}';
const WORKER = '/* pthread worker */';

/**
 * ipk context over one synthetic install of `pkg`. `files` are paths
 * relative to the package root, so a test states the layout it is probing
 * verbatim (`dist/esm/ffmpeg-core.js`) rather than through a helper that
 * already assumes one.
 */
function installed(
  pkg: string,
  files: Record<string, string | Uint8Array>,
  opts: { readBytesFails?: boolean } = {}
): IpkResolutionContext {
  const pkgDir = `${ROOT}/node_modules/${pkg}`;
  const entries = new Map<string, string | Uint8Array>([
    [`${pkgDir}/package.json`, JSON.stringify({ name: pkg, version: '0.12.10' })],
  ]);
  for (const [rel, content] of Object.entries(files)) entries.set(`${pkgDir}/${rel}`, content);
  const dirs = new Set<string>();
  for (const path of entries.keys()) {
    for (let dir = posix.dirname(path); dir !== '/' && !dirs.has(dir); dir = posix.dirname(dir)) {
      dirs.add(dir);
    }
  }
  return {
    fromDir: ROOT,
    reader: {
      exists: async (path) => entries.has(path) || dirs.has(path),
      isDirectory: async (path) => dirs.has(path),
      readFile: async (path) => {
        const value = entries.get(path);
        if (typeof value !== 'string') throw new Error(`ENOENT: ${path}`);
        return value;
      },
    },
    readBytes: async (path) => {
      const value = entries.get(path);
      if (opts.readBytesFails || !(value instanceof Uint8Array)) throw new Error(`EIO: ${path}`);
      return value;
    },
  };
}

describe('tryLoadFfmpegCoreFromNodeModules layouts', () => {
  it('resolves the dist/esm layout every 0.12.x release ships', async () => {
    const loaded = await tryLoadFfmpegCoreFromNodeModules(
      installed('@ffmpeg/core', {
        'dist/esm/ffmpeg-core.js': GLUE,
        'dist/esm/ffmpeg-core.wasm': WASM,
        'dist/umd/ffmpeg-core.js': '/* umd */',
        'dist/umd/ffmpeg-core.wasm': WASM,
      }),
      '@ffmpeg/core'
    );
    expect(loaded).toEqual({ pkg: '@ffmpeg/core', coreSource: GLUE, wasmBytes: WASM });
  });

  it('resolves the -mt core when its pthread worker sits in the same layout', async () => {
    const loaded = await tryLoadFfmpegCoreFromNodeModules(
      installed('@ffmpeg/core-mt', {
        'dist/esm/ffmpeg-core.js': GLUE,
        'dist/esm/ffmpeg-core.wasm': WASM,
        'dist/esm/ffmpeg-core.worker.js': WORKER,
      }),
      '@ffmpeg/core-mt'
    );
    expect(loaded?.pkg).toBe('@ffmpeg/core-mt');
    expect(loaded?.workerSource).toBe(WORKER);
  });

  it('treats an -mt layout without its pthread worker as a miss', async () => {
    const loaded = await tryLoadFfmpegCoreFromNodeModules(
      installed('@ffmpeg/core-mt', {
        'dist/esm/ffmpeg-core.js': GLUE,
        'dist/esm/ffmpeg-core.wasm': WASM,
      }),
      '@ffmpeg/core-mt'
    );
    expect(loaded).toBeNull();
  });

  // The UMD build is a real shipped layout (the package's `main`), excluded
  // on purpose: the wrapper's module worker `import()`s the glue and needs a
  // default export, which UMD has none of.
  it('does not fall back to dist/umd when dist/esm is absent', async () => {
    const loaded = await tryLoadFfmpegCoreFromNodeModules(
      installed('@ffmpeg/core', {
        'dist/umd/ffmpeg-core.js': '/* umd */',
        'dist/umd/ffmpeg-core.wasm': WASM,
      }),
      '@ffmpeg/core'
    );
    expect(loaded).toBeNull();
  });

  // The flat layout is what 0.11.x and earlier shipped; those cores speak
  // the pre-0.12 protocol the bundled wrapper cannot drive.
  it('does not accept the flat dist/ layout of 0.11.x cores', async () => {
    const loaded = await tryLoadFfmpegCoreFromNodeModules(
      installed('@ffmpeg/core', {
        'dist/ffmpeg-core.js': GLUE,
        'dist/ffmpeg-core.wasm': WASM,
        'dist/ffmpeg-core.worker.js': WORKER,
      }),
      '@ffmpeg/core'
    );
    expect(loaded).toBeNull();
  });

  it('returns null when the layout has the glue but not the wasm, or vice versa', async () => {
    const glueOnly = await tryLoadFfmpegCoreFromNodeModules(
      installed('@ffmpeg/core', { 'dist/esm/ffmpeg-core.js': GLUE }),
      '@ffmpeg/core'
    );
    const wasmOnly = await tryLoadFfmpegCoreFromNodeModules(
      installed('@ffmpeg/core', { 'dist/esm/ffmpeg-core.wasm': WASM }),
      '@ffmpeg/core'
    );
    expect(glueOnly).toBeNull();
    expect(wasmOnly).toBeNull();
  });

  it('returns null when the files exist but the wasm bytes cannot be read', async () => {
    const loaded = await tryLoadFfmpegCoreFromNodeModules(
      installed(
        '@ffmpeg/core',
        { 'dist/esm/ffmpeg-core.js': GLUE, 'dist/esm/ffmpeg-core.wasm': WASM },
        { readBytesFails: true }
      ),
      '@ffmpeg/core'
    );
    expect(loaded).toBeNull();
  });
});
