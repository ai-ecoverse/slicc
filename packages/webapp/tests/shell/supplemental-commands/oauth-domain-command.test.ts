import type { IFileSystem } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the provider-settings module so the command exercises its
// public surface (getExtraOAuthDomains / setExtraOAuthDomainsAsync /
// getAllExtraOAuthDomains) without touching real localStorage. This
// is the layer that issue #701 broke: the command was calling the
// sync `setExtraOAuthDomains` from the kernel worker and the writes
// disappeared. Locking the command-level call shape to the async
// setter prevents a future refactor from dropping the `await` and
// re-introducing the same bug silently.
vi.mock('../../../src/providers/account-store.js', () => ({
  getExtraOAuthDomains: vi.fn(),
  setExtraOAuthDomainsAsync: vi.fn(),
  getAllExtraOAuthDomains: vi.fn(),
}));

import {
  getAllExtraOAuthDomains,
  getExtraOAuthDomains,
  setExtraOAuthDomainsAsync,
} from '../../../src/providers/account-store.js';
import { createOAuthDomainCommand } from '../../../src/shell/supplemental-commands/oauth-domain-command.js';

const mockGetExtraOAuthDomains = vi.mocked(getExtraOAuthDomains);
const mockSetExtraOAuthDomainsAsync = vi.mocked(setExtraOAuthDomainsAsync);
const mockGetAllExtraOAuthDomains = vi.mocked(getAllExtraOAuthDomains);

function createMockCtx() {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };
  return {
    fs: fs as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

describe('oauth-domain command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExtraOAuthDomains.mockReturnValue([]);
    mockGetAllExtraOAuthDomains.mockReturnValue({});
    mockSetExtraOAuthDomainsAsync.mockResolvedValue(undefined);
  });

  it('has correct name', () => {
    expect(createOAuthDomainCommand().name).toBe('oauth-domain');
  });

  it('--help and no-args both print help', async () => {
    const cmd = createOAuthDomainCommand();
    const help = await cmd.execute(['--help'], createMockCtx());
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('oauth-domain');
    const noArgs = await cmd.execute([], createMockCtx());
    expect(noArgs.stdout).toContain('oauth-domain');
  });

  describe('list', () => {
    it('list <provider> returns the domains', async () => {
      mockGetExtraOAuthDomains.mockReturnValue(['admin.hlx.page', '*.aem.page']);
      const result = await createOAuthDomainCommand().execute(['list', 'adobe'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('admin.hlx.page\n*.aem.page\n');
      expect(mockGetExtraOAuthDomains).toHaveBeenCalledWith('adobe');
    });

    it('list <provider> says no extras when empty', async () => {
      const result = await createOAuthDomainCommand().execute(['list', 'adobe'], createMockCtx());
      expect(result.stdout).toBe('(no extra domains configured for adobe)\n');
    });

    it('list (no provider) shows all configured providers', async () => {
      mockGetAllExtraOAuthDomains.mockReturnValue({
        adobe: ['admin.hlx.page'],
        github: ['hub.example.com'],
      });
      const result = await createOAuthDomainCommand().execute(['list'], createMockCtx());
      expect(result.stdout).toBe('adobe: admin.hlx.page\ngithub: hub.example.com\n');
    });
  });

  describe('add — routes through the async setter (issue #701)', () => {
    it('add <provider> <domain> appends and awaits the async setter', async () => {
      mockGetExtraOAuthDomains.mockReturnValue(['existing.example.com']);
      const result = await createOAuthDomainCommand().execute(
        ['add', 'adobe', 'admin.hlx.page'],
        createMockCtx()
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Added admin.hlx.page');
      // Key assertion: the command MUST call setExtraOAuthDomainsAsync,
      // not the sync setExtraOAuthDomains. The bug at issue #701 was a
      // sync call from the worker that silently no-op'd because the
      // worker-shim doesn't echo back to the page.
      expect(mockSetExtraOAuthDomainsAsync).toHaveBeenCalledWith('adobe', [
        'existing.example.com',
        'admin.hlx.page',
      ]);
    });

    it('add is idempotent on duplicate (case-insensitive)', async () => {
      mockGetExtraOAuthDomains.mockReturnValue(['ADMIN.HLX.PAGE']);
      const result = await createOAuthDomainCommand().execute(
        ['add', 'adobe', 'admin.hlx.page'],
        createMockCtx()
      );
      expect(result.stdout).toContain('already in adobe extras');
      expect(mockSetExtraOAuthDomainsAsync).not.toHaveBeenCalled();
    });

    it('add propagates async-setter failure to stderr + exit 1', async () => {
      mockSetExtraOAuthDomainsAsync.mockRejectedValue(new Error('panel-rpc unreachable'));
      const result = await createOAuthDomainCommand().execute(
        ['add', 'adobe', 'admin.hlx.page'],
        createMockCtx()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('panel-rpc unreachable');
    });

    it('add requires both provider and domain', async () => {
      const result = await createOAuthDomainCommand().execute(['add', 'adobe'], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('requires');
      expect(mockSetExtraOAuthDomainsAsync).not.toHaveBeenCalled();
    });
  });

  describe('remove — routes through the async setter (issue #701)', () => {
    it('remove drops the matching domain and awaits the async setter', async () => {
      mockGetExtraOAuthDomains.mockReturnValue(['admin.hlx.page', '*.aem.page']);
      const result = await createOAuthDomainCommand().execute(
        ['remove', 'adobe', 'admin.hlx.page'],
        createMockCtx()
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Removed admin.hlx.page');
      expect(mockSetExtraOAuthDomainsAsync).toHaveBeenCalledWith('adobe', ['*.aem.page']);
    });

    it("remove is a no-op when the domain isn't present", async () => {
      mockGetExtraOAuthDomains.mockReturnValue(['other.example.com']);
      const result = await createOAuthDomainCommand().execute(
        ['remove', 'adobe', 'admin.hlx.page'],
        createMockCtx()
      );
      expect(result.stdout).toContain('not found');
      expect(mockSetExtraOAuthDomainsAsync).not.toHaveBeenCalled();
    });

    it('remove propagates async-setter failure to stderr + exit 1', async () => {
      // Dropped-`await` regression guard: without `await`, the
      // rejection becomes an unhandled promise and the command
      // returns exitCode: 0 — this assertion would then fail.
      mockGetExtraOAuthDomains.mockReturnValue(['admin.hlx.page']);
      mockSetExtraOAuthDomainsAsync.mockRejectedValue(new Error('panel-rpc unreachable'));
      const result = await createOAuthDomainCommand().execute(
        ['remove', 'adobe', 'admin.hlx.page'],
        createMockCtx()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('panel-rpc unreachable');
    });

    it('remove requires both provider and domain', async () => {
      const result = await createOAuthDomainCommand().execute(['remove', 'adobe'], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(mockSetExtraOAuthDomainsAsync).not.toHaveBeenCalled();
    });
  });

  describe('clear — routes through the async setter (issue #701)', () => {
    it('clear empties the extras for the provider via the async setter', async () => {
      const result = await createOAuthDomainCommand().execute(['clear', 'adobe'], createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Cleared');
      expect(mockSetExtraOAuthDomainsAsync).toHaveBeenCalledWith('adobe', []);
    });

    it('clear propagates async-setter failure to stderr + exit 1', async () => {
      // Dropped-`await` regression guard — see the `remove` variant
      // above for rationale.
      mockSetExtraOAuthDomainsAsync.mockRejectedValue(new Error('panel-rpc unreachable'));
      const result = await createOAuthDomainCommand().execute(['clear', 'adobe'], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('panel-rpc unreachable');
    });

    it('clear requires a provider', async () => {
      const result = await createOAuthDomainCommand().execute(['clear'], createMockCtx());
      expect(result.exitCode).toBe(1);
      expect(mockSetExtraOAuthDomainsAsync).not.toHaveBeenCalled();
    });
  });

  it('rejects unknown subcommands', async () => {
    const result = await createOAuthDomainCommand().execute(['frobnicate'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });
});
