/**
 * Tests for the ANSI-to-HTML renderer used by the bash tool body.
 */

import { describe, expect, it } from 'vitest';
import { ansiToHtml } from '../../src/ui/ansi.js';

describe('ansiToHtml', () => {
  it('returns an empty string for empty input', () => {
    expect(ansiToHtml('')).toBe('');
  });

  it('escapes HTML in plain text without ANSI codes', () => {
    expect(ansiToHtml('a <b> & "c"')).toBe('a &lt;b&gt; &amp; &quot;c&quot;');
  });

  it('renders basic foreground colors as inline-styled spans', () => {
    const out = ansiToHtml('\x1b[31mred\x1b[0m plain');
    expect(out).toContain('<span style="color:#cd3131">red</span>');
    expect(out).toContain(' plain');
  });

  it('resets state on \\x1b[0m so following text is unstyled', () => {
    const out = ansiToHtml('\x1b[32mok\x1b[0mtail');
    expect(out).toBe('<span style="color:#0dbc79">ok</span>tail');
  });

  it('treats an empty SGR sequence as a full reset', () => {
    const out = ansiToHtml('\x1b[33mwarn\x1b[mtail');
    expect(out).toBe('<span style="color:#e5e510">warn</span>tail');
  });

  it('combines bold and underline modifiers with color', () => {
    const out = ansiToHtml('\x1b[1;4;34mhi\x1b[0m');
    expect(out).toContain('color:#2472c8');
    expect(out).toContain('font-weight:600');
    expect(out).toContain('text-decoration:underline');
  });

  it('handles bright foreground colors (90-97)', () => {
    const out = ansiToHtml('\x1b[91merr\x1b[0m');
    expect(out).toContain('color:#f14c4c');
  });

  it('supports 256-color foreground via 38;5;n', () => {
    const out = ansiToHtml('\x1b[38;5;9mx\x1b[0m');
    expect(out).toContain('color:#f14c4c');
  });

  it('supports truecolor foreground via 38;2;r;g;b', () => {
    const out = ansiToHtml('\x1b[38;2;10;20;30mx\x1b[0m');
    expect(out).toContain('color:rgb(10,20,30)');
  });

  it('strips non-SGR CSI sequences like cursor moves and erase', () => {
    const out = ansiToHtml('a\x1b[2Jb\x1b[Kc\x1b[10;5Hd');
    expect(out).toBe('abcd');
  });

  it('strips CSI sequences with non-letter final bytes (~, @, `)', () => {
    // Bracketed paste markers (\x1b[200~ / \x1b[201~) and other final
    // bytes in 0x40-0x7E must be stripped, not leaked into the output.
    const out = ansiToHtml('a\x1b[200~paste\x1b[201~b\x1b[5@c\x1b[2`d');
    expect(out).toBe('apastebcd');
  });

  it('strips OSC sequences terminated by BEL', () => {
    const out = ansiToHtml('pre\x1b]0;title\x07post');
    expect(out).toBe('prepost');
  });

  it('ignores unknown 38/<mode> extended-color sequences without leaking the mode byte', () => {
    // `\x1b[38;1m` is an unknown extended-color mode. The 1 must NOT be
    // re-interpreted as the standalone "bold" SGR code after the 38 is
    // skipped — the entire sequence should be a no-op style-wise.
    expect(ansiToHtml('\x1b[38;1mx\x1b[0m')).toBe('x');
    expect(ansiToHtml('\x1b[48;4mx\x1b[0m')).toBe('x');
  });

  it('escapes HTML inside a styled span', () => {
    const out = ansiToHtml('\x1b[31m<x>&\x1b[0m');
    expect(out).toBe('<span style="color:#cd3131">&lt;x&gt;&amp;</span>');
  });

  it('keeps an unterminated style applied to trailing text', () => {
    const out = ansiToHtml('\x1b[32mstill green');
    expect(out).toBe('<span style="color:#0dbc79">still green</span>');
  });

  it('returns plain text unchanged when no style is active', () => {
    expect(ansiToHtml('just text')).toBe('just text');
  });

  it('renders inverse video by swapping fg/bg', () => {
    const out = ansiToHtml('\x1b[31;7minv\x1b[0m');
    expect(out).toContain('background-color:#cd3131');
    expect(out).toContain('color:#e6e6e6');
  });

  it('renders background colors (40-47)', () => {
    const out = ansiToHtml('\x1b[44mbg\x1b[0m');
    expect(out).toContain('background-color:#2472c8');
  });

  it('39 resets foreground without touching background', () => {
    const out = ansiToHtml('\x1b[31;44mab\x1b[39mc\x1b[0m');
    expect(out).toContain('<span style="color:#cd3131;background-color:#2472c8">ab</span>');
    expect(out).toContain('<span style="background-color:#2472c8">c</span>');
  });

  // Ampersand handling — these guard against two failure modes:
  //   1) "swallowed": innerHTML parses an unescaped `&foo;` as an HTML entity.
  //   2) "double-escaped": user sees literal `&amp;` on screen because the
  //      renderer escapes an already-escaped string twice.
  // The renderer's contract is "raw text in, escape exactly once" — so a
  // literal `&amp;` in the source IS expected to render as `&amp;` on screen
  // (the source said so). The cases below pin that contract.
  describe('ampersand handling', () => {
    it('escapes a bare & once between chunks', () => {
      expect(ansiToHtml('foo & bar')).toBe('foo &amp; bar');
    });

    it('escapes & that opens an entity-shaped name (no swallowing)', () => {
      expect(ansiToHtml('AT&T &copy; &#65;')).toBe('AT&amp;T &amp;copy; &amp;#65;');
    });

    it('escapes & in a URL query string', () => {
      expect(ansiToHtml('curl http://x?a=1&b=2&c=3')).toBe('curl http://x?a=1&amp;b=2&amp;c=3');
    });

    it('escapes literal &amp; from source exactly once (no double-escape regression)', () => {
      // The source bytes are literally `&amp;`. Escaping them once yields
      // `&amp;amp;`, which the browser renders as the visible text `&amp;`
      // — matching what the user typed. Escaping twice would surface
      // `&amp;amp;` on screen, which is the bug we are guarding against.
      expect(ansiToHtml('foo &amp; bar')).toBe('foo &amp;amp; bar');
    });

    it('escapes & at the boundary just before a CSI sequence', () => {
      expect(ansiToHtml('foo &\x1b[31mbar\x1b[0m')).toBe(
        'foo &amp;<span style="color:#cd3131">bar</span>'
      );
    });

    it('escapes & at the boundary just after a CSI reset', () => {
      expect(ansiToHtml('\x1b[31mfoo\x1b[0m& bar')).toBe(
        '<span style="color:#cd3131">foo</span>&amp; bar'
      );
    });

    it('escapes & sitting alone inside a styled span', () => {
      expect(ansiToHtml('\x1b[33m&\x1b[0m')).toBe('<span style="color:#e5e510">&amp;</span>');
    });

    it('escapes & at the very start and very end of input', () => {
      expect(ansiToHtml('& foo')).toBe('&amp; foo');
      expect(ansiToHtml('foo &')).toBe('foo &amp;');
    });

    it('escapes adjacent &s without merging or dropping any', () => {
      expect(ansiToHtml('A&&B&&&C')).toBe('A&amp;&amp;B&amp;&amp;&amp;C');
    });
  });
});
