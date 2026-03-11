import { describe, expect, it } from 'vitest';

import { normalizeAccessibilityText } from './normalize-accessibility-text.js';

describe('normalizeAccessibilityText', () => {
  it('returns fallback for nullish values', () => {
    expect(normalizeAccessibilityText(null, 'fallback')).toBe('fallback');
    expect(normalizeAccessibilityText(undefined, 'fallback')).toBe('fallback');
  });

  it('preserves primitive string-compatible values', () => {
    expect(normalizeAccessibilityText('hello')).toBe('hello');
    expect(normalizeAccessibilityText(0)).toBe('0');
    expect(normalizeAccessibilityText(false)).toBe('false');
    expect(normalizeAccessibilityText(1n)).toBe('1');
  });

  it('serializes JSON-compatible objects and arrays', () => {
    expect(normalizeAccessibilityText({ label: 'Message' })).toBe('{"label":"Message"}');
    expect(normalizeAccessibilityText(['composer'])).toBe('["composer"]');
  });

  it('uses fallback when JSON.stringify returns undefined', () => {
    expect(normalizeAccessibilityText(() => 'noop', 'fallback')).toBe('fallback');
    expect(normalizeAccessibilityText(Symbol('x'), 'fallback')).toBe('fallback');
  });

  it('falls back to String(value) when JSON serialization throws', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(normalizeAccessibilityText(circular)).toBe('[object Object]');
  });
});