import { beforeEach, describe, expect, it } from 'vitest';
import { SliccMemrow } from '../../src/memory/slicc-memrow.js';
// Sibling composed by tag — importing here registers it so the row's
// <slicc-memtag> upgrades during the test run.
import '../../src/memory/slicc-memtag.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

/** Mount a memrow with the given attributes and return it. */
function mount(attrs: Record<string, string> = {}): SliccMemrow {
  const el = document.createElement('slicc-memrow');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el as SliccMemrow;
}

describe('slicc-memrow', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-memrow')).toBe(SliccMemrow);
  });

  it('is keyboard reachable with button semantics by default', () => {
    const el = mount({ heading: 'keyboard first' });
    expect(el.getAttribute('role')).toBe('button');
    expect(el.tabIndex).toBe(0);
  });

  it('renders the .mt header and .ms summary into its own light DOM', () => {
    const el = mount({ heading: 'icon buttons need tooltips', summary: 'must have aria-label' });
    expect(el.shadowRoot).toBeNull();
    const mt = el.querySelector('.mt');
    const title = el.querySelector('.mt b');
    const ms = el.querySelector('.ms');
    expect(mt).not.toBeNull();
    expect(title?.textContent).toBe('icon buttons need tooltips');
    expect(ms?.textContent).toContain('must have aria-label');
  });

  it('hard-caps rendered titles at 96 characters without dropping the remainder', () => {
    const heading = 'x'.repeat(120);
    const el = mount({ heading });
    const renderedTitle = el.querySelector('.mt b')?.textContent ?? '';
    const renderedSummary = el.querySelector('.ms')?.textContent ?? '';
    expect(renderedTitle).toHaveLength(96);
    expect(renderedSummary).toBe('x'.repeat(24));
    expect(renderedTitle + renderedSummary).toBe(heading);
  });

  it('reflects heading attribute ↔ property without using native title', () => {
    const el = mount();
    el.heading = 'palette preference';
    expect(el.getAttribute('heading')).toBe('palette preference');
    expect(el.hasAttribute('title')).toBe(false);
    expect(el.querySelector('.mt b')?.textContent).toBe('palette preference');
    el.heading = null;
    expect(el.hasAttribute('heading')).toBe(false);
  });

  it('reflects summary attribute ↔ property', () => {
    const el = mount();
    el.summary = 'Prefers paper canvas + violet accent.';
    expect(el.getAttribute('summary')).toBe('Prefers paper canvas + violet accent.');
    expect(el.querySelector('.ms')?.textContent).toContain('Prefers paper canvas');
  });

  it('reflects fresh attribute ↔ property and mirrors the host class', () => {
    const el = mount();
    expect(el.fresh).toBe(false);
    expect(el.classList.contains('fresh')).toBe(false);
    el.fresh = true;
    expect(el.hasAttribute('fresh')).toBe(true);
    expect(el.classList.contains('fresh')).toBe(true);
    el.fresh = false;
    expect(el.classList.contains('fresh')).toBe(false);
  });

  it('defaults the tag to user', () => {
    const el = mount();
    expect(el.tag).toBe('user');
    const tag = el.querySelector('slicc-memtag');
    expect(tag?.getAttribute('type')).toBe('user');
  });

  it('does not render a tag when the host has no tag attribute', () => {
    const el = mount();
    expect((el.querySelector('slicc-memtag') as HTMLElement).hidden).toBe(true);
  });

  it('composes <slicc-memtag> by tag for each kind — through its type API, no host pill', () => {
    const cases: Array<['user' | 'feedback' | 'project', string]> = [
      ['user', 'user'],
      ['feedback', 'feedback'],
      ['project', 'project'],
    ];
    for (const [tag, label] of cases) {
      const el = mount({ tag });
      const memtag = el.querySelector('slicc-memtag');
      expect(memtag).not.toBeNull();
      expect(memtag?.getAttribute('type')).toBe(tag);
      // The component renders its own shadow pill with the per-type default
      // label; the host must NOT carry the prototype `.mtag.*` fallback
      // classes — that painted a second pill around the real one.
      expect(memtag?.classList.contains('mtag')).toBe(false);
      expect(memtag?.shadowRoot?.textContent).toContain(label);
      // Exactly one painted border: host border-width 0, shadow pill 1px.
      expect(getComputedStyle(memtag as Element).borderTopWidth).toBe('0px');
      const pill = memtag?.shadowRoot?.querySelector('.mtag') as Element;
      expect(getComputedStyle(pill).borderTopWidth).toBe('1px');
    }
  });

  it('coerces an unknown tag to user', () => {
    const el = mount({ tag: 'bogus' });
    expect(el.tag).toBe('user');
    expect(el.querySelector('slicc-memtag')?.getAttribute('type')).toBe('user');
  });

  it('escapes interpolated title and summary text', () => {
    const el = mount({ heading: '<img src=x onerror=1>', summary: '<b>bold</b>' });
    expect(el.querySelector('.mt b')?.querySelector('img')).toBeNull();
    expect(el.querySelector('.mt b')?.textContent).toBe('<img src=x onerror=1>');
    expect(el.querySelector('.ms')?.querySelector('b')).toBeNull();
    expect(el.querySelector('.ms')?.textContent).toContain('<b>bold</b>');
  });

  it('relocates slotted children into the .ms summary line', () => {
    const el = document.createElement('slicc-memrow') as SliccMemrow;
    el.setAttribute('summary', 'see ');
    const link = document.createElement('a');
    link.textContent = 'the doc';
    link.href = '#';
    el.appendChild(link);
    document.body.appendChild(el);
    const ms = el.querySelector('.ms');
    expect(ms?.querySelector('a')?.textContent).toBe('the doc');
    expect(ms?.textContent).toContain('see ');
  });

  it('emits a composed select event on click with title/summary/tag detail', () => {
    const el = mount({ heading: 'e2e via puppeteer-core', summary: 'use CDP', tag: 'feedback' });
    let detail: { heading: string; summary: string; tag: string } | null = null;
    el.addEventListener('select', (e) => {
      detail = (e as CustomEvent).detail;
    });
    el.click();
    expect(detail).not.toBeNull();
    expect(detail!.heading).toBe('e2e via puppeteer-core');
    expect(detail!.summary).toBe('use CDP');
    expect(detail!.tag).toBe('feedback');
  });

  it('emits select on Enter and Space keydown', () => {
    const el = mount({ heading: 't' });
    let count = 0;
    el.addEventListener('select', () => {
      count += 1;
    });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(count).toBe(2);
  });

  it('renders disclosure only when clamped content is genuinely hidden', async () => {
    const short = mount({ heading: 'short', summary: 'visible detail' });
    const el = mount({ heading: 'long tail', summary: 'detail '.repeat(40) });
    short.style.width = '320px';
    el.style.width = '320px';
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(short.querySelector('.mexpand')).toBeNull();
    const button = el.querySelector('.mexpand') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('Show more');
    button.click();
    expect(el.hasAttribute('expanded')).toBe(true);
    expect(button.textContent).toBe('Show less');
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('stops emitting after disconnect (listener cleanup)', () => {
    const el = mount({ heading: 't' });
    let count = 0;
    el.addEventListener('select', () => {
      count += 1;
    });
    el.click();
    expect(count).toBe(1);
    el.remove();
    el.click();
    expect(count).toBe(1);
  });

  it('applies the prototype card geometry (border radius + padding)', () => {
    const el = mount({ heading: 't', summary: 's' });
    const cs = getComputedStyle(el);
    expect(cs.display).toBe('block');
    expect(cs.borderTopLeftRadius).toBe('11px');
    expect(cs.paddingLeft).toBe('13px');
    expect(cs.paddingTop).toBe('11px');
  });

  it('rose-tints the fresh card background distinctly from a default row', () => {
    const plain = mount({ heading: 'plain' });
    const fresh = mount({ heading: 'fresh', fresh: '' });
    const plainBg = getComputedStyle(plain).backgroundColor;
    const freshBg = getComputedStyle(fresh).backgroundColor;
    // The default card is transparent; the fresh card carries a rose tint.
    expect(freshBg).not.toBe(plainBg);
    expect(freshBg).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('rebases the fresh tint over the dark canvas in dark mode', () => {
    const fresh = mount({ heading: 'fresh', fresh: '' });
    const lightBg = getComputedStyle(fresh).backgroundColor;
    setTheme('dark');
    const darkBg = getComputedStyle(fresh).backgroundColor;
    expect(darkBg).not.toBe(lightBg);
  });

  it('pins the memtag to the right of the header (margin-left auto)', () => {
    const el = mount({ heading: 'a short title', tag: 'user' });
    el.style.width = '320px';
    const title = el.querySelector('.mt b') as HTMLElement;
    const memtag = el.querySelector('slicc-memtag') as HTMLElement;
    // `margin-left:auto` on the flex item pushes it to the trailing edge: the
    // memtag's left edge sits well past the title's right edge (a gap, not flush).
    const titleRight = title.getBoundingClientRect().right;
    const tagLeft = memtag.getBoundingClientRect().left;
    expect(tagLeft).toBeGreaterThan(titleRight + 8);
  });
});
