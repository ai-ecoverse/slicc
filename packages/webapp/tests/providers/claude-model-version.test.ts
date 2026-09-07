import { describe, expect, it } from 'vitest';

import {
  claudeRejectsTemperature,
  claudeSupportsAdaptiveThinking,
  claudeSupportsMaxEffort,
  claudeSupportsNativeXhighEffort,
  claudeSupportsPromptCaching,
  parseClaudeVersion,
} from '../../src/providers/claude-model-version.js';

describe('parseClaudeVersion', () => {
  it.each([
    ['claude-opus-4-5', { family: 'opus', major: 4, minor: 5 }],
    ['claude-opus-4-6', { family: 'opus', major: 4, minor: 6 }],
    ['claude-opus-4-7', { family: 'opus', major: 4, minor: 7 }],
    ['claude-opus-4-8', { family: 'opus', major: 4, minor: 8 }],
    ['claude-opus-4-9', { family: 'opus', major: 4, minor: 9 }],
    ['claude-sonnet-4-5', { family: 'sonnet', major: 4, minor: 5 }],
    ['claude-sonnet-4-6', { family: 'sonnet', major: 4, minor: 6 }],
    ['claude-sonnet-5', { family: 'sonnet', major: 5, minor: 0 }],
    ['claude-sonnet-5-0', { family: 'sonnet', major: 5, minor: 0 }],
    ['us.anthropic.claude-sonnet-5-0', { family: 'sonnet', major: 5, minor: 0 }],
    ['claude-haiku-4-5', { family: 'haiku', major: 4, minor: 5 }],
    ['claude-opus-5', { family: 'opus', major: 5, minor: 0 }],
    ['claude-fable-5', { family: 'fable', major: 5, minor: 0 }],
    ['claude-fable-5-1', { family: 'fable', major: 5, minor: 1 }],
    ['us.anthropic.claude-fable-5-1', { family: 'fable', major: 5, minor: 1 }],
    ['us.anthropic.claude-opus-4-8', { family: 'opus', major: 4, minor: 8 }],
    ['global.anthropic.claude-opus-4-9', { family: 'opus', major: 4, minor: 9 }],
  ])('parses %s', (id, expected) => {
    expect(parseClaudeVersion(id)).toEqual(expected);
  });

  it('parses a display-name form like "Claude Opus 4.8"', () => {
    expect(parseClaudeVersion('opaque-routing-id', 'Claude Opus 4.8 (US)')).toEqual({
      family: 'opus',
      major: 4,
      minor: 8,
    });
  });

  it('normalizes underscore / space / dot separators', () => {
    expect(parseClaudeVersion('claude_opus_4_8')).toEqual({
      family: 'opus',
      major: 4,
      minor: 8,
    });
    expect(parseClaudeVersion('claude opus 4 9')).toEqual({
      family: 'opus',
      major: 4,
      minor: 9,
    });
  });

  it.each([
    ['gpt-4o'],
    ['gemini-2.5-pro'],
    ['opaque-routing-id'],
    [''],
    // Legacy dated IDs must NOT match (date suffix looks like a version)
    ['claude-3-5-sonnet-20241022'],
    ['claude-3-7-sonnet-20250219'],
  ])('returns null for non-Claude id %s', (id) => {
    expect(parseClaudeVersion(id)).toBeNull();
  });
});

describe('claudeSupportsAdaptiveThinking', () => {
  it.each([
    ['claude-opus-4-6'],
    ['claude-opus-4-7'],
    ['claude-opus-4-8'],
    ['claude-opus-4-9'],
    ['claude-sonnet-4-6'],
    ['claude-sonnet-4-7'],
    ['claude-sonnet-5'],
    ['claude-sonnet-5-0'],
    ['us.anthropic.claude-sonnet-5-0'],
    ['claude-opus-5'],
    // Verified live against bedrock-runtime.us-west-2: fable-5 400s on
    // `thinking.type.enabled` and demands `thinking.type.adaptive`.
    ['claude-fable-5'],
    ['claude-fable-5-1'],
  ])('returns true for adaptive-capable %s', (id) => {
    expect(claudeSupportsAdaptiveThinking(id)).toBe(true);
  });

  it.each([
    ['claude-opus-4-5'],
    ['claude-sonnet-4-5'],
    ['claude-haiku-4-9'], // haiku stays on legacy regardless of version
    ['gpt-4o'],
  ])('returns false for non-adaptive %s', (id) => {
    expect(claudeSupportsAdaptiveThinking(id)).toBe(false);
  });
});

describe('claudeSupportsNativeXhighEffort', () => {
  it.each([
    ['claude-opus-4-7'],
    ['claude-opus-4-8'],
    ['claude-opus-4-9'],
    ['claude-sonnet-5'],
    ['claude-sonnet-5-0'],
    ['us.anthropic.claude-sonnet-5-0'],
    ['claude-opus-5'],
    ['claude-fable-5'],
    ['claude-fable-5-1'],
  ])('returns true for Opus ≥ 4.7, Sonnet ≥ 5.0, or Fable (%s)', (id) => {
    expect(claudeSupportsNativeXhighEffort(id)).toBe(true);
  });

  it.each([['claude-opus-4-6'], ['claude-sonnet-4-6'], ['claude-sonnet-4-7'], ['gpt-4o']])(
    'returns false for %s',
    (id) => {
      expect(claudeSupportsNativeXhighEffort(id)).toBe(false);
    }
  );
});

describe('claudeSupportsMaxEffort', () => {
  it.each([['claude-opus-4-6'], ['claude-sonnet-4-6']])(
    'returns true for %s (xhigh → max clamp)',
    (id) => {
      expect(claudeSupportsMaxEffort(id)).toBe(true);
    }
  );

  it.each([
    ['claude-opus-4-5'],
    ['claude-opus-4-7'],
    ['claude-opus-4-8'],
    ['claude-sonnet-5'],
    ['claude-sonnet-5-0'],
    ['claude-fable-5'],
    ['gpt-4o'],
  ])('returns false for %s', (id) => {
    expect(claudeSupportsMaxEffort(id)).toBe(false);
  });
});

describe('claudeSupportsPromptCaching', () => {
  it.each([
    ['claude-opus-4-5'],
    ['claude-opus-4-8'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0'],
    ['claude-haiku-4-5'],
    // Regression: these have no `-4-` in the id, which the old substring
    // check keyed on, so cache points were dropped on every request.
    ['us.anthropic.claude-opus-5'],
    ['us.anthropic.claude-sonnet-5'],
    ['us.anthropic.claude-fable-5'],
    // Legacy 3.x backports.
    ['anthropic.claude-3-7-sonnet-20250219-v1:0'],
    ['anthropic.claude-3-5-haiku-20241022-v1:0'],
  ])('returns true for %s', (id) => {
    expect(claudeSupportsPromptCaching(id)).toBe(true);
  });

  it.each([
    ['anthropic.claude-3-haiku-20240307-v1:0'],
    ['anthropic.claude-3-5-sonnet-20241022-v1:0'],
    ['us.amazon.nova-pro-v1'],
    ['gpt-4o'],
  ])('returns false for %s', (id) => {
    expect(claudeSupportsPromptCaching(id)).toBe(false);
  });

  it('matches on the display name for opaque application-inference-profile ARNs', () => {
    expect(
      claudeSupportsPromptCaching(
        'arn:aws:bedrock:us-west-2:1:application-inference-profile/x',
        'Claude Opus 5'
      )
    ).toBe(true);
  });
});

describe('claudeRejectsTemperature', () => {
  // The reject list tracks generations, not families. Every id below was
  // confirmed against bedrock-runtime.us-west-2, which answers
  // `400 \`temperature\` is deprecated for this model.`
  it.each([
    ['claude-opus-4-7'],
    ['claude-opus-4-8'],
    ['claude-opus-4-9'],
    ['claude-opus-5'],
    ['claude-sonnet-5'],
    ['claude-sonnet-5-0'],
    ['claude-fable-5'],
    ['claude-fable-5-1'],
  ])('returns true for Opus ≥ 4.7, Sonnet ≥ 5.0, or Fable (%s)', (id) => {
    expect(claudeRejectsTemperature(id)).toBe(true);
  });

  it.each([
    ['claude-opus-4-6'],
    ['claude-sonnet-4-6'],
    ['claude-sonnet-4-9'],
    // Haiku 4.5 still accepts `temperature` (live-verified).
    ['claude-haiku-4-9'],
    ['gpt-4o'],
  ])('returns false for %s', (id) => {
    expect(claudeRejectsTemperature(id)).toBe(false);
  });
});
