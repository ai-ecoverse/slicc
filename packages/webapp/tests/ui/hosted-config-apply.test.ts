import type { Account } from '@slicc/cloud-core/cone-config';
import { describe, expect, it, vi } from 'vitest';
import { applyHostedAccounts, prewarmHostedModels } from '../../src/ui/hosted-config-apply.js';

describe('applyHostedAccounts (managed-only reconcile)', () => {
  it('saves oauth via saveOAuthAccount, apikey via addAccount, removes managed-absent', async () => {
    const calls: string[] = [];
    const deps = {
      saveOAuthAccount: vi.fn(async (o: { providerId: string }) => {
        calls.push('save:' + o.providerId);
      }),
      addAccount: vi.fn((id: string) => {
        calls.push('add:' + id);
      }),
      removeAccount: vi.fn(async (id: string) => {
        calls.push('remove:' + id);
      }),
      currentProviderIds: () => ['adobe', 'openai', 'manual-local'],
      previouslyManaged: () => ['adobe', 'openai'],
    };
    const accounts: Account[] = [
      { providerId: 'adobe', kind: 'oauth', accessToken: 't' },
      { providerId: 'anthropic', kind: 'apikey', apiKey: 'k' },
    ];
    await applyHostedAccounts(accounts, deps);
    expect(calls).toContain('save:adobe');
    expect(calls).toContain('add:anthropic');
    expect(calls).toContain('remove:openai');
    expect(calls).not.toContain('remove:manual-local');
  });
});

describe('prewarmHostedModels', () => {
  it('refreshes models for oauth accounts whose provider has the hook, passing the token', async () => {
    const refreshed: Array<{ providerId: string; token?: string }> = [];
    const deps = {
      getRefreshModels: (providerId: string) =>
        providerId === 'adobe'
          ? async (token?: string) => {
              refreshed.push({ providerId, token });
            }
          : undefined,
    };
    const accounts: Account[] = [
      { providerId: 'adobe', kind: 'oauth', accessToken: 'ims-tok' },
      { providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }, // not oauth → skipped
      { providerId: 'github', kind: 'oauth', accessToken: 'gh' }, // no hook → skipped
    ];
    await prewarmHostedModels(accounts, deps);
    expect(refreshed).toEqual([{ providerId: 'adobe', token: 'ims-tok' }]);
  });

  it('skips oauth accounts without an access token', async () => {
    let called = false;
    const deps = {
      getRefreshModels: () => async () => {
        called = true;
      },
    };
    await prewarmHostedModels([{ providerId: 'adobe', kind: 'oauth', accessToken: '' }], deps);
    expect(called).toBe(false);
  });

  it('is best-effort: a refresh that rejects does not reject the whole pre-warm', async () => {
    const deps = {
      getRefreshModels: () => async () => {
        throw new Error('network down');
      },
    };
    await expect(
      prewarmHostedModels([{ providerId: 'adobe', kind: 'oauth', accessToken: 't' }], deps)
    ).resolves.toBeUndefined();
  });

  it('does not hang on a refresh that never resolves (per-refresh timeout)', async () => {
    // A hung /v1/models fetch must not block account application / cold start.
    const deps = {
      getRefreshModels: () => () => new Promise<void>(() => {}), // never resolves
    };
    await expect(
      prewarmHostedModels([{ providerId: 'adobe', kind: 'oauth', accessToken: 't' }], deps, 10)
    ).resolves.toBeUndefined();
  });
});
