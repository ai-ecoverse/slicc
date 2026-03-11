import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServeCommand } from './serve-command.js';

function normalizeMockPath(path: string): string {
  const resolved: string[] = [];

  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return `/${resolved.join('/')}`;
}

function createMockCtx(opts: {
  directories?: string[];
  files?: string[];
  cwd?: string;
} = {}) {
  const directories = new Set((opts.directories ?? []).map(normalizeMockPath));
  const files = new Set((opts.files ?? []).map(normalizeMockPath));

  return {
    cwd: opts.cwd ?? '/workspace',
    fs: {
      resolvePath: (cwd: string, target: string) => {
        return normalizeMockPath(target.startsWith('/') ? target : `${cwd}/${target}`);
      },
      stat: vi.fn().mockImplementation(async (path: string) => {
        const normalizedPath = normalizeMockPath(path);
        if (directories.has(normalizedPath)) return { isFile: false, isDirectory: true };
        if (files.has(normalizedPath)) return { isFile: true, isDirectory: false };
        throw new Error(`ENOENT: ${normalizedPath}`);
      }),
    },
  };
}

describe('serve command', () => {
  let originalWindow: typeof globalThis.window;
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    openSpy = vi.fn().mockReturnValue({});
    (globalThis as any).window = { open: openSpy };
  });

  afterEach(() => {
    globalThis.window = originalWindow;
  });

  it('shows help with no args', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: serve');
  });

  it('shows help with --help', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--help'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--entry');
  });

  it('errors when browser APIs are unavailable', async () => {
    const savedWindow = globalThis.window;
    delete (globalThis as any).window;

    const cmd = createServeCommand();
    const result = await cmd.execute(['/workspace/app'], {} as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('browser APIs are unavailable');

    (globalThis as any).window = savedWindow;
  });

  it('serves a directory with the default index.html entry', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['/workspace/app'], ctx as never);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:3000/preview/workspace/app/index.html',
      '_blank',
      'noopener,noreferrer',
    );
    expect(result.stdout).toContain('serving /workspace/app');
  });

  it('resolves relative directories against cwd', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      cwd: '/workspace/project',
      directories: ['/workspace/project/site'],
      files: ['/workspace/project/site/index.html'],
    });

    const result = await cmd.execute(['site'], ctx as never);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:3000/preview/workspace/project/site/index.html',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('supports a custom entry file', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/pages/home.html'],
    });

    const result = await cmd.execute(['--entry', 'pages/home.html', '/workspace/app'], ctx as never);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:3000/preview/workspace/app/pages/home.html',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('normalizes dot segments in a custom entry before opening the preview URL', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--entry', './index.html', '/workspace/app'], ctx as never);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:3000/preview/workspace/app/index.html',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('normalizes repeated separators in a custom entry before opening the preview URL', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/pages/home.html'],
    });

    const result = await cmd.execute(['--entry', 'pages//home.html', '/workspace/app'], ctx as never);

    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'http://localhost:3000/preview/workspace/app/pages/home.html',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('rejects path traversal in the entry file', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--entry=../escape.html', '/workspace/app'], ctx as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid entry file');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('errors when the directory does not exist', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['/workspace/missing'], ctx as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no such directory');
  });

  it('errors when the target is not a directory', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({ files: ['/workspace/file.html'] });
    const result = await cmd.execute(['/workspace/file.html'], ctx as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not a directory');
  });

  it('errors when the entry file does not exist', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({ directories: ['/workspace/app'] });
    const result = await cmd.execute(['/workspace/app'], ctx as never);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('entry file not found');
  });

  it('succeeds even when window.open returns null', async () => {
    openSpy.mockReturnValue(null);
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['/workspace/app'], ctx as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('/workspace/app');
  });
});