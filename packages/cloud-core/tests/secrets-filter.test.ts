import { describe, expect, it } from 'vitest';
import { filterSecretsEnv } from '../src/secrets-filter.js';

describe('filterSecretsEnv', () => {
  it('strips E2B_API_KEY with various whitespace shapes', () => {
    const input = [
      'ANTHROPIC_API_KEY=sk-test',
      'E2B_API_KEY=plain',
      '  E2B_API_KEY=leading-space',
      'E2B_API_KEY  =extra-space-before-eq',
      'E2B_API_KEY_DOMAINS=e2b.dev',
      '\tE2B_API_KEY=tab-prefixed',
    ].join('\n');
    const out = filterSecretsEnv(input);
    expect(out).toContain('ANTHROPIC_API_KEY=sk-test');
    // All four E2B_API_KEY variants must be stripped:
    expect(out).not.toContain('E2B_API_KEY=plain');
    expect(out).not.toContain('E2B_API_KEY=leading-space');
    expect(out).not.toContain('E2B_API_KEY=extra-space-before-eq');
    expect(out).not.toContain('E2B_API_KEY_DOMAINS=e2b.dev');
    expect(out).not.toContain('E2B_API_KEY=tab-prefixed');
  });

  it('preserves comments and empty lines', () => {
    const input = '# important comment\n\nANTHROPIC_API_KEY=x\nE2B_API_KEY=strip\n';
    const out = filterSecretsEnv(input);
    expect(out).toContain('# important comment');
    expect(out.split('\n').some((l) => l === '')).toBe(true);
    expect(out).toContain('ANTHROPIC_API_KEY=x');
    expect(out).not.toContain('E2B_API_KEY=strip');
  });
});
