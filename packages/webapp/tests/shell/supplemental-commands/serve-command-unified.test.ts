import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPreviewMinter, setPreviewOp } from '../../../src/shell/preview-minter.js';
import { createServeCommand } from '../../../src/shell/supplemental-commands/serve-command.js';

// `serve --bridge` auto-provisions a `preview-bridge` webhook via the lick
// surface BEFORE minting (Task 17). Stub it so the in-realm mint path can be
// exercised without a live kernel LickManager; createWebhook yields id 'wh1'.
vi.mock('../../../src/shell/supplemental-commands/lick-surface.js', () => ({
  getLickManagerSurface: vi.fn(async () => ({
    createWebhook: vi.fn(async (name: string) => ({
      id: 'wh1',
      name,
      createdAt: new Date().toISOString(),
    })),
    deleteWebhook: vi.fn(async () => true),
    listWebhooks: vi.fn(async () => []),
  })),
}));

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
    setPreviewOp(null);
    delete (globalThis as Record<string, unknown>).__slicc_panelRpc;
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    setPreviewMinter(null);
    setPreviewOp(null);
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
      url: 'https://abc123.sliccy.now/index.html',
      pushed: 3,
      previewToken: 'tok',
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
      maxTabs: undefined,
      quiet: false,
      webhookId: undefined,
    });
    expect(result.stdout).toContain('Preview URL: https://abc123.sliccy.now/index.html');
    expect(result.stdout).toContain('Pushed to 3 followers');
  });

  it('singularizes follower count when pushed === 1', async () => {
    setPreviewMinter(async () => ({
      url: 'https://x.sliccy.now/i.html',
      pushed: 1,
      previewToken: 'tok',
    }));
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
      url: 'https://abc123.sliccy.now/index.html',
      pushed: 0,
      previewToken: 'tok',
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
    expect(createPage).toHaveBeenCalledWith('https://abc123.sliccy.now/index.html');
    expect(openSpy).not.toHaveBeenCalled();
    expect(result.stdout).toContain('(targetId: target-123)');
  });

  it('falls back to window.open() when no BrowserAPI is provided', async () => {
    setPreviewMinter(async () => ({
      url: 'https://abc123.sliccy.now/index.html',
      pushed: 0,
      previewToken: 'tok',
    }));
    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });
    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    expect(openSpy).toHaveBeenCalledWith(
      'https://abc123.sliccy.now/index.html',
      '_blank',
      'noopener,noreferrer'
    );
    expect(result.stdout).not.toContain('targetId');
  });

  it('--bridge passes bridge=true to the in-realm minter', async () => {
    const minter = vi
      .fn()
      .mockResolvedValue({ url: 'https://x.sliccy.now/i.html', pushed: 0, previewToken: 'tok' });
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
      maxTabs: undefined,
      quiet: false,
      webhookId: 'wh1',
    });
  });

  it('--no-bridge forces bridge=false at the serve command (never mints bridged)', async () => {
    const minter = vi
      .fn()
      .mockResolvedValue({ url: 'https://x.sliccy.now/i.html', pushed: 0, previewToken: 'tok' });
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
      maxTabs: undefined,
      quiet: false,
      webhookId: undefined,
    });
  });

  it('--bridge combined with --no-bridge: both flags forwarded; no webhook provisioned (mint site resolves precedence)', async () => {
    const minter = vi
      .fn()
      .mockResolvedValue({ url: 'https://x.sliccy.now/i.html', pushed: 0, previewToken: 'tok' });
    setPreviewMinter(minter);

    const cmd = createServeCommand();
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await cmd.execute(['--bridge', '--no-bridge', '/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(0);
    // serve forwards the raw bridge/noBridge intent to the mint (the mint site
    // computes effectiveBridge/allowLive). effectiveBridge = !noBridge && bridge
    // → false here, so serve provisions NO webhook (webhookId stays undefined).
    expect(minter).toHaveBeenCalledWith({
      entryPath: '/workspace/app/index.html',
      servedRoot: '/workspace/app',
      bridge: true,
      noBridge: true,
      maxTabs: undefined,
      quiet: false,
      webhookId: undefined,
    });
  });

  it('--project prints a deprecation warning to stderr but still mints', async () => {
    setPreviewMinter(async () => ({
      url: 'https://abc.sliccy.now/index.html',
      pushed: 0,
      previewToken: 'tok',
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
        return { url: 'https://rpc.sliccy.now/index.html', pushed: 2 };
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
          maxTabs: undefined,
          quiet: false,
          webhookId: 'wh1',
        },
      },
    ]);
    expect(result.stdout).toContain('Preview URL: https://rpc.sliccy.now/index.html');
    expect(result.stdout).toContain('Pushed to 2 followers');
  });

  it('keeps a bare logs argument available as a directory name', async () => {
    const minter = vi.fn().mockResolvedValue({
      previewToken: 'tok-logs',
      url: 'https://example.test/index.html',
      pushed: 0,
    });
    setPreviewMinter(minter);
    const ctx = createMockCtx({
      directories: ['/workspace/logs'],
      files: ['/workspace/logs/index.html'],
    });

    const result = await createServeCommand().execute(['logs'], ctx as never);

    expect(result.exitCode).toBe(0);
    expect(minter).toHaveBeenCalledWith(expect.objectContaining({ servedRoot: '/workspace/logs' }));
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

  // ── --stop ────────────────────────────────────────────────────────

  it('--stop <token> revokes via in-realm getPreviewOp and reports success', async () => {
    setPreviewOp(async () => ({ revoked: true }));
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop', 'tok-abc'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Preview revoked: tok-abc');
  });

  it('--stop <token> reports error when in-realm op returns revoked:false', async () => {
    setPreviewOp(async () => ({ revoked: false }));
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop', 'tok-abc'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found or already revoked');
  });

  it('--stop <token> revokes via panel-RPC tray-revoke-preview', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        return { revoked: true };
      },
      dispose: () => {},
    };
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop', 'tok-xyz'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Preview revoked: tok-xyz');
    expect(calls).toEqual([{ op: 'tray-revoke-preview', payload: { previewToken: 'tok-xyz' } }]);
  });

  it('--stop <token> reports error when panel-RPC returns revoked:false', async () => {
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async () => ({ revoked: false }),
      dispose: () => {},
    };
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop', 'tok-xyz'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not found or already revoked');
  });

  it('--stop <token> errors when no in-realm op or panel-RPC client is available', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop', 'tok-abc'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no leader tray available');
  });

  it('--stop without value returns parse error', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing value for --stop');
  });

  // ── --list ────────────────────────────────────────────────────────

  it('--list lists via in-realm getPreviewOp and formats output', async () => {
    setPreviewOp(async () => ({
      previews: [
        {
          previewToken: 'tok-a',
          url: 'https://a.sliccy.now/',
          servedRoot: '/workspace/app',
          entryPath: '/workspace/app/index.html',
          allowLive: false,
          createdAt: '2026-06-01T00:00:00.000Z',
        },
        {
          previewToken: 'tok-b',
          url: 'https://b.sliccy.now/',
          servedRoot: '/workspace/dist',
          entryPath: '/workspace/dist/index.html',
          allowLive: true,
          createdAt: '2026-06-02T00:00:00.000Z',
        },
      ],
    }));
    const cmd = createServeCommand();
    const result = await cmd.execute(['--list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Active previews:');
    expect(result.stdout).toContain('tok-a');
    expect(result.stdout).toContain('tok-b');
    expect(result.stdout).toContain('https://a.sliccy.now/');
    expect(result.stdout).toContain('https://b.sliccy.now/');
  });

  it('--list reports empty when in-realm op returns no previews', async () => {
    setPreviewOp(async () => ({ previews: [] }));
    const cmd = createServeCommand();
    const result = await cmd.execute(['--list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No active previews');
  });

  it('--list lists via panel-RPC tray-list-previews', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        return {
          previews: [
            {
              previewToken: 'tok-c',
              url: 'https://c.sliccy.now/',
              servedRoot: '/workspace/src',
              entryPath: '/workspace/src/index.html',
              allowLive: false,
              createdAt: '2026-06-03T00:00:00.000Z',
            },
          ],
        };
      },
      dispose: () => {},
    };
    const cmd = createServeCommand();
    const result = await cmd.execute(['--list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tok-c');
    expect(result.stdout).toContain('https://c.sliccy.now/');
    expect(calls).toEqual([{ op: 'tray-list-previews', payload: undefined }]);
  });

  it('--list reports empty when panel-RPC returns no previews', async () => {
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async () => ({ previews: [] }),
      dispose: () => {},
    };
    const cmd = createServeCommand();
    const result = await cmd.execute(['--list'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No active previews');
  });

  it('--list errors when no in-realm op or panel-RPC client is available', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--list'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no leader tray available');
  });

  it('rejects unknown options', async () => {
    const cmd = createServeCommand();
    const result = await cmd.execute(['--bogus', '/workspace/app'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown option');
  });

  it('rejects path traversal in the entry file', async () => {
    setPreviewMinter(async () => ({ url: 'x', pushed: 0, previewToken: 'tok' }));
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
    setPreviewMinter(async () => ({ url: 'x', pushed: 0, previewToken: 'tok' }));
    const cmd = createServeCommand();
    const ctx = createMockCtx();
    const result = await cmd.execute(['/workspace/missing'], ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no such directory');
  });

  it('errors when the entry file does not exist', async () => {
    setPreviewMinter(async () => ({ url: 'x', pushed: 0, previewToken: 'tok' }));
    const cmd = createServeCommand();
    const ctx = createMockCtx({ directories: ['/workspace/app'] });
    const result = await cmd.execute(['/workspace/app'], ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('entry file not found');
  });

  // ── error-path coverage (review blind-spot §1) ────────────────────

  it('--stop <token> catches in-realm op rejections', async () => {
    setPreviewOp(async () => {
      throw new Error('panel-rpc: op tray-revoke-preview timed out after 15000ms');
    });
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop', 'tok-abc'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('panel-rpc: op tray-revoke-preview timed out');
  });

  it('--stop <token> catches panel-RPC rejections', async () => {
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async () => {
        throw new Error('serve: leader tray has no active session');
      },
      dispose: () => {},
    };
    const cmd = createServeCommand();
    const result = await cmd.execute(['--stop', 'tok-abc'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('serve: leader tray has no active session');
  });

  it('--list catches in-realm op rejections', async () => {
    setPreviewOp(async () => {
      throw new Error('Preview list failed: 500');
    });
    const cmd = createServeCommand();
    const result = await cmd.execute(['--list'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Preview list failed: 500');
  });

  it('--list catches panel-RPC rejections', async () => {
    (globalThis as Record<string, unknown>).__slicc_panelRpc = {
      call: async () => {
        throw new Error('Preview list failed: 502');
      },
      dispose: () => {},
    };
    const cmd = createServeCommand();
    const result = await cmd.execute(['--list'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Preview list failed: 502');
  });

  it('publishes a 30d immutable snapshot with relative paths and MIME types', async () => {
    const minter = vi.fn().mockResolvedValue({
      previewToken: 'persistent-token',
      url: 'https://persistent.sliccy.now/index.html',
      pushed: 0,
    });
    setPreviewMinter(minter);
    const vfs = {
      walk: async function* () {
        yield '/workspace/app/index.html';
        yield '/workspace/app/assets/logo.png';
      },
      readFile: vi.fn(async (path: string) =>
        path.endsWith('.png') ? new Uint8Array([1, 2, 3]) : new TextEncoder().encode('<h1>ok</h1>')
      ),
    };
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await createServeCommand(undefined, vfs as never).execute(
      ['--ttl', '30d', '/workspace/app'],
      ctx as never
    );

    expect(result.exitCode).toBe(0);
    expect(minter).toHaveBeenCalledWith(
      expect.objectContaining({
        ttlMs: 30 * 24 * 60 * 60 * 1000,
        noBridge: true,
        snapshotFiles: [
          expect.objectContaining({ path: 'index.html', mime: 'text/html' }),
          expect.objectContaining({ path: 'assets/logo.png', mime: 'image/png' }),
        ],
      })
    );
  });

  it('gives persistent preview uploads a ten-minute panel-RPC timeout', async () => {
    const call = vi.fn().mockResolvedValue({
      previewToken: 'persistent-token',
      url: 'https://persistent.sliccy.now/index.html',
      pushed: 0,
    });
    (globalThis as Record<string, unknown>).__slicc_panelRpc = { call, dispose: () => {} };
    const vfs = {
      walk: async function* () {
        yield '/workspace/app/index.html';
      },
      readFile: vi.fn(async () => new TextEncoder().encode('<h1>ok</h1>')),
    };
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });

    const result = await createServeCommand(undefined, vfs as never).execute(
      ['--ttl', '1d', '/workspace/app'],
      ctx as never
    );

    expect(result.exitCode).toBe(0);
    expect(call).toHaveBeenCalledWith(
      'tray-open-preview',
      expect.objectContaining({ ttlMs: 86_400_000 }),
      { timeoutMs: 10 * 60_000 }
    );
  });

  it.each(['0d', '1.5d', '30', '1s', '-1d'])('rejects invalid --ttl value %s', async (ttl) => {
    const result = await createServeCommand().execute(
      ['--ttl', ttl, '/workspace/app'],
      {} as never
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--ttl must be a positive whole duration');
  });

  it('rejects retention above 30d with the Deluxe error before walking', async () => {
    const result = await createServeCommand().execute(['--ttl=5w', '/workspace/app'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'serve: --ttl cannot exceed 30d; longer retention requires a Sliccy Deluxe De-Enshittification plan.\n'
    );
  });

  it.each(['--bridge', '--max-tabs=2'])('rejects --ttl combined with %s', async (flag) => {
    const ctx = createMockCtx({
      directories: ['/workspace/app'],
      files: ['/workspace/app/index.html'],
    });
    const result = await createServeCommand().execute(
      ['--ttl=1d', flag, '/workspace/app'],
      ctx as never
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`--ttl cannot be combined with ${flag.split('=')[0]}`);
  });

  it('shows preview mode and expiry in --list output', async () => {
    setPreviewOp(async () => ({
      previews: [
        {
          previewToken: 'persistent-token',
          url: 'https://persistent.sliccy.now/',
          servedRoot: '/workspace/app',
          entryPath: '/workspace/app/index.html',
          allowLive: false,
          createdAt: '2026-08-03T00:00:00.000Z',
          mode: 'persistent',
          expiresAt: '2026-08-10T00:00:00.000Z',
        },
      ],
    }));
    const result = await createServeCommand().execute(['--list'], {} as never);
    expect(result.stdout).toContain('TOKEN  MODE  EXPIRES');
    expect(result.stdout).toContain('persistent  2026-08-10T00:00:00.000Z');
  });
});
