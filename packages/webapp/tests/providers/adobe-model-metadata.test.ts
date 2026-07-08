/**
 * Unit coverage for the pure Adobe model-metadata merge helper.
 *
 * This is the enrichment logic `providers/adobe.ts:getModelIds()` runs over
 * each model. It is extracted into `src/providers/adobe-model-metadata.ts`
 * (no DOM / chrome / import.meta.glob deps) so it can be tested against the
 * real implementation rather than a mirror — unlike adobe.ts itself.
 *
 * Key behavior under test: the unauthenticated `/v1/config` fallback path
 * carries `context_window` / `max_tokens` from the config entry, so a model's
 * real window reaches the model object (and therefore GC) even before the
 * authenticated `/v1/models` response has populated the metadata cache.
 */
import { describe, expect, it } from 'vitest';
import { enrichAdobeModel } from '../../src/providers/adobe-model-metadata.js';

describe('enrichAdobeModel', () => {
  it('carries context_window/max_tokens from the entry when no cache exists', () => {
    // Mirrors the /v1/config fallback: cache empty, metadata only on the entry.
    const enriched = enrichAdobeModel({
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      context_window: 1_000_000,
      max_tokens: 128_000,
      input: ['text', 'image'],
    });
    expect(enriched.context_window).toBe(1_000_000);
    expect(enriched.max_tokens).toBe(128_000);
    expect(enriched.input).toEqual(['text', 'image']);
    expect(enriched.name).toBe('Claude Sonnet 4.6');
  });

  it('prefers cached metadata over the entry (authenticated /v1/models wins)', () => {
    const enriched = enrichAdobeModel(
      { id: 'claude-opus-4-6', name: 'Opus', context_window: 200_000 },
      { id: 'claude-opus-4-6', context_window: 1_000_000, max_tokens: 128_000, api: 'anthropic' }
    );
    expect(enriched.context_window).toBe(1_000_000);
    expect(enriched.max_tokens).toBe(128_000);
  });

  it('falls back to entry fields the cache does not specify', () => {
    const enriched = enrichAdobeModel(
      { id: 'm', name: 'M', context_window: 500_000, max_tokens: 64_000 },
      { id: 'm', context_window: 1_000_000 } // cache lacks max_tokens
    );
    expect(enriched.context_window).toBe(1_000_000);
    expect(enriched.max_tokens).toBe(64_000);
  });

  it('propagates the api field for OpenAI-compatible routing', () => {
    const enriched = enrichAdobeModel({ id: 'glm', name: 'GLM', api: 'openai' });
    expect(enriched.api).toBe('openai');
  });

  it('disables eager tool-input streaming for Haiku (Bedrock 400 workaround)', () => {
    const enriched = enrichAdobeModel({ id: 'claude-haiku-4-5', name: 'Haiku' });
    expect(enriched.compat).toEqual({ supportsEagerToolInputStreaming: false });
  });

  it('does not set compat for non-Haiku models', () => {
    const enriched = enrichAdobeModel({ id: 'claude-sonnet-4-6', name: 'Sonnet' });
    expect(enriched.compat).toBeUndefined();
  });

  it('omits absent optional fields entirely (no undefined keys)', () => {
    const enriched = enrichAdobeModel({ id: 'bare', name: 'Bare' });
    expect(enriched).toEqual({ id: 'bare', name: 'Bare' });
    expect('context_window' in enriched).toBe(false);
    expect('max_tokens' in enriched).toBe(false);
  });

  it('defaults name to id when missing', () => {
    const enriched = enrichAdobeModel({ id: 'no-name' });
    expect(enriched.name).toBe('no-name');
  });

  it('propagates reasoning from the entry when cache lacks it', () => {
    const enriched = enrichAdobeModel({
      id: 'claude-sonnet-5-0',
      name: 'Claude Sonnet 5.0',
      reasoning: true,
    });
    expect(enriched.reasoning).toBe(true);
  });

  it('prefers cached reasoning over entry reasoning', () => {
    const enriched = enrichAdobeModel(
      { id: 'claude-sonnet-5-0', name: 'Claude Sonnet 5.0', reasoning: true },
      { id: 'claude-sonnet-5-0', reasoning: false }
    );
    expect(enriched.reasoning).toBe(false);
  });

  it('propagates cost from the entry for unknown models', () => {
    const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const enriched = enrichAdobeModel({
      id: 'claude-sonnet-5-0',
      name: 'Claude Sonnet 5.0',
      cost,
    });
    expect(enriched.cost).toEqual(cost);
  });

  it('prefers cached cost over entry cost', () => {
    const entryCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const cachedCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
    const enriched = enrichAdobeModel(
      { id: 'claude-sonnet-5-0', name: 'Sonnet', cost: entryCost },
      { id: 'claude-sonnet-5-0', cost: cachedCost }
    );
    expect(enriched.cost).toEqual(cachedCost);
  });

  it('adds thinkingLevelMap with xhigh for Sonnet 5 (pi-ai 0.80.3 omits it)', () => {
    const enriched = enrichAdobeModel({ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' });
    expect(enriched.thinkingLevelMap).toEqual({ xhigh: 'xhigh' });
  });

  it('does not add thinkingLevelMap for non-Sonnet-5 models', () => {
    const enriched = enrichAdobeModel({ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' });
    expect(enriched.thinkingLevelMap).toBeUndefined();
  });
});
