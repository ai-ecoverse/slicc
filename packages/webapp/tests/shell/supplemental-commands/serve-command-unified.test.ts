import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPreviewMinter } from '../../../src/scoops/preview-minter.js';
import { createServeCommand } from '../../../src/shell/supplemental-commands/serve-command.js';

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

function createMockCtx(opts: { directories?: string[]; files?: string[]; cwd?: string } = {}) {
  const directories = new Set((opts.directories ?? []).map(normalizeMockPath));
  const files = new Set((opts.files ?? []).map(normalizeMockPath));
  return {
    cwd: opts.cwd ?? '/workspace',
    fs: {
      resolvePath: (cwd: string, target: string) =>
        normalizeMockPath(target.startsWith('/') ? target : `${cwd}/${target}`),
      stat: vi.fn().mockImplementation(async (path: string) => {
        const normalizedPath = normalizeMockPath(path);
        if (directories.has(normalizedPath)) return { isFile: false, isDirectory: true };
        if (files.has(normalizedPath)) return { isFile: true, isDirectory: false };
        throw new Error(`ENOENT: ${normalizedPath}`);
      }),
    },
  };
}

describe('serve command (unified preview)', () => {
  let originalWindow: typeof globalThis.window;
  let openSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalWindow = globalThis.window;
    openSpy = vi.fn().mockReturnValue({});
    (globalThis as unknown as { window: { open: typeof openSpy } }).window = { open: openSpy };
    setPreviewMinter(null);
    delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    setPreviewMinter(null);
    delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
  });

  it('shows help with no args', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: serve');
    expect(result.stdout).toContain('--bridge');
    expect(result.stdout).toContain('--no-bridge');
  });

  it('shows help with --help and exits 0', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--help'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--entry');
    expect(result.stdout).toContain('--stop');
    expect(result.stdout).toContain('--list');
  });

  it('mints via the in-realm minter when set and reports url + follower count', async () => {
    const minter = vi.fn().mockResolvedValue({
      url: 'https://abc123.preview.sliccy.ai/index.html',
      pushed: 3,
    });
    setPreviewMinter(minter);

    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['/workspace/app'], ctx as never);

    expect(result.exitCode).toBe(0);
    expect(minter).toHaveBeenCalledTimes(1);
    expect(minter).toHaveBeenCalledWith({
      entryPath: '/workspace/app/index.html',
      servedRoot: '/workspace/app',
      bridge: false,
      noBridge: false,
    });
    expect(result.stdout).toContain('Preview URL: https://abc123.preview.sliccy.ai/index.html');
    expect(result.stdout).toContain('Pushed to 3 followers');
  });

  it('singularizes follower count when pushed === 1', async () => {
    setPreviewMinter(async () => ({ url: 'https://x.preview.sliccy.ai/i.html', pushed: 1 }));
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });
    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Pushed to 1 follower\n');
    expect(result.stdout).not.toContain('1 followers');
  });

  it('opens the leader tab via BrowserAPI.createPage when provided', async () => {
    setPreviewMinter(async () => ({
      url: 'https://abc123.preview.sliccy.ai/index.html',
      pushed: 0,
    }));
    const createPage = vi.fn().mockResolvedValue('target-123');
    const browserAPI = { createPage } as never;

    const cmd = createServeCommand(browserAPI);
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(createPage).toHaveBeenCalledWith('https://abc123.preview.sliccy.ai/index.html');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('falls back to window.open() when no BrowserAPI is provided', async () => {
    setPreviewMinter(async () => ({
      url: 'https://abc123.preview.sliccy.ai/index.html',
      pushed: 0,
    }));
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });
    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'https://abc123.preview.sliccy.ai/index.html',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('--bridge passes bridge=true to the in-realm minter', async () => {
    const minter = vi
      .fn()
      .mockResolvedValue({ url: 'https://x.preview.sliccy.ai/i.html', pushed: 0 });
    setPreviewMinter(minter);

    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--bridge', '/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(minter).toHaveBeenCalledWith({
      entryPath: '/workspace/app/index.html',
      servedRoot: '/workspace/app',
      bridge: true,
      noBridge: false,
    });
  });

  it('--no-bridge passes noBridge=true to the in-realm minter (mint site enforces --no-bridge wins)', async () => {
    const minter = vi
      .fn()
      .mockResolvedValue({ url: 'https://x.preview.sliccy.ai/i.html', pushed: 0 });
    setPreviewMinter(minter);

    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--no-bridge', '/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(minter).toHaveBeenCalledWith({
      entryPath: '/workspace/app/index.html',
      servedRoot: '/workspace/app',
      bridge: false,
      noBridge: true,
    });
  });

  it('--bridge combined with --no-bridge: both flags forwarded; mint site resolves precedence', async () => {
    const minter = vi
      .fn()
      .mockResolvedValue({ url: 'https://x.preview.sliccy.ai/i.html', pushed: 0 });
    setPreviewMinter(minter);

    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--bridge', '--no-bridge', '/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(minter).toHaveBeenCalledWith({
      entryPath: '/workspace/app/index.html',
      servedRoot: '/workspace/app',
      bridge: true,
      noBridge: true,
    });
  });

  it('--project prints a deprecation warning to stderr but still mints', async () => {
    setPreviewMinter(async () => ({
      url: 'https://abc.preview.sliccy.ai/index.html',
      pushed: 0,
    }));
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--project', '/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('--project is obsolete');
    expect(result.stdout).toContain('Preview URL:');
  });

  it('routes through panel-RPC tray-open-preview when no in-realm minter is set', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        return { url: 'https://rpc.preview.sliccy.ai/index.html', pushed: 2 };
      },
      dispose: () => {},
    };

    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--bridge', '/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual([
      {
        op: 'tray-open-preview',
        payload: {
          entryPath: '/workspace/app/index.html',
          servedRoot: '/workspace/app',
          bridge: true,
          noBridge: false,
        },
      },
    ]);
    expect(result.stdout).toContain('Preview URL: https://rpc.preview.sliccy.ai/index.html');
    expect(result.stdout).toContain('Pushed to 2 followers');
  });

  it('errors when neither in-realm minter nor panel-RPC client is available', async () => {
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no leader tray available');
    expect(result.stderr).toContain('host enable');
  });

  it('surfaces minter errors (no active leader tray) on stderr with exit 1', async () => {
    setPreviewMinter(async () => {
      throw new Error('no active leader tray');
    });
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no active leader tray');
  });

  it('surfaces panel-RPC errors on stderr with exit 1', async () => {
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async () => {
        throw new Error('no active leader tray');
      },
      dispose: () => {},
    };
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no active leader tray');
  });

  it('--stop <token> returns "not yet implemented" with exit 1', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop', 'tok-abc'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--stop is not yet implemented');
  });

  it('--list returns "not yet implemented" with exit 1', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--list'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--list is not yet implemented');
  });

  it('rejects unknown options', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--bogus', '/workspace/app'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown option');
  });

  it('rejects path traversal in the entry file', async () => {
    setPreviewMinter(async () => ({ url: 'x', pushed: 0 }));
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--entry=../escape.html', '/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid entry file');
  });

  it('errors when the directory does not exist', async () => {
    setPreviewMinter(async () => ({ url: 'x', pushed: 0 }));
    const cmd = createServeCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['/workspace/missing'], ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no such directory');
  });

  it('errors when the entry file does not exist', async () => {
    setPreviewMinter(async () => ({ url: 'x', pushed: 0 }));
    const cmd = createServeCommand();
    const ctx = createMockCtx({ directories: ['/workspace/app'] });
    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('entry file not found');
  });
});
