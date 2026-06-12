import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SliccTabOverlay,
  type TabDescriptor,
  type TabOverlayCloseReason,
} from '../../src/dock/slicc-tab-overlay.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const TABS: TabDescriptor[] = [
  {
    id: 't1',
    title: 'First',
    url: 'a.example',
    screenshot: 'data:image/png;base64,AAAA',
    active: true,
  },
  { id: 't2', title: 'Second', url: 'b.example' },
  { id: 't3', title: 'Third' },
];

function mount(setup?: (el: SliccTabOverlay) => void): SliccTabOverlay {
  const el = document.createElement('slicc-tab-overlay') as SliccTabOverlay;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The rendered tab cards inside the grid. */
function cards(el: SliccTabOverlay): HTMLElement[] {
  return [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.card') ?? [])];
}

describe('slicc-tab-overlay', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-tab-overlay')).toBe(SliccTabOverlay);
  });

  it('keeps its CSS in a constructable adopted stylesheet (no <style> node)', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('style')).toBeNull();
    expect((el.shadowRoot as ShadowRoot).adoptedStyleSheets.length).toBe(1);
  });

  it('is hidden until open (the host display flips with the attribute)', () => {
    const el = mount();
    expect(getComputedStyle(el).display).toBe('none');
    el.show();
    expect(el.hasAttribute('open')).toBe(true);
    expect(getComputedStyle(el).display).toBe('block');
  });

  it('builds the overlay scrim + header bar with parts', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('.overlay[part="overlay"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.bar[part="bar"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.close[part="close"]')).not.toBeNull();
  });

  it('reflects the heading (defaulting to "Open tabs") into the header', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('.title')?.textContent).toBe('Open tabs');
    el.heading = 'Switch tab';
    expect(el.getAttribute('heading')).toBe('Switch tab');
    expect(el.shadowRoot?.querySelector('.title')?.textContent).toBe('Switch tab');
    el.heading = null;
    expect(el.hasAttribute('heading')).toBe(false);
  });

  it('renders one card per tab with the live count', () => {
    const el = mount((o) => (o.tabs = TABS));
    expect(cards(el)).toHaveLength(3);
    expect(el.shadowRoot?.querySelector('.count')?.textContent).toBe('3');
    expect(el.shadowRoot?.querySelector('.grid[part="grid"]')).not.toBeNull();
  });

  it('shows the empty state (no cards) when there are no tabs', () => {
    const el = mount((o) => (o.tabs = []));
    expect(cards(el)).toHaveLength(0);
    expect(el.shadowRoot?.querySelector('.empty')?.textContent).toBe('No open tabs.');
    expect(el.shadowRoot?.querySelector('.count')?.textContent).toBe('0');
  });

  it('renders a screenshot img when present, else a globe placeholder', () => {
    const el = mount((o) => (o.tabs = TABS));
    const [first, , third] = cards(el);
    expect(first.querySelector('img.shot')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(third.querySelector('.shot.ph svg')).toBeInstanceOf(SVGSVGElement);
  });

  it('marks the active tab with the .on ring and aria-current', () => {
    const el = mount((o) => (o.tabs = TABS));
    const active = cards(el).filter((c) => c.classList.contains('on'));
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('data-tab-id')).toBe('t1');
    expect(active[0].getAttribute('aria-current')).toBe('true');
  });

  it('falls back to the id as the card title when no title is set', () => {
    const el = mount((o) => (o.tabs = [{ id: 'bare' }]));
    expect(el.shadowRoot?.querySelector('.name')?.textContent).toBe('bare');
  });

  it('escapes interpolated title text (no injection surface)', () => {
    const el = mount((o) => (o.tabs = [{ id: 'x', title: '<img src=x>' }]));
    expect(el.shadowRoot?.querySelector('.name')?.textContent).toBe('<img src=x>');
    expect(el.shadowRoot?.querySelector('img')).toBeNull();
  });

  it('emits tab-activate (composed + bubbling) when a card is clicked', () => {
    const el = mount((o) => (o.tabs = TABS));
    const seen = vi.fn();
    document.body.addEventListener('tab-activate', (e) =>
      seen((e as CustomEvent<{ id: string }>).detail.id)
    );
    cards(el)[1].click();
    expect(seen).toHaveBeenCalledWith('t2');
    document.body.removeEventListener('tab-activate', seen);
  });

  it('activates a card via the Enter / Space keys', () => {
    const el = mount((o) => (o.tabs = TABS));
    const seen = vi.fn();
    el.addEventListener('tab-activate', (e) => seen((e as CustomEvent<{ id: string }>).detail.id));
    cards(el)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    cards(el)[2].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(seen).toHaveBeenNthCalledWith(1, 't1');
    expect(seen).toHaveBeenNthCalledWith(2, 't3');
  });

  it('emits tab-close (not tab-activate) when a card ✕ is clicked', () => {
    const el = mount((o) => (o.tabs = TABS));
    const close = vi.fn();
    const activate = vi.fn();
    el.addEventListener('tab-close', (e) => close((e as CustomEvent<{ id: string }>).detail.id));
    el.addEventListener('tab-activate', activate);
    (cards(el)[1].querySelector('.x') as HTMLButtonElement).click();
    expect(close).toHaveBeenCalledWith('t2');
    expect(activate).not.toHaveBeenCalled();
  });

  it('returns a defensive copy from the tabs getter', () => {
    const el = mount((o) => (o.tabs = TABS));
    const got = el.tabs;
    got[0].title = 'mutated';
    expect(el.tabs[0].title).toBe('First');
  });

  it('tolerates a non-array assignment by clearing the tabs', () => {
    const el = mount((o) => (o.tabs = TABS));
    // @ts-expect-error — exercising the runtime guard.
    el.tabs = null;
    expect(cards(el)).toHaveLength(0);
  });

  /** Collect the `reason` from every `overlay-close` an open overlay emits. */
  function closeReasons(el: SliccTabOverlay): TabOverlayCloseReason[] {
    const reasons: TabOverlayCloseReason[] = [];
    el.addEventListener('overlay-close', (e) =>
      reasons.push((e as CustomEvent<{ reason: TabOverlayCloseReason }>).detail.reason)
    );
    return reasons;
  }

  it('closes with reason "close-button" when the header ✕ is clicked', () => {
    const el = mount((o) => o.show());
    const reasons = closeReasons(el);
    (el.shadowRoot?.querySelector('.close') as HTMLButtonElement).click();
    expect(el.open).toBe(false);
    expect(reasons).toEqual(['close-button']);
  });

  it('closes with reason "backdrop" on a scrim mousedown (but not on a card)', () => {
    const el = mount((o) => {
      o.tabs = TABS;
      o.show();
    });
    const reasons = closeReasons(el);
    cards(el)[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(reasons).toEqual([]);
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(reasons).toEqual(['backdrop']);
  });

  it('closes with reason "escape" on the Escape key while open', () => {
    const el = mount((o) => o.show());
    const reasons = closeReasons(el);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(reasons).toEqual(['escape']);
    expect(el.open).toBe(false);
  });

  it('hide() closes with reason "api"; show() is idempotent', () => {
    const el = mount((o) => o.show());
    const reasons = closeReasons(el);
    el.show();
    el.hide();
    expect(reasons).toEqual(['api']);
  });

  it('drops the document Escape listener on disconnect', () => {
    const el = mount((o) => o.show());
    const reasons = closeReasons(el);
    el.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(reasons).toEqual([]);
  });

  it('lays the scrim out fixed and full-viewport (real Chromium)', () => {
    const el = mount((o) => o.show());
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    const cs = getComputedStyle(overlay);
    expect(cs.position).toBe('fixed');
    expect(cs.flexDirection).toBe('column');
  });
});
