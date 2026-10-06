/**
 * Surrogate-safe UTF-16 clipping — the quickLabel path must never feed a
 * lone surrogate into JSON.stringify (Adobe/Bedrock GPT rejects the body).
 */

import { describe, expect, it } from 'vitest';
import { clipUtf16, cutBefore, LAST_ACTIVITY_MAX, wellFormed } from '../../src/base/utf16-clip.js';

/** True when `s` contains a UTF-16 code unit in the surrogate range. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

describe('cutBefore', () => {
  it('backs up when the cut would leave a high surrogate', () => {
    const s = `aaaa😀${'x'.repeat(20)}`;
    // 😀 is at indices 4..5; cutting at 5 leaves the high surrogate.
    expect(cutBefore(s, 5)).toBe(4);
    expect(s.slice(0, cutBefore(s, 5))).toBe('aaaa');
  });

  it('leaves a cut after a complete pair alone', () => {
    const s = `aaaa😀xxxx`;
    expect(cutBefore(s, 6)).toBe(6);
    expect(s.slice(0, 6)).toBe('aaaa😀');
  });
});

describe('clipUtf16', () => {
  it('returns short text unchanged', () => {
    expect(clipUtf16('abc', 10)).toBe('abc');
  });

  it('never splits a surrogate pair at the cut', () => {
    // Emoji straddles the UTF-16 cut: (max-1) ASCII + high surrogate at max-1.
    const max = 10;
    const text = `${'a'.repeat(max - 1)}😀${'b'.repeat(20)}`;
    const out = clipUtf16(text, max);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe(wellFormed(out));
    expect(JSON.parse(JSON.stringify(out))).toBe(out);
    // Dropped the straddling emoji rather than keep its high half.
    expect(out).toBe('a'.repeat(max - 1));
  });

  it('keeps a complete emoji when it fits under the cap', () => {
    const text = `${'a'.repeat(8)}😀`;
    expect(clipUtf16(text, 10)).toBe(text);
  });

  it('LAST_ACTIVITY_MAX matches the chip-tip budget', () => {
    expect(LAST_ACTIVITY_MAX).toBe(600);
  });
});

describe('wellFormed', () => {
  it('replaces a lone high or low surrogate with U+FFFD', () => {
    expect(wellFormed('hello \uD83D world')).toBe('hello \uFFFD world');
    expect(wellFormed('sys \uDE00 prompt')).toBe('sys \uFFFD prompt');
  });

  it('leaves a complete surrogate pair intact', () => {
    expect(wellFormed('ok 😀')).toBe('ok 😀');
  });
});
