import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushCredentialsToWorker, resolveDefaultModel } from '../../src/ui/onboarding-helpers.js';
import type { ProviderConfig } from '../../src/providers/index.js';

// ---------------------------------------------------------------------------
// flushCredentialsToWorker
// ---------------------------------------------------------------------------

function withLocalStorage(store: Record<string, string>, fn: () => void): void {
  const mock = { getItem: (key: string) => store[key] ?? null };
  (globalThis as Record<string, unknown>).localStorage = mock;
  try {
    fn();
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
}

describe('flushCredentialsToWorker', () => {
  it('sends both keys when both are present in localStorage', () => {
    withLocalStorage(
      { slicc_accounts: '{"accounts":[]}', 'selected-model': 'anthropic:claude-sonnet-4-6' },
      () => {
        const sent: unknown[] = [];
        flushCredentialsToWorker({ sendRaw: (m) => sent.push(m) });
        expect(sent).toEqual([
          { type: 'local-storage-set', key: 'slicc_accounts', value: '{"accounts":[]}' },
          {
            type: 'local-storage-set',
            key: 'selected-model',
            value: 'anthropic:claude-sonnet-4-6',
          },
        ]);
      }
    );
  });

  it('skips a key that is null in localStorage', () => {
    withLocalStorage({ slicc_accounts: '{"accounts":[]}' }, () => {
      const sent: unknown[] = [];
      flushCredentialsToWorker({ sendRaw: (m) => sent.push(m) });
      expect(sent).toHaveLength(1);
      expect((sent[0] as { key: string }).key).toBe('slicc_accounts');
    });
  });

  it('sends nothing when both keys are absent', () => {
    withLocalStorage({}, () => {
      const sent: unknown[] = [];
      flushCredentialsToWorker({ sendRaw: (m) => sent.push(m) });
      expect(sent).toHaveLength(0);
    });
  });

  it('uses the exact LocalStorageSetMsg envelope shape', () => {
    withLocalStorage({ 'selected-model': 'adobe:claude-sonnet-4-6' }, () => {
      const sent: unknown[] = [];
      flushCredentialsToWorker({ sendRaw: (m) => sent.push(m) });
      expect(sent[0]).toStrictEqual({
        type: 'local-storage-set',
        key: 'selected-model',
        value: 'adobe:claude-sonnet-4-6',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// resolveDefaultModel
// ---------------------------------------------------------------------------

const makeModels = (ids: string[]) => ids.map((id) => ({ id }));
const noHidden = () => false;
const getModels = (id: string) => {
  const catalogue: Record<string, Array<{ id: string }>> = {
    adobe: makeModels(['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']),
    empty: [],
  };
  return catalogue[id] ?? [];
};

const baseCfg: ProviderConfig = {
  id: 'adobe',
  name: 'Adobe',
  isOAuth: true,
};

describe('resolveDefaultModel', () => {
  it('returns exact match when defaultModelId is set and matches exactly', () => {
    const cfg: ProviderConfig = { ...baseCfg, defaultModelId: 'claude-sonnet-4-6' };
    expect(resolveDefaultModel('adobe', cfg, getModels, noHidden)).toBe('adobe:claude-sonnet-4-6');
  });

  it('prefers exact match over fuzzy when both would match', () => {
    // 'sonnet' is a substring of 'claude-sonnet-4-6', but 'claude-sonnet-4-6' is an exact match
    const cfg: ProviderConfig = { ...baseCfg, defaultModelId: 'claude-sonnet-4-6' };
    expect(resolveDefaultModel('adobe', cfg, getModels, noHidden)).toBe('adobe:claude-sonnet-4-6');
  });

  it('falls back to fuzzy substring match when there is no exact match', () => {
    const cfg: ProviderConfig = { ...baseCfg, defaultModelId: 'sonnet' };
    expect(resolveDefaultModel('adobe', cfg, getModels, noHidden)).toBe('adobe:claude-sonnet-4-6');
  });

  it('falls back to first visible model when defaultModelId is absent', () => {
    const cfg: ProviderConfig = { ...baseCfg };
    expect(resolveDefaultModel('adobe', cfg, getModels, noHidden)).toBe('adobe:claude-opus-4-7');
  });

  it('skips hidden models and still resolves the first visible one', () => {
    const cfg: ProviderConfig = { ...baseCfg };
    const isHidden = (id: string) => id === 'claude-opus-4-7';
    expect(resolveDefaultModel('adobe', cfg, getModels, isHidden)).toBe('adobe:claude-sonnet-4-6');
  });

  it('returns undefined when the catalogue has no visible models', () => {
    const cfg: ProviderConfig = { ...baseCfg };
    expect(resolveDefaultModel('empty', cfg, getModels, noHidden)).toBeUndefined();
  });

  it('returns undefined when all models are hidden', () => {
    const cfg: ProviderConfig = { ...baseCfg };
    expect(resolveDefaultModel('adobe', cfg, getModels, () => true)).toBeUndefined();
  });
});
