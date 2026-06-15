import { describe, expect, it } from 'vitest';
import {
  buildScrubber,
  domainMatches,
  isAllowedDomain,
  MIN_MASKABLE_SECRET_LENGTH,
  mask,
} from '../src/secret-masking.js';

describe('mask()', () => {
  it('produces deterministic output for same inputs', async () => {
    const a = await mask('session-1', 'GITHUB_TOKEN', 'ghp_abc123xyz');
    const b = await mask('session-1', 'GITHUB_TOKEN', 'ghp_abc123xyz');
    expect(a).toBe(b);
  });

  it('produces different output for different sessions', async () => {
    const a = await mask('session-1', 'GITHUB_TOKEN', 'ghp_abc123xyz');
    const b = await mask('session-2', 'GITHUB_TOKEN', 'ghp_abc123xyz');
    expect(a).not.toBe(b);
  });

  it('produces different output for different secret names', async () => {
    const a = await mask('session-1', 'TOKEN_A', 'sk-abc123');
    const b = await mask('session-1', 'TOKEN_B', 'sk-abc123');
    expect(a).not.toBe(b);
  });

  it('preserves ghp_ prefix', async () => {
    const result = await mask('s1', 'GH', 'ghp_abc123xyz');
    expect(result.startsWith('ghp_')).toBe(true);
    expect(result.length).toBe('ghp_abc123xyz'.length);
  });

  it('preserves sk- prefix', async () => {
    const result = await mask('s1', 'OPENAI', 'sk-someLongKey123');
    expect(result.startsWith('sk-')).toBe(true);
    expect(result.length).toBe('sk-someLongKey123'.length);
  });

  it('preserves AKIA prefix', async () => {
    const result = await mask('s1', 'AWS', 'AKIAIOSFODNN7EXAMPLE');
    expect(result.startsWith('AKIA')).toBe(true);
    expect(result.length).toBe('AKIAIOSFODNN7EXAMPLE'.length);
  });

  it('preserves xoxb- prefix', async () => {
    const result = await mask('s1', 'SLACK', 'xoxb-123-456-abc');
    expect(result.startsWith('xoxb-')).toBe(true);
    expect(result.length).toBe('xoxb-123-456-abc'.length);
  });

  it('preserves github_pat_ prefix', async () => {
    const result = await mask('s1', 'GH', 'github_pat_abc123');
    expect(result.startsWith('github_pat_')).toBe(true);
    expect(result.length).toBe('github_pat_abc123'.length);
  });

  it('preserves sk-ant- prefix', async () => {
    const result = await mask('s1', 'ANTH', 'sk-ant-abcdef');
    expect(result.startsWith('sk-ant-')).toBe(true);
    expect(result.length).toBe('sk-ant-abcdef'.length);
  });

  it('handles unknown prefix with same-length hex', async () => {
    const result = await mask('s1', 'CUSTOM', 'myCustomSecret123');
    expect(result.length).toBe('myCustomSecret123'.length);
    // no known prefix preserved
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('masked value differs from real value', async () => {
    const real = 'ghp_abc123xyz';
    const result = await mask('s1', 'GH', real);
    expect(result).not.toBe(real);
  });

  it('handles very long values', async () => {
    const real = 'sk-' + 'a'.repeat(200);
    const result = await mask('s1', 'KEY', real);
    expect(result.startsWith('sk-')).toBe(true);
    expect(result.length).toBe(real.length);
  });
});

describe('buildScrubber()', () => {
  it('replaces real values with masked values', () => {
    const scrub = buildScrubber([{ realValue: 'secret123', maskedValue: 'masked00' }]);
    expect(scrub('token is secret123 here')).toBe('token is masked00 here');
  });

  it('replaces multiple occurrences', () => {
    const scrub = buildScrubber([{ realValue: 'abcdefghi', maskedValue: 'xyz123456' }]);
    expect(scrub('abcdefghi and abcdefghi')).toBe('xyz123456 and xyz123456');
  });

  it('handles multiple secrets', () => {
    const scrub = buildScrubber([
      { realValue: 'secret001', maskedValue: 'mask_0001' },
      { realValue: 'secret002', maskedValue: 'mask_0002' },
    ]);
    expect(scrub('secret001 and secret002')).toBe('mask_0001 and mask_0002');
  });

  it('replaces longest match first', () => {
    const scrub = buildScrubber([
      { realValue: 'secret-aa', maskedValue: 'XXXXXXXXX' },
      { realValue: 'secret-aaaa', maskedValue: 'YYYYYYYYYYY' },
    ]);
    expect(scrub('my secret-aaaa key')).toBe('my YYYYYYYYYYY key');
  });

  it('returns identity for empty secrets', () => {
    const scrub = buildScrubber([]);
    expect(scrub('hello')).toBe('hello');
  });

  it('handles text with no matches', () => {
    const scrub = buildScrubber([{ realValue: 'nothereXX', maskedValue: 'maskedXXX' }]);
    expect(scrub('nothing to replace')).toBe('nothing to replace');
  });

  // ---- Minimum-length guard ----

  it('exports MIN_MASKABLE_SECRET_LENGTH = 9', () => {
    expect(MIN_MASKABLE_SECRET_LENGTH).toBe(9);
  });

  it('skips a value shorter than the minimum length (8 chars stays unmasked)', () => {
    const eight = 'abcdefgh'; // 8 chars
    const scrub = buildScrubber([{ realValue: eight, maskedValue: 'MASKED88' }]);
    // Scrubber must NOT replace the too-short value
    expect(scrub(`hello ${eight} world`)).toBe(`hello ${eight} world`);
  });

  it('keeps a value at the minimum length (9 chars masks normally)', () => {
    const nine = 'abcdefghi'; // 9 chars
    const scrub = buildScrubber([{ realValue: nine, maskedValue: 'MASKED999' }]);
    expect(scrub(`hello ${nine} world`)).toBe('hello MASKED999 world');
  });

  it('boundary: short values are excluded while long values still register in the same scrubber', () => {
    const scrub = buildScrubber([
      { realValue: 'short78', maskedValue: 'mask7777' }, // 7 chars — must be skipped
      { realValue: 'longSecret123', maskedValue: 'longMasked123' }, // 13 chars — kept
    ]);
    expect(scrub('short78 and longSecret123')).toBe('short78 and longMasked123');
  });
});

describe('domainMatches()', () => {
  it('matches exact domain', () => {
    expect(domainMatches('api.github.com', 'api.github.com')).toBe(true);
  });

  it('rejects different exact domain', () => {
    expect(domainMatches('api.github.com', 'evil.com')).toBe(false);
  });

  it('wildcard matches subdomain', () => {
    expect(domainMatches('*.github.com', 'api.github.com')).toBe(true);
    expect(domainMatches('*.github.com', 'uploads.github.com')).toBe(true);
  });

  it('wildcard does NOT match bare domain', () => {
    expect(domainMatches('*.github.com', 'github.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(domainMatches('*.GitHub.COM', 'API.github.com')).toBe(true);
    expect(domainMatches('Api.GitHub.com', 'api.github.com')).toBe(true);
  });

  it('rejects partial suffix match', () => {
    expect(domainMatches('*.github.com', 'notgithub.com')).toBe(false);
  });

  it('bare * matches any domain', () => {
    expect(domainMatches('*', 'api.github.com')).toBe(true);
    expect(domainMatches('*', 'example.com')).toBe(true);
    expect(domainMatches('*', 'localhost')).toBe(true);
  });
});

describe('isAllowedDomain()', () => {
  it('returns true if any pattern matches', () => {
    expect(isAllowedDomain(['api.github.com', '*.openai.com'], 'api.openai.com')).toBe(true);
  });

  it('returns false if no pattern matches', () => {
    expect(isAllowedDomain(['api.github.com'], 'evil.com')).toBe(false);
  });

  it('returns false for empty patterns', () => {
    expect(isAllowedDomain([], 'anything.com')).toBe(false);
  });
});
