import { beforeEach, describe, expect, it, vi } from 'vitest';
// Sibling composed BY TAG by the dock; imported here so it registers and the
// rendered `<slicc-dock-item>` children upgrade when the dock renders them.
import '../../src/dock/slicc-dock-item.js';
import {
  type DockCollapseDetail,
  type DockItemDescriptor,
  type DockSelectDetail,
  SliccDock,
} from '../../src/dock/slicc-dock.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const SPRINKLES: DockItemDescriptor[] = [
  { id: 'hero', glyph: '✦', label: 'Hero studio', kind: 'sprinkle', hue: 'var(--violet)' },
  { id: 'palette', glyph: '✦', label: 'palette', kind: 'sprinkle', hue: 'var(--amber)' },
];

/** Mount a dock with the given sprinkles, optionally with the system tools + active. */
function mount(
  items: DockItemDescriptor[] = SPRINKLES,
  opts: { systemTools?: boolean; active?: string } = {}
): SliccDock {
  const el = document.createElement('slicc-dock') as SliccDock;
  el.items = items;
  if (opts.systemTools) el.systemTools = true;
  if (opts.active) el.active = opts.active;
  document.body.appendChild(el);
  return el;
}

/** The rendered `<slicc-dock-item>`s inside the rail. */
function dockItems(el: SliccDock): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('slicc-dock-item')];
}

/** Find a rendered dock-item by its `data-t` id. */
function itemById(el: SliccDock, id: string): HTMLElement | undefined {
  return dockItems(el).find((i) => i.dataset.t === id);
}

/** Click a dock-item end-to-end: the dock-item wires its click on the inner shadow
 *  `<button>`, so a real click there fires its own `select`/`collapse` event (which
 *  the dock listens for). Falls back to a host-level click if the shadow button is
 *  absent (defensive — should not happen once the item upgrades). */
function clickItem(el: SliccDock, id: string): void {
  const item = itemById(el, id);
  const button = item?.shadowRoot?.querySelector<HTMLButtonElement>('button');
  if (button) button.click();
  else item?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
}

describe('slicc-dock', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-dock')).toBe(SliccDock);
  });

  it('renders into light DOM (no shadow root) and carries the scoped host class + rail part/role', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
    expect(el.classList.contains('slicc-dock')).toBe(true);
    expect(el.getAttribute('part')).toBe('rail');
    expect(el.getAttribute('role')).toBe('toolbar');
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('injects its scoped stylesheet once', () => {
    mount();
    mount();
    expect(document.querySelectorAll('#slicc-dock-style')).toHaveLength(1);
  });

  describe('item composition', () => {
    it('renders one <slicc-dock-item> per sprinkle, then a New + launcher', () => {
      const el = mount();
      const ids = dockItems(el).map((i) => i.dataset.t);
      expect(ids).toEqual(['hero', 'palette', 'new']);
      const newItem = itemById(el, 'new');
      // The dock forwards the descriptor label as the dock-item's `tip`.
      expect(newItem?.getAttribute('tip')).toBe('New sprinkle');
      expect(newItem?.getAttribute('glyph')).toBe('＋');
    });

    it('forwards glyph, label (→tip), kind and hue to each item', () => {
      const el = mount();
      const hero = itemById(el, 'hero');
      expect(hero?.getAttribute('glyph')).toBe('✦');
      expect(hero?.getAttribute('tip')).toBe('Hero studio');
      expect(hero?.getAttribute('kind')).toBe('sprinkle');
      // The hue is forwarded as the dock-item's `hue` attribute (it sets --h itself).
      expect(hero?.getAttribute('hue')).toBe('var(--violet)');
    });

    it('escapes interpolated label/id text', () => {
      const el = mount([{ id: 'x', label: '<img src=x>', kind: 'sprinkle' }]);
      expect(itemById(el, 'x')?.getAttribute('tip')).toBe('<img src=x>');
      expect(el.querySelector('img')).toBeNull();
    });

    it('always renders the .grow spacer that pushes tools to the bottom', () => {
      const el = mount();
      expect(el.querySelector('.grow')).not.toBeNull();
    });
  });

  describe('system tools variant', () => {
    it('omits the divider + pinned tools by default', () => {
      const el = mount();
      expect(el.querySelector('.div')).toBeNull();
      expect(itemById(el, 'browser')).toBeUndefined();
    });

    it('appends the .div divider + Browser/Files/Terminal/Memory tools after the grow', () => {
      const el = mount(SPRINKLES, { systemTools: true });
      expect(el.querySelector('.div')).not.toBeNull();
      expect(itemById(el, 'browser')?.getAttribute('tip')).toBe('Browser · CDP');
      expect(itemById(el, 'files')?.getAttribute('tip')).toBe('Files · VFS');
      expect(itemById(el, 'term')?.getAttribute('glyph')).toBe('>_');
      expect(itemById(el, 'memory')?.getAttribute('glyph')).toBe('◉');
      // The pinned tools are marked as tools, not sprinkles.
      expect(itemById(el, 'files')?.getAttribute('kind')).toBe('tool');
    });

    it('reflects the system-tools attribute to the property', () => {
      const el = mount();
      expect(el.systemTools).toBe(false);
      el.systemTools = true;
      expect(el.hasAttribute('system-tools')).toBe(true);
      expect(itemById(el, 'memory')).toBeDefined();
      el.systemTools = false;
      expect(el.hasAttribute('system-tools')).toBe(false);
      expect(itemById(el, 'memory')).toBeUndefined();
    });
  });

  describe('items property', () => {
    it('returns a defensive copy (mutating the result does not affect state)', () => {
      const el = mount();
      const got = el.items;
      got[0].label = 'mutated';
      expect(el.items[0].label).toBe('Hero studio');
    });

    it('re-renders when the items list is replaced', () => {
      const el = mount();
      el.items = [{ id: 'solo', glyph: '✦', label: 'Solo', kind: 'sprinkle' }];
      // solo + the New launcher.
      expect(dockItems(el).map((i) => i.dataset.t)).toEqual(['solo', 'new']);
    });

    it('tolerates a non-array assignment by clearing the sprinkles', () => {
      const el = mount();
      // @ts-expect-error — exercising the runtime guard.
      el.items = null;
      // Only the New launcher remains.
      expect(dockItems(el).map((i) => i.dataset.t)).toEqual(['new']);
    });
  });

  describe('active reflection + state', () => {
    it('reflects the active attribute to the property', () => {
      const el = mount(SPRINKLES, { active: 'hero' });
      expect(el.active).toBe('hero');
      el.active = 'palette';
      expect(el.getAttribute('active')).toBe('palette');
      el.active = null;
      expect(el.hasAttribute('active')).toBe(false);
    });

    it('renders the active item with the active attribute on initial paint', () => {
      const el = mount(SPRINKLES, { active: 'hero' });
      expect(itemById(el, 'hero')?.hasAttribute('active')).toBe(true);
    });

    it('marks only the active item via syncActive (no full rebuild)', () => {
      const el = mount(SPRINKLES, { active: 'hero' });
      el.active = 'palette';
      const lit = dockItems(el).filter((i) => i.hasAttribute('active'));
      expect(lit).toHaveLength(1);
      expect(lit[0].dataset.t).toBe('palette');
    });
  });

  describe('selection + collapse behaviour', () => {
    it('selectItem() sets active and emits slicc-dock-select with { id, kind }', () => {
      const el = mount(SPRINKLES, { systemTools: true });
      const detail = vi.fn();
      el.addEventListener('slicc-dock-select', (e) =>
        detail((e as CustomEvent<DockSelectDetail>).detail)
      );
      el.selectItem('hero');
      expect(el.active).toBe('hero');
      expect(detail).toHaveBeenCalledWith({ id: 'hero', kind: 'sprinkle' });
      el.selectItem('files');
      expect(detail).toHaveBeenCalledWith({ id: 'files', kind: 'tool' });
    });

    it('clicking a non-active item selects it (re-emits dock-select)', () => {
      const el = mount();
      const select = vi.fn();
      el.addEventListener('slicc-dock-select', (e) =>
        select((e as CustomEvent<DockSelectDetail>).detail.id)
      );
      clickItem(el, 'hero');
      expect(select).toHaveBeenCalledWith('hero');
      expect(el.active).toBe('hero');
      // The active item now carries the active attribute (so its next click collapses).
      expect(itemById(el, 'hero')?.hasAttribute('active')).toBe(true);
    });

    it('clicking the active item collapses it (re-emits dock-collapse, clears active)', () => {
      const el = mount(SPRINKLES, { active: 'hero' });
      const collapse = vi.fn();
      const select = vi.fn();
      el.addEventListener('slicc-dock-collapse', (e) =>
        collapse((e as CustomEvent<DockCollapseDetail>).detail.id)
      );
      el.addEventListener('slicc-dock-select', select);
      clickItem(el, 'hero');
      expect(collapse).toHaveBeenCalledWith('hero');
      expect(select).not.toHaveBeenCalled();
      expect(el.active).toBeNull();
    });

    it('clicking through the rail moves the active item in lockstep (select → collapse)', () => {
      const el = mount(SPRINKLES, { systemTools: true });
      clickItem(el, 'hero');
      expect(el.active).toBe('hero');
      // Selecting a system tool moves the active item off the sprinkle.
      clickItem(el, 'files');
      expect(el.active).toBe('files');
      expect(itemById(el, 'hero')?.hasAttribute('active')).toBe(false);
      // Clicking the now-active tool collapses the shell.
      clickItem(el, 'files');
      expect(el.active).toBeNull();
    });

    it('collapse() is a no-op event-wise when nothing is active but still clears', () => {
      const el = mount();
      const collapse = vi.fn();
      el.addEventListener('slicc-dock-collapse', collapse);
      el.collapse();
      expect(collapse).not.toHaveBeenCalled();
      expect(el.active).toBeNull();
    });

    it('events bubble + are composed so ancestors can listen', () => {
      const el = mount();
      const seen = vi.fn();
      document.body.addEventListener('slicc-dock-select', seen);
      el.selectItem('hero');
      expect(seen).toHaveBeenCalledTimes(1);
      document.body.removeEventListener('slicc-dock-select', seen);
    });
  });

  describe('slotted adoption', () => {
    it('adopts pre-existing sprinkle slicc-dock-item children into the items list at connect', () => {
      const el = document.createElement('slicc-dock') as SliccDock;
      el.innerHTML =
        '<slicc-dock-item item-id="hero" kind="sprinkle" glyph="✦" tip="Hero studio"></slicc-dock-item>' +
        '<slicc-dock-item item-id="palette" kind="sprinkle" glyph="✦" tip="palette"></slicc-dock-item>';
      document.body.appendChild(el);
      expect(el.items.map((i) => i.id)).toEqual(['hero', 'palette']);
      expect(el.items.map((i) => i.label)).toEqual(['Hero studio', 'palette']);
      // Rebuilt canonically: the two adopted sprinkles + the New launcher.
      expect(dockItems(el).map((i) => i.dataset.t)).toEqual(['hero', 'palette', 'new']);
    });

    it('drops slotted system-tool items in favour of the declarative system-tools attribute', () => {
      const el = document.createElement('slicc-dock') as SliccDock;
      el.innerHTML =
        '<slicc-dock-item item-id="hero" kind="sprinkle" glyph="✦" tip="Hero studio"></slicc-dock-item>' +
        '<slicc-dock-item item-id="files" kind="tool" glyph="⌗" tip="Files"></slicc-dock-item>';
      document.body.appendChild(el);
      expect(el.items.map((i) => i.id)).toEqual(['hero']);
    });
  });

  describe('lifecycle', () => {
    it('drops the child event listeners on disconnect (no re-emit after removal)', () => {
      const el = mount();
      const item = itemById(el, 'hero')!;
      el.remove();
      const select = vi.fn();
      el.addEventListener('slicc-dock-select', select);
      // Simulate the child firing its own select after the dock is detached.
      item.dispatchEvent(
        new CustomEvent('select', { detail: { id: 'hero' }, bubbles: true, composed: true })
      );
      expect(select).not.toHaveBeenCalled();
    });
  });

  describe('computed appearance (real Chromium)', () => {
    it('lays the rail out as a fixed 48px centered flex column with the 8px gap', () => {
      const el = mount();
      const cs = getComputedStyle(el);
      expect(cs.display).toBe('flex');
      expect(cs.flexDirection).toBe('column');
      expect(cs.alignItems).toBe('center');
      expect(cs.rowGap).toBe('8px');
      // flex: 0 0 48px → no grow, no shrink, 48px basis.
      expect(cs.flexGrow).toBe('0');
      expect(cs.flexShrink).toBe('0');
      expect(cs.flexBasis).toBe('48px');
    });

    it('draws the border-left hairline and the tinted rail background', () => {
      const el = mount();
      const cs = getComputedStyle(el);
      expect(cs.borderLeftWidth).toBe('1px');
      expect(cs.borderLeftStyle).toBe('solid');
      // The rail bg is a color-mix over --bg — resolves to an opaque, non-transparent
      // color (Chromium may serialize it as a wide-gamut `color(srgb …)`).
      expect(cs.backgroundColor).toMatch(/^(rgb|color)\(/);
      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    });

    it('flips the rail background between light and dark (--ctx over --bg)', () => {
      const light = mount();
      const lightBg = getComputedStyle(light).backgroundColor;
      light.remove();
      document.body.classList.add('dark');
      const dark = mount();
      const darkBg = getComputedStyle(dark).backgroundColor;
      document.body.classList.remove('dark');
      expect(darkBg).not.toBe(lightBg);
    });

    it('lays the .grow spacer out with flex:1 so tools sink to the bottom', () => {
      const el = mount(SPRINKLES, { systemTools: true });
      const grow = el.querySelector('.grow') as HTMLElement;
      expect(getComputedStyle(grow).flexGrow).toBe('1');
    });

    it('draws the .div divider as a 22x1 hairline', () => {
      const el = mount(SPRINKLES, { systemTools: true });
      const div = el.querySelector('.div') as HTMLElement;
      const cs = getComputedStyle(div);
      expect(cs.width).toBe('22px');
      expect(cs.height).toBe('1px');
    });
  });
});
