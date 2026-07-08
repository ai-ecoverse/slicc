import { describe, expect, it } from 'vitest';
import { threeWayMerge } from '../../src/git/merge-file-core.js';

const labels = { current: 'ours', base: 'orig', other: 'theirs' };

describe('threeWayMerge', () => {
  it('no change on any side returns the base verbatim', () => {
    const base = 'a\nb\nc\n';
    const result = threeWayMerge(base, base, base, { labels });
    expect(result.content).toBe(base);
    expect(result.conflicts).toBe(0);
  });

  it('one-sided change (ours) auto-merges', () => {
    const base = 'a\nb\nc\n';
    const current = 'a\nB\nc\n';
    const result = threeWayMerge(current, base, base, { labels });
    expect(result.content).toBe('a\nB\nc\n');
    expect(result.conflicts).toBe(0);
  });

  it('one-sided change (theirs) auto-merges', () => {
    const base = 'a\nb\nc\n';
    const other = 'a\nb\nC\n';
    const result = threeWayMerge(base, base, other, { labels });
    expect(result.content).toBe('a\nb\nC\n');
    expect(result.conflicts).toBe(0);
  });

  it('identical change on both sides auto-merges without conflict', () => {
    const base = 'a\nb\nc\n';
    const changed = 'a\nBB\nc\n';
    const result = threeWayMerge(changed, base, changed, { labels });
    expect(result.content).toBe('a\nBB\nc\n');
    expect(result.conflicts).toBe(0);
  });

  it('adjacent non-overlapping changes merge cleanly', () => {
    const base = 'a\nb\nc\nd\ne\n';
    const current = 'A\nb\nc\nd\ne\n';
    const other = 'a\nb\nc\nd\nE\n';
    const result = threeWayMerge(current, base, other, { labels });
    expect(result.content).toBe('A\nb\nc\nd\nE\n');
    expect(result.conflicts).toBe(0);
  });

  it('divergent overlapping changes produce a conflict hunk', () => {
    const base = 'a\nb\nc\n';
    const current = 'a\nX\nc\n';
    const other = 'a\nY\nc\n';
    const result = threeWayMerge(current, base, other, { labels });
    expect(result.conflicts).toBe(1);
    expect(result.content).toBe('a\n<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\nc\n');
  });

  it('diff3 mode adds the base section between markers', () => {
    const base = 'a\nb\nc\n';
    const current = 'a\nX\nc\n';
    const other = 'a\nY\nc\n';
    const result = threeWayMerge(current, base, other, { labels, diff3: true });
    expect(result.conflicts).toBe(1);
    expect(result.content).toBe(
      'a\n<<<<<<< ours\nX\n||||||| orig\nb\n=======\nY\n>>>>>>> theirs\nc\n'
    );
  });

  it('favor=ours resolves conflicts to the current side without markers', () => {
    const base = 'a\nb\nc\n';
    const current = 'a\nX\nc\n';
    const other = 'a\nY\nc\n';
    const result = threeWayMerge(current, base, other, { labels, favor: 'ours' });
    expect(result.content).toBe('a\nX\nc\n');
    expect(result.conflicts).toBe(1);
    expect(result.content).not.toContain('<<<<<<<');
  });

  it('favor=theirs resolves conflicts to the other side without markers', () => {
    const base = 'a\nb\nc\n';
    const current = 'a\nX\nc\n';
    const other = 'a\nY\nc\n';
    const result = threeWayMerge(current, base, other, { labels, favor: 'theirs' });
    expect(result.content).toBe('a\nY\nc\n');
    expect(result.conflicts).toBe(1);
  });

  it('favor=union concatenates current then other', () => {
    const base = 'a\nb\nc\n';
    const current = 'a\nX\nc\n';
    const other = 'a\nY\nc\n';
    const result = threeWayMerge(current, base, other, { labels, favor: 'union' });
    expect(result.content).toBe('a\nX\nY\nc\n');
    expect(result.conflicts).toBe(1);
  });

  it('preserves a missing trailing newline exactly', () => {
    const base = 'a\nb';
    const current = 'a\nB';
    const result = threeWayMerge(current, base, base, { labels });
    expect(result.content).toBe('a\nB');
    expect(result.conflicts).toBe(0);
  });

  it('does not introduce phantom trailing blank lines', () => {
    const base = 'a\nb\nc\n';
    const current = 'a\nb\nc\nd\n';
    const result = threeWayMerge(current, base, base, { labels });
    expect(result.content).toBe('a\nb\nc\nd\n');
    expect(result.content.endsWith('\n\n')).toBe(false);
  });

  it('handles empty base with a one-sided insertion', () => {
    const result = threeWayMerge('hello\n', '', '', { labels });
    expect(result.content).toBe('hello\n');
    expect(result.conflicts).toBe(0);
  });

  it('conflicts on divergent insertions into an empty base', () => {
    const result = threeWayMerge('ours\n', '', 'theirs\n', { labels });
    expect(result.conflicts).toBe(1);
    expect(result.content).toBe('<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n');
  });

  it('handles one-line files with divergent single-line edits', () => {
    const result = threeWayMerge('X\n', 'a\n', 'Y\n', { labels });
    expect(result.conflicts).toBe(1);
    expect(result.content).toBe('<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\n');
  });

  it('uses default labels when none are provided', () => {
    const result = threeWayMerge('X\n', 'a\n', 'Y\n', {});
    expect(result.content).toContain('<<<<<<< current');
    expect(result.content).toContain('>>>>>>> other');
  });
});
