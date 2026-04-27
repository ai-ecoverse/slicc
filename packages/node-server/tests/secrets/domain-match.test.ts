import { describe, expect, it } from 'vitest';
import { matchDomain, matchesDomains } from '../../src/secrets/domain-match.js';

describe('matchDomain', () => {
  it('matches exact domain', () => {
    expect(matchDomain('api.github.com', 'api.github.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchDomain('API.GitHub.COM', 'api.github.com')).toBe(true);
    expect(matchDomain('api.github.com', 'API.GITHUB.COM')).toBe(true);
  });

  it('does not match different domains', () => {
    expect(matchDomain('evil.com', 'api.github.com')).toBe(false);
  });

  it('matches wildcard subdomain pattern', () => {
    expect(matchDomain('api.github.com', '*.github.com')).toBe(true);
    expect(matchDomain('raw.github.com', '*.github.com')).toBe(true);
  });

  it('wildcard does not match the base domain itself', () => {
    expect(matchDomain('github.com', '*.github.com')).toBe(false);
  });

  it('wildcard does not match unrelated domains', () => {
    expect(matchDomain('evil.com', '*.github.com')).toBe(false);
    expect(matchDomain('github.com.evil.com', '*.github.com')).toBe(false);
  });

  it('matches deep subdomains with wildcard', () => {
    expect(matchDomain('a.b.github.com', '*.github.com')).toBe(true);
  });

  it('matches bare wildcard *', () => {
    expect(matchDomain('anything.com', '*')).toBe(true);
    expect(matchDomain('api.github.com', '*')).toBe(true);
  });
});

describe('matchesDomains', () => {
  it('returns true if any pattern matches', () => {
    expect(matchesDomains('api.github.com', ['api.openai.com', '*.github.com'])).toBe(true);
  });

  it('returns false if no pattern matches', () => {
    expect(matchesDomains('evil.com', ['api.openai.com', '*.github.com'])).toBe(false);
  });

  it('returns false for empty patterns list', () => {
    expect(matchesDomains('api.github.com', [])).toBe(false);
  });
});
