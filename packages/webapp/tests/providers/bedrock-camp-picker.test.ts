/**
 * End-to-end picker behaviour for bedrock-camp: what `getProviderModels()`
 * actually hands the UI, against the REAL pi-ai catalogue (no mocked model
 * lists), so a catalogue change that hides a model fails here.
 *
 * Covers the two things unit-testing the predicates in isolation misses: that
 * Claude 5 is genuinely reachable end to end, and that an allowlisted
 * non-Claude model arrives with `reasoning` cleared so the composer does not
 * offer a thinking-level control that cannot reach the wire.
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

async function pickerModels(): Promise<Array<{ id: string; reasoning?: boolean }>> {
  const { getProviderModels } = await import('../../src/providers/account-store.js');
  return getProviderModels('bedrock-camp');
}

describe('bedrock-camp picker contents', () => {
  beforeEach(() => {
    storage.clear();
    storage.set(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'bedrock-camp', apiKey: 'ABSK-x', baseUrl: BEDROCK_BASE_URL }])
    );
  });

  it('surfaces Claude 5 — the regression this whole change exists for', async () => {
    const ids = (await pickerModels()).map((m) => m.id);
    expect(ids).toContain('us.anthropic.claude-opus-5');
    expect(ids.some((id) => /anthropic\.claude-sonnet-5/.test(id))).toBe(true);
  });

  it('surfaces Opus 5.5 before pi-ai lists it, on the profiles the endpoint reaches', async () => {
    const ids = (await pickerModels()).map((m) => m.id);
    expect(ids).toContain('us.anthropic.claude-opus-5-5');
    expect(ids).toContain('global.anthropic.claude-opus-5-5');
    expect(ids).not.toContain('eu.anthropic.claude-opus-5-5');
    expect(ids).not.toContain('jp.anthropic.claude-opus-5-5');
  });

  it('routes Opus 5.5 through bedrock-camp with effort control', async () => {
    const opus = (await pickerModels()).find((m) => m.id === 'us.anthropic.claude-opus-5-5') as
      | { reasoning?: boolean; api?: string; provider?: string }
      | undefined;
    expect(opus?.reasoning).toBe(true);
    expect(opus?.api).toBe('bedrock-camp-converse');
    expect(opus?.provider).toBe('bedrock-camp');
  });

  it('resolves a requested Opus 5.5 id instead of degrading to the selected model', async () => {
    storage.set('selected-model', 'bedrock-camp:us.anthropic.claude-opus-5');
    const { resolveModelById } = await import('../../src/providers/account-store.js');
    const model = resolveModelById('us.anthropic.claude-opus-5-5');
    expect(model.id).toBe('us.anthropic.claude-opus-5-5');
    expect(model.api).toBe('bedrock-camp-converse');
    expect(model.baseUrl).toBe(BEDROCK_BASE_URL);
  });

  it('resolves a selected Opus 5.5 as the current model', async () => {
    storage.set('selected-model', 'bedrock-camp:us.anthropic.claude-opus-5-5');
    const { resolveCurrentModel } = await import('../../src/providers/account-store.js');
    const model = resolveCurrentModel();
    expect(model.id).toBe('us.anthropic.claude-opus-5-5');
    expect(model.api).toBe('bedrock-camp-converse');
    expect(model.baseUrl).toBe(BEDROCK_BASE_URL);
  });

  it('keeps effort control on Claude, where it reaches the wire', async () => {
    const opus = (await pickerModels()).find((m) => m.id === 'us.anthropic.claude-opus-5');
    expect(opus?.reasoning).toBe(true);
  });

  it('clears reasoning on allowlisted non-Claude models', async () => {
    // gpt-5.6 still reasons; it just cannot be told how hard, so advertising a
    // low/medium/high/xhigh selector would be a lie — every level produces a
    // byte-identical request.
    const gpt = (await pickerModels()).filter((m) => m.id.includes('openai.gpt-5.6'));
    expect(gpt.length).toBeGreaterThan(0);
    for (const m of gpt) expect(m.reasoning, m.id).toBe(false);
  });

  // The benchmark selects models with `slicc <join-url> model <m>`, which only
  // resolves against this list; `claude-fable-5-1` used to fail "no model
  // matches" even though the Claude filter admits the family.
  it('surfaces Fable 5.1, GPT-6 and Kimi K3 on the profiles a us- endpoint reaches', async () => {
    const ids = (await pickerModels()).map((m) => m.id);
    for (const baseId of [
      'anthropic.claude-fable-5-1',
      'openai.gpt-6-sol',
      'openai.gpt-6-luna',
      'openai.gpt-6-astra',
      'moonshotai.kimi-k3',
    ]) {
      expect(ids, baseId).toContain(`global.${baseId}`);
      expect(ids, baseId).toContain(`us.${baseId}`);
    }
  });

  it('keeps effort control on Fable 5.1 and GPT-6, and clears it on Kimi K3', async () => {
    const models = await pickerModels();
    const reasoning = (id: string) => models.find((m) => m.id === id)?.reasoning;
    for (const id of [
      'us.anthropic.claude-fable-5-1',
      'global.openai.gpt-6-sol',
      'us.openai.gpt-6-luna',
      'global.openai.gpt-6-astra',
    ]) {
      expect(reasoning(id), id).toBe(true);
    }
    // Bedrock ignores every effort shape Kimi K3 is sent.
    expect(reasoning('global.moonshotai.kimi-k3')).toBe(false);
  });

  // The composer steps off → low → medium → high → xhigh → max; `minimal`
  // is unsupported on GPT-6 and Astra cannot turn reasoning off.
  it.each([
    ['global.openai.gpt-6-sol', ['off', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['us.openai.gpt-6-luna', ['off', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['global.openai.gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('offers %s the levels Bedrock accepts', async (id, levels) => {
    const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai/compat');
    const model = (await pickerModels()).find((m) => m.id === id);
    expect(getSupportedThinkingLevels(model as never)).toEqual(levels);
  });

  it.each([
    ['global.anthropic.claude-fable-5-1'],
    ['us.openai.gpt-6-sol'],
    ['global.moonshotai.kimi-k3'],
  ])('resolves a requested %s instead of degrading to the selected model', async (id) => {
    storage.set('selected-model', 'bedrock-camp:us.anthropic.claude-opus-5');
    const { resolveModelById } = await import('../../src/providers/account-store.js');
    const model = resolveModelById(id);
    expect(model.id).toBe(id);
    expect(model.api).toBe('bedrock-camp-converse');
    expect(model.cost.input).toBeGreaterThan(0);
  });

  it("keeps GPT-6's long-context tier when pi's live overlay supplies the model", async () => {
    // pi's hosted amazon-bedrock entry, as served: no `cost.tiers`.
    const { getBuiltinModelDataGeneratedAt } = await import('@earendil-works/pi-ai/providers/all');
    const { MODEL_CATALOG_STORAGE_KEY } = await import('../../src/core/model-catalog.js');
    storage.set(
      MODEL_CATALOG_STORAGE_KEY,
      JSON.stringify({
        'amazon-bedrock': {
          models: [
            {
              id: 'us.openai.gpt-6-sol',
              name: 'GPT-6 Sol (US)',
              api: 'bedrock-converse-stream',
              provider: 'amazon-bedrock',
              baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 },
              contextWindow: 1_050_000,
              maxTokens: 128_000,
              thinkingLevelMap: { xhigh: 'xhigh' },
            },
          ],
          checkedAt: 0,
          lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
        },
      })
    );
    const gpt = (await pickerModels()).find((m) => m.id === 'us.openai.gpt-6-sol') as
      | { cost?: { tiers?: Array<{ inputTokensAbove: number; input: number }> } }
      | undefined;
    expect(gpt?.cost?.tiers).toEqual([
      { inputTokensAbove: 272_000, input: 4.4, output: 16.5, cacheRead: 0.44, cacheWrite: 5.5 },
    ]);
  });

  it("keeps GPT-6's full effort range when pi's overlay lists only xhigh", async () => {
    const { getBuiltinModelDataGeneratedAt } = await import('@earendil-works/pi-ai/providers/all');
    const { MODEL_CATALOG_STORAGE_KEY } = await import('../../src/core/model-catalog.js');
    const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai/compat');
    storage.set(
      MODEL_CATALOG_STORAGE_KEY,
      JSON.stringify({
        'amazon-bedrock': {
          models: [
            {
              id: 'global.openai.gpt-6-astra',
              name: 'GPT-6 Astra (Global)',
              api: 'bedrock-converse-stream',
              provider: 'amazon-bedrock',
              baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
              reasoning: true,
              input: ['text', 'image'],
              cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
              contextWindow: 1_050_000,
              maxTokens: 128_000,
              thinkingLevelMap: { xhigh: 'xhigh' },
            },
          ],
          checkedAt: 0,
          lastModified: (getBuiltinModelDataGeneratedAt() ?? 0) + 1,
        },
      })
    );
    const astra = (await pickerModels()).find((m) => m.id === 'global.openai.gpt-6-astra');
    expect(astra?.reasoning).toBe(true);
    expect(getSupportedThinkingLevels(astra as never)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('keeps unverified non-Claude models out entirely', async () => {
    const ids = (await pickerModels()).map((m) => m.id);
    for (const needle of ['grok', 'glm', 'minimax', 'nova', 'llama', 'deepseek', 'palmyra']) {
      expect(
        ids.filter((id) => id.includes(needle)),
        needle
      ).toEqual([]);
    }
  });
});
