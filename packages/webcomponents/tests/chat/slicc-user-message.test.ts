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
});
