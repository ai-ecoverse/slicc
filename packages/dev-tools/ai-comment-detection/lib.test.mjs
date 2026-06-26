import { describe, expect, it } from 'vitest';
import {
  AI_GENERATED_LABEL,
  classifyComment,
  decideLabels,
  HUMAN_IN_THE_LOOP_LABEL,
  interpretPangram,
  isBotAccount,
  isBotLogin,
  isThreadSettledHuman,
  jaccardSimilarity,
  MARKDOWN_DENSITY_THRESHOLD,
  markdownDensity,
  maxSimilarity,
  tokenize,
} from './lib.mjs';

describe('isBotLogin', () => {
  it('flags [bot] suffixes and known bot logins', () => {
    expect(isBotLogin('dependabot[bot]')).toBe(true);
    expect(isBotLogin('renovate')).toBe(true);
    expect(isBotLogin('github-actions')).toBe(true);
    expect(isBotLogin('my-ci')).toBe(true);
  });
  it('does not flag ordinary human logins', () => {
    expect(isBotLogin('trieloff')).toBe(false);
    expect(isBotLogin('octocat')).toBe(false);
  });
  it('tolerates null/undefined/empty', () => {
    expect(isBotLogin(null)).toBe(false);
    expect(isBotLogin('')).toBe(false);
  });
});

describe('isBotAccount', () => {
  it('treats GitHub Bot type and app-token comments as bots', () => {
    expect(isBotAccount({ login: 'someone', type: 'Bot' })).toBe(true);
    expect(isBotAccount({ login: 'someone', viaApp: true })).toBe(true);
  });
  it('falls back to login heuristics for User accounts', () => {
    expect(isBotAccount({ login: 'renovate', type: 'User' })).toBe(true);
    expect(isBotAccount({ login: 'trieloff', type: 'User' })).toBe(false);
  });
});

describe('markdownDensity', () => {
  it('scores heavily formatted text high and plain text zero', () => {
    const formatted = '## Heading\n\n- **bold** item with `code`\n- [link](http://x)\n\n> quote';
    expect(markdownDensity(formatted)).toBeGreaterThan(0.15);
    expect(markdownDensity('lgtm thanks for the fix')).toBe(0);
  });
  it('returns 0 for empty input', () => {
    expect(markdownDensity('')).toBe(0);
    expect(markdownDensity(null)).toBe(0);
  });
});

describe('similarity', () => {
  it('tokenizes into a lowercased word set', () => {
    expect(tokenize('Hello, WORLD hello')).toEqual(new Set(['hello', 'world']));
  });
  it('computes jaccard similarity', () => {
    expect(jaccardSimilarity(tokenize('a b c'), tokenize('a b c'))).toBe(1);
    expect(jaccardSimilarity(tokenize('a b'), tokenize('c d'))).toBe(0);
  });
  it('finds the max similarity against a corpus', () => {
    const sim = maxSimilarity('the build is green', ['the build is green', 'totally different']);
    expect(sim).toBe(1);
    expect(maxSimilarity('', ['anything'])).toBe(0);
  });
});

describe('interpretPangram', () => {
  it('reads the async task schema (fraction_ai + assisted)', () => {
    const v = interpretPangram({
      stage: 'STAGE_SUCCESS',
      fraction_ai: 0.7,
      fraction_ai_assisted: 0.2,
    });
    expect(v).toEqual({ isAi: true, score: expect.closeTo(0.9, 5), available: true });
  });
  it('reads the v3 sync schema (ai_likelihood)', () => {
    expect(interpretPangram({ ai_likelihood: 0.1 }).isAi).toBe(false);
    expect(interpretPangram({ ai_likelihood: 0.9 }).isAi).toBe(true);
  });
  it('marks failed/empty results unavailable', () => {
    expect(interpretPangram({ stage: 'STAGE_FAILED' }).available).toBe(false);
    expect(interpretPangram(null).available).toBe(false);
  });
});

describe('classifyComment (cascade)', () => {
  it('short-circuits on a bot account without calling pangram', async () => {
    let called = false;
    const v = await classifyComment({
      login: 'renovate',
      body: 'plain text',
      pangram: async () => {
        called = true;
        return {};
      },
    });
    expect(v.isHuman).toBe(false);
    expect(v.method).toBe('account');
    expect(called).toBe(false);
  });
  it('flags heavy markdown before reaching pangram', async () => {
    const v = await classifyComment({
      login: 'human',
      body: '## H\n- **a** `b`\n- [c](http://d)\n> q',
      pangram: async () => ({ fraction_ai: 0 }),
    });
    expect(v.method).toBe('markdown-density');
    expect(v.isHuman).toBe(false);
  });
  it('flags moderately formatted prose at the tuned 0.12 threshold', async () => {
    // ~0.125 density: above the tuned 0.12 threshold, below the old 0.15 one.
    const body =
      'We should refactor this **helper** and move the `parse` call into the utils module sometime soon';
    expect(markdownDensity(body)).toBeGreaterThanOrEqual(MARKDOWN_DENSITY_THRESHOLD);
    expect(markdownDensity(body)).toBeLessThan(0.15);
    const v = await classifyComment({
      login: 'human',
      body,
      pangram: async () => ({ fraction_ai: 0 }),
    });
    expect(v.method).toBe('markdown-density');
    expect(v.isHuman).toBe(false);
  });
  it('flags near-duplicate comments via similarity', async () => {
    const v = await classifyComment({
      login: 'human',
      body: 'ci is green and ready to merge',
      corpus: ['ci is green and ready to merge'],
      pangram: async () => ({ fraction_ai: 0 }),
    });
    expect(v.method).toBe('similarity');
  });
  it('falls back to pangram and honours its verdict', async () => {
    const ai = await classifyComment({
      login: 'h',
      body: 'genuine prose here',
      pangram: async () => ({ ai_likelihood: 0.95 }),
    });
    expect(ai).toMatchObject({ isHuman: false, method: 'pangram' });
    const human = await classifyComment({
      login: 'h',
      body: 'genuine prose here',
      pangram: async () => ({ ai_likelihood: 0.05 }),
    });
    expect(human).toMatchObject({ isHuman: true, method: 'pangram' });
  });
  it('defaults to human when pangram is unavailable', async () => {
    const v = await classifyComment({ login: 'h', body: 'genuine prose here' });
    expect(v).toMatchObject({ isHuman: true, method: 'default-human' });
  });
});

describe('decideLabels', () => {
  it('labels a fully AI thread ai-generated', () => {
    expect(decideLabels([{ isHuman: false }, { isHuman: false }])).toEqual({
      add: [AI_GENERATED_LABEL],
      remove: [HUMAN_IN_THE_LOOP_LABEL],
    });
  });
  it('labels a thread with any human contribution human-in-the-loop', () => {
    expect(decideLabels([{ isHuman: false }, { isHuman: true }])).toEqual({
      add: [HUMAN_IN_THE_LOOP_LABEL],
      remove: [AI_GENERATED_LABEL],
    });
  });
  it('does nothing for an empty thread', () => {
    expect(decideLabels([])).toEqual({ add: [], remove: [] });
  });
});

describe('isThreadSettledHuman', () => {
  it('is true when human-in-the-loop is already on the thread', () => {
    expect(isThreadSettledHuman([HUMAN_IN_THE_LOOP_LABEL])).toBe(true);
    expect(isThreadSettledHuman(['something-else', HUMAN_IN_THE_LOOP_LABEL])).toBe(true);
  });
  it('is false when the label is absent', () => {
    expect(isThreadSettledHuman([])).toBe(false);
    expect(isThreadSettledHuman([AI_GENERATED_LABEL])).toBe(false);
    expect(isThreadSettledHuman()).toBe(false);
  });
});
