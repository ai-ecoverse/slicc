import { describe, expect, it } from 'vitest';

import {
  adaptiveThinkingPayloadHook,
  modelNeedsAdaptiveThinkingShim,
  thinkingLevelToEffort,
  withAdaptiveThinkingShim,
} from '../../src/providers/adaptive-thinking.js';

describe('modelNeedsAdaptiveThinkingShim', () => {
  it.each([
    ['claude-opus-4-8'],
    ['us.anthropic.claude-opus-4-8'],
    ['claude opus 4 8'],
  ])('returns true for opus-4-8 form %s (pi-ai 0.75.3 does not know it)', (id) => {
    expect(modelNeedsAdaptiveThinkingShim(id)).toBe(true);
  });

  it.each([
    // pi-ai already emits adaptive for these — no shim needed.
    ['claude-opus-4-6'],
    ['claude-opus-4-7'],
    ['us.anthropic.claude-sonnet-4-6'],
    // unrelated models
    ['gpt-4o'],
  ])('returns false for %s', (id) => {
    expect(modelNeedsAdaptiveThinkingShim(id)).toBe(false);
  });

  it('matches on display name when the id is opaque', () => {
    expect(modelNeedsAdaptiveThinkingShim('opaque', 'Claude Opus 4.8 (US)')).toBe(true);
  });
});

describe('thinkingLevelToEffort', () => {
  it.each([
    ['minimal', 'low'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
  ])('maps level %s → effort %s', (level, effort) => {
    expect(thinkingLevelToEffort(level as never)).toBe(effort);
  });

  it('defaults to high when no level is given', () => {
    expect(thinkingLevelToEffort(undefined)).toBe('high');
  });

  it('honors a model thinkingLevelMap override', () => {
    expect(thinkingLevelToEffort('high', { high: 'xhigh' })).toBe('xhigh');
  });
});

describe('adaptiveThinkingPayloadHook', () => {
  it('rewrites enabled-thinking into the adaptive shape + output_config.effort', async () => {
    const hook = adaptiveThinkingPayloadHook('high');
    const out = await hook(
      {
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
      },
      {} as never
    );
    expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(out.thinking).not.toHaveProperty('budget_tokens');
    expect(out.output_config).toEqual({ effort: 'high' });
    expect(out.max_tokens).toBe(4096);
  });

  it('is a no-op when there is no thinking block (thinking disabled)', async () => {
    const hook = adaptiveThinkingPayloadHook('high');
    const params = { model: 'claude-opus-4-8', max_tokens: 64 };
    const out = await hook(params, {} as never);
    expect(out).not.toHaveProperty('output_config');
    expect(out).not.toHaveProperty('thinking');
  });

  it('is a no-op when thinking is already adaptive', async () => {
    const hook = adaptiveThinkingPayloadHook('low');
    const params = { thinking: { type: 'adaptive', display: 'summarized' } };
    const out = await hook(params, {} as never);
    expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(out).not.toHaveProperty('output_config');
  });

  it('composes with a prior onPayload (prior runs first)', async () => {
    const prior = (p: Record<string, unknown>) => ({ ...p, tagged: true });
    const hook = adaptiveThinkingPayloadHook('medium', prior);
    const out = await hook({ thinking: { type: 'enabled', budget_tokens: 1024 } }, {} as never);
    expect(out.tagged).toBe(true);
    expect(out.thinking).toEqual({ type: 'adaptive' });
    expect(out.output_config).toEqual({ effort: 'medium' });
  });
});

describe('withAdaptiveThinkingShim', () => {
  it('attaches an onPayload that adapts the body for opus-4-8', async () => {
    const opts = withAdaptiveThinkingShim(
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
      { reasoning: 'high', apiKey: 'tok' }
    );
    expect(typeof opts.onPayload).toBe('function');
    const out = await opts.onPayload!(
      { thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' } },
      {} as never
    );
    expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(out.output_config).toEqual({ effort: 'high' });
  });

  it('returns the options unchanged for a model pi-ai already handles', () => {
    const input = { reasoning: 'high', apiKey: 'tok' };
    const out = withAdaptiveThinkingShim({ id: 'claude-opus-4-7' }, input);
    expect(out).toBe(input);
  });
});
