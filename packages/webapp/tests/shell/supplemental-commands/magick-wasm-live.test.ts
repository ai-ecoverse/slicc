import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ImageMagickModule } from '../../../src/shell/supplemental-commands/magick-wasm.js';

vi.mock('../../../src/shell/supplemental-commands/shared.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isNodeRuntime: () => false,
}));

const PKG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../node_modules/@imagemagick/magick-wasm'
);

const LAYOUTS = ['dist/x86/magick.wasm', 'dist/magick.wasm'] as const;

const VFS_ROOT = '/workspace';
const VFS_PKG = `${VFS_ROOT}/node_modules/@imagemagick/magick-wasm`;

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

    expect(bytes?.[0]).toBe(0xff);
    expect(bytes?.[1]).toBe(0xd8);
  });

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

    expect(magick.MagickFormat.Jpeg).toBe('JPEG');
    expect(typeof magick.Gravity.Center).toBe('number');
    expect(typeof magick.MagickImageCollection.create).toBe('function');
  });
});
