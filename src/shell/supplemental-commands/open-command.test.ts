import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createOpenCommand } from './open-command.js';

function createMockCtx(opts: { files?: Record<string, Uint8Array>; cwd?: string } = {}) {
  const files = opts.files ?? {};
  return {
    cwd: opts.cwd ?? '/workspace',
    fs: {
      resolvePath: (_cwd: string, target: string) => {
        if (target.startsWith('/')) return target;
        return `${_cwd}/${target}`;
      },
      stat: vi.fn().mockImplementation(async (path: string) => {
        if (files[path]) return { isFile: true, isDirectory: false };
        throw new Error(`ENOENT: ${path}`);
      }),
      readFileBuffer: vi.fn().mockImplementation(async (path: string) => {
        if (files[path]) return files[path];
        throw new Error(`ENOENT: ${path}`);
      }),
    },
  };
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
    // In Node test env (no chrome.runtime), falls back to localhost preview URL
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:3000/preview/workspace/app/index.html',
      '_blank',
      'noopener,noreferrer',
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
      'http://localhost:3000/preview/workspace/app',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens a relative VFS path resolved against cwd', async () => {
    const cmd = createOpenCommand();
    const ctx = createMockCtx({ cwd: '/workspace/project' });
    const result = await cmd.execute(['index.html'], ctx as any);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:3000/preview/workspace/project/index.html',
      '_blank',
      'noopener,noreferrer',
    );
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
    const result = await cmd.execute(['https://example.com', '/workspace/app/index.html'], ctx as any);

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
