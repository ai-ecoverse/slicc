import { describe, expect, it } from 'vitest';

import {
  modelSupportsTemperature,
  withSupportedTemperature,
} from '../../src/providers/temperature-support.js';

describe('modelSupportsTemperature', () => {
  it.each([
    ['claude-opus-4-8'],
    ['us.anthropic.claude-opus-4-8'],
    ['global.anthropic.claude-opus-4-8'],
    ['claude-opus-4-7'],
    ['us.anthropic.claude-opus-4-7'],
    // Future Opus releases (4.9, 5.x) inherit the reject behavior via the
    // shared version threshold.
    ['claude-opus-4-9'],
    ['us.anthropic.claude-opus-4-9'],
  ])('returns false for temperature-rejecting model id %s', (id) => {
    expect(modelSupportsTemperature(id)).toBe(false);
  });

  it.each([
    ['claude-opus-4-6'],
    ['us.anthropic.claude-sonnet-4-6'],
    ['claude-haiku-4-5'],
    ['gpt-4o'],
    ['gemini-2.5-pro'],
  ])('returns true for model id %s that accepts temperature', (id) => {
    expect(modelSupportsTemperature(id)).toBe(true);
  });

  it('matches on the display name when the id is opaque', () => {
    // The Adobe proxy sometimes carries the human name, not a dotted id.
    expect(modelSupportsTemperature('opaque-routing-id', 'Claude Opus 4.8 (US)')).toBe(false);
    expect(modelSupportsTemperature('opaque-routing-id', 'Claude Sonnet 4.6 (US)')).toBe(true);
  });

  it('normalizes separators (dots/underscores/spaces) before matching', () => {
    expect(modelSupportsTemperature('claude opus 4 8')).toBe(false);
    expect(modelSupportsTemperature('claude_opus_4_8')).toBe(false);
  });
});

describe('withSupportedTemperature', () => {
  it('strips temperature for a model that rejects it', () => {
    const out = withSupportedTemperature('claude-opus-4-8', 'Claude Opus 4.8', {
      temperature: 0.3,
      maxTokens: 24,
    });
    expect(out).not.toHaveProperty('temperature');
    expect(out.maxTokens).toBe(24);
  });

  it('keeps temperature for a model that accepts it', () => {
    const out = withSupportedTemperature('claude-sonnet-4-6', 'Claude Sonnet 4.6', {
      temperature: 0.3,
      maxTokens: 24,
    });
    expect(out.temperature).toBe(0.3);
    expect(out.maxTokens).toBe(24);
  });

  it('is a no-op when no temperature is set', () => {
    const options: { maxTokens: number; temperature?: number } = { maxTokens: 24 };
    const out = withSupportedTemperature('claude-opus-4-8', 'Claude Opus 4.8', options);
    expect(out).toBe(options);
  });

  it('does not mutate the caller-supplied options object', () => {
    const options = { temperature: 0.3, maxTokens: 24 };
    withSupportedTemperature('claude-opus-4-8', undefined, options);
    expect(options.temperature).toBe(0.3);
  });
});

/**
 * Non-Claude allowlisted models. Both answer
 * `400 "This model doesn't support the temperature field."` on
 * `bedrock-runtime.us-west-2`, so `quick-llm.ts`'s `temperature: 0.3` helper
 * calls would fail without this. Paired with the picker allowlist in
 * `built-in/bedrock-camp-compat.ts` — extend both together.
 */
describe('non-Claude Bedrock models that reject temperature', () => {
  it.each([
    ['global.openai.gpt-5.6-sol'],
    ['global.openai.gpt-5.6-terra'],
    ['global.openai.gpt-5.6-luna'],
  ])('%s does not support temperature', (id) => {
    expect(modelSupportsTemperature(id)).toBe(false);
  });

  it('matches on the display name for opaque application-inference-profile ARNs', () => {
    const arn = 'arn:aws:bedrock:us-west-2:1:application-inference-profile/x';
    expect(modelSupportsTemperature(arn, 'GPT-5.6 Sol (Global)')).toBe(false);
  });

  it('strips temperature from options for those models', () => {
    expect(
      withSupportedTemperature('global.openai.gpt-5.6-sol', undefined, {
        temperature: 0.3,
        maxTokens: 8,
      })
    ).toEqual({ maxTokens: 8 });
  });

  it('leaves other non-Claude Bedrock models alone', () => {
    for (const id of [
      'us.amazon.nova-pro-v1:0',
      'us.openai.gpt-oss-120b-1:0',
      'global.zai.glm-5',
      'us.qwen.qwen3-32b-v1:0',
      // Not allowlisted, so never reached — and must not be misdetected.
      'global.xai.grok-4.6',
      'global.xai.grok-4.3',
    ]) {
      expect(modelSupportsTemperature(id), id).toBe(true);
    }
  });
});
