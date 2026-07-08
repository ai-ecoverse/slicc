import { describe, expect, it } from 'vitest';

import {
  claudeRejectsTemperature,
  claudeSupportsAdaptiveThinking,
  claudeSupportsMaxEffort,
  claudeSupportsNativeXhighEffort,
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
    ['claude-sonnet-5-0', { family: 'sonnet', major: 5, minor: 0 }],
    ['us.anthropic.claude-sonnet-5-0', { family: 'sonnet', major: 5, minor: 0 }],
    ['claude-haiku-4-5', { family: 'haiku', major: 4, minor: 5 }],
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
    ['claude-sonnet-5-0'],
    ['us.anthropic.claude-sonnet-5-0'],
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
    ['claude-sonnet-5-0'],
    ['us.anthropic.claude-sonnet-5-0'],
  ])('returns true for Opus ≥ 4.7 or Sonnet ≥ 5.0 (%s)', (id) => {
    expect(claudeSupportsNativeXhighEffort(id)).toBe(true);
  });

  it.each([
    ['claude-opus-4-6'],
    ['claude-sonnet-4-6'],
    ['claude-sonnet-4-7'],
    ['gpt-4o'],
  ])('returns false for %s', (id) => {
    expect(claudeSupportsNativeXhighEffort(id)).toBe(false);
  });
});

describe('claudeSupportsMaxEffort', () => {
  it.each([
    ['claude-opus-4-6'],
    ['claude-sonnet-4-6'],
  ])('returns true for %s (xhigh → max clamp)', (id) => {
    expect(claudeSupportsMaxEffort(id)).toBe(true);
  });

  it.each([
    ['claude-opus-4-5'],
    ['claude-opus-4-7'],
    ['claude-opus-4-8'],
    ['claude-sonnet-5-0'],
    ['gpt-4o'],
  ])('returns false for %s', (id) => {
    expect(claudeSupportsMaxEffort(id)).toBe(false);
  });
});

describe('claudeRejectsTemperature', () => {
  it.each([
    ['claude-opus-4-7'],
    ['claude-opus-4-8'],
    ['claude-opus-4-9'],
  ])('returns true for Opus ≥ 4.7 (%s)', (id) => {
    expect(claudeRejectsTemperature(id)).toBe(true);
  });

  it.each([
    ['claude-opus-4-6'],
    ['claude-sonnet-4-6'],
    ['claude-sonnet-5-0'],
    ['claude-sonnet-4-9'],
    ['claude-haiku-4-9'],
    ['gpt-4o'],
  ])('returns false for %s', (id) => {
    expect(claudeRejectsTemperature(id)).toBe(false);
  });
});
