import { describe, expect, it } from 'vitest';

import { minOutputTokens, withOutputTokenFloor } from '../../src/providers/output-token-floor.js';

const bedrock = (id: string, name?: string) => ({ api: 'bedrock-camp-converse', id, name });

describe('minOutputTokens', () => {
  it.each([
    ['global.openai.gpt-6-luna'],
    ['us.openai.gpt-6-sol'],
    ['global.openai.gpt-6.1-sol'],
    ['global.openai.gpt-5.6-terra'],
    ['global.moonshotai.kimi-k3'],
    ['global.xai.grok-4.7'],
  ])('is 16 for %s on Bedrock Converse', (id) => {
    expect(minOutputTokens(bedrock(id))).toBe(16);
  });

  it('applies to pi-ai’s own Bedrock Converse api too', () => {
    expect(
      minOutputTokens({ api: 'bedrock-converse-stream', id: 'global.openai.gpt-6-luna' })
    ).toBe(16);
  });

  it('applies to an opaque application inference profile, whatever it names', () => {
    expect(
      minOutputTokens(
        bedrock(
          'arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/x',
          'GPT-6 Luna'
        )
      )
    ).toBe(16);
  });

  it.each([
    ['global.anthropic.claude-haiku-5-5'],
    ['us.anthropic.claude-sonnet-5-5'],
    ['global.anthropic.claude-opus-5-5'],
  ])('is 1 for Claude %s, which accepts a single token', (id) => {
    expect(minOutputTokens(bedrock(id))).toBe(1);
  });

  it('is 1 where no rule is known', () => {
    expect(minOutputTokens({ api: 'anthropic-messages', id: 'claude-sonnet-5-5' })).toBe(1);
    expect(minOutputTokens({ api: 'azure-openai', id: 'gpt-6-luna' })).toBe(1);
  });
});

describe('withOutputTokenFloor', () => {
  const luna = bedrock('global.openai.gpt-6-luna');

  it('raises a budget below the model minimum to the minimum', () => {
    expect(withOutputTokenFloor(luna, 1)).toBe(16);
    expect(withOutputTokenFloor(luna, 15)).toBe(16);
  });

  it('leaves budgets at or above the minimum, and an absent budget, alone', () => {
    expect(withOutputTokenFloor(luna, 16)).toBe(16);
    expect(withOutputTokenFloor(luna, 4096)).toBe(4096);
    expect(withOutputTokenFloor(luna, undefined)).toBeUndefined();
  });

  it('leaves Claude’s small budgets alone', () => {
    expect(withOutputTokenFloor(bedrock('global.anthropic.claude-haiku-5-5'), 1)).toBe(1);
  });
});
