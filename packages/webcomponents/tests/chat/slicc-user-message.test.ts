import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccUserMessage } from '../../src/chat/slicc-user-message.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string> = {}): SliccUserMessage {
  const el = document.createElement('slicc-user-message');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

describe('slicc-user-message', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  afterEach(() => {
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-user-message')).toBe(SliccUserMessage);
  });

  it('renders the .msg.user row wrapping a single .b bubble', () => {
    const el = mount({ text: 'hello' });
    const row = el.shadowRoot?.querySelector('.msg.user');
    const bubble = row?.querySelector('.b');
    expect(row).not.toBeNull();
    expect(bubble).not.toBeNull();
    expect(row?.querySelectorAll('.b').length).toBe(1);
    expect(bubble?.textContent).toBe('hello');
  });

  it('exposes ::part hooks on the row and bubble', () => {
    const el = mount({ text: 'parts' });
    expect(el.shadowRoot?.querySelector('[part="message"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('[part="bubble"]')).not.toBeNull();
  });

  it('reflects the text attribute to the property', () => {
    const el = mount({ text: 'attr first' });
    expect(el.text).toBe('attr first');
  });

  it('reflects the text property to the attribute and re-renders', () => {
    const el = mount();
    el.text = 'set via property';
    expect(el.getAttribute('text')).toBe('set via property');
    expect(el.shadowRoot?.querySelector('.b')?.textContent).toBe('set via property');
  });

  it('clears the attribute when the property is set to null', () => {
    const el = mount({ text: 'temporary' });
    el.text = null;
    expect(el.hasAttribute('text')).toBe(false);
  });

  it('renders a default <slot> when no text attribute is present', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('slot')).not.toBeNull();
  });

  it('projects slotted content through the bubble when text is absent', () => {
    const el = document.createElement('slicc-user-message');
    el.textContent = 'slotted body';
    document.body.appendChild(el);
    const slot = el.shadowRoot?.querySelector('slot') as HTMLSlotElement;
    expect(
      slot
        .assignedNodes()
        .map((n) => n.textContent)
        .join('')
    ).toBe('slotted body');
  });

  it('escapes interpolated text', () => {
    const el = mount({ text: '<script>x</script>' });
    const bubble = el.shadowRoot?.querySelector('.b');
    expect(bubble?.querySelector('script')).toBeNull();
    expect(bubble?.textContent).toBe('<script>x</script>');
  });

  it('right-aligns the bubble via the flex row (light)', () => {
    const el = mount({ text: 'right' });
    const row = el.shadowRoot?.querySelector('.msg.user') as HTMLElement;
    const cs = getComputedStyle(row);
    expect(cs.display).toBe('flex');
    expect(cs.justifyContent).toBe('flex-end');
  });

  it('paints the inverted bubble: white text, asymmetric radius, 80% cap (light)', () => {
    const el = mount({ text: 'bubble' });
    const bubble = el.shadowRoot?.querySelector('.b') as HTMLElement;
    const cs = getComputedStyle(bubble);
    // --deep is #000 in light, so white text on a black ground.
    expect(cs.color).toBe('rgb(255, 255, 255)');
    expect(cs.backgroundColor).toBe('rgb(0, 0, 0)');
    // Asymmetric iMessage radius: 16 16 4 16.
    expect(cs.borderTopLeftRadius).toBe('16px');
    expect(cs.borderTopRightRadius).toBe('16px');
    expect(cs.borderBottomRightRadius).toBe('4px');
    expect(cs.borderBottomLeftRadius).toBe('16px');
    // Capped relative to the column (80%); resolves to a px/percent length, never `none`.
    expect(cs.maxWidth).not.toBe('none');
    expect(cs.maxWidth).toMatch(/(?:px|%)$/);
  });

  it('flips the bubble text to dark ink in dark mode (body.dark)', () => {
    document.body.classList.add('dark');
    const el = mount({ text: 'dark' });
    const bubble = el.shadowRoot?.querySelector('.b') as HTMLElement;
    expect(getComputedStyle(bubble).color).toBe('rgb(10, 10, 10)');
  });

  it('flips the bubble text to dark ink under [data-theme="dark"]', () => {
    document.body.setAttribute('data-theme', 'dark');
    const el = mount({ text: 'dark attr' });
    const bubble = el.shadowRoot?.querySelector('.b') as HTMLElement;
    expect(getComputedStyle(bubble).color).toBe('rgb(10, 10, 10)');
  });

  describe('markdown body (setBodyHtml)', () => {
    it('renders rendered-markdown HTML into the bubble and wins over text/slot', () => {
      const el = mount({ text: 'plain' });
      el.setBodyHtml('<p>run <code>npm test</code> then <a href="https://x.dev">open</a></p>');
      const bubble = el.shadowRoot?.querySelector('.b') as HTMLElement;
      expect(bubble.querySelector('code')?.textContent).toBe('npm test');
      expect(bubble.querySelector('a')?.getAttribute('href')).toBe('https://x.dev');
      // The text attribute no longer wins once body HTML is set.
      expect(bubble.textContent).not.toBe('plain');
    });

    it('styles inline code in the mono font with a currentColor-tinted chip', () => {
      const el = mount();
      el.setBodyHtml('<p>use <code>--canvas</code></p>');
      const code = el.shadowRoot?.querySelector('.b code') as HTMLElement;
      const cs = getComputedStyle(code);
      expect(cs.fontFamily.toLowerCase()).toContain('mono');
      // The chip background is derived from currentColor (not transparent/none).
      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    });

    it('renders a fenced code block and a list', () => {
      const el = mount();
      el.setBodyHtml('<ul><li>a</li><li>b</li></ul><pre><code>x = 1</code></pre>');
      const bubble = el.shadowRoot?.querySelector('.b') as HTMLElement;
      expect(bubble.querySelectorAll('li')).toHaveLength(2);
      expect(bubble.querySelector('pre code')?.textContent).toBe('x = 1');
    });
  });

  describe('attachments (setAttachments)', () => {
    it('renders an image attachment as a right-aligned thumbnail above the bubble', () => {
      const el = mount({ text: 'see this' });
      el.setAttachments([{ name: 'p.png', kind: 'image', src: 'data:image/png;base64,AAAA' }]);
      const row = el.shadowRoot?.querySelector('.attachments') as HTMLElement;
      expect(row).not.toBeNull();
      expect(getComputedStyle(row).justifyContent).toBe('flex-end');
      const img = row.querySelector('.attachment-chip--image img') as HTMLImageElement;
      expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA');
      // The attachment row precedes the bubble in the stack.
      const stack = el.shadowRoot?.querySelector('.stack') as HTMLElement;
      const kids = Array.from(stack.children).map((n) => n.className);
      expect(kids[0]).toBe('attachments');
      expect(kids[1]).toBe('b');
    });

    it('renders a non-image attachment as a lucide file chip with name + meta', () => {
      const el = mount({ text: 'doc' });
      el.setAttachments([{ name: 'tokens.css', kind: 'text', mime: 'text/css', size: 2048 }]);
      const chip = el.shadowRoot?.querySelector('.attachment-chip--text') as HTMLElement;
      expect(chip.querySelector('.attachment-chip__visual svg')).toBeInstanceOf(SVGSVGElement);
      expect(chip.querySelector('.attachment-chip__name')?.textContent).toBe('tokens.css');
      expect(chip.querySelector('.attachment-chip__meta')?.textContent).toBe('text/css · 2.0 KB');
    });

    it('omits the bubble for an image-only message (no text / slot)', () => {
      const el = mount();
      el.setAttachments([{ name: 's.png', kind: 'image', src: 'data:image/png;base64,AAAA' }]);
      expect(el.shadowRoot?.querySelector('.attachments')).not.toBeNull();
      expect(el.shadowRoot?.querySelector('.b')).toBeNull();
    });

    it('replaces attachments on a subsequent call', () => {
      const el = mount({ text: 'x' });
      el.setAttachments([{ name: 'a.png', kind: 'image', src: 'data:image/png;base64,AAAA' }]);
      el.setAttachments([{ name: 'b.txt', kind: 'text' }]);
      expect(el.shadowRoot?.querySelectorAll('.attachment-chip')).toHaveLength(1);
      expect(el.shadowRoot?.querySelector('.attachment-chip__name')?.textContent).toBe('b.txt');
    });
  });
});
