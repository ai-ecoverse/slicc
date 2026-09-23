/**
 * The live catalogue reaches provider composition: a model that exists only in
 * the stored pi.dev overlay shows up in a provider's picker and resolves as a
 * selected model, with no provider-specific code.
 */
import type { Api, Model } from '@earendil-works/pi-ai';
import { getModels as getBundledModels } from '@earendil-works/pi-ai/compat';
import { getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';
import { beforeEach, describe, expect, it } from 'vitest';
import { MODEL_CATALOG_STORAGE_KEY } from '../../src/core/model-catalog.js';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
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
  },
  configurable: true,
  writable: true,
});

const BEDROCK_BASE_URL = 'https://bedrock-runtime.us-west-2.amazonaws.com';
const NEW_ID = 'us.anthropic.claude-opus-9-9';

function storeBedrockOverlay(): void {
  const template = (getBundledModels as (p: string) => Model<Api>[])('amazon-bedrock').find(
    (m) => m.id === 'us.anthropic.claude-opus-5'
  );
  storage.set(
    MODEL_CATALOG_STORAGE_KEY,
    JSON.stringify({
      'amazon-bedrock': {
        models: [{ ...template, id: NEW_ID, name: 'Claude Opus 9.9 (US)' }],
        checkedAt: 0,
        lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
      },
    })
  );
}

describe('live model catalogue in provider composition', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('lists the pi-ai catalogues behind the configured accounts', async () => {
    storage.set(
      'slicc_accounts',
      JSON.stringify([
        { providerId: 'bedrock-camp', apiKey: 'ABSK-x', baseUrl: BEDROCK_BASE_URL },
        { providerId: 'anthropic', apiKey: 'sk-ant' },
        { providerId: 'openai', apiKey: '', loggedOut: true },
      ])
    );
    const { getModelCatalogProviderIds } = await import('../../src/providers/account-store.js');
    expect(getModelCatalogProviderIds().sort()).toEqual([
      'amazon-bedrock',
      'anthropic',
      'bedrock-camp',
    ]);
  });

  it('surfaces an overlay-only Bedrock model in the bedrock-camp picker and resolves it', async () => {
    storage.set(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'bedrock-camp', apiKey: 'ABSK-x', baseUrl: BEDROCK_BASE_URL }])
    );
    storeBedrockOverlay();
    storage.set('selected-model', `bedrock-camp:${NEW_ID}`);
    const { getProviderModels, resolveCurrentModel } = await import(
      '../../src/providers/account-store.js'
    );
    const picked = getProviderModels('bedrock-camp').find((m) => m.id === NEW_ID);
    expect(picked).toMatchObject({ api: 'bedrock-camp-converse', provider: 'bedrock-camp' });
    const current = resolveCurrentModel();
    expect(current).toMatchObject({
      id: NEW_ID,
      api: 'bedrock-camp-converse',
      baseUrl: BEDROCK_BASE_URL,
    });
  });
});
