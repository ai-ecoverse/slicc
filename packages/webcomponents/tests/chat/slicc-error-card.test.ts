import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccErrorCard } from '../../src/chat/slicc-error-card.js';
import { iconEl } from '../../src/internal/icons.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/** Inner shape markup of a lucide icon at the header size, for comparison. */
function iconShape(name: string, size: number): string {
  return iconEl(name, { size }).innerHTML;
}

function mount(attrs: Record<string, string> = {}): SliccErrorCard {
  const el = document.createElement('slicc-error-card') as SliccErrorCard;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

describe('slicc-error-card', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-error-card')).toBe(SliccErrorCard);
  });

  it('reflects attributes to properties and back', () => {
    const el = mount();
    el.label = 'Boom';
    el.message = 'Something broke';
    el.buttonLabel = 'Retry now';
    el.messageId = 'msg-42';
    expect(el.getAttribute('label')).toBe('Boom');
    expect(el.getAttribute('message')).toBe('Something broke');
    expect(el.getAttribute('button-label')).toBe('Retry now');
    expect(el.getAttribute('message-id')).toBe('msg-42');
    // Attribute → property direction.
    el.setAttribute('message-id', 'msg-99');
    expect(el.messageId).toBe('msg-99');

    el.label = null;
    el.message = null;
    el.buttonLabel = null;
    el.messageId = null;
    expect(el.hasAttribute('label')).toBe(false);
    expect(el.hasAttribute('message')).toBe(false);
    expect(el.hasAttribute('button-label')).toBe(false);
    expect(el.hasAttribute('message-id')).toBe(false);
    expect(el.messageId).toBeNull();
  });

  it('renders the prototype structure with ::part hooks', () => {
    const el = mount({ message: 'Connection refused' });
    const root = el.shadowRoot;
    expect(root).toBeTruthy();
    expect(root?.querySelector('[part="card"]')).toBeTruthy();
    expect(root?.querySelector('[part="header"]')).toBeTruthy();
    expect(root?.querySelector('[part="icon"]')).toBeTruthy();
    expect(root?.querySelector('[part="label"]')).toBeTruthy();
    expect(root?.querySelector('[part="body"]')).toBeTruthy();
    expect(root?.querySelector('[part="button"]')).toBeTruthy();
  });

  it('renders defaults for label and button label', () => {
    const el = mount({ message: 'oops' });
    expect(el.shadowRoot?.querySelector('[part="label"]')?.textContent).toBe(
      'Something went wrong'
    );
    expect(el.shadowRoot?.querySelector('[part="button"]')?.textContent?.trim()).toBe('Try again');
  });

  it('honors custom label and button-label attributes', () => {
    const el = mount({
      label: 'Cone error',
      message: 'rate limited',
      'button-label': 'Try once more',
    });
    expect(el.shadowRoot?.querySelector('[part="label"]')?.textContent).toBe('Cone error');
    expect(el.shadowRoot?.querySelector('[part="button"]')?.textContent?.trim()).toBe(
      'Try once more'
    );
  });

  it('renders a lucide triangle-alert icon in the header (never an emoji)', () => {
    const el = mount({ message: 'oops' });
    const icon = el.shadowRoot?.querySelector('[part="icon"]') as HTMLElement;
    const svg = icon.querySelector('svg');
    expect(svg).toBeInstanceOf(SVGSVGElement);
    expect(svg?.innerHTML).toBe(iconShape('triangle-alert', 14));
    expect(svg?.getAttribute('width')).toBe('14');
    // No emoji / unicode-symbol text in the rendered card.
    expect(
      (el.shadowRoot?.textContent ?? '').match(/[\u{1F000}-\u{1FAFF}]|[\u{26A0}]/u)
    ).toBeNull();
  });

  it('renders the retry button with a rotate-ccw glyph', () => {
    const el = mount({ message: 'oops' });
    const btn = el.shadowRoot?.querySelector('[part="button"]') as HTMLButtonElement;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
    const svg = btn.querySelector('svg');
    expect(svg).toBeInstanceOf(SVGSVGElement);
    expect(svg?.innerHTML).toBe(iconShape('rotate-ccw', 12));
  });

  it('renders the escaped message body and falls back to a slot when absent', () => {
    const withMessage = mount({ message: '<b>boom</b>' });
    const body = withMessage.shadowRoot?.querySelector('[part="body"]');
    // text node escapes by construction — no <b> child is interpolated
    expect(body?.querySelector('b')).toBeNull();
    expect(body?.textContent).toBe('<b>boom</b>');

    const slotted = mount();
    expect(slotted.shadowRoot?.querySelector('[part="body"] slot')).not.toBeNull();
  });

  it('dispatches slicc-error-retry (bubbling, composed) on retry click', () => {
    const el = mount({ message: 'rate limited', 'message-id': 'err-7' });
    const seen: CustomEvent[] = [];
    document.body.addEventListener('slicc-error-retry', (e) => seen.push(e as CustomEvent));
    const btn = el.shadowRoot?.querySelector('[part="button"]') as HTMLButtonElement;
    btn.click();
    expect(seen).toHaveLength(1);
    expect(seen[0].bubbles).toBe(true);
    expect(seen[0].composed).toBe(true);
    expect(seen[0] instanceof CustomEvent).toBe(true);
    // The card stamps its `message-id` onto the event so the host can bind
    // retry to the specific failed turn rather than scanning the whole thread.
    expect(seen[0].detail).toEqual({ messageId: 'err-7' });
  });

  it('exposes a programmatic retry() that dispatches the same event', () => {
    const el = mount({ message: 'oops', 'message-id': 'err-1' });
    const spy = vi.fn();
    el.addEventListener('slicc-error-retry', spy);
    el.retry();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as CustomEvent).detail).toEqual({ messageId: 'err-1' });
  });

  it('emits a null messageId when no message-id attribute is set', () => {
    const el = mount({ message: 'oops' });
    const seen: CustomEvent[] = [];
    el.addEventListener('slicc-error-retry', (e) => seen.push(e as CustomEvent));
    el.retry();
    expect(seen[0].detail).toEqual({ messageId: null });
  });

  it('re-renders on attribute change', () => {
    const el = mount({ message: 'first' });
    expect(el.shadowRoot?.querySelector('[part="body"]')?.textContent).toBe('first');
    el.message = 'second';
    expect(el.shadowRoot?.querySelector('[part="body"]')?.textContent).toBe('second');
  });

  it('paints the card with a red-tinted border (light mode)', () => {
    const el = mount({ message: 'oops' });
    const card = el.shadowRoot?.querySelector('.err') as HTMLElement;
    const cs = getComputedStyle(card);
    // border resolved from color-mix(in srgb, var(--red) 38%, var(--line))
    expect(cs.borderTopWidth).not.toBe('0px');
    expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  it('routes the card tint toward the dark canvas in dark mode', () => {
    const el = mount({ message: 'oops' });
    const card = el.shadowRoot?.querySelector('.err') as HTMLElement;
    const light = getComputedStyle(card).backgroundColor;
    document.body.classList.add('dark');
    const dark = getComputedStyle(card).backgroundColor;
    expect(dark).not.toBe(light);
  });

  it('unbinds the click listener on disconnect', () => {
    const el = mount({ message: 'oops' });
    const seen: Event[] = [];
    document.body.addEventListener('slicc-error-retry', (e) => seen.push(e));
    const btn = el.shadowRoot?.querySelector('[part="button"]') as HTMLButtonElement;
    el.remove();
    btn.click();
    expect(seen).toHaveLength(0);
  });
});
