import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenCommand } from '../../../src/shell/supplemental-commands/open-command.js';

function createMockCtx(
  opts: { files?: Record<string, Uint8Array>; directories?: string[]; cwd?: string } = {}
) {
  const files = opts.files ?? {};
  const directories = new Set(opts.directories ?? []);
  return {
    cwd: opts.cwd ?? '/workspace',
    fs: {
      resolvePath: (_cwd: string, target: string) => {
        if (target.startsWith('/')) return target;
        return `${_cwd}/${target}`;
      },
      stat: vi.fn().mockImplementation(async (path: string) => {
        if (directories.has(path)) return { isFile: false, isDirectory: true };
        if (files[path]) return { isFile: true, isDirectory: false };
        throw new Error(`ENOENT: ${path}`);
      }),
      exists: vi.fn().mockImplementation(async (path: string) => !!files[path]),
      readFileBuffer: vi.fn().mockImplementation(async (path: string) => {
        if (files[path]) return files[path];
        throw new Error(`ENOENT: ${path}`);
      }),
    },
  };
}

// Build a minimal PNG with IHDR color_type = 6 (RGBA, has alpha).
function pngWithAlphaBytes(): Uint8Array {
  const b = new Uint8Array(26);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0x00, 0x00, 0x00, 0x0d], 8); // length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  // width(4) + height(4) + bit_depth(1) zeroed; color_type at offset 25
  b[25] = 6;
  return b;
}

function pngOpaqueBytes(): Uint8Array {
  const b = pngWithAlphaBytes();
  b[25] = 2; // RGB, no alpha
  return b;
}

function webpLosslessBytes(): Uint8Array {
  // RIFF....WEBPVP8L
  const b = new Uint8Array(16);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  b.set([0x57, 0x45, 0x42, 0x50], 8); // 'WEBP'
  b.set([0x56, 0x50, 0x38, 0x4c], 12); // 'VP8L'
  return b;
}

interface MockResize {
  createImageBitmap: ReturnType<typeof vi.fn>;
  canvasArgs: { width: number; height: number }[];
  convertCalls: { type: string; quality?: number }[];
  bitmapCloseSpies: ReturnType<typeof vi.fn>[];
  outputBytes: Uint8Array;
  convertToBlobOverride?: (opts: { type: string; quality?: number }) => Promise<Blob>;
}

function installImageMocks(
  bitmapWidth: number,
  bitmapHeight: number,
  outputBytes: Uint8Array = new Uint8Array([0xaa, 0xbb, 0xcc])
): MockResize {
  const state: MockResize = {
    createImageBitmap: vi.fn(),
    canvasArgs: [],
    convertCalls: [],
    bitmapCloseSpies: [],
    outputBytes,
  };
  state.createImageBitmap.mockImplementation(async () => {
    const close = vi.fn();
    state.bitmapCloseSpies.push(close);
    return { width: bitmapWidth, height: bitmapHeight, close };
  });
  (globalThis as any).createImageBitmap = state.createImageBitmap;
  (globalThis as any).OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      state.canvasArgs.push({ width: w, height: h });
    }
    getContext(kind: string) {
      if (kind !== '2d') return null;
      return { drawImage: vi.fn() };
    }
    async convertToBlob(opts: { type: string; quality?: number }) {
      state.convertCalls.push({ type: opts.type, quality: opts.quality });
      if (state.convertToBlobOverride) return state.convertToBlobOverride(opts);
      return new Blob([state.outputBytes as BlobPart], { type: opts.type });
    }
  };
  return state;
}

function uninstallImageMocks(): void {
  delete (globalThis as any).createImageBitmap;
  delete (globalThis as any).OffscreenCanvas;
}

describe('open command', () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    openSpy = vi.fn().mockReturnValue({});

    // Minimal window/document mocks
    (globalThis as any).window = { open: openSpy };
    (globalThis as any).document = {
      createElement: vi.fn().mockReturnValue({
        href: '',
        download: '',
        style: {},
        click: vi.fn(),
      }),
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
      },
    };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  it('errors when browser APIs are unavailable', async () => {
    // Temporarily remove window/document to simulate Node env
    const savedWindow = globalThis.window;
    const savedDocument = globalThis.document;
    delete (globalThis as any).window;
    delete (globalThis as any).document;

    const cmd = createOpenCommand();
    const result = await cmd.execute(['test.html'], {} as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('browser APIs are unavailable');

    (globalThis as any).window = savedWindow;
    (globalThis as any).document = savedDocument;
  });

  it('shows help with no args', async () => {
    const cmd = createOpenCommand();
    const result = await cmd.execute([], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: open');
  });

  it('shows help with --help', async () => {
    const cmd = createOpenCommand();
    const result = await cmd.execute(['--help'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--download');
  });

  it('opens a URL directly via window.open', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['https://example.com'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(result.stdout).toContain('opened https://example.com');
  });

  it('opens a VFS file path via preview service worker URL', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['/workspace/app/index.html'], ctx as any);

    expect(result.exitCode).toBe(0);
    // In Node test env (no chrome.runtime), falls back to localhost preview URL.
    // No project-root markers exist in the mock fs, so `findProjectRoot` falls
    // back to the file's own containing directory (`/workspace/app`).
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:5710/preview/workspace/app/index.html?projectRoot=%2Fworkspace%2Fapp',
      '_blank',
      'noopener,noreferrer'
    );
    expect(result.stdout).toContain('/workspace/app/index.html');
    expect(result.stdout).toContain('/preview/workspace/app/index.html');
  });

  it('opens a VFS directory via preview service worker URL', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['/workspace/app'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:5710/preview/workspace/app?projectRoot=%2Fworkspace',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('opens a relative VFS path resolved against cwd', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx({ cwd: '/workspace/project' });
    const result = await cmd.execute(['index.html'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:5710/preview/workspace/project/index.html?projectRoot=%2Fworkspace%2Fproject',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('detects a project root at a directory containing a marker file and uses it as projectRoot', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx({
      files: {
        '/shared/aem-boilerplate/head.html': new Uint8Array(),
        '/shared/aem-boilerplate/drafts/page.html': new Uint8Array(),
      },
    });
    const result = await cmd.execute(['/shared/aem-boilerplate/drafts/page.html'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:5710/preview/shared/aem-boilerplate/drafts/page.html' +
        '?projectRoot=%2Fshared%2Faem-boilerplate',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('detects the target itself as the project root when it is a directory containing a marker', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx({
      directories: ['/shared/aem-boilerplate'],
      files: {
        '/shared/aem-boilerplate/head.html': new Uint8Array(),
      },
    });
    const result = await cmd.execute(['/shared/aem-boilerplate'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:5710/preview/shared/aem-boilerplate?projectRoot=%2Fshared%2Faem-boilerplate',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('opens the tab via BrowserAPI.createPage and reports targetId when provided', async () => {
    const createPage = vi.fn().mockResolvedValue('target-123');
    const browserAPI = { createPage } as any;
    const cmd = createOpenCommand(browserAPI);
    const ctx = createMockCtx();
    const result = await cmd.execute(['/workspace/app/index.html'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(createPage).toHaveBeenCalledWith(
      'http://localhost:5710/preview/workspace/app/index.html?projectRoot=%2Fworkspace%2Fapp'
    );
    expect(openSpy).not.toHaveBeenCalled();
    expect(result.stdout).toContain('(targetId: target-123)');
  });

  it('downloads a VFS file with --download flag', async () => {
    const fileBytes = new Uint8Array([0x3c, 0x68, 0x31, 0x3e]);
    const cmd = createOpenCommand();
    const ctx = createMockCtx({ files: { '/workspace/test.html': fileBytes } });

    // Mock URL.createObjectURL and URL.revokeObjectURL
    const origCreateObjectURL = globalThis.URL?.createObjectURL;
    const origRevokeObjectURL = globalThis.URL?.revokeObjectURL;
    (globalThis as any).URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    (globalThis as any).URL.revokeObjectURL = vi.fn();

    const result = await cmd.execute(['--download', '/workspace/test.html'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('downloaded /workspace/test.html');
    expect(openSpy).not.toHaveBeenCalled(); // Should not open tab
    expect(ctx.fs.readFileBuffer).toHaveBeenCalledWith('/workspace/test.html');

    // Restore
    if (origCreateObjectURL) (globalThis as any).URL.createObjectURL = origCreateObjectURL;
    if (origRevokeObjectURL) (globalThis as any).URL.revokeObjectURL = origRevokeObjectURL;
  });

  it('downloads a VFS file with -d flag', async () => {
    const fileBytes = new Uint8Array([0x48, 0x65]);
    const cmd = createOpenCommand();
    const ctx = createMockCtx({ files: { '/workspace/file.txt': fileBytes } });

    const origCreateObjectURL = globalThis.URL?.createObjectURL;
    const origRevokeObjectURL = globalThis.URL?.revokeObjectURL;
    (globalThis as any).URL.createObjectURL = vi.fn().mockReturnValue('blob:mock');
    (globalThis as any).URL.revokeObjectURL = vi.fn();

    const result = await cmd.execute(['-d', '/workspace/file.txt'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('downloaded /workspace/file.txt');

    if (origCreateObjectURL) (globalThis as any).URL.createObjectURL = origCreateObjectURL;
    if (origRevokeObjectURL) (globalThis as any).URL.revokeObjectURL = origRevokeObjectURL;
  });

  it('fails download for directory with --download', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx();
    // Override stat to return isFile: false (directory)
    ctx.fs.stat.mockResolvedValueOnce({ isFile: false, isDirectory: true });
    const result = await cmd.execute(['--download', '/workspace/somedir'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a file');
  });

  it('fails download gracefully when file does not exist', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx(); // no files registered → stat throws ENOENT
    const result = await cmd.execute(['--download', '/workspace/missing.txt'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no such file');
  });

  it('fails download gracefully when read fails', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx();
    // stat succeeds but readFileBuffer throws
    ctx.fs.stat.mockResolvedValueOnce({ isFile: true, isDirectory: false });
    ctx.fs.readFileBuffer.mockRejectedValueOnce(new Error('EIO'));
    const result = await cmd.execute(['--download', '/workspace/broken.txt'], ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to read');
  });

  describe('--view (image inlining)', () => {
    afterEach(() => {
      uninstallImageMocks();
    });

    it('without --size prints dimensions + mime + size hint and exits 1', async () => {
      const png = pngWithAlphaBytes();
      const mocks = installImageMocks(1024, 768);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/image.png': png } });
      const result = await cmd.execute(['--view', '/workspace/image.png'], ctx as any);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('1024x768');
      expect(result.stderr).toContain('image/png');
      expect(result.stderr).toContain('--size');
      expect(result.stderr).toContain('low');
      expect(result.stderr).toContain('medium');
      expect(result.stderr).toContain('high');
      expect(result.stderr).toContain('WxH');
      expect(result.stdout).not.toContain('<img:data:');
      // No --size: must not allocate a canvas or invoke convertToBlob.
      expect(mocks.canvasArgs).toEqual([]);
      expect(mocks.convertCalls).toEqual([]);
      // The bitmap acquired for dimension-only decode must still be released.
      expect(mocks.bitmapCloseSpies).toHaveLength(1);
      expect(mocks.bitmapCloseSpies[0]).toHaveBeenCalledTimes(1);
    });

    it('APNG input is re-encoded as image/png (canvas does not support image/apng)', async () => {
      // pngWithAlphaBytes() produces bytes whose IHDR color_type = 6, so
      // sourceHasAlpha() returns true. The .apng extension drives
      // detectMimeType → 'image/apng'.
      const apng = pngWithAlphaBytes();
      const mocks = installImageMocks(500, 500);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/anim.apng': apng } });
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/anim.apng'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<img:data:image/png;base64,');
      expect(mocks.convertCalls[0]).toEqual({ type: 'image/png', quality: undefined });
    });

    it('releases the bitmap when convertToBlob rejects', async () => {
      const png = pngWithAlphaBytes();
      const mocks = installImageMocks(500, 500);
      mocks.convertToBlobOverride = async () => {
        throw new Error('encode failed');
      };
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/image.png': png } });
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/image.png'],
        ctx as any
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('encode failed');
      expect(mocks.bitmapCloseSpies).toHaveLength(1);
      expect(mocks.bitmapCloseSpies[0]).toHaveBeenCalledTimes(1);
    });

    it('with --size WxH inlines only the resized image (image/jpeg for opaque source)', async () => {
      const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xaa, 0xbb, 0xcc, 0xdd]);
      const mocks = installImageMocks(2048, 1024);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/photo.jpg': jpg } });
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/photo.jpg'],
        ctx as any
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<img:data:image/jpeg;base64,');
      expect(mocks.canvasArgs).toHaveLength(1);
      // Aspect-preserving fit into 256x256: scale = 256/2048 = 0.125
      expect(mocks.canvasArgs[0]).toEqual({ width: 256, height: 128 });
      expect(mocks.convertCalls[0]).toEqual({ type: 'image/jpeg', quality: 0.85 });
      // The inlined base64 must match the resize output, NOT the source bytes.
      const base64Source = Buffer.from(jpg).toString('base64');
      expect(result.stdout).not.toContain(base64Source);
    });

    it('--size low maps to 256x256', async () => {
      const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const mocks = installImageMocks(1000, 1000);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/photo.jpg': jpg } });
      const result = await cmd.execute(
        ['--view', '--size', 'low', '/workspace/photo.jpg'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(mocks.canvasArgs[0]).toEqual({ width: 256, height: 256 });
    });

    it('--size medium maps to 768x768', async () => {
      const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const mocks = installImageMocks(2000, 2000);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/photo.jpg': jpg } });
      const result = await cmd.execute(
        ['--view', '--size', 'medium', '/workspace/photo.jpg'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(mocks.canvasArgs[0]).toEqual({ width: 768, height: 768 });
    });

    it('--size high maps to 1536x1536', async () => {
      const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const mocks = installImageMocks(3000, 3000);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/photo.jpg': jpg } });
      const result = await cmd.execute(
        ['--view', '--size', 'high', '/workspace/photo.jpg'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(mocks.canvasArgs[0]).toEqual({ width: 1536, height: 1536 });
    });

    it('does not upscale when source is smaller than the box', async () => {
      const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      const mocks = installImageMocks(100, 50);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/photo.jpg': jpg } });
      const result = await cmd.execute(
        ['--view', '--size', '1024x1024', '/workspace/photo.jpg'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(mocks.canvasArgs[0]).toEqual({ width: 100, height: 50 });
    });

    it('preserves image/png mime when source PNG has alpha', async () => {
      const png = pngWithAlphaBytes();
      const mocks = installImageMocks(500, 500);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/image.png': png } });
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/image.png'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<img:data:image/png;base64,');
      expect(mocks.convertCalls[0]).toEqual({ type: 'image/png', quality: undefined });
    });

    it('re-encodes opaque PNG as image/jpeg', async () => {
      const png = pngOpaqueBytes();
      const mocks = installImageMocks(500, 500);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/image.png': png } });
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/image.png'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<img:data:image/jpeg;base64,');
      expect(mocks.convertCalls[0]).toEqual({ type: 'image/jpeg', quality: 0.85 });
    });

    it('preserves image/webp mime when source is lossless WebP', async () => {
      // Map .webp extension to image/webp via detectMimeType.
      const webp = webpLosslessBytes();
      const mocks = installImageMocks(800, 600);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/sticker.webp': webp } });
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/sticker.webp'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<img:data:image/webp;base64,');
      expect(mocks.convertCalls[0]).toEqual({ type: 'image/webp', quality: undefined });
    });

    it('-v short flag still works with --size', async () => {
      const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      installImageMocks(800, 800);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/photo.jpg': jpg } });
      const result = await cmd.execute(
        ['-v', '--size', '256x256', '/workspace/photo.jpg'],
        ctx as any
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('<img:data:image/jpeg;base64,');
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('--size garbage exits 1 with a parse error mentioning --size', async () => {
      const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
      installImageMocks(800, 800);
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/photo.jpg': jpg } });
      const result = await cmd.execute(
        ['--view', '--size', 'garbage', '/workspace/photo.jpg'],
        ctx as any
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--size');
      expect(result.stdout).not.toContain('<img:data:');
    });

    it('--size with no value exits 1 with a parse error mentioning --size', async () => {
      const cmd = createOpenCommand();
      const ctx = createMockCtx();
      const result = await cmd.execute(['--view', '--size'], ctx as any);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--size');
    });

    it('non-image target reports a decode error and does not fall back to raw base64', async () => {
      const textBytes = new TextEncoder().encode('not an image');
      const mocks = installImageMocks(0, 0);
      mocks.createImageBitmap.mockRejectedValueOnce(new Error('bad image'));
      const cmd = createOpenCommand();
      const ctx = createMockCtx({ files: { '/workspace/notes.txt': textBytes } });
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/notes.txt'],
        ctx as any
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not an image');
      expect(result.stdout).not.toContain('<img:data:');
    });

    it('fails --view gracefully when file does not exist', async () => {
      installImageMocks(100, 100);
      const cmd = createOpenCommand();
      const ctx = createMockCtx();
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/missing.png'],
        ctx as any
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('no such file');
    });

    it('fails --view for directory', async () => {
      installImageMocks(100, 100);
      const cmd = createOpenCommand();
      const ctx = createMockCtx();
      ctx.fs.stat.mockResolvedValueOnce({ isFile: false, isDirectory: true });
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/somedir'],
        ctx as any
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not a file');
    });

    it('fails --view gracefully when read fails', async () => {
      installImageMocks(100, 100);
      const cmd = createOpenCommand();
      const ctx = createMockCtx();
      ctx.fs.stat.mockResolvedValueOnce({ isFile: true, isDirectory: false });
      ctx.fs.readFileBuffer.mockRejectedValueOnce(new Error('EIO'));
      const result = await cmd.execute(
        ['--view', '--size', '256x256', '/workspace/broken.png'],
        ctx as any
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('failed to read');
    });

    it('help text documents --size', async () => {
      const cmd = createOpenCommand();
      const result = await cmd.execute(['--help'], {} as any);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('--size');
      expect(result.stdout).toContain('low');
      expect(result.stdout).toContain('medium');
      expect(result.stdout).toContain('high');
    });
  });

  it('succeeds even when window.open returns null (extension mode)', async () => {
    openSpy.mockReturnValue(null);
    const cmd = createOpenCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['/workspace/test.html'], ctx as any);

    // In extension contexts, window.open() returns null even when the tab opens
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('/workspace/test.html');
  });

  it('succeeds even when window.open returns null for URL (extension mode)', async () => {
    openSpy.mockReturnValue(null);
    const cmd = createOpenCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['https://example.com'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('opened https://example.com');
  });

  it('handles multiple targets', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(
      ['https://example.com', '/workspace/app/index.html'],
      ctx as any
    );

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(result.stdout).toContain('opened https://example.com');
    expect(result.stdout).toContain('/workspace/app/index.html');
  });

  it('shows help when only flags and no targets', async () => {
    const cmd = createOpenCommand();
    const result = await cmd.execute(['--download'], {} as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: open');
  });
});
