import { describe, expect, it } from 'vitest';

/** Option bag whose type carries the onPayload the shim may attach. */
type ShimOptions = {
  reasoning?: string;
  effort?: string;
  apiKey?: string;
  onPayload?: (
    payload: Record<string, unknown>,
    model: never
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
};

import {
  adaptiveThinkingPayloadHook,
  modelNeedsAdaptiveThinkingShim,
  thinkingLevelToEffort,
  withAdaptiveThinkingShim,
} from '../../src/providers/adaptive-thinking.js';

describe('modelNeedsAdaptiveThinkingShim', () => {
  it.each([
    // Models pi-ai already emits adaptive for — the rewrite is still safe (no-op
    // unless thinking.type === 'enabled' is present in the payload).
    ['claude-opus-4-6'],
    ['claude-opus-4-7'],
    ['us.anthropic.claude-sonnet-4-6'],
    // Models pi-ai 0.75.3 misses — these actually need the rewrite.
    ['claude-opus-4-8'],
    ['us.anthropic.claude-opus-4-8'],
    ['claude opus 4 8'],
    // Future releases are picked up automatically by the version threshold.
    ['claude-opus-4-9'],
    ['claude-sonnet-4-7'],
    ['claude-sonnet-5-0'],
    ['us.anthropic.claude-sonnet-5-0'],
  ])('returns true for adaptive-capable %s', (id) => {
    expect(modelNeedsAdaptiveThinkingShim(id)).toBe(true);
  });

  it.each([
    // Older Claude families that pre-date adaptive thinking.
    ['claude-opus-4-5'],
    ['claude-sonnet-4-5'],
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
  ])('maps level %s → effort %s (no model: legacy passthrough)', (level, effort) => {
    expect(thinkingLevelToEffort(level as never)).toBe(effort);
  });

  it('defaults to high when no level is given', () => {
    expect(thinkingLevelToEffort(undefined)).toBe('high');
  });

  it('honors a model thinkingLevelMap override (no model id: not clamped)', () => {
    expect(thinkingLevelToEffort('high', { thinkingLevelMap: { high: 'xhigh' } })).toBe('xhigh');
  });

  // xhigh clamping mirrors bedrock-camp's mapThinkingLevelToEffort — model ids
  // mirror those in claude-model-version.test.ts.
  it('keeps xhigh for Opus ≥ 4.7 (native xhigh)', () => {
    expect(thinkingLevelToEffort('xhigh', { id: 'claude-opus-4-7' })).toBe('xhigh');
    expect(thinkingLevelToEffort('xhigh', { id: 'claude-opus-4-8' })).toBe('xhigh');
    expect(thinkingLevelToEffort('xhigh', { id: 'us.anthropic.claude-opus-4-8' })).toBe('xhigh');
  });

  it('clamps xhigh to max for Opus 4.6', () => {
    expect(thinkingLevelToEffort('xhigh', { id: 'claude-opus-4-6' })).toBe('max');
  });

  it('clamps xhigh to high for Sonnet 4.6 (no native xhigh, no max)', () => {
    expect(thinkingLevelToEffort('xhigh', { id: 'claude-sonnet-4-6' })).toBe('high');
    expect(thinkingLevelToEffort('xhigh', { id: 'us.anthropic.claude-sonnet-4-6' })).toBe('high');
  });

  it('clamps xhigh to high for Sonnet 5.0', () => {
    expect(thinkingLevelToEffort('xhigh', { id: 'claude-sonnet-5-0' })).toBe('high');
  });

  it('matches model name when the id is opaque (Opus 4.6 → max)', () => {
    expect(thinkingLevelToEffort('xhigh', { id: 'opaque', name: 'Claude Opus 4.6' })).toBe('max');
  });

  it('clamps a thinkingLevelMap override that resolves to xhigh', () => {
    // Override maps 'high' → 'xhigh', then clamp downshifts for Sonnet 4.6.
    expect(
      thinkingLevelToEffort('high', {
        id: 'claude-sonnet-4-6',
        thinkingLevelMap: { high: 'xhigh' },
      })
    ).toBe('high');
    // Same override but on Opus 4.6 clamps to 'max'.
    expect(
      thinkingLevelToEffort('high', {
        id: 'claude-opus-4-6',
        thinkingLevelMap: { high: 'xhigh' },
      })
    ).toBe('max');
  });

  it('leaves non-xhigh values untouched even with a clamping-eligible model', () => {
    expect(thinkingLevelToEffort('high', { id: 'claude-opus-4-6' })).toBe('high');
    expect(thinkingLevelToEffort('medium', { id: 'claude-sonnet-4-6' })).toBe('medium');
    expect(thinkingLevelToEffort('low', { id: 'claude-opus-4-7' })).toBe('low');
    expect(thinkingLevelToEffort(undefined, { id: 'claude-opus-4-6' })).toBe('high');
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
    const opts = withAdaptiveThinkingShim({ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }, {
      reasoning: 'high',
      apiKey: 'tok',
    } as ShimOptions);
    expect(typeof opts.onPayload).toBe('function');
    const out = await opts.onPayload!(
      { thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' } },
      {} as never
    );
    expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(out.output_config).toEqual({ effort: 'high' });
  });

  it('returns the options unchanged for a model that pre-dates adaptive thinking', () => {
    const input = { reasoning: 'high', apiKey: 'tok' };
    const out = withAdaptiveThinkingShim({ id: 'claude-opus-4-5' }, input);
    expect(out).toBe(input);
  });

  it('returns the options unchanged for a non-Claude model', () => {
    const input = { reasoning: 'high', apiKey: 'tok' };
    const out = withAdaptiveThinkingShim({ id: 'gpt-4o' }, input);
    expect(out).toBe(input);
  });

  it('attaches an onPayload that is a no-op for adaptive-already payloads (opus-4-7)', async () => {
    const opts = withAdaptiveThinkingShim({ id: 'claude-opus-4-7', name: 'Claude Opus 4.7' }, {
      reasoning: 'high',
      apiKey: 'tok',
    } as ShimOptions);
    // Hook is attached even though pi-ai already emits adaptive for opus-4-7,
    // but it only rewrites when thinking.type === 'enabled' is present.
    expect(typeof opts.onPayload).toBe('function');
    const adaptiveIn = { thinking: { type: 'adaptive', display: 'summarized' } };
    const out = await opts.onPayload!(adaptiveIn, {} as never);
    expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(out).not.toHaveProperty('output_config');
  });

  it('clamps an unsupported reasoning: xhigh per model (Opus 4.6 → max, Sonnet 4.6 → high)', async () => {
    const opus46 = withAdaptiveThinkingShim({ id: 'claude-opus-4-6' }, {
      reasoning: 'xhigh',
      apiKey: 'tok',
    } as ShimOptions);
    const opus46Out = await opus46.onPayload!(
      { thinking: { type: 'enabled', budget_tokens: 1024 } },
      {} as never
    );
    expect(opus46Out.output_config).toEqual({ effort: 'max' });

    const sonnet46 = withAdaptiveThinkingShim({ id: 'claude-sonnet-4-6' }, {
      reasoning: 'xhigh',
      apiKey: 'tok',
    } as ShimOptions);
    const sonnet46Out = await sonnet46.onPayload!(
      { thinking: { type: 'enabled', budget_tokens: 1024 } },
      {} as never
    );
    expect(sonnet46Out.output_config).toEqual({ effort: 'high' });

    const opus48 = withAdaptiveThinkingShim({ id: 'claude-opus-4-8' }, {
      reasoning: 'xhigh',
      apiKey: 'tok',
    } as ShimOptions);
    const opus48Out = await opus48.onPayload!(
      { thinking: { type: 'enabled', budget_tokens: 1024 } },
      {} as never
    );
    expect(opus48Out.output_config).toEqual({ effort: 'xhigh' });
  });

  it('clamps a caller-supplied explicit effort: "xhigh" the same way', async () => {
    const opts = withAdaptiveThinkingShim({ id: 'claude-sonnet-4-6' }, {
      effort: 'xhigh',
      apiKey: 'tok',
    } as ShimOptions);
    const out = await opts.onPayload!(
      { thinking: { type: 'enabled', budget_tokens: 1024 } },
      {} as never
    );
    expect(out.output_config).toEqual({ effort: 'high' });
  });
});
