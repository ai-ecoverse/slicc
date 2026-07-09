// @vitest-environment jsdom
/**
 * Coverage for the self-contained ANSI SGR → DOM parser: every SGR family,
 * reset semantics, 256/truecolor, no-ANSI passthrough, non-SGR stripping, and
 * XSS-safety (HTML-special chars are never interpreted as markup).
 */

import { describe, expect, it } from 'vitest';
import { ansiToDom } from '../../src/ui/ansi-to-dom.js';

/** Convenience: render into a container and return it for querying. */
function render(input: string): HTMLElement {
  const host = document.createElement('div');
  host.append(ansiToDom(input));
  return host;
}

describe('ansiToDom', () => {
  it('returns a single text node when the input has no ANSI', () => {
    const node = ansiToDom('plain output, no escapes');
    expect(node.nodeType).toBe(Node.TEXT_NODE);
    expect(node.textContent).toBe('plain output, no escapes');
  });

  it('renders foreground colors (30-37) as styled spans, text preserved', () => {
    const host = render('\x1b[31mred\x1b[0m tail');
    expect(host.textContent).toBe('red tail');
    const span = host.querySelector('span') as HTMLElement;
    expect(span.textContent).toBe('red');
    expect(span.style.color).toBeTruthy();
    // Trailing text after reset is a bare text node (no span wrapper).
    expect(host.querySelectorAll('span').length).toBe(1);
  });

  it('renders bright foreground (90-97) and background (40-47/100-107)', () => {
    const host = render('\x1b[92mbg\x1b[0m\x1b[41mred-bg\x1b[0m\x1b[102mbright-bg\x1b[0m');
    const spans = host.querySelectorAll('span');
    expect(spans.length).toBe(3);
    expect(spans[0].style.color).toBeTruthy();
    expect(spans[1].style.backgroundColor).toBeTruthy();
    expect(spans[2].style.backgroundColor).toBeTruthy();
  });

  it('applies bold, dim, italic, and underline attributes', () => {
    const host = render('\x1b[1mb\x1b[0m\x1b[2md\x1b[0m\x1b[3mi\x1b[0m\x1b[4mu\x1b[0m');
    const [b, d, i, u] = Array.from(host.querySelectorAll('span'));
    expect(b.style.fontWeight).toBe('bold');
    expect(d.style.opacity).toBe('0.6');
    expect(i.style.fontStyle).toBe('italic');
    expect(u.style.textDecoration).toBe('underline');
  });

  it('nests multiple attributes in one span and resets them all with 0', () => {
    const host = render('\x1b[1;4;33mboth\x1b[0mafter');
    const span = host.querySelector('span') as HTMLElement;
    expect(span.textContent).toBe('both');
    expect(span.style.fontWeight).toBe('bold');
    expect(span.style.textDecoration).toBe('underline');
    expect(span.style.color).toBeTruthy();
    // Everything after reset is unstyled text.
    expect(host.querySelectorAll('span').length).toBe(1);
    expect(host.textContent).toBe('bothafter');
  });

  it('resets only fg/bg with 39/49 while keeping other attributes', () => {
    const host = render('\x1b[1;31;41mx\x1b[39;49my\x1b[0m');
    const [x, y] = Array.from(host.querySelectorAll('span'));
    expect(x.style.color).toBeTruthy();
    expect(x.style.backgroundColor).toBeTruthy();
    // y keeps bold but drops both colors.
    expect(y.style.fontWeight).toBe('bold');
    expect(y.style.color).toBe('');
    expect(y.style.backgroundColor).toBe('');
  });

  it('supports 256-color foreground and background', () => {
    const host = render('\x1b[38;5;196mfg\x1b[0m\x1b[48;5;21mbg\x1b[0m\x1b[38;5;244mgray\x1b[0m');
    const [fg, bg, gray] = Array.from(host.querySelectorAll('span'));
    expect(fg.style.color).toContain('rgb');
    expect(bg.style.backgroundColor).toContain('rgb');
    expect(gray.style.color).toContain('rgb');
  });

  it('supports truecolor (38;2 / 48;2) with clamped channels', () => {
    const host = render('\x1b[38;2;10;20;30mtc\x1b[0m\x1b[48;2;300;0;0mclamp\x1b[0m');
    const [tc, clamp] = Array.from(host.querySelectorAll('span'));
    expect(tc.style.color.replace(/\s/g, '')).toBe('rgb(10,20,30)');
    expect(clamp.style.backgroundColor.replace(/\s/g, '')).toBe('rgb(255,0,0)');
  });

  it('strips non-SGR CSI sequences instead of emitting them', () => {
    // Cursor move + erase-line are dropped; only the visible text remains.
    const host = render('a\x1b[2K\x1b[1;1Hb');
    expect(host.textContent).toBe('ab');
    expect(host.querySelector('span')).toBeNull();
  });

  it('strips OSC sequences (BEL- and ST-terminated)', () => {
    const bel = render('\x1b]0;window title\x07visible');
    expect(bel.textContent).toBe('visible');
    const st = render('\x1b]8;;https://example.com\x1b\\link');
    expect(st.textContent).toBe('link');
  });

  it('strips lone/other escape sequences', () => {
    const host = render('x\x1b(By\x1b=z');
    expect(host.textContent).toBe('xyz');
  });

  it('does not interpret HTML-special characters as markup (XSS-safe)', () => {
    const host = render('\x1b[31m<img src=x onerror=alert(1)>\x1b[0m & "q"');
    // Nothing was injected as an element; the payload is inert text.
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toBe('<img src=x onerror=alert(1)> & "q"');
    const span = host.querySelector('span') as HTMLElement;
    expect(span.childElementCount).toBe(0);
    expect(span.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('treats a bare ESC[m (empty params) as a reset', () => {
    const host = render('\x1b[1mbold\x1b[mplain');
    expect(host.querySelectorAll('span').length).toBe(1);
    expect(host.textContent).toBe('boldplain');
  });
});
