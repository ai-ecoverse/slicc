/**
 * Regression coverage for issue #1752 — `agent --model claude-haiku-4-5`
 * validated (exit 0) but the spawned scoop silently ran as the cone's Opus.
 *
 * Validation used a looser notion of "known" (any account's
 * `getProviderModels()` list, plus a cross-provider shorthand scan) than the
 * spawn path, which resolves `config.modelId` through `resolveModelById()`
 * against the SELECTED provider only. `resolveModelIdForScoop` closes the gap
 * by requiring `resolveModelById(id).id === id`.
 *
 * Runs against the REAL pi-ai model catalogue (no mocked model lists) so a
 * catalogue change that breaks alias resolution fails here.
 */
import { beforeEach, describe, expect, it } from 'vitest';

const storage = new Map<string, string>();
const storageStub = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    storage.set(k, v);
  },
  removeItem: (k: string) => {
    storage.delete(k);
  },
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => {
    storage.clear();
  },
};
Object.defineProperty(globalThis, 'localStorage', {
  value: storageStub,
  configurable: true,
  writable: true,
});

const BEDROCK_BASE_URL = 'https://bedrock-runtime.us-west-2.amazonaws.com';

/** Seed a bedrock-camp account selected on Opus 4.8 (the issue's setup). */
function seedBedrockCampOnOpus(): void {
  storage.set(
    'slicc_accounts',
    JSON.stringify([{ providerId: 'bedrock-camp', apiKey: 'ABSK-x', baseUrl: BEDROCK_BASE_URL }])
  );
  storage.set('selected-model', 'bedrock-camp:us.anthropic.claude-opus-4-8');
}

describe('resolveModelIdForScoop (bedrock-camp selected)', () => {
  beforeEach(() => {
    storage.clear();
    seedBedrockCampOnOpus();
  });

  it('expands a bare haiku alias to a real bedrock haiku profile', async () => {
    const { resolveModelIdForScoop } = await import('../../src/providers/account-store.js');
    const resolved = resolveModelIdForScoop('claude-haiku-4-5');
    expect(resolved).toMatch(/anthropic\.claude-haiku-4-5/);
  });

  it('expands a bare sonnet alias (the id that already worked)', async () => {
    const { resolveModelIdForScoop } = await import('../../src/providers/account-store.js');
    const resolved = resolveModelIdForScoop('claude-sonnet-4-6');
    expect(resolved).toMatch(/anthropic\.claude-sonnet-4-6/);
  });

  it('never resolves to the selected (parent) model for a haiku request', async () => {
    const { resolveModelIdForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelIdForScoop('claude-haiku-4-5')).not.toBe('us.anthropic.claude-opus-4-8');
  });

  it('passes a fully-qualified id through unchanged', async () => {
    const { resolveModelIdForScoop } = await import('../../src/providers/account-store.js');
    const id = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    expect(resolveModelIdForScoop(id)).toBe(id);
  });

  it('rejects a bogus id', async () => {
    const { resolveModelIdForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelIdForScoop('this-model-does-not-exist-xyz')).toBeNull();
  });

  it('rejects an empty id', async () => {
    const { resolveModelIdForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelIdForScoop('')).toBeNull();
  });

  it('every resolved id round-trips through resolveModelById', async () => {
    const { resolveModelById, resolveModelIdForScoop } = await import(
      '../../src/providers/account-store.js'
    );
    for (const input of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'haiku', 'opus']) {
      const resolved = resolveModelIdForScoop(input);
      expect(resolved, input).not.toBeNull();
      // The invariant the spawn path depends on: what we validate is what runs.
      expect(resolveModelById(resolved!).id, input).toBe(resolved);
    }
  });

  it('prefers the selected provider over another account offering the alias', async () => {
    storage.set(
      'slicc_accounts',
      JSON.stringify([
        { providerId: 'anthropic', apiKey: 'sk-ant-x' },
        { providerId: 'bedrock-camp', apiKey: 'ABSK-x', baseUrl: BEDROCK_BASE_URL },
      ])
    );
    storage.set('selected-model', 'bedrock-camp:us.anthropic.claude-opus-4-8');
    const { resolveModelById, resolveModelIdForScoop } = await import(
      '../../src/providers/account-store.js'
    );
    const resolved = resolveModelIdForScoop('claude-haiku-4-5');
    // `anthropic` offers the bare id, but bedrock-camp is selected — picking
    // the bare id would degrade to Opus at `resolveModelById` time.
    expect(resolved).toMatch(/anthropic\.claude-haiku-4-5/);
    expect(resolveModelById(resolved!).id).toBe(resolved);
  });
});

describe('resolveModelIdForScoop (native anthropic selected)', () => {
  beforeEach(() => {
    storage.clear();
    storage.set(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'anthropic', apiKey: 'sk-ant-x' }])
    );
    storage.set('selected-model', 'anthropic:claude-opus-4-8');
  });

  it('keeps the bare pi-ai alias when the selected provider offers it', async () => {
    const { resolveModelIdForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelIdForScoop('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });

  it('rejects a bedrock-only inference-profile id', async () => {
    const { resolveModelIdForScoop } = await import('../../src/providers/account-store.js');
    expect(resolveModelIdForScoop('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBeNull();
  });
});
