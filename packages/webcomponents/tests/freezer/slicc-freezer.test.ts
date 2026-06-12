import { beforeEach, describe, expect, it, vi } from 'vitest';
// Composed children — importing registers their tags so they upgrade in the rail.
import '../../src/freezer/slicc-freezer-card.js';
import '../../src/freezer/slicc-freezer-new.js';
import { type FreezerToggleDetail, SliccFreezer } from '../../src/freezer/slicc-freezer.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/** A single prototype session row (`.fzcard`) the freezer's filter recognises. */
function cardHtml(slug: string, title: string, meta: string): string {
  return (
    `<div class="fzcard" data-s="${slug}">` +
    '<span class="snow">❄</span>' +
    `<div class="ftext"><div class="fzt">${title}</div><div class="fzm">${meta}</div></div>` +
    '</div>'
  );
}

const NEW_CHAT =
  '<button class="fznew" aria-label="New chat"><span class="nlbl">New chat</span></button>';

const RAIL =
  NEW_CHAT +
  cardHtml('warm-hero', 'warm hero redesign', '2h ago') +
  cardHtml('checkout', 'checkout funnel audit', 'yesterday') +
  cardHtml('dark-mode', 'dark-mode polish', '3d ago');

/** Mount a freezer with the rail content and (optionally) the open/ctx flags. */
function mount(opts: { open?: boolean; ctx?: boolean; html?: string } = {}): SliccFreezer {
  const el = document.createElement('slicc-freezer') as SliccFreezer;
  if (opts.open) el.setAttribute('open', '');
  if (opts.ctx) el.setAttribute('ctx', '');
  el.innerHTML = opts.html ?? RAIL;
  document.body.appendChild(el);
  return el;
}

const header = (el: SliccFreezer) => el.querySelector<HTMLElement>(':scope > .fzh');
const toggle = (el: SliccFreezer) => el.querySelector<HTMLButtonElement>('.fztgl');
const search = (el: SliccFreezer) => el.querySelector<HTMLInputElement>('.fzsearch');
const rail = (el: SliccFreezer) => el.querySelector<HTMLElement>(':scope > .fzrail');
const cards = (el: SliccFreezer) => [...el.querySelectorAll<HTMLElement>('.fzcard')];

describe('slicc-freezer', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-freezer')).toBe(SliccFreezer);
  });

  describe('structure (light DOM)', () => {
    it('renders into light DOM (no shadow root) with the scoped host class + part', () => {
      const el = mount();
      expect(el.shadowRoot).toBeNull();
      expect(el.classList.contains('slicc-freezer')).toBe(true);
      expect(el.getAttribute('part')).toBe('freezer');
    });

    it('builds the header band (toggle + search) and the scroll rail in order', () => {
      const el = mount();
      const kids = [...el.children];
      expect(kids[0]).toBe(header(el));
      expect(kids[1]).toBe(rail(el));
      expect(toggle(el)).toBeTruthy();
      expect(search(el)).toBeTruthy();
      expect(header(el)?.getAttribute('part')).toBe('header');
      expect(toggle(el)?.getAttribute('part')).toBe('toggle');
      expect(search(el)?.getAttribute('part')).toBe('search');
      expect(rail(el)?.getAttribute('part')).toBe('rail');
    });

    it('defaults the aria-label to the past-sessions freezer label', () => {
      const el = mount();
      expect(el.getAttribute('aria-label')).toBe('Past sessions (freezer)');
    });

    it('preserves a host-supplied aria-label', () => {
      const el = document.createElement('slicc-freezer') as SliccFreezer;
      el.setAttribute('aria-label', 'Custom');
      document.body.appendChild(el);
      expect(el.getAttribute('aria-label')).toBe('Custom');
    });

    it('injects its scoped stylesheet exactly once across instances', () => {
      mount();
      mount();
      expect(document.querySelectorAll('#slicc-freezer-style')).toHaveLength(1);
    });

    it('relocates slotted New-chat + session rows into the rail', () => {
      const el = mount();
      const r = rail(el)!;
      expect(r.querySelector('.fznew')).toBeTruthy();
      expect(cards(el)).toHaveLength(3);
      // Every card now lives inside the rail, not loose on the host.
      for (const c of cards(el)) expect(r.contains(c)).toBe(true);
    });

    it('uses a distinct panel-toggle glyph (rect+chevron), not a snowflake', () => {
      const el = mount();
      const svg = toggle(el)?.querySelector('svg');
      expect(svg?.querySelector('rect')).toBeTruthy();
      expect(svg?.querySelector('polyline')).toBeTruthy();
      expect(toggle(el)?.textContent).not.toContain('❄');
    });
  });

  describe('open ↔ property reflection + variants', () => {
    it('defaults to collapsed (no open attribute)', () => {
      const el = mount();
      expect(el.open).toBe(false);
      expect(el.hasAttribute('open')).toBe(false);
    });

    it('reflects the open attribute to the property and back', () => {
      const el = mount({ open: true });
      expect(el.open).toBe(true);
      el.open = false;
      expect(el.hasAttribute('open')).toBe(false);
      el.open = true;
      expect(el.hasAttribute('open')).toBe(true);
    });

    it('mirrors open state onto the toggle aria-expanded + title', () => {
      const el = mount();
      expect(toggle(el)?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle(el)?.getAttribute('title')).toBe('Expand freezer');
      el.open = true;
      expect(toggle(el)?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle(el)?.getAttribute('title')).toBe('Collapse freezer');
    });
  });

  describe('ctx (freezer-context accent)', () => {
    it('reflects the ctx attribute to the property', () => {
      const el = mount({ ctx: true });
      expect(el.ctx).toBe(true);
      el.ctx = false;
      expect(el.hasAttribute('ctx')).toBe(false);
      el.ctx = true;
      expect(el.hasAttribute('ctx')).toBe(true);
    });
  });

  describe('search', () => {
    it('uses the default placeholder, overridable via the attribute', () => {
      const el = mount();
      expect(search(el)?.placeholder).toBe('search past sessions');
      el.searchPlaceholder = 'find a thread';
      expect(search(el)?.placeholder).toBe('find a thread');
    });

    it('live-filters session rows by textContent substring (match-hidden)', () => {
      const el = mount();
      const input = search(el)!;
      input.value = 'checkout';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const hidden = cards(el).filter((c) => c.classList.contains('match-hidden'));
      const shown = cards(el).filter((c) => !c.classList.contains('match-hidden'));
      expect(shown).toHaveLength(1);
      expect(shown[0].dataset.s).toBe('checkout');
      expect(hidden).toHaveLength(2);
    });

    it('clears every filter when the query is emptied', () => {
      const el = mount();
      el.query = 'dark';
      expect(cards(el).some((c) => c.classList.contains('match-hidden'))).toBe(true);
      el.query = '';
      expect(cards(el).some((c) => c.classList.contains('match-hidden'))).toBe(false);
    });

    it('matches against the meta line too (not just the title)', () => {
      const el = mount();
      el.query = '3d ago';
      const shown = cards(el).filter((c) => !c.classList.contains('match-hidden'));
      expect(shown).toHaveLength(1);
      expect(shown[0].dataset.s).toBe('dark-mode');
    });
  });

  describe('toggle behavior + events', () => {
    it('clicking the toggle flips open and emits freezer-toggle', () => {
      const el = mount();
      const onToggle = vi.fn();
      el.addEventListener('freezer-toggle', (e) =>
        onToggle((e as CustomEvent<FreezerToggleDetail>).detail)
      );
      toggle(el)!.click();
      expect(el.open).toBe(true);
      expect(onToggle).toHaveBeenCalledWith({ open: true });
      toggle(el)!.click();
      expect(el.open).toBe(false);
      expect(onToggle).toHaveBeenLastCalledWith({ open: false });
    });

    it('toggle(force) sets the explicit state and emits', () => {
      const el = mount({ open: true });
      const onToggle = vi.fn();
      el.addEventListener('freezer-toggle', (e) =>
        onToggle((e as CustomEvent<FreezerToggleDetail>).detail.open)
      );
      el.toggle(false);
      expect(el.open).toBe(false);
      expect(onToggle).toHaveBeenCalledWith(false);
    });

    it('bubbles + is composed so ancestors can listen', () => {
      const el = mount();
      const seen = vi.fn();
      document.body.addEventListener('freezer-toggle', seen);
      el.toggle();
      expect(seen).toHaveBeenCalledTimes(1);
      document.body.removeEventListener('freezer-toggle', seen);
    });
  });

  describe('collapse ↔ expand wiring (child propagation)', () => {
    /** Mount a freezer with composed `<slicc-freezer-new>` + card children. */
    function mountComposed(open: boolean): SliccFreezer {
      const el = document.createElement('slicc-freezer') as SliccFreezer;
      if (open) el.setAttribute('open', '');
      const neu = document.createElement('slicc-freezer-new');
      const card1 = document.createElement('slicc-freezer-card');
      card1.setAttribute('title', 'warm hero redesign');
      card1.setAttribute('slug', 'warm-hero');
      const card2 = document.createElement('slicc-freezer-card');
      card2.setAttribute('title', 'checkout funnel audit');
      card2.setAttribute('slug', 'checkout');
      el.append(neu, card1, card2);
      document.body.appendChild(el);
      return el;
    }

    const composedItems = (el: SliccFreezer) => [
      ...el.querySelectorAll<HTMLElement>('slicc-freezer-card, slicc-freezer-new'),
    ];

    it('open at mount → every composed child is expanded', () => {
      const el = mountComposed(true);
      const items = composedItems(el);
      expect(items.length).toBe(3);
      for (const item of items) expect(item.hasAttribute('expanded')).toBe(true);
    });

    it('collapsed at mount → no composed child is expanded', () => {
      const el = mountComposed(false);
      const items = composedItems(el);
      expect(items.length).toBe(3);
      for (const item of items) expect(item.hasAttribute('expanded')).toBe(false);
    });

    it('toggling the rail flips child expanded live (titles ↔ icons only)', () => {
      const el = mountComposed(false);
      toggle(el)!.click(); // expand
      for (const item of composedItems(el)) expect(item.hasAttribute('expanded')).toBe(true);
      toggle(el)!.click(); // collapse
      for (const item of composedItems(el)) expect(item.hasAttribute('expanded')).toBe(false);
    });

    it('setting open via the property propagates to children', () => {
      const el = mountComposed(false);
      el.open = true;
      for (const item of composedItems(el)) expect(item.hasAttribute('expanded')).toBe(true);
    });

    it('a row appended while open inherits the expanded state', () => {
      const el = mountComposed(true);
      const extra = document.createElement('slicc-freezer-card');
      extra.setAttribute('title', 'late arrival');
      el.append(extra);
      expect(extra.hasAttribute('expanded')).toBe(true);
    });

    it('leaves raw prototype .fzcard rows untouched (no expanded attribute)', () => {
      const el = mount({ open: true });
      for (const c of cards(el)) expect(c.hasAttribute('expanded')).toBe(false);
    });
  });

  describe('rail API', () => {
    it('append() adds a node into the rail preserving order', () => {
      const el = mount({ html: NEW_CHAT });
      const extra = document.createElement('div');
      extra.className = 'fzcard';
      extra.textContent = 'appended session';
      el.append(extra);
      expect(rail(el)?.contains(extra)).toBe(true);
      expect(rail(el)?.lastElementChild).toBe(extra);
    });
  });

  describe('lifecycle', () => {
    it('drops the toggle + search listeners on disconnect', () => {
      const el = mount();
      const tgl = toggle(el)!;
      const onToggle = vi.fn();
      el.addEventListener('freezer-toggle', onToggle);
      el.remove();
      tgl.click();
      expect(onToggle).not.toHaveBeenCalled();
    });

    it('survives a disconnect/reconnect without rebuilding the chrome', () => {
      const el = mount();
      const builtRail = rail(el);
      el.remove();
      document.body.appendChild(el);
      expect(rail(el)).toBe(builtRail);
      // Single header + single rail (no duplicates).
      expect(el.querySelectorAll(':scope > .fzh')).toHaveLength(1);
      expect(el.querySelectorAll(':scope > .fzrail')).toHaveLength(1);
    });
  });

  describe('computed appearance (real Chromium)', () => {
    it('is a fixed left rail at z-index 6, 44px wide when collapsed', () => {
      const el = mount();
      const cs = getComputedStyle(el);
      expect(cs.position).toBe('fixed');
      expect(cs.left).toBe('0px');
      expect(cs.zIndex).toBe('6');
      expect(cs.width).toBe('44px');
    });

    it('widens to 260px when open', () => {
      const el = mount({ open: true });
      expect(getComputedStyle(el).width).toBe('260px');
    });

    it('animates the width over .4s (the open/collapse transition)', () => {
      const el = mount();
      const cs = getComputedStyle(el);
      expect(cs.transitionProperty).toContain('width');
      expect(cs.transitionDuration).toContain('0.4s');
    });

    it('hides the search input until open', () => {
      const el = mount();
      expect(getComputedStyle(search(el)!).display).toBe('none');
      el.open = true;
      expect(getComputedStyle(search(el)!).display).toBe('block');
    });

    it('centers rail items collapsed and stretches them when open', () => {
      const el = mount();
      expect(getComputedStyle(rail(el)!).alignItems).toBe('center');
      el.open = true;
      expect(getComputedStyle(rail(el)!).alignItems).toBe('stretch');
    });

    it('removes a search-filtered row from layout (display:none) when open', () => {
      const el = mount({ open: true });
      el.query = 'checkout';
      const hidden = cards(el).find((c) => c.classList.contains('match-hidden'))!;
      expect(getComputedStyle(hidden).display).toBe('none');
    });

    it('mirrors the toggle glyph (scaleX(-1)) when expanded', () => {
      const el = mount({ open: true });
      const svg = toggle(el)?.querySelector('svg') as SVGElement;
      const t = getComputedStyle(svg).transform;
      // scaleX(-1) → matrix(-1, 0, 0, 1, 0, 0).
      expect(t).toBe('matrix(-1, 0, 0, 1, 0, 0)');
    });
  });
});
