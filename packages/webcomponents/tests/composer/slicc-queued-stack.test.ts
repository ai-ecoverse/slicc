import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type QueuedMessage, SliccQueuedStack } from '../../src/composer/slicc-queued-stack.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(): SliccQueuedStack {
  const el = document.createElement('slicc-queued-stack');
  document.body.appendChild(el);
  return el;
}

function items(n: number): QueuedMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m-${i + 1}`,
    text: `message ${i + 1}`,
  }));
}

describe('slicc-queued-stack', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-queued-stack')).toBe(SliccQueuedStack);
  });

  it('renders nothing for an empty queue', () => {
    const el = mount();
    el.setMessages([]);
    expect(el.shadowRoot?.children.length).toBe(0);
    expect(el.getAttribute('count')).toBe('0');
    expect(getComputedStyle(el).display).toBe('none');
  });

  it('renders nothing when no `count` attribute is set (initial mount)', () => {
    const el = mount();
    expect(el.hasAttribute('count')).toBe(false);
    expect(getComputedStyle(el).display).toBe('none');
  });

  it('reflects the message count to the `count` attribute', () => {
    const el = mount();
    el.setMessages(items(4));
    expect(el.getAttribute('count')).toBe('4');
    expect(el.count).toBe(4);
  });

  it('renders one card per item — N items → N cards', () => {
    const el = mount();
    el.setMessages(items(5));
    const cards = el.shadowRoot?.querySelectorAll('.card');
    expect(cards?.length).toBe(5);
  });

  it('puts the most-recently-enqueued item at the front (highest z-index, upright)', () => {
    const el = mount();
    el.setMessages(items(3));
    const front = el.shadowRoot?.querySelector('.card.is-front') as HTMLElement;
    expect(front).not.toBeNull();
    // The front card carries both `card` and `front` part hooks.
    expect(front.getAttribute('part')).toBe('card front');
    // The front bubble contents are the LAST item's text — "message 3".
    expect(front.querySelector('.bubble')?.textContent).toBe('message 3');
    // The front card's z-index is the largest (equals the item count).
    expect(Number(front.style.zIndex)).toBe(3);
    // And no rotation/offset — the front card must read upright.
    expect(front.style.transform).toBe('none');
  });

  it('renders the badge with a clock icon and "N queued" label', () => {
    const el = mount();
    el.setMessages(items(4));
    const badge = el.shadowRoot?.querySelector('[part="badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.querySelector('svg')).toBeTruthy();
    expect(badge.textContent).toContain('4 queued');
  });

  it('exposes ::part hooks on stack, card, front, badge, dismiss', () => {
    const el = mount();
    el.setMessages(items(2));
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector('[part="stack"]')).not.toBeNull();
    expect(root.querySelector('[part~="card"]')).not.toBeNull();
    expect(root.querySelector('[part~="front"]')).not.toBeNull();
    expect(root.querySelector('[part="badge"]')).not.toBeNull();
    expect(root.querySelector('[part="dismiss"]')).not.toBeNull();
  });

  it('renders the × dismiss button only on the front card', () => {
    const el = mount();
    el.setMessages(items(3));
    const buttons = el.shadowRoot?.querySelectorAll('.dismiss');
    expect(buttons?.length).toBe(1);
    const front = el.shadowRoot?.querySelector('.card.is-front');
    expect(front?.querySelector('.dismiss')).not.toBeNull();
  });

  it('fires slicc-queued-remove with detail.id of the FRONT (newest) item', () => {
    const el = mount();
    el.setMessages(items(3));
    const spy = vi.fn();
    el.addEventListener('slicc-queued-remove', spy as EventListener);
    const btn = el.shadowRoot?.querySelector('.dismiss') as HTMLButtonElement;
    btn.click();
    expect(spy).toHaveBeenCalledTimes(1);
    const ev = spy.mock.calls[0][0] as CustomEvent<{ id: string }>;
    expect(ev.detail).toEqual({ id: 'm-3' });
    expect(ev.bubbles).toBe(true);
    expect(ev.composed).toBe(true);
  });

  it('does NOT mutate its own list when dismiss fires (host owns dequeue)', () => {
    const el = mount();
    el.setMessages(items(3));
    const btn = el.shadowRoot?.querySelector('.dismiss') as HTMLButtonElement;
    btn.click();
    // Still 3 cards — the host is responsible for calling setMessages again.
    expect(el.shadowRoot?.querySelectorAll('.card').length).toBe(3);
    expect(el.count).toBe(3);
    expect(el.getAttribute('count')).toBe('3');
  });

  it('applies alternating ±1–3° tilts and small offsets to back cards', () => {
    const el = mount();
    el.setMessages(items(4));
    const backs = el.shadowRoot?.querySelectorAll(
      '.card:not(.is-front)'
    ) as NodeListOf<HTMLElement>;
    expect(backs.length).toBe(3);
    for (const back of backs) {
      expect(back.style.transform).toMatch(/translate\(-?\d+px, -?\d+px\) rotate\(-?[1-3]deg\)/);
    }
  });

  it('replaces the rendered list on a subsequent setMessages call', () => {
    const el = mount();
    el.setMessages(items(5));
    el.setMessages(items(2));
    expect(el.shadowRoot?.querySelectorAll('.card').length).toBe(2);
    expect(el.getAttribute('count')).toBe('2');
    el.setMessages([]);
    expect(el.shadowRoot?.children.length).toBe(0);
    expect(el.getAttribute('count')).toBe('0');
  });

  it('renders the optional +N attachment hint on a card', () => {
    const el = mount();
    el.setMessages([{ id: 'm-1', text: 'with files', attachments: 3 }]);
    const attach = el.shadowRoot?.querySelector('.attach') as HTMLElement;
    expect(attach?.textContent).toBe('+3');
  });
});
