import { describe, it, expect } from 'vitest';
import { initialsFromLabel } from '../../src/ui/avatar-initials.js';

describe('initialsFromLabel', () => {
  it('derives initials from an OAuth "email (Plan)" label', () => {
    // Regression: the naive first/last-word split produced "L(" because
    // of the " (Team)" suffix and the "@" — we want "LT".
    expect(initialsFromLabel('lars@trieloff.net (Team)')).toBe('LT');
  });

  it('uses local + domain initials for a single-segment email', () => {
    expect(initialsFromLabel('lars@trieloff.net')).toBe('LT');
  });

  it('uses both local-part segments when the address is dotted', () => {
    expect(initialsFromLabel('lars.trieloff@example.com')).toBe('LT');
    expect(initialsFromLabel('john_doe@example.com')).toBe('JD');
  });

  it('handles plain first/last names', () => {
    expect(initialsFromLabel('Lars Trieloff')).toBe('LT');
  });

  it('falls back to the first two characters for a single token', () => {
    expect(initialsFromLabel('octocat')).toBe('OC');
  });

  it('returns empty string for blank input', () => {
    expect(initialsFromLabel('')).toBe('');
    expect(initialsFromLabel(undefined)).toBe('');
    expect(initialsFromLabel(null)).toBe('');
  });
});
