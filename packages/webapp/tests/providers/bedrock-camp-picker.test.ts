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
