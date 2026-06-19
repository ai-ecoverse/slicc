import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConvertCommand,
  createIpkContextFromCtx,
} from '../../../src/shell/supplemental-commands/convert-command.js';
import * as magickWasm from '../../../src/shell/supplemental-commands/magick-wasm.js';

function createMockCtx(overrides: Partial<{ fs: Partial<IFileSystem>; cwd: string }> = {}) {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    readFileBuffer: vi.fn().mockRejectedValue(new Error('file not found')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: overrides.cwd ?? '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

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
    expect(result.stderr).toContain('expected exactly one input file and one output file');
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
    const result = await cmd.execute(['input.png', '-sharpen', '2', 'output.png'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unsupported option -sharpen');
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
    return {
      fs: fs as IFileSystem,
      cwd: '/workspace',
      env: new Map<string, string>(),
      stdin: '',
    };
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
    expect(Array.from(result!)).toEqual(Array.from(fakeWasm));
  });

  it('help text contains no CDN / jsdelivr references (zero network)', async () => {
    const cmd = createConvertCommand();
    const result = await cmd.execute(['--help'], createIpkMockCtx());
    expect(result.stdout).not.toMatch(/jsdelivr|unpkg|esm\.sh|https?:\/\//);
  });
});
