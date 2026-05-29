/**
 * Tests for the ANSI-to-HTML renderer used by the bash tool body.
 */

import { describe, it, expect } from 'vitest';
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

  it('strips OSC sequences terminated by BEL', () => {
    const out = ansiToHtml('pre\x1b]0;title\x07post');
    expect(out).toBe('prepost');
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
});
