import { beforeEach, describe, expect, it } from 'vitest';
// Sibling from THIS wave — registered on import; the bar composes it BY TAG and
// only depends on its public contract (`tab-id` / `kind` / `label` / `closable` /
// `active` attributes and the bubbling+composed `select` / `close` events).
import '../../src/workbench/slicc-tab.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';
import { SliccTabBar, type TabDescriptor } from '../../src/workbench/slicc-tab-bar.js';

const TOOL_TABS: TabDescriptor[] = [
  { id: 'files', label: 'Files', kind: 'tool', glyph: '◇' },
  { id: 'term', label: 'Terminal', kind: 'tool' },
  { id: 'memory', label: 'Memory', kind: 'tool' },
];

const SPRINKLE_TABS: TabDescriptor[] = [
  { id: 'hero', label: 'Hero studio', kind: 'sprinkle', closable: true },
  { id: 'palette', label: 'palette', kind: 'sprinkle', closable: true },
];

/** Construct + mount a tab bar with the given tab set; returns it attached. */
function mount(tabs: TabDescriptor[] = []): SliccTabBar {
  const el = document.createElement('slicc-tab-bar') as SliccTabBar;
  el.style.cssText = 'display:flex;width:320px;';
  document.body.appendChild(el);
  el.tabs = tabs;
  return el;
}

/** The rendered `<slicc-tab>` children of the bar, in DOM order. */
function tabEls(el: SliccTabBar): HTMLElement[] {
  return Array.from(el.querySelectorAll(':scope > slicc-tab')) as HTMLElement[];
}

/** Find a rendered child tab by its bar id. */
function tabById(el: SliccTabBar, id: string): HTMLElement {
  return tabEls(el).find((t) => t.getAttribute('tab-id') === id) as HTMLElement;
}

describe('slicc-tab-bar', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-tab-bar')).toBe(SliccTabBar);
  });

  it('renders into light DOM (no shadow root)', () => {
    const el = mount(TOOL_TABS);
    expect(el.shadowRoot).toBeNull();
  });

  it('reflects the active attribute to the property and back', () => {
    const el = mount(TOOL_TABS);
    expect(el.active).toBeNull();
    el.active = 'term';
    expect(el.getAttribute('active')).toBe('term');
    expect(el.active).toBe('term');
    el.active = null;
    expect(el.hasAttribute('active')).toBe(false);
    el.setAttribute('active', 'files');
    expect(el.active).toBe('files');
  });

  it('returns a defensive copy from the tabs getter', () => {
    const el = mount(TOOL_TABS);
    const got = el.tabs;
    got.push({ id: 'rogue', label: 'rogue' });
    got[0].label = 'mutated';
    expect(el.tabs.length).toBe(3);
    expect(el.tabs[0].label).toBe('Files');
  });

  // ---- variants / states ----

  it('empty: renders no tabs and no dividers', () => {
    const el = mount([]);
    expect(tabEls(el).length).toBe(0);
    expect(el.querySelectorAll('.slicc-tab-bar__div').length).toBe(0);
  });

  it('with tool tabs: one <slicc-tab> per descriptor, in order, kind="tool", id on tab-id', () => {
    const el = mount(TOOL_TABS);
    const tabs = tabEls(el);
    expect(tabs.length).toBe(3);
    expect(tabs.map((t) => t.getAttribute('tab-id'))).toEqual(['files', 'term', 'memory']);
    expect(tabs.every((t) => t.getAttribute('kind') === 'tool')).toBe(true);
    expect(tabs[0].getAttribute('label')).toBe('Files');
    expect(tabs[0].getAttribute('glyph')).toBe('◇');
  });

  it('with sprinkle tabs: renders kind="sprinkle" closable chips', () => {
    const el = mount(SPRINKLE_TABS);
    const tabs = tabEls(el);
    expect(tabs.length).toBe(2);
    expect(tabs.every((t) => t.getAttribute('kind') === 'sprinkle')).toBe(true);
    expect(tabs.every((t) => t.hasAttribute('closable'))).toBe(true);
  });

  it('inserts a .tdiv hairline divider between groups of differing kind', () => {
    const el = mount([...TOOL_TABS, ...SPRINKLE_TABS]);
    const dividers = el.querySelectorAll('.slicc-tab-bar__div');
    // Exactly one tool↔sprinkle boundary → exactly one divider.
    expect(dividers.length).toBe(1);
    expect(dividers[0].getAttribute('part')).toBe('divider');
    // No divider within a same-kind run.
    expect(mount(TOOL_TABS).querySelectorAll('.slicc-tab-bar__div').length).toBe(0);
  });

  it('overflowing: scrolls horizontally (scrollWidth exceeds clientWidth, overflow-x auto)', () => {
    const many: TabDescriptor[] = Array.from({ length: 24 }, (_, i) => ({
      id: `t${i}`,
      label: `A fairly long tab label ${i}`,
      kind: 'tool',
    }));
    const el = mount(many);
    el.style.width = '200px';
    expect(getComputedStyle(el).overflowX).toBe('auto');
    expect(el.scrollWidth).toBeGreaterThan(el.clientWidth);
  });

  // ---- layout (real Chromium getComputedStyle) ----

  it('is a flex row with 4px gap and min-width 0 (mirrors .tabstrip)', () => {
    const el = mount(TOOL_TABS);
    const cs = getComputedStyle(el);
    expect(cs.display).toBe('flex');
    expect(cs.flexDirection).toBe('row');
    expect(cs.alignItems).toBe('center');
    expect(cs.columnGap).toBe('4px');
    expect(cs.minWidth).toBe('0px');
  });

  it('divider is a 1px×18px hairline tinted by --line', () => {
    const el = mount([...TOOL_TABS, ...SPRINKLE_TABS]);
    const div = el.querySelector('.slicc-tab-bar__div') as HTMLElement;
    const cs = getComputedStyle(div);
    const rect = div.getBoundingClientRect();
    expect(Math.round(rect.width)).toBe(1);
    expect(Math.round(rect.height)).toBe(18);
    // --line (light: #e5e5e5) resolves to a concrete, non-transparent color.
    expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  });

  // ---- behavior / events ----

  it('addTab appends a tab and selects it, firing tab-select', () => {
    const el = mount(TOOL_TABS);
    const seen: string[] = [];
    el.addEventListener('tab-select', (e) => seen.push((e as CustomEvent).detail.id));
    el.addTab({ id: 'browser', label: 'Browser', kind: 'tool' });
    expect(el.tabs.map((t) => t.id)).toEqual(['files', 'term', 'memory', 'browser']);
    expect(el.active).toBe('browser');
    expect(seen).toEqual(['browser']);
  });

  it('addTab with an existing id updates in place (no duplicate) and selects it', () => {
    const el = mount(TOOL_TABS);
    el.addTab({ id: 'files', label: 'Files (renamed)', kind: 'tool' });
    expect(el.tabs.length).toBe(3);
    expect(tabById(el, 'files').getAttribute('label')).toBe('Files (renamed)');
    expect(el.active).toBe('files');
  });

  it('selectTab sets the active state, mirrors it onto the child, fires tab-select once', () => {
    const el = mount(TOOL_TABS);
    const seen: string[] = [];
    el.addEventListener('tab-select', (e) => seen.push((e as CustomEvent).detail.id));
    el.selectTab('memory');
    expect(el.active).toBe('memory');
    // active state mirrored onto the matching child (drives its `.on` state).
    expect(tabById(el, 'memory').hasAttribute('active')).toBe(true);
    expect(tabById(el, 'files').hasAttribute('active')).toBe(false);
    // Re-selecting the active tab is a no-op (no second event).
    el.selectTab('memory');
    expect(seen).toEqual(['memory']);
  });

  it('selectTab ignores an unknown id', () => {
    const el = mount(TOOL_TABS);
    let fired = false;
    el.addEventListener('tab-select', () => {
      fired = true;
    });
    el.selectTab('nope');
    expect(el.active).toBeNull();
    expect(fired).toBe(false);
  });

  it("a child <slicc-tab>'s `select` event selects that tab (re-emitted as tab-select)", () => {
    const el = mount(TOOL_TABS);
    const seen: string[] = [];
    el.addEventListener('tab-select', (e) => seen.push((e as CustomEvent).detail.id));
    // The real slicc-tab dispatches a bubbling+composed `select` on body click.
    tabById(el, 'term').dispatchEvent(
      new CustomEvent('select', { detail: { tabId: 'term' }, bubbles: true, composed: true })
    );
    expect(el.active).toBe('term');
    expect(seen).toEqual(['term']);
  });

  it('clicking a real slicc-tab body selects it (through its shadow `select`)', () => {
    const el = mount(TOOL_TABS);
    const seen: string[] = [];
    el.addEventListener('tab-select', (e) => seen.push((e as CustomEvent).detail.id));
    // Click the real tab's inner button inside its shadow root.
    const term = tabById(el, 'term');
    const btn = term.shadowRoot?.querySelector('button') as HTMLElement;
    btn.click();
    expect(el.active).toBe('term');
    expect(seen).toEqual(['term']);
  });

  it("a child <slicc-tab>'s `close` event removes that tab (re-emitted as tab-close)", () => {
    const el = mount(SPRINKLE_TABS);
    el.selectTab('hero');
    const closes: string[] = [];
    const selects: string[] = [];
    el.addEventListener('tab-close', (e) => closes.push((e as CustomEvent).detail.id));
    el.addEventListener('tab-select', (e) => selects.push((e as CustomEvent).detail.id));

    tabById(el, 'hero').dispatchEvent(
      new CustomEvent('close', { detail: { tabId: 'hero' }, bubbles: true, composed: true })
    );

    expect(el.tabs.map((t) => t.id)).toEqual(['palette']);
    expect(closes).toEqual(['hero']);
    // Closing the active tab falls back to the first remaining tab.
    expect(el.active).toBe('palette');
    expect(selects).toEqual(['palette']);
  });

  it("clicking a real slicc-tab's close affordance removes it (through its shadow `close`)", () => {
    const el = mount(SPRINKLE_TABS);
    el.selectTab('hero');
    const closes: string[] = [];
    el.addEventListener('tab-close', (e) => closes.push((e as CustomEvent).detail.id));

    const hero = tabById(el, 'hero');
    const x = hero.shadowRoot?.querySelector('[data-close]') as HTMLElement;
    x.click();

    expect(el.tabs.map((t) => t.id)).toEqual(['palette']);
    expect(closes).toEqual(['hero']);
    expect(el.active).toBe('palette');
  });

  it("removeTab of the active tab falls back to the first remaining tab (prototype select('files'))", () => {
    const el = mount(TOOL_TABS);
    el.selectTab('term');
    const order: string[] = [];
    el.addEventListener('tab-close', (e) => order.push(`close:${(e as CustomEvent).detail.id}`));
    el.addEventListener('tab-select', (e) => order.push(`select:${(e as CustomEvent).detail.id}`));
    el.removeTab('term');
    expect(el.tabs.map((t) => t.id)).toEqual(['files', 'memory']);
    expect(el.active).toBe('files');
    // tab-close precedes the fallback tab-select.
    expect(order).toEqual(['close:term', 'select:files']);
  });

  it('removeTab of a non-active tab keeps the active selection', () => {
    const el = mount(TOOL_TABS);
    el.selectTab('memory');
    el.removeTab('files');
    expect(el.tabs.map((t) => t.id)).toEqual(['term', 'memory']);
    expect(el.active).toBe('memory');
  });

  it('removeTab of the last tab clears the active selection', () => {
    const el = mount([{ id: 'only', label: 'Only', kind: 'tool' }]);
    el.selectTab('only');
    el.removeTab('only');
    expect(el.tabs.length).toBe(0);
    expect(el.active).toBeNull();
  });

  it('removeTab of an unknown id is a no-op (no event)', () => {
    const el = mount(TOOL_TABS);
    let fired = false;
    el.addEventListener('tab-close', () => {
      fired = true;
    });
    el.removeTab('ghost');
    expect(el.tabs.length).toBe(3);
    expect(fired).toBe(false);
  });

  it('tab-select / tab-close events are composed and bubbling', () => {
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const el = document.createElement('slicc-tab-bar') as SliccTabBar;
    host.appendChild(el);
    el.tabs = SPRINKLE_TABS;

    let bubbledSelect = false;
    let bubbledClose = false;
    let composedOk = false;
    host.addEventListener('tab-select', (e) => {
      bubbledSelect = true;
      composedOk = (e as CustomEvent).composed === true;
    });
    host.addEventListener('tab-close', () => {
      bubbledClose = true;
    });
    el.selectTab('hero');
    el.removeTab('hero');
    expect(bubbledSelect).toBe(true);
    expect(composedOk).toBe(true);
    expect(bubbledClose).toBe(true);
  });

  it('assigning tabs replaces the whole set and clears a now-missing active', () => {
    const el = mount(TOOL_TABS);
    el.selectTab('term');
    expect(el.active).toBe('term');
    el.tabs = SPRINKLE_TABS;
    expect(el.tabs.map((t) => t.id)).toEqual(['hero', 'palette']);
    // `term` is gone → active falls back to the first of the new set.
    expect(el.active).toBe('hero');
  });

  it('keeps the active child in sync when the active attribute changes directly', () => {
    const el = mount(TOOL_TABS);
    el.setAttribute('active', 'memory');
    expect(tabById(el, 'memory').hasAttribute('active')).toBe(true);
    expect(tabById(el, 'files').hasAttribute('active')).toBe(false);
  });

  it('survives detach + re-attach without losing its tab set or duplicating tabs', () => {
    const el = mount(TOOL_TABS);
    el.selectTab('term');
    el.remove();
    document.body.appendChild(el);
    expect(tabEls(el).length).toBe(3);
    expect(el.active).toBe('term');
    // Selection still works after re-attach (child `select` listener survived).
    tabById(el, 'memory').dispatchEvent(
      new CustomEvent('select', { detail: { tabId: 'memory' }, bubbles: true, composed: true })
    );
    expect(el.active).toBe('memory');
  });
});
