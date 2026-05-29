import { describe, it, expect, vi } from 'vitest';
import { applyHostedAccounts } from '../../src/ui/hosted-config-apply.js';
import type { Account } from '@slicc/cloud-core/cone-config';

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
