/**
 * Live canary for the bundled `@imagemagick/magick-wasm` glue.
 *
 * Every other magick test drives the loader over a synthetic file map, so
 * they all pass against a package whose real on-disk shape has changed
 * underneath us. That is exactly how the 0.0.42 -> 0.0.43 bump (PR #2744)
 * got a green unit suite while `convert` / `magick` were broken: 0.0.43
 * moved `dist/magick.wasm` to `dist/x86/magick.wasm`, and nothing that
 * mocked the filesystem could notice.
 *
 * This test uses the REAL installed package — its actual layout, its actual
 * `magick.wasm`, its actual glue — and runs one real decode/encode through
 * `getMagick`. It is the check that fails when a dependency update changes
 * the package's shape, its exports, or its ABI. Keep it pointed at the
 * installed copy; mocking anything here defeats the purpose.
 *
 * Cost is small (~150 ms): a 1x1 PNG in, a JPEG out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImageMagickModule } from '../../../src/shell/supplemental-commands/magick-wasm.js';

// `getMagick`'s Node branch resolves the binary over a `file://` URL, which
// the package rejects ("Only http/https protocol is supported"). Force the
// browser branch — compile bytes to a `WebAssembly.Module`, hand that to the
// glue — which is the path every SLICC runtime actually takes.
vi.mock('../../../src/shell/supplemental-commands/shared.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isNodeRuntime: () => false,
}));

const PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../node_modules/@imagemagick/magick-wasm'
);

/** Same candidate order the loader uses, resolved against the real install. */
const LAYOUTS = ['dist/x86/magick.wasm', 'dist/magick.wasm'] as const;

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/@imagemagick/magick-wasm`;

// 1x1 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('magick-wasm live round-trip (real installed package)', () => {
  let magick: ImageMagickModule;

  beforeAll(async () => {
    const layout = LAYOUTS.find((candidate) => existsSync(`${PKG}/${candidate}`));
    expect(
      layout,
      `no magick.wasm under ${PKG} in any known layout (${LAYOUTS.join(', ')}) — the package ` +
        `changed shape again; update MAGICK_WASM_CANDIDATES in magick-wasm.ts to match`
    ).toBeDefined();

    const wasm = new Uint8Array(readFileSync(`${PKG}/${layout}`));
    const pkgJson = readFileSync(`${PKG}/package.json`, 'utf8');
    // Mirror the real layout into the VFS the loader walks.
    const present = new Set([`${VFS_PKG}/package.json`, `${VFS_PKG}/${layout}`]);
    const ipk = {
      fromDir: VFS_ROOT,
      reader: {
        exists: async (path: string) => present.has(path),
        isDirectory: async (path: string) =>
          [...present].some((file) => file.startsWith(`${path}/`)),
        readFile: async (path: string) => {
          if (path === `${VFS_PKG}/package.json`) return pkgJson;
          throw new Error(`ENOENT: ${path}`);
        },
      },
      readBytes: async (path: string) =>
        path.endsWith('package.json') ? new TextEncoder().encode(pkgJson) : wasm,
    };
    const { getMagick } = await import('../../../src/shell/supplemental-commands/magick-wasm.js');
    magick = await getMagick({ ipk });
  }, 60_000);

  it('decodes a PNG and encodes a JPEG through the bundled glue', async () => {
    let jpeg: Uint8Array | null = null;
    let geometry = '';
    await magick.ImageMagick.read(new Uint8Array(PNG), async (image) => {
      geometry = `${image.width}x${image.height}`;
      image.resize(new magick.MagickGeometry(4, 4));
      image.quality = 90;
      image.write(magick.MagickFormat.Jpeg, (data) => {
        jpeg = new Uint8Array(data);
      });
    });
    const bytes = jpeg as Uint8Array | null;
    expect(geometry).toBe('1x1');
    expect(bytes).not.toBeNull();
    // JPEG SOI marker — proves a real encode, not a passthrough.
    expect(bytes?.[0]).toBe(0xff);
    expect(bytes?.[1]).toBe(0xd8);
  });

  /**
   * `getMagick` returns a hand-assembled object of named imports rather than
   * the module namespace, so that the unused 64-bit glue tree-shakes out of
   * the kernel worker's cold-boot payload. A release that renames or drops a
   * member would leave a silent `undefined` here — the `as unknown as` cast
   * in the loader means TypeScript cannot catch it.
   */
  it('resolves every ImageMagickModule member to a real binding', () => {
    const members: (keyof ImageMagickModule)[] = [
      'initializeImageMagick',
      'ImageMagick',
      'MagickImageCollection',
      'Drawables',
      'MagickColor',
      'Magick',
      'AlphaAction',
      'ColorSpace',
      'Gravity',
      'MagickFormat',
      'MagickGeometry',
      'Percentage',
    ];
    for (const member of members) {
      expect(magick[member], `ImageMagickModule.${member} is missing from the glue`).toBeDefined();
    }
    // Spot-check that the enums carry real values, not empty objects.
    expect(magick.MagickFormat.Jpeg).toBe('JPEG');
    expect(typeof magick.Gravity.Center).toBe('number');
    expect(typeof magick.MagickImageCollection.create).toBe('function');
  });
});
