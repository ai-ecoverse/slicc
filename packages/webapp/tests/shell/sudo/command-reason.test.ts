/**
 * Leading-comment → sudo reason extraction (`shell/sudo/command-reason.ts`).
 *
 * The contract the shell depends on: only a comment at the TOP of a script
 * counts, it collapses to one bounded line, and anything that is not an
 * explanation of intent (a shebang, a comment further down) stays out.
 */

import { describe, expect, it } from 'vitest';
import {
  extractLeadingCommentReason,
  SUDO_REASON_ENV,
} from '../../../src/shell/sudo/command-reason.js';
import { MAX_SUDO_REASON_LENGTH, normalizeSudoReason } from '../../../src/sudo/reason.js';

describe('extractLeadingCommentReason', () => {
  it('reads a single leading comment', () => {
    expect(extractLeadingCommentReason('# clear the stale build\nrm -rf /workspace/build')).toBe(
      'clear the stale build'
    );
  });

  it('joins a wrapped multi-line comment block into one sentence', () => {
    const script = ['# the release tag is cut and CI is green,', '# so push it', 'git push'].join(
      '\n'
    );
    expect(extractLeadingCommentReason(script)).toBe(
      'the release tag is cut and CI is green, so push it'
    );
  });

  it('skips blank lines before the block but stops at one after it', () => {
    expect(extractLeadingCommentReason('\n\n# why\n\n# unrelated note\nls')).toBe('why');
  });

  it('ignores a shebang without treating it as the end of the block', () => {
    expect(extractLeadingCommentReason('#!/bin/bash\n# why this runs\nls')).toBe('why this runs');
  });

  it('returns empty for a script that does not open with a comment', () => {
    expect(extractLeadingCommentReason('ls -la\n# too late to explain')).toBe('');
    expect(extractLeadingCommentReason('')).toBe('');
  });

  it('strips the comment markers, not the words', () => {
    expect(extractLeadingCommentReason('### why ###\nls')).toBe('why ###');
  });

  it('yields nothing for a comment with no text', () => {
    expect(extractLeadingCommentReason('#\n#\nls')).toBe('');
  });

  it('collapses and truncates through normalizeSudoReason', () => {
    const long = `# ${'a'.repeat(MAX_SUDO_REASON_LENGTH + 50)}\nls`;
    const reason = extractLeadingCommentReason(long);
    expect(reason).toHaveLength(MAX_SUDO_REASON_LENGTH);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('is the internal env name the shell tags runs with', () => {
    // Guards the name a command reads out of its own `ctx.env`; renaming one
    // side without the other silently drops every reason.
    expect(SUDO_REASON_ENV).toBe('__SLICC_SUDO_REASON');
  });
});

describe('normalizeSudoReason', () => {
  it('collapses all whitespace to single spaces', () => {
    expect(normalizeSudoReason('  a \n\t b  ')).toBe('a b');
  });

  it('leaves a short single-line reason untouched', () => {
    expect(normalizeSudoReason('because the build needs it')).toBe('because the build needs it');
  });

  it('truncates at the cap with an ellipsis', () => {
    const out = normalizeSudoReason('x'.repeat(MAX_SUDO_REASON_LENGTH * 2));
    expect(out).toHaveLength(MAX_SUDO_REASON_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  // A lone surrogate survives `JSON.stringify` as an unpaired `\uDxxx` escape,
  // and Foundation's decoder rejects the whole message — the reason would
  // silently stop `sudo.approve.request` from reaching an iOS approver.
  it('never splits a surrogate pair at the cut', () => {
    // The emoji straddles the UTF-16 cut: 298 ASCII + a 2-unit astral char.
    const out = normalizeSudoReason(`${'a'.repeat(MAX_SUDO_REASON_LENGTH - 2)}😀 tail`);
    expect(out.endsWith('…')).toBe(true);
    expect(JSON.parse(JSON.stringify(out))).toBe(out);
    for (const unit of out) {
      const code = unit.codePointAt(0) ?? 0;
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it('counts code points, so astral text is not truncated early', () => {
    const out = normalizeSudoReason('😀'.repeat(MAX_SUDO_REASON_LENGTH));
    expect(Array.from(out)).toHaveLength(MAX_SUDO_REASON_LENGTH);
  });

  it('leaves an astral reason exactly at the cap untouched', () => {
    const exact = '😀'.repeat(MAX_SUDO_REASON_LENGTH);
    expect(normalizeSudoReason(exact)).toBe(exact);
  });
});
