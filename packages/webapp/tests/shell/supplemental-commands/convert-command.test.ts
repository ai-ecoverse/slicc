import { readFileSync } from 'fs';
import type { IFileSystem } from 'just-bash';
import { createCommandContext, unsafeBytesFromLatin1 } from 'just-bash';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConvertCommand,
  createIpkContextFromCtx,
} from '../../../src/shell/supplemental-commands/convert-command.js';
import * as magickWasm from '../../../src/shell/supplemental-commands/magick-wasm.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const createMockCtx = (overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string }> = {}) =>
  mockCommandContext({
    fs: {
      readFileBuffer: vi.fn().mockRejectedValue(new Error('file not found')),
      writeFile: vi.fn().mockResolvedValue(undefined),
      ...overrides.fs,
    },
    cwd: overrides.cwd ?? '/home',
  });

describe('createConvertCommand', () => {
  it('returns a Command with the correct name', () => {
    const cmd = createConvertCommand();
    expect(cmd.name).toBe('convert');
  });

  it('returns a Command with a custom name', () => {
    const cmd = createConvertCommand('magick');
    expect(cmd.name).toBe('magick');
  });

  it('has an execute function', () => {
    const cmd = createConvertCommand();
    expect(typeof cmd.execute).toBe('function');
  });
});

describe('convert --help', () => {
  it('shows help with --help flag', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: convert');
    expect(result.stdout).toContain('-resize');
    expect(result.stdout).toContain('-rotate');
    expect(result.stdout).toContain('-crop');
    expect(result.stdout).toContain('-quality');
    expect(result.stdout).toContain('-thumbnail');
    expect(result.stdout).toContain('-auto-orient');
    expect(result.stdout).toContain('-extent');
    expect(result.stderr).toBe('');
  });

  it('shows help with -h flag', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['-h'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: convert');
  });

  it('shows help with no arguments', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: convert');
  });
});

describe('convert argument parsing errors', () => {
  it('errors when only input is provided (no output)', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['input.png'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected exactly one input file and one output file');
  });

  it('errors when more than 2 positional args are provided', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['input.png', 'extra.png', 'output.png'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('multiple input files require +append or -append');
  });

  it('errors when -resize is missing argument', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['input.png', '-resize'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing argument for -resize');
  });

  it('errors when -rotate is missing argument (followed by another flag)', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(
      ['input.png', '-rotate', '-quality', '80', 'output.png'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing argument for -rotate');
  });

  it('errors when -rotate is missing argument (at end)', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['input.png', 'output.png', '-rotate'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing argument for -rotate');
  });

  it('errors on unsupported option', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['input.png', '-emboss', '2', 'output.png'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported option -emboss');
  });

  it('requires an output after a zero-argument operation', async () => {
    const result = await createConvertCommand().execute(['input.png', '-flip'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected an output file');
  });

  it('uses custom command name in error messages', async () => {
    const cmd = createConvertCommand('magick');
    const result = await cmd.execute(['input.png'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('magick: expected exactly one input file and one output file');
  });

  it('errors when input file does not exist', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['missing.png', 'output.png'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
  });

  it('help is shown even if --help is among other args', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['input.png', '--help', 'output.png'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: convert');
  });
});

describe('convert argument parsing (valid args, file-not-found)', () => {
  // These test that argument parsing succeeds but the command fails at file read
  // (since we can't load WASM in Node tests)

  it('parses -resize WxH and proceeds to file read', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(
      ['input.png', '-resize', '800x600', 'output.png'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
    // It got past arg parsing (no "unsupported option" error)
    expect(result.stderr).not.toContain('unsupported option');
  });

  it('parses -rotate and proceeds to file read', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['input.png', '-rotate', '90', 'output.png'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
    expect(result.stderr).not.toContain('unsupported option');
  });

  it('parses -crop and proceeds to file read', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(
      ['input.png', '-crop', '100x100+0+0', 'output.png'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
    expect(result.stderr).not.toContain('unsupported option');
  });

  it('parses -quality and proceeds to file read', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(
      ['input.png', '-quality', '85', 'output.png'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
    expect(result.stderr).not.toContain('unsupported option');
  });

  it('parses multiple operations and proceeds to file read', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(
      ['input.png', '-resize', '800x600', '-rotate', '90', '-quality', '75', 'output.png'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('file not found');
    expect(result.stderr).not.toContain('unsupported option');
  });

  it('resolves paths relative to cwd', async () => {
    const readFileBuffer = vi.fn().mockRejectedValue(new Error('file not found'));
    const cmd = createConvertCommand();
    await cmd.execute(['photo.png', 'out.png'], createMockCtx({ fs: { readFileBuffer } }));
    expect(readFileBuffer).toHaveBeenCalledWith('/home/photo.png');
  });
});

describe('convert image composition', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function installCompositionMock(imageSizes: Array<{ width: number; height: number }> = []) {
    const appendDirections: string[] = [];
    const appendChildCounts: number[] = [];
    const drawCalls: Array<{ image: string; steps: string[] }> = [];
    const operationCalls: string[] = [];
    const addFont = vi.fn();
    let imageNumber = 0;
    class MockGeometry {
      constructor(
        readonly value: string | number,
        readonly height?: number
      ) {}
    }
    const createImage = (name: string, width = 160, height = 284) => {
      const image = {
        name,
        width,
        height,
        quality: 0,
        set backgroundColor(color: { value: string }) {
          operationCalls.push(`background:${color.value}`);
        },
        set colorSpace(value: number) {
          operationCalls.push(`colorspace:${value}`);
        },
        alpha: (value: number) => operationCalls.push(`alpha:${value}`),
        autoGamma: () => operationCalls.push('auto-gamma'),
        autoLevel: () => operationCalls.push('auto-level'),
        autoOrient: () => operationCalls.push('auto-orient'),
        blur: (radius: number, sigma: number) => operationCalls.push(`blur:${radius}x${sigma}`),
        resize: (geometry: MockGeometry) => operationCalls.push(`resize:${geometry.value}`),
        rotate: vi.fn(),
        crop: (geometry: MockGeometry, gravity?: number) =>
          operationCalls.push(`crop:${geometry.value}:${gravity ?? 'none'}`),
        extent: (geometry: MockGeometry, ...args: Array<number | { value: string }>) => {
          if (typeof geometry.value === 'number' && geometry.height !== undefined) {
            image.width = geometry.value;
            image.height = geometry.height;
          }
          operationCalls.push(
            `extent:${geometry.value}:${args.map((arg) => (typeof arg === 'number' ? arg : arg.value)).join(':')}`
          );
        },
        flip: () => operationCalls.push('flip'),
        flop: () => operationCalls.push('flop'),
        negate: () => operationCalls.push('negate'),
        normalize: () => operationCalls.push('normalize'),
        sharpen: (radius: number, sigma: number) =>
          operationCalls.push(`sharpen:${radius}x${sigma}`),
        strip: () => operationCalls.push('strip'),
        thumbnail: (geometry: MockGeometry) => operationCalls.push(`thumbnail:${geometry.value}`),
        transparent: (color: { value: string }) =>
          operationCalls.push(`transparent:${color.value}`),
        trim: () => operationCalls.push('trim'),
        write: vi.fn((_format: string, callback: (data: Uint8Array) => void) => {
          callback(new Uint8Array([1, 2, 3]));
        }),
      };
      return image;
    };
    class MockDrawables {
      steps: string[] = [];
      gravity(value: number) {
        this.steps.push(`gravity:${value}`);
        return this;
      }
      fillColor(color: { value: string }) {
        this.steps.push(`fill:${color.value}`);
        return this;
      }
      textUnderColor(color: { value: string }) {
        this.steps.push(`undercolor:${color.value}`);
        return this;
      }
      font(name: string) {
        this.steps.push(`font:${name}`);
        return this;
      }
      fontPointSize(value: number) {
        this.steps.push(`pointsize:${value}`);
        return this;
      }
      text(x: number, y: number, value: string) {
        this.steps.push(`text:${x},${y}:${value}`);
        return this;
      }
      draw(image: { name: string }) {
        drawCalls.push({ image: image.name, steps: [...this.steps] });
        return this;
      }
    }
    const read = vi.fn(async (_bytes: Uint8Array, callback: (image: unknown) => Promise<void>) => {
      const index = imageNumber++;
      const size = imageSizes[index];
      await callback(createImage(`input-${index}`, size?.width, size?.height));
    });
    vi.spyOn(magickWasm, 'getMagick').mockResolvedValue({
      ImageMagick: { read },
      MagickImageCollection: {
        create: () => {
          const collection = [] as unknown as Array<unknown> & {
            appendHorizontally: (callback: (image: unknown) => Promise<void>) => Promise<void>;
            appendVertically: (callback: (image: unknown) => Promise<void>) => Promise<void>;
            dispose: () => void;
          };
          collection.appendHorizontally = async (callback) => {
            appendDirections.push('horizontal');
            appendChildCounts.push(collection.length);
            await callback(createImage('horizontal'));
          };
          collection.appendVertically = async (callback) => {
            appendDirections.push('vertical');
            appendChildCounts.push(collection.length);
            await callback(createImage('vertical'));
          };
          collection.dispose = vi.fn();
          return collection;
        },
      },
      Drawables: MockDrawables,
      MagickColor: class {
        readonly r = 0;
        readonly g = 0;
        readonly b = 0;
        readonly a = 0;
        constructor(readonly value: string) {}
      },
      Magick: { addFont },
      AlphaAction: { Extract: 8, Off: 9, Remove: 12, Set: 13, OffIfOpaque: 16 },
      ColorSpace: { CMYK: 2, Gray: 3, sRGB: 23 },
      Gravity: { Center: 5, South: 8 },
      MagickFormat: { JPEG: 'JPEG', PNG: 'PNG' },
      MagickGeometry: MockGeometry,
      Percentage: class {},
      initializeImageMagick: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof magickWasm.getMagick>>);
    return { addFont, appendChildCounts, appendDirections, drawCalls, operationCalls, read };
  }

  it('joins multiple inputs horizontally with +append', async () => {
    const { appendDirections, read } = installCompositionMock();
    const readFileBuffer = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const result = await createConvertCommand().execute(
      ['f00.jpg', 'f01.jpg', 'f02.jpg', 'f03.jpg', '+append', '/tmp/filmstrip.jpg'],
      createMockCtx({ fs: { readFileBuffer, writeFile } })
    );
    expect(result.exitCode).toBe(0);
    expect(read).toHaveBeenCalledTimes(4);
    expect(appendDirections).toEqual(['horizontal']);
    expect(writeFile).toHaveBeenCalledWith('/tmp/filmstrip.jpg', new Uint8Array([1, 2, 3]));
  });

  it('reads repeated input paths only once', async () => {
    const { read } = installCompositionMock();
    const readFileBuffer = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const result = await createConvertCommand().execute(
      ['same.jpg', 'same.jpg', '+append', '/tmp/repeated.jpg'],
      createMockCtx({ fs: { readFileBuffer } })
    );

    expect(result.exitCode).toBe(0);
    expect(readFileBuffer).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('supports nested horizontal rows joined with -append', async () => {
    const { appendDirections } = installCompositionMock();
    const result = await createConvertCommand().execute(
      [
        '(',
        'f00.jpg',
        'f01.jpg',
        '+append',
        ')',
        '(',
        'f02.jpg',
        'f03.jpg',
        '+append',
        ')',
        '-append',
        '/tmp/grid.jpg',
      ],
      createMockCtx({ fs: { readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1])) } })
    );
    expect(result.exitCode).toBe(0);
    expect(appendDirections).toEqual(['horizontal', 'horizontal', 'vertical']);
  });

  it('appends every image in the current ungrouped sequence', async () => {
    const { appendChildCounts } = installCompositionMock();
    const result = await createConvertCommand().execute(
      ['a.jpg', 'b.jpg', '+append', 'c.jpg', 'd.jpg', '+append', 'output.jpg'],
      createMockCtx({ fs: { readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1])) } })
    );

    expect(result.exitCode).toBe(0);
    expect(appendChildCounts).toEqual([2, 3]);
  });

  it('uses background and gravity when padding mixed-size append inputs', async () => {
    const { operationCalls } = installCompositionMock([
      { width: 100, height: 50 },
      { width: 80, height: 100 },
    ]);
    const result = await createConvertCommand().execute(
      ['a.png', 'b.png', '-background', 'white', '-gravity', 'center', '+append', 'output.png'],
      createMockCtx({ fs: { readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1])) } })
    );

    expect(result.exitCode).toBe(0);
    expect(operationCalls).toContain('extent:100:5:white');
  });

  it('retries annotation font loading after a transient failure', async () => {
    const { addFont } = installCompositionMock();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary font failure'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    vi.stubGlobal('fetch', fetchMock);
    const args = ['input.jpg', '-annotate', '+0+0', 'label', 'output.jpg'];
    const context = createMockCtx({
      fs: { readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1])) },
    });

    const first = await createConvertCommand().execute(args, context);
    const second = await createConvertCommand().execute(args, context);

    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain('temporary font failure');
    expect(second.exitCode).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(addFont).toHaveBeenCalledWith('AdobeClean-Regular.otf', new Uint8Array([1, 2, 3]));
  });

  it('applies gravity, colors, point size, and annotation within input groups', async () => {
    const { addFont, appendDirections, drawCalls } = installCompositionMock();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })
    );
    const result = await createConvertCommand().execute(
      [
        '(',
        'f00.jpg',
        '-gravity',
        'south',
        '-fill',
        'white',
        '-undercolor',
        '#00000080',
        '-pointsize',
        '14',
        '-annotate',
        '+0+2',
        '0:06',
        ')',
        '(',
        'f01.jpg',
        '-gravity',
        'south',
        '-fill',
        'white',
        '-undercolor',
        '#00000080',
        '-pointsize',
        '14',
        '-annotate',
        '+0+2',
        '0:19',
        ')',
        '+append',
        '/tmp/labeled.jpg',
      ],
      createMockCtx({ fs: { readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1])) } })
    );
    expect(result.exitCode).toBe(0);
    expect(addFont).toHaveBeenCalledWith('AdobeClean-Regular.otf', new Uint8Array([1, 2, 3]));
    expect(appendDirections).toEqual(['horizontal']);
    expect(drawCalls).toEqual([
      {
        image: 'input-0',
        steps: [
          'gravity:8',
          'fill:white',
          'undercolor:#00000080',
          'font:AdobeClean-Regular.otf',
          'pointsize:14',
          'text:0,2:0:06',
        ],
      },
      {
        image: 'input-1',
        steps: [
          'gravity:8',
          'fill:white',
          'undercolor:#00000080',
          'font:AdobeClean-Regular.otf',
          'pointsize:14',
          'text:0,2:0:19',
        ],
      },
    ]);
  });

  it('supports common resize, orientation, cleanup, mirror, and filter operations', async () => {
    const { operationCalls } = installCompositionMock();
    const result = await createConvertCommand().execute(
      [
        'input.jpg',
        '-resize',
        '800x600^',
        '-thumbnail',
        '200x200>',
        '-auto-orient',
        '-flip',
        '-flop',
        '-strip',
        '-trim',
        '-auto-gamma',
        '-auto-level',
        '-normalize',
        '-negate',
        '-blur',
        '0x2',
        '-sharpen',
        '0x1.5',
        'output.jpg',
      ],
      createMockCtx({ fs: { readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1])) } })
    );
    expect(result.exitCode).toBe(0);
    expect(operationCalls).toEqual([
      'resize:800x600^',
      'thumbnail:200x200>',
      'auto-orient',
      'flip',
      'flop',
      'strip',
      'trim',
      'auto-gamma',
      'auto-level',
      'normalize',
      'negate',
      'blur:0x2',
      'sharpen:0x1.5',
    ]);
  });

  it('supports canvas, transparency, and colorspace operations', async () => {
    const { operationCalls } = installCompositionMock();
    const result = await createConvertCommand().execute(
      [
        'input.png',
        '-background',
        'white',
        '-gravity',
        'center',
        '-crop',
        '100x100-5+10',
        '-extent',
        '800x600+0+0',
        '-alpha',
        'off-if-opaque',
        '-colorspace',
        'gray',
        '-transparent',
        'white',
        'output.png',
      ],
      createMockCtx({ fs: { readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1])) } })
    );
    expect(result.exitCode).toBe(0);
    expect(operationCalls).toEqual([
      'background:white',
      'crop:100x100-5+10:5',
      'extent:800x600+0+0:5:white',
      'alpha:16',
      'colorspace:3',
      'transparent:white',
    ]);
  });

  it.each([
    [['input.png', '-extent', '100', 'output.png'], 'Invalid extent geometry'],
    [['input.png', '-blur', 'nope', 'output.png'], 'Invalid blur radius/sigma'],
    [['input.png', '-colorspace', 'made-up', 'output.png'], 'Invalid colorspace'],
    [['input.png', '-alpha', 'made-up', 'output.png'], 'Invalid alpha mode'],
  ])('rejects invalid common option values: %s', async (args, message) => {
    installCompositionMock();
    const result = await createConvertCommand().execute(
      args,
      createMockCtx({ fs: { readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([1])) } })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
  });
});

describe('convert output snapshot (regression: WASM heap clobber)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('copies the image.write callback data so post-callback heap reuse cannot mangle the output', async () => {
    // magick-wasm hands us a Uint8Array view INTO its linear memory.
    // After the callback returns, the runtime is free to reuse those
    // bytes for other allocations. If convert holds the raw view
    // across `await ctx.fs.writeFile(...)`, the bytes the FS layer
    // reads can be whatever junk emscripten wrote next — in the
    // wild that's null-terminated format names and similar ASCII
    // text, which made the on-disk file land as "UTF-8 text with
    // CRLF terminators" garbage. Pin that we snapshot synchronously.
    const heap = new Uint8Array(64);
    for (let i = 0; i < 8; i++) heap[i] = i + 1; // 1..8 — distinctive
    const view = new Uint8Array(heap.buffer, 0, 8);

    const writtenContent: unknown[] = [];
    const cmd = createConvertCommand();
    const ctx = createMockCtx({
      fs: {
        readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff])),
        writeFile: vi.fn(async (_path: string, content: unknown) => {
          writtenContent.push(content);
        }),
      },
    });

    const mockImage = {
      width: 10,
      height: 10,
      quality: 0,
      resize: vi.fn(),
      rotate: vi.fn(),
      crop: vi.fn(),
      write: vi.fn((_format: string, cb: (data: Uint8Array) => void) => {
        cb(view);
        // Simulate emscripten reusing the heap region after the
        // callback returns — overwrite with text-looking bytes.
        for (let i = 0; i < 8; i++) heap[i] = '\n'.charCodeAt(0);
      }),
    };

    vi.spyOn(magickWasm, 'getMagick').mockResolvedValue({
      ImageMagick: {
        read: vi.fn(async (_bytes: Uint8Array, fn: (image: unknown) => Promise<void>) => {
          await fn(mockImage);
        }),
      },
      MagickFormat: { JPEG: 'JPEG', PNG: 'PNG' } as Record<string, string>,
      MagickGeometry: class {
        ignoreAspectRatio = false;
        constructor() {}
      },
      Percentage: class {
        constructor(_n: number) {}
        toDouble() {
          return 0;
        }
      },
      initializeImageMagick: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof magickWasm.getMagick>>);

    const result = await cmd.execute(['/tmp/in.png', '/tmp/out.png'], ctx);
    expect(result.exitCode).toBe(0);
    expect(writtenContent.length).toBe(1);

    const persisted = writtenContent[0];
    expect(persisted).toBeInstanceOf(Uint8Array);
    const persistedBytes = persisted as Uint8Array;
    // Pre-clobber bytes — if convert had kept the raw view, this
    // would now be all `\n`.
    expect(Array.from(persistedBytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // And the snapshot must own its own backing buffer, not the
    // shared heap — otherwise a later post-write clobber would
    // still propagate.
    expect(persistedBytes.buffer).not.toBe(heap.buffer);
  });

  it('rejects a zero-byte buffer with a clear error instead of writing a 0-byte JPEG', async () => {
    // `!new Uint8Array(0)` is `false` (Uint8Array instances are
    // truthy regardless of length), so the byte-length check is
    // load-bearing. Magick-wasm has been observed handing back an
    // empty buffer on certain unsupported-format quirks; without the
    // length guard the user gets exit 0 and a 0-byte file that
    // looks fine until the next consumer chokes.
    const writtenContent: unknown[] = [];
    const cmd = createConvertCommand();
    const ctx = createMockCtx({
      fs: {
        readFileBuffer: vi.fn().mockResolvedValue(new Uint8Array([0xff, 0xd8, 0xff])),
        writeFile: vi.fn(async (_path: string, content: unknown) => {
          writtenContent.push(content);
        }),
      },
    });

    const mockImage = {
      width: 10,
      height: 10,
      quality: 0,
      resize: vi.fn(),
      rotate: vi.fn(),
      crop: vi.fn(),
      write: vi.fn((_format: string, cb: (data: Uint8Array) => void) => {
        cb(new Uint8Array(0));
      }),
    };

    vi.spyOn(magickWasm, 'getMagick').mockResolvedValue({
      ImageMagick: {
        read: vi.fn(async (_bytes: Uint8Array, fn: (image: unknown) => Promise<void>) => {
          await fn(mockImage);
        }),
      },
      MagickFormat: { JPEG: 'JPEG', PNG: 'PNG' } as Record<string, string>,
      MagickGeometry: class {
        ignoreAspectRatio = false;
      },
      Percentage: class {
        constructor(_n: number) {}
        toDouble() {
          return 0;
        }
      },
      initializeImageMagick: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof magickWasm.getMagick>>);

    const result = await cmd.execute(['/tmp/in.png', '/tmp/out.png'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Failed to generate output image');
    expect(writtenContent).toHaveLength(0);
  });
});

describe('install-required guidance (browser branch)', () => {
  // Vitest runs under Node so `getMagick`'s Node fallback always resolves
  // the locally-installed npm `@imagemagick/magick-wasm`. Exercise the
  // browser-branch resolver helper directly to pin the
  // null-when-absent / bytes-when-installed behavior. The end-to-end
  // guidance path is exercised manually per the task's verification plan
  // (`ipk add @imagemagick/magick-wasm && convert in.png out.jpg`).

  function createIpkMockCtx() {
    const fileStore = new Map<string, string | Uint8Array>();
    const dirSet = new Set<string>(['/workspace']);
    const fs: Partial<IFileSystem> = {
      resolvePath: (base: string, path: string) =>
        path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path}`,
      exists: vi.fn().mockImplementation(async (p: string) => fileStore.has(p) || dirSet.has(p)),
      stat: vi.fn().mockImplementation(async (p: string) => {
        if (fileStore.has(p)) {
          const v = fileStore.get(p)!;
          return { isFile: true, isDirectory: false, size: v.length };
        }
        if (dirSet.has(p)) return { isFile: false, isDirectory: true, size: 0 };
        throw new Error(`ENOENT: ${p}`);
      }),
      readFile: vi.fn().mockImplementation(async (p: string) => {
        const v = fileStore.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return typeof v === 'string' ? v : new TextDecoder().decode(v);
      }),
      readFileBuffer: vi.fn().mockImplementation(async (p: string) => {
        const v = fileStore.get(p);
        if (v === undefined) throw new Error(`ENOENT: ${p}`);
        return typeof v === 'string' ? new TextEncoder().encode(v) : v;
      }),
      writeFile: vi.fn().mockImplementation(async (p: string, content: string | Uint8Array) => {
        fileStore.set(p, content);
        const parts = p.split('/').slice(0, -1);
        for (let i = 1; i <= parts.length; i++) {
          dirSet.add(parts.slice(0, i).join('/') || '/');
        }
      }),
    };
    return createCommandContext({
      fs: fs as IFileSystem,
      cwd: '/workspace',
      env: new Map<string, string>(),
      stdin: unsafeBytesFromLatin1(''),
    });
  }

  it('tryLoadMagickWasmFromNodeModules returns null when the package is absent', async () => {
    const ctx = createIpkMockCtx();
    const result = await magickWasm.tryLoadMagickWasmFromNodeModules(createIpkContextFromCtx(ctx));
    expect(result).toBeNull();
  });

  it('tryLoadMagickWasmFromNodeModules reads dist/magick.wasm when installed', async () => {
    const ctx = createIpkMockCtx();
    await ctx.fs.writeFile(
      '/workspace/node_modules/@imagemagick/magick-wasm/package.json',
      JSON.stringify({ name: '@imagemagick/magick-wasm', version: '0.0.38', main: 'dist/index.js' })
    );
    const fakeWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    await ctx.fs.writeFile(
      '/workspace/node_modules/@imagemagick/magick-wasm/dist/magick.wasm',
      fakeWasm
    );
    const result = await magickWasm.tryLoadMagickWasmFromNodeModules(createIpkContextFromCtx(ctx));
    expect(result).not.toBeNull();
    expect(Array.from(result!.bytes)).toEqual(Array.from(fakeWasm));
    expect(result!.version).toBe('0.0.38');
  });

  it('help text contains no CDN / jsdelivr references (zero network)', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['--help'], createIpkMockCtx());
    expect(result.stdout).not.toMatch(/jsdelivr|unpkg|esm\.sh|https?:\/\//);
  });
});

/**
 * Regression for the production `convert` hang (F-C04, PR #1085). The
 * webapp bundles the `@imagemagick/magick-wasm` JS glue at exactly
 * `BUNDLED_MAGICK_VERSION`, but a bare `ipk add @imagemagick/magick-wasm`
 * installs npm-latest into the VFS. Feeding the bundled glue a `magick.wasm`
 * from a different release makes emscripten's `initializeImageMagick` hang
 * forever in the kernel DedicatedWorker (a run dependency is never
 * fulfilled), which only surfaced as a 30s `withInitTimeout` rejection.
 * Live-verified: matched 0.0.40 glue+wasm completes a real resize in ~14ms
 * (rc=0); mismatched 0.0.40 glue + 0.0.41 wasm hangs the full 30s. The
 * loader now guards the version contract and pins the install guidance.
 */
describe('glue/wasm version guard (F-C04 hang root cause)', () => {
  it('passes silently when the installed wasm matches the bundled glue', () => {
    expect(() =>
      magickWasm.assertMagickVersionMatch(magickWasm.BUNDLED_MAGICK_VERSION)
    ).not.toThrow();
  });

  it('throws actionable, version-pinned guidance on a mismatch', () => {
    expect(() => magickWasm.assertMagickVersionMatch('0.0.40')).toThrow(/version mismatch/);
    expect(() => magickWasm.assertMagickVersionMatch('0.0.40')).toThrow(
      new RegExp(`ipk add @imagemagick/magick-wasm@${magickWasm.BUNDLED_MAGICK_VERSION}`)
    );
    // The mismatch message names both versions so the fix is unambiguous.
    expect(() => magickWasm.assertMagickVersionMatch('0.0.40')).toThrow(/0\.0\.40/);
    expect(() => magickWasm.assertMagickVersionMatch('0.0.40')).toThrow(
      new RegExp(magickWasm.BUNDLED_MAGICK_VERSION.replace(/\./g, '\\.'))
    );
  });

  it('keeps BUNDLED_MAGICK_VERSION in lockstep with the installed package', () => {
    const require = createRequire(import.meta.url);
    const main = require.resolve('@imagemagick/magick-wasm');
    const pkg = JSON.parse(readFileSync(resolve(dirname(main), '../package.json'), 'utf-8'));
    expect(magickWasm.BUNDLED_MAGICK_VERSION).toBe(pkg.version);
  });
});

/**
 * Regression for NS1 / F-C04: `convert` / `magick` hung on every real
 * operation in the PRODUCTION `vite build`. A dynamic
 * `import('@imagemagick/magick-wasm')` inside the kernel DedicatedWorker
 * compiles to a separate Rollup chunk wrapped in Vite's `__vitePreload`
 * helper (which touches `document` / `window`) and never settles in the
 * worker — `optimizeDeps.include` only papered over it in dev. The glue
 * MUST be imported statically (like `@ffmpeg/ffmpeg` in `ffmpeg-wasm.ts`)
 * so the production worker bundle resolves it inline. This is a
 * bundling-shape invariant a runtime unit test cannot exercise, so we
 * pin it at the source level instead.
 */
describe('magick-wasm import shape (NS1 / F-C04 regression)', () => {
  const magickSrc = readFileSync(
    resolve(__dirname, '../../../src/shell/supplemental-commands/magick-wasm.ts'),
    'utf-8'
  );

  it('imports @imagemagick/magick-wasm statically, not via dynamic import()', () => {
    expect(magickSrc).toMatch(/import \* as magickModule from '@imagemagick\/magick-wasm'/);
    expect(magickSrc).not.toMatch(/import\(\s*['"]@imagemagick\/magick-wasm['"]\s*\)/);
  });

  it('mirrors the static-import pattern proven by ffmpeg-wasm.ts', () => {
    const ffmpegSrc = readFileSync(
      resolve(__dirname, '../../../src/shell/supplemental-commands/ffmpeg-wasm.ts'),
      'utf-8'
    );
    expect(ffmpegSrc).not.toMatch(/import\(\s*['"]@ffmpeg\/ffmpeg['"]\s*\)/);
  });

  /**
   * Regression for the kernel-worker WASM bring-up hang (PR #1085, EXT
   * blocker B): `convert` / `magick` ran `initializeImageMagick(bytes)`,
   * which drives emscripten's async byte path
   * (`wasmBinary` → `WebAssembly.instantiate(bytes)`) and wedges inside
   * the kernel DedicatedWorker on every real op. The fix compiles the
   * bytes to a `WebAssembly.Module` host-side via the shared
   * `compileWasmModule` primitive (same one biome/esbuild use) and hands
   * the module to `initializeImageMagick`, forcing the synchronous
   * `new WebAssembly.Instance(module, imports)` bring-up. Pinned at the
   * source level since the worker-bundle behavior a unit test cannot run.
   */
  it('compiles the wasm to a WebAssembly.Module host-side before init', () => {
    expect(magickSrc).toMatch(
      /import \{ compileWasmModule \} from '\.\.\/\.\.\/kernel\/realm\/wasm-compiler\.js'/
    );
    // The browser/extension paths compile bytes and hand the module to init.
    expect(magickSrc).toMatch(/compileWasmModule\(/);
    expect(magickSrc).toMatch(/initializeImageMagick\(wasmModule\)/);
  });

  it('bounds initializeImageMagick with a timeout so a wedged bring-up surfaces', () => {
    expect(magickSrc).toMatch(/withInitTimeout\(magickModule\.initializeImageMagick\(/);
  });

  /**
   * Regression for the F-C04 production hang: the bundled glue version and
   * the ipk-installed `magick.wasm` version must match or init hangs. The
   * browser loader must guard the version BEFORE compiling/instantiating so
   * a mismatch fails fast with actionable guidance instead of wedging the
   * worker for 30s.
   */
  it('guards the glue/wasm version before compiling in the browser path', () => {
    expect(magickSrc).toMatch(/assertMagickVersionMatch\(installed\.version\)/);
    // The guard must precede the host-compile step.
    const guardIdx = magickSrc.indexOf('assertMagickVersionMatch(installed.version)');
    const compileIdx = magickSrc.indexOf('compileWasmModule(bytes)');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(compileIdx).toBeGreaterThan(guardIdx);
  });
});

describe('withInitTimeout', () => {
  it('resolves with the init result when init settles before the timeout', async () => {
    await expect(magickWasm.withInitTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('rejects with a clear timeout error when init never settles', async () => {
    const neverSettles = new Promise<void>(() => {});
    await expect(magickWasm.withInitTimeout(neverSettles, 10)).rejects.toThrow(
      /ImageMagick WASM initialization timed out after 10ms/
    );
  });

  it('propagates the init rejection (not the timeout) when init fails first', async () => {
    const boom = Promise.reject(new Error('boom'));
    await expect(magickWasm.withInitTimeout(boom, 1000)).rejects.toThrow(/boom/);
  });

  it('exposes a positive default timeout bound', () => {
    expect(magickWasm.MAGICK_INIT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
