import { describe, expect, it } from 'vitest';
import { countInlineReviewComments, decideReview } from './lib.mjs';

describe('decideReview', () => {
  it('reviews an open PR with zero inline comments', () => {
    const out = decideReview({ state: 'open', isDraft: false, inlineReviewCommentCount: 0 });
    expect(out.shouldReview).toBe(true);
    expect(out.reason).toMatch(/reviewing/i);
  });

  it('skips an open PR that already has inline comments', () => {
    const out = decideReview({ state: 'open', isDraft: false, inlineReviewCommentCount: 3 });
    expect(out.shouldReview).toBe(false);
    expect(out.reason).toContain('3');
  });

  it('skips a draft PR', () => {
    const out = decideReview({ state: 'open', isDraft: true, inlineReviewCommentCount: 0 });
    expect(out.shouldReview).toBe(false);
    expect(out.reason).toMatch(/draft/i);
  });

  it('skips a closed PR', () => {
    const out = decideReview({ state: 'closed', isDraft: false, inlineReviewCommentCount: 0 });
    expect(out.shouldReview).toBe(false);
    expect(out.reason).toMatch(/not open/i);
  });

  it('skips when state is missing', () => {
    expect(decideReview({}).shouldReview).toBe(false);
    expect(decideReview().shouldReview).toBe(false);
  });
});

describe('countInlineReviewComments', () => {
  it('returns the length of an array', () => {
    expect(countInlineReviewComments([{ id: 1 }, { id: 2 }])).toBe(2);
  });

  it('returns 0 for an empty array', () => {
    expect(countInlineReviewComments([])).toBe(0);
  });

  it('tolerates null/undefined and non-array input', () => {
    expect(countInlineReviewComments(null)).toBe(0);
    expect(countInlineReviewComments(undefined)).toBe(0);
    expect(countInlineReviewComments({})).toBe(0);
  });
});
