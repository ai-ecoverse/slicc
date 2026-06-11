import { beforeEach, describe, expect, it } from 'vitest';
import {
  type SliccAddDetail,
  SliccAddMenu,
  type SliccAddSection,
} from '../../src/add-menu/slicc-add-menu.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/** Mount a fresh menu in the document body and return it. */
function mount(): SliccAddMenu {
  const el = document.createElement('slicc-add-menu');
  document.body.appendChild(el);
  return el;
}

const shadow = (el: SliccAddMenu) => el.shadowRoot as ShadowRoot;
const trigger = (el: SliccAddMenu) => shadow(el).querySelector('.trigger') as HTMLButtonElement;
const searchInput = (el: SliccAddMenu) =>
  shadow(el).querySelector('.searchbox input') as HTMLInputElement;
const rows = (el: SliccAddMenu) =>
  Array.from(shadow(el).querySelectorAll<HTMLElement>('.results .item'));
const sections = (el: SliccAddMenu) =>
  Array.from(shadow(el).querySelectorAll<HTMLElement>('.results .sec')).map(
    (s) => s.textContent ?? ''
  );

/** Drive the search box the way a keystroke would. */
function typeSearch(el: SliccAddMenu, value: string): void {
  const input = searchInput(el);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Yield a microtask so the async #renderBody settles. */
const flush = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe('slicc-add-menu', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-add-menu')).toBe(SliccAddMenu);
  });

  it('exposes the ::part hooks from the prototype contract', () => {
    const el = mount();
    const root = shadow(el);
    expect(root.querySelector('[part="wrap"]')).not.toBeNull();
    expect(root.querySelector('[part="trigger"]')).not.toBeNull();
    expect(root.querySelector('[part="results"]')).not.toBeNull();
  });

  it('renders the trigger as a lucide <svg>, never a unicode +/× glyph', () => {
    const el = mount();
    const trig = trigger(el);
    // The glyph is a real <svg>, not text.
    const svg = trig.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.querySelector('path, line, circle, rect')).not.toBeNull();
    // No bespoke unicode plus/times/fullwidth-plus glyph leaked into the markup.
    for (const glyph of ['+', '×', '＋', '✕', '✦']) {
      expect(trig.textContent ?? '').not.toContain(glyph);
    }
  });

  it('swaps the trigger glyph between lucide plus (closed) and x (open)', async () => {
    const el = mount();
    const trig = trigger(el);

    // Closed: a lucide "plus" — two crossing line/path segments, no diagonals.
    expect(trig.querySelector('svg')).not.toBeNull();

    el.open();
    await flush();
    // Open: still an <svg> (a lucide "x"), still no unicode glyph text.
    const openSvg = trig.querySelector('svg');
    expect(openSvg).not.toBeNull();
    expect(trig.textContent ?? '').not.toContain('×');
    expect(trig.textContent ?? '').not.toContain('+');
    // The "x" glyph has diagonal line segments, the "plus" does not.
    expect(openSvg?.querySelector('line, path')).not.toBeNull();

    el.close();
    await flush();
    expect(trig.querySelector('svg')).not.toBeNull();
  });

  it('renders every result-row + quick-action icon as a lucide <svg> (no emoji)', async () => {
    const el = mount();
    el.open();
    await flush();
    const icons = Array.from(shadow(el).querySelectorAll<HTMLElement>('.results .item .ic'));
    expect(icons.length).toBeGreaterThan(0);
    for (const ic of icons) {
      expect(ic.querySelector('svg')).not.toBeNull();
    }
    // The search-box leading icon is also a lucide <svg>.
    expect(shadow(el).querySelector('.searchbox .si svg')).not.toBeNull();
    // No emoji / bespoke glyph anywhere in the open panel's text.
    const text = (shadow(el).querySelector('.results') as HTMLElement).textContent ?? '';
    for (const glyph of ['📎', '🖼', '📷', '🖥', '➕', '✕', '×']) {
      expect(text).not.toContain(glyph);
    }
  });

  it('starts closed', () => {
    const el = mount();
    expect(el.isOpen).toBe(false);
    expect(el.hasAttribute('data-open')).toBe(false);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('opens and closes via the trigger, reflecting data-open + aria-expanded', async () => {
    const el = mount();

    trigger(el).click();
    await flush();
    expect(el.isOpen).toBe(true);
    expect(el.hasAttribute('data-open')).toBe(true);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('true');

    trigger(el).click();
    await flush();
    expect(el.isOpen).toBe(false);
    expect(el.hasAttribute('data-open')).toBe(false);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');
  });

  it('reveals the slide-in search box only while open (real layout)', async () => {
    const el = mount();
    const box = shadow(el).querySelector('.searchbox') as HTMLElement;
    expect(getComputedStyle(box).display).toBe('none');

    el.open();
    await flush();
    expect(getComputedStyle(box).display).not.toBe('none');
  });

  it('renders the default demo dataset (quick actions + the three sections)', async () => {
    const el = mount();
    el.open();
    await flush();

    expect(sections(el)).toEqual(['Files', 'Skills', 'Conversations']);
    // Demo quick actions appear up top when there is no query.
    const labels = rows(el).map((r) => r.querySelector('.lb')?.textContent ?? '');
    expect(labels).toContain('Upload from this computer');
    expect(labels).toContain('README.md');
    expect(labels).toContain('slicc-handoff');
  });

  it('filters results by the search query across sections', async () => {
    const el = mount();
    el.open();
    await flush();

    typeSearch(el, 'main');
    await flush();

    const labels = rows(el).map((r) => r.querySelector('.lb')?.textContent ?? '');
    expect(labels).toContain('main.ts');
    // Non-matching demo rows are filtered out.
    expect(labels).not.toContain('README.md');
    // A no-match query shows the empty state.
    typeSearch(el, 'zzzznomatch');
    await flush();
    expect(rows(el)).toHaveLength(0);
    expect(shadow(el).querySelector('.empty')).not.toBeNull();
  });

  it('emits a composed, bubbling "slicc-add" event with detail on row selection', async () => {
    const el = mount();
    el.open();
    await flush();
    typeSearch(el, 'orchestrator');
    await flush();

    let detail: SliccAddDetail | undefined;
    let event: CustomEvent<SliccAddDetail> | undefined;
    // Listen on document to prove the event bubbles + crosses the shadow boundary.
    document.addEventListener(
      'slicc-add',
      (e) => {
        event = e as CustomEvent<SliccAddDetail>;
        detail = (e as CustomEvent<SliccAddDetail>).detail;
      },
      { once: true }
    );

    const row = rows(el).find((r) => r.querySelector('.lb')?.textContent === 'orchestrator.ts');
    expect(row).toBeTruthy();
    row?.click();

    expect(event?.bubbles).toBe(true);
    expect(event?.composed).toBe(true);
    expect(detail).toEqual({
      kind: 'file',
      id: '/workspace/src/orchestrator.ts',
      label: 'orchestrator.ts',
    });
    // Selecting closes the menu.
    expect(el.isOpen).toBe(false);
  });

  it('emits a capture detail for the screenshot quick action', async () => {
    const el = mount();
    el.open();
    await flush();

    let detail: SliccAddDetail | undefined;
    document.addEventListener('slicc-add', (e) => {
      detail = (e as CustomEvent<SliccAddDetail>).detail;
    });

    const shot = rows(el).find((r) => r.querySelector('.lb')?.textContent === 'Take a screenshot');
    shot?.click();
    expect(detail).toEqual({ kind: 'capture', mode: 'screenshot', label: 'Take a screenshot' });
  });

  it('honors an injected `results` dataset in place of the demo data', async () => {
    const custom: SliccAddSection[] = [
      {
        kind: 'doc',
        label: 'Docs',
        icon: 'file',
        entries: [{ id: 'spec', label: 'Design spec', sub: 'docs/design.md' }],
      },
    ];
    const el = mount();
    el.results = custom;
    el.open();
    await flush();

    expect(sections(el)).toEqual(['Docs']);
    const labels = rows(el).map((r) => r.querySelector('.lb')?.textContent ?? '');
    expect(labels).toContain('Design spec');
    // Demo data is gone.
    expect(labels).not.toContain('README.md');

    // The injected dataset selection carries its own kind + id.
    let detail: SliccAddDetail | undefined;
    document.addEventListener('slicc-add', (e) => {
      detail = (e as CustomEvent<SliccAddDetail>).detail;
    });
    rows(el)
      .find((r) => r.querySelector('.lb')?.textContent === 'Design spec')
      ?.click();
    expect(detail).toEqual({ kind: 'doc', id: 'spec', label: 'Design spec' });

    // Clearing the override restores the demo dataset.
    el.results = null;
    el.open();
    await flush();
    expect(sections(el)).toEqual(['Files', 'Skills', 'Conversations']);
  });

  it('honors an injected async `provider` callback (taking precedence over results)', async () => {
    const seen: string[] = [];
    const el = mount();
    el.results = [
      {
        kind: 'static',
        label: 'Static',
        icon: 'file',
        entries: [{ id: 's', label: 'static row' }],
      },
    ];
    el.provider = (q) => {
      seen.push(q);
      return Promise.resolve([
        {
          kind: 'dyn',
          label: 'Dynamic',
          icon: 'sparkles',
          entries: [{ id: 'd', label: 'dynamic row' }],
        },
      ]);
    };
    el.open();
    await flush();

    expect(sections(el)).toEqual(['Dynamic']);
    const labels = rows(el).map((r) => r.querySelector('.lb')?.textContent ?? '');
    expect(labels).toContain('dynamic row');
    // Provider wins over results.
    expect(labels).not.toContain('static row');
    // Provider was called with the (lower-cased) query.
    typeSearch(el, 'DYN');
    await flush();
    expect(seen).toContain('dyn');
  });

  it('escapes interpolated entry text', async () => {
    const el = mount();
    el.results = [
      {
        kind: 'x',
        label: 'X',
        icon: 'file',
        entries: [{ id: 'evil', label: '<img src=x onerror=alert(1)>', sub: '<b>sub</b>' }],
      },
    ];
    el.open();
    await flush();
    // Filter to the malicious row so quick actions don't shadow it in the DOM.
    typeSearch(el, 'img');
    await flush();
    const lb = shadow(el).querySelector('.results .item .lb') as HTMLElement;
    expect(lb.querySelector('img')).toBeNull();
    expect(lb.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('toggles the data-dropping state during a file drag-over', async () => {
    const el = mount();
    const wrap = shadow(el).querySelector('.wrap') as HTMLElement;

    wrap.dispatchEvent(new DragEvent('dragover', { bubbles: true }));
    await flush();
    expect(el.hasAttribute('data-dropping')).toBe(true);

    wrap.dispatchEvent(new DragEvent('drop', { bubbles: true }));
    expect(el.hasAttribute('data-dropping')).toBe(false);
  });

  it('a dropped file emits slicc-add WITH the File object (hosts read its content)', async () => {
    const el = mount();
    const wrap = shadow(el).querySelector('.wrap') as HTMLElement;
    const details: Array<Record<string, unknown>> = [];
    el.addEventListener('slicc-add', (e) =>
      details.push((e as CustomEvent<Record<string, unknown>>).detail)
    );

    const file = new File(['payload'], 'drop.md', { type: 'text/markdown' });
    const dt = new DataTransfer();
    dt.items.add(file);
    wrap.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ kind: 'upload', name: 'drop.md', size: 7 });
    expect(details[0].file).toBe(file);
  });

  it('cleans up the document listener on disconnect', () => {
    const el = mount();
    el.open();
    expect(el.isOpen).toBe(true);
    el.remove();
    // A document mousedown after removal must not throw / mutate the detached node.
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(el.isConnected).toBe(false);
  });
});
