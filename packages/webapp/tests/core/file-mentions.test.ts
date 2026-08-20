/**
 * Tests for the file-mention heuristic — what counts as a file name in prose.
 *
 * The heuristic is deliberately permissive (async VFS verification is what makes
 * it safe), so these tests police the two edges that verification CANNOT fix:
 * names we must never miss, and non-files that would waste a lookup on every
 * message — versions, domains, and sentence-ending words.
 */

import { describe, expect, it } from 'vitest';
import { findFileMentions } from '../../src/core/file-mentions.js';

const paths = (text: string): string[] => findFileMentions(text).map((m) => m.path);

describe('findFileMentions', () => {
  it('finds a bare filename with an extension the MIME table never heard of', () => {
    // The motivating case: `.jsh` is in no extension table, but it is obviously
    // a file when an agent says it.
    expect(paths('I updated bb.jsh for you')).toEqual(['bb.jsh']);
  });

  it('finds several mentions in one sentence', () => {
    expect(paths('Wrote check.sh, then rewrote it as check.js')).toEqual(['check.sh', 'check.js']);
  });

  it('finds a full repo-relative path', () => {
    expect(paths('see packages/webapp/src/main.ts for the entry')).toEqual([
      'packages/webapp/src/main.ts',
    ]);
  });

  it('captures a line-number suffix and reports the line separately', () => {
    const [mention] = findFileMentions('fails at src/main.ts:42 today');
    expect(mention?.path).toBe('src/main.ts');
    expect(mention?.line).toBe(42);
  });

  it('captures a line:column suffix without confusing it for the path', () => {
    const [mention] = findFileMentions('see src/main.ts:42:7 there');
    expect(mention?.path).toBe('src/main.ts');
    expect(mention?.line).toBe(42);
  });

  it('finds absolute and home-relative paths', () => {
    expect(paths('open /workspace/skills/slack/scripts/slack.jsh now')).toEqual([
      '/workspace/skills/slack/scripts/slack.jsh',
    ]);
    expect(paths('check ~/.config/app.toml please')).toEqual(['~/.config/app.toml']);
  });

  it('finds extensionless build files by name', () => {
    expect(paths('edit the Makefile now')).toContain('Makefile');
    expect(paths('the Dockerfile is stale')).toContain('Dockerfile');
  });

  it('drops sentence punctuation that trails the name', () => {
    expect(paths('I rewrote check.js.')).toEqual(['check.js']);
    expect(paths('files: a.ts, b.ts.')).toEqual(['a.ts', 'b.ts']);
  });

  it('finds a mention wrapped in backticks or parentheses', () => {
    expect(paths('use `bb.jsh` here')).toEqual(['bb.jsh']);
    expect(paths('the entry (main.ts) is small')).toEqual(['main.ts']);
  });

  it('reports offsets that slice back to the matched text', () => {
    const text = 'I updated bb.jsh for you';
    const [mention] = findFileMentions(text);
    expect(text.slice(mention?.start ?? 0, mention?.end ?? 0)).toBe('bb.jsh');
  });

  // -- the rejections; each one would otherwise fire on ordinary prose --

  it('ignores version numbers and decimals', () => {
    expect(paths('bumped to 1.2.3 today')).toEqual([]);
    expect(paths('about 3.14 seconds')).toEqual([]);
    expect(paths('shipped v2.0 already')).toEqual([]);
  });

  it('ignores domains', () => {
    expect(paths('see example.com for docs')).toEqual([]);
    expect(paths('from diffs.com and trees.software')).toEqual([]);
  });

  it('ignores words that merely end a sentence', () => {
    expect(paths('That is all done. Next up')).toEqual([]);
    expect(paths('slower than before. So it goes')).toEqual([]);
  });

  it('ignores ellipses', () => {
    expect(paths('waiting... still waiting')).toEqual([]);
  });

  it('returns nothing for prose with no file names', () => {
    expect(paths('All checks are green and the branch is mergeable')).toEqual([]);
  });

  it('does not emit overlapping spans', () => {
    const mentions = findFileMentions('packages/webapp/src/main.ts and src/main.ts');
    for (let i = 1; i < mentions.length; i += 1) {
      expect(mentions[i]?.start).toBeGreaterThanOrEqual(mentions[i - 1]?.end ?? 0);
    }
  });
});
