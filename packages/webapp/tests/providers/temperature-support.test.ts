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

describe('non-Claude Bedrock models that reject temperature', () => {
  it.each([
    ['global.openai.gpt-5.6-sol'],
    ['global.openai.gpt-5.6-terra'],
    ['global.openai.gpt-5.6-luna'],
    ['global.openai.gpt-6-sol'],
    ['us.openai.gpt-6-sol'],
    ['global.openai.gpt-6-luna'],
    ['us.openai.gpt-6-luna'],
    ['global.openai.gpt-6-astra'],
    ['us.openai.gpt-6-astra'],
    ['global.moonshotai.kimi-k3'],
    ['us.moonshotai.kimi-k3'],
  ])('%s does not support temperature', (id) => {
    expect(modelSupportsTemperature(id)).toBe(false);
  });

  it('matches on the display name for opaque application-inference-profile ARNs', () => {
    const arn = 'arn:aws:bedrock:us-west-2:1:application-inference-profile/x';
    expect(modelSupportsTemperature(arn, 'GPT-5.6 Sol (Global)')).toBe(false);
    expect(modelSupportsTemperature(arn, 'GPT-6 Astra (US)')).toBe(false);
    expect(modelSupportsTemperature(arn, 'Kimi K3 (Global)')).toBe(false);
  });

  it.each([['global.anthropic.claude-fable-5-1'], ['us.anthropic.claude-fable-5-1']])(
    '%s does not support temperature',
    (id) => {
      expect(modelSupportsTemperature(id)).toBe(false);
    }
  );

  it.each([
    ['global.openai.gpt-6-terra'],
    ['global.openai.gpt-6.1-sol'],
    ['global.moonshotai.kimi-k3.5'],
    ['global.moonshotai.kimi-k30'],
    ['global.moonshotai.kimi-k2.5'],
  ])('%s is not caught by the pinned patterns', (id) => {
    expect(modelSupportsTemperature(id)).toBe(true);
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

      'global.xai.grok-4.6',
      'global.xai.grok-4.3',
    ]) {
      expect(modelSupportsTemperature(id), id).toBe(true);
    }
  });
});
