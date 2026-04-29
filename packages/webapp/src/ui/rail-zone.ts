/**
 * RailZone — vertical icon rail + collapsible content panel.
 *
 * Used by the standalone/CLI right-side UI. Replaces the horizontal
 * `mini-tabs` for the right zone with a thin always-visible icon rail
 * stacked vertically, where:
 *
 * - sprinkles render as icon buttons in the top section,
 * - terminal / files / memory render as pinned icons in the bottom section,
 * - clicking an idle icon activates that item AND expands the content
 *   panel beside the rail,
 * - clicking the active icon collapses the panel,
 * - long-press (>=2s) or click with any modifier key (cmd / ctrl /
 *   shift / alt / option) activates that item AND switches to
 *   fullpage mode (chat hidden, content fills the available space),
 * - the [+] button is rendered only when the top section would
 *   overflow the available rail height.
 */

import type { ZoneId } from './panel-types.js';

export interface RailItem {
  id: string;
  label: string;
  /** SVG markup for the icon (innerHTML of a 16×16 svg). */
  icon: string;
  /** Content element to mount when activated. */
  element: HTMLElement;
  /** True for sprinkles; pinned built-ins are not closable. */
  closable?: boolean;
  /** 'top' for sprinkles, 'bottom' for built-in tools. */
  position: 'top' | 'bottom';
  onActivate?: () => void;
  onClose?: () => void;
}

export interface RailZoneCallbacks {
  /** Fires after an item is activated (panel expanded / fullpage). */
  onItemActivate?: (id: string) => void;
  /** Fires when the panel becomes collapsed. */
  onCollapse?: () => void;
  /** Fires when an item's close button is clicked. */
  onItemClose?: (id: string) => void;
  /** Fires when [+] is clicked. */
  onAddClick?: () => void;
  /** Fires when fullpage mode toggles on or off. */
  onFullpageToggle?: (isFullpage: boolean) => void;
}

export interface RailZoneOptions {
  /**
   * When true, plain clicks on a rail item activate the panel in
   * fullpage mode instead of expanding beside the existing layout.
   * The extension side panel uses this — there's not enough width
   * to host both chat and an expanded rail content panel side by
   * side. Standalone keeps the default (false).
   */
  defaultFullpage?: boolean;
}

/** Long-press threshold in milliseconds for the click-and-hold gesture. */
const LONG_PRESS_MS = 1000;

interface RailEntry {
  btn: HTMLButtonElement;
  container: HTMLElement;
  item: RailItem;
}

export class RailZone {
  readonly zoneId: ZoneId;
  private rail: HTMLElement;
  private contentArea: HTMLElement;
  private callbacks: RailZoneCallbacks;
  private storageKey: string;

  /** Top section (sprinkles) — items render here in insertion order. */
  private topSection: HTMLElement;
  /** Bottom section (built-in tools) — pinned at the rail's bottom edge. */
  private bottomSection: HTMLElement;
  /** [+] button (only visible when top section overflows). */
  private addBtn: HTMLButtonElement | null = null;

  private entries = new Map<string, RailEntry>();
  private activeId: string | null = null;
  private fullpage = false;
  private overflowObserver: ResizeObserver | null = null;
  private defaultFullpage = false;
  /** Header slot above the top section (e.g. user avatar in the extension rail). */
  private headerSection: HTMLElement | null = null;

  constructor(
    railEl: HTMLElement,
    contentEl: HTMLElement,
    zoneId: ZoneId,
    callbacks: RailZoneCallbacks = {},
    options: RailZoneOptions = {}
  ) {
    this.rail = railEl;
    this.contentArea = contentEl;
    this.zoneId = zoneId;
    this.callbacks = callbacks;
    this.storageKey = `slicc-${zoneId}-rail`;
    this.defaultFullpage = options.defaultFullpage ?? false;

    this.rail.classList.add('rail');
    this.topSection = document.createElement('div');
    this.topSection.className = 'rail__section rail__section--top';
    this.bottomSection = document.createElement('div');
    this.bottomSection.className = 'rail__section rail__section--bottom';
    this.rail.appendChild(this.topSection);
    this.rail.appendChild(this.bottomSection);

    // Default to collapsed — the rail is always visible, but the
    // content panel is hidden until the user clicks an item.
    this.contentArea.classList.add('rail-content--collapsed');
    this.contentArea.style.display = 'none';
  }

  /** Add an item to the rail. */
  addItem(item: RailItem): void {
    if (this.entries.has(item.id)) return;

    const btn = this.createItemButton(item);
    const section = item.position === 'bottom' ? this.bottomSection : this.topSection;

    if (item.closable && item.position === 'top' && this.addBtn) {
      // Insert sprinkle items before the [+] button when present.
      section.insertBefore(btn, this.addBtn);
    } else {
      section.appendChild(btn);
    }

    item.element.style.display = 'none';
    this.contentArea.appendChild(item.element);

    this.entries.set(item.id, { btn, container: item.element, item });
    this.updateOverflowState();
  }

  /** Remove an item from the rail. */
  removeItem(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.btn.remove();
    entry.container.remove();
    this.entries.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      this.collapse();
    }
    this.updateOverflowState();
  }

  hasItem(id: string): boolean {
    return this.entries.has(id);
  }

  /** Activate an item and expand the content panel. */
  activateItem(id: string, options: { fullpage?: boolean } = {}): void {
    const target = this.entries.get(id);
    if (!target) return;

    this.activeId = id;
    for (const [itemId, { btn, container }] of this.entries) {
      const active = itemId === id;
      btn.classList.toggle('rail__item--active', active);
      container.style.display = active ? 'flex' : 'none';
    }

    this.contentArea.classList.remove('rail-content--collapsed');
    this.contentArea.style.display = 'flex';

    try {
      localStorage.setItem(this.storageKey, id);
    } catch {
      // localStorage may be unavailable in some contexts.
    }

    if (options.fullpage !== undefined) this.setFullpage(options.fullpage);

    target.item.onActivate?.();
    this.callbacks.onItemActivate?.(id);
  }

  /** Collapse the content panel — rail icons stay visible. */
  collapse(): void {
    if (this.activeId) {
      const target = this.entries.get(this.activeId);
      if (target) {
        target.btn.classList.remove('rail__item--active');
        target.container.style.display = 'none';
      }
    }
    this.activeId = null;
    this.contentArea.classList.add('rail-content--collapsed');
    this.contentArea.style.display = 'none';
    if (this.fullpage) this.setFullpage(false);
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      // ignore
    }
    this.callbacks.onCollapse?.();
  }

  isCollapsed(): boolean {
    return this.activeId === null;
  }

  setFullpage(fullpage: boolean): void {
    if (this.fullpage === fullpage) return;
    this.fullpage = fullpage;
    this.callbacks.onFullpageToggle?.(fullpage);
  }

  isFullpage(): boolean {
    return this.fullpage;
  }

  getActiveItemId(): string | null {
    return this.activeId;
  }

  /** Show or hide the [+] button. The button only renders when the
   *  top section's intrinsic content height exceeds the rail's
   *  available height (overflow-driven, not always-on). */
  enableAddButton(): void {
    if (this.addBtn) return;
    const btn = document.createElement('button');
    btn.className = 'rail__item rail__item--add';
    btn.dataset.tooltip = 'Add panel';
    btn.dataset.tooltipPos = 'left';
    btn.setAttribute('aria-label', 'Add panel');
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v10M3 8h10"/></svg>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      this.callbacks.onAddClick?.();
    });
    this.topSection.appendChild(btn);
    this.addBtn = btn;
    btn.style.display = 'none';

    // Recompute overflow when the rail or its contents resize.
    if (typeof ResizeObserver !== 'undefined') {
      this.overflowObserver = new ResizeObserver(() => this.updateOverflowState());
      this.overflowObserver.observe(this.rail);
      this.overflowObserver.observe(this.topSection);
    }
    this.updateOverflowState();
  }

  /** Decide whether the [+] button should be visible based on overflow. */
  private updateOverflowState(): void {
    if (!this.addBtn) return;
    const railHeight = this.rail.clientHeight || this.rail.offsetHeight;
    const bottomHeight = this.bottomSection.offsetHeight;
    const topItemsHeight = Array.from(this.topSection.children)
      .filter((el) => el !== this.addBtn)
      .reduce((sum, el) => sum + (el as HTMLElement).offsetHeight, 0);
    // No measurable layout (e.g. jsdom or pre-mount): keep [+] hidden.
    if (railHeight <= 0 || topItemsHeight <= 0) {
      this.addBtn.style.display = 'none';
      return;
    }
    // Reserve some breathing room (8px) between top/bottom sections.
    const availableTop = railHeight - bottomHeight - 8;
    const overflowing = topItemsHeight > availableTop;
    this.addBtn.style.display = overflowing ? '' : 'none';
  }

  /** Create the rail button for an item with click + long-press wiring. */
  private createItemButton(item: RailItem): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'rail__item';
    btn.dataset.itemId = item.id;
    btn.dataset.tooltip = item.label;
    btn.dataset.tooltipPos = 'left';
    btn.setAttribute('aria-label', item.label);
    btn.innerHTML = item.icon;

    // Press-ripple layer: a clipped overlay that hosts the growing
    // circle drawn during a long-press. Inserted as the first child
    // so the icon renders on top of the ripple.
    const pressLayer = document.createElement('span');
    pressLayer.className = 'rail__item-press-layer';
    btn.insertBefore(pressLayer, btn.firstChild);

    this.attachActivationHandlers(btn, item.id);
    return btn;
  }

  /** Wire click + long-press + modifier-click activation. */
  private attachActivationHandlers(btn: HTMLButtonElement, id: string): void {
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let firedLongPress = false;
    let pressEl: HTMLSpanElement | null = null;

    const removePressVisual = () => {
      if (pressEl) {
        pressEl.remove();
        pressEl = null;
      }
    };

    const clearTimer = () => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
      removePressVisual();
    };

    /**
     * Build the growing-circle ripple. The element starts as a tiny
     * dot at the cursor, animates outward via CSS transitions, and
     * fully covers the button right at the long-press threshold.
     */
    const startPressVisual = (e: MouseEvent) => {
      removePressVisual();
      const layer = btn.querySelector<HTMLElement>('.rail__item-press-layer');
      if (!layer) return;
      const rect = btn.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      // Cover the whole button no matter where the click landed:
      // diagonal from the press point to the farthest corner.
      const farthestX = Math.max(x, rect.width - x);
      const farthestY = Math.max(y, rect.height - y);
      const radius = Math.ceil(Math.hypot(farthestX, farthestY)) + 2;
      const span = document.createElement('span');
      span.className = 'rail__item-press';
      span.style.left = `${x}px`;
      span.style.top = `${y}px`;
      span.style.width = '0px';
      span.style.height = '0px';
      span.style.transitionDuration = `${LONG_PRESS_MS}ms`;
      layer.appendChild(span);
      pressEl = span;
      // Force layout, then expand to full button cover.
      requestAnimationFrame(() => {
        if (!pressEl) return;
        pressEl.style.width = `${radius * 2}px`;
        pressEl.style.height = `${radius * 2}px`;
      });
    };

    btn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // Modifier-clicks are an instant trigger — no press animation.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      firedLongPress = false;
      clearTimer();
      startPressVisual(e);
      pressTimer = setTimeout(() => {
        firedLongPress = true;
        removePressVisual();
        this.activateItem(id, { fullpage: true });
      }, LONG_PRESS_MS);
    });

    btn.addEventListener('mouseup', () => clearTimer());
    btn.addEventListener('mouseleave', () => clearTimer());
    btn.addEventListener('blur', () => clearTimer());
    btn.addEventListener('contextmenu', () => clearTimer());

    btn.addEventListener('click', (e) => {
      // Skip the click that the long-press already handled.
      if (firedLongPress) {
        firedLongPress = false;
        e.preventDefault();
        return;
      }
      const modifierClick = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
      if (modifierClick) {
        this.activateItem(id, { fullpage: true });
        return;
      }
      // Plain click: toggle. In `defaultFullpage` mode (extension
      // side panel) the active rail item already covers the panel,
      // so collapsing on a second click on the same icon takes the
      // user back to chat naturally.
      const wantsFullpage = this.defaultFullpage;
      if (this.activeId === id && (wantsFullpage ? this.fullpage : !this.fullpage)) {
        this.collapse();
      } else {
        this.activateItem(id, { fullpage: wantsFullpage });
      }
    });
  }

  /**
   * Mount a custom widget above the top section. Used by the
   * extension layout to host the user avatar at the rail's top edge.
   * Pass null to remove the previously-mounted widget.
   */
  mountTopWidget(widget: HTMLElement | null): void {
    if (this.headerSection) {
      this.headerSection.remove();
      this.headerSection = null;
    }
    if (!widget) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'rail__section rail__section--header';
    wrapper.appendChild(widget);
    this.rail.insertBefore(wrapper, this.topSection);
    this.headerSection = wrapper;
  }

  /** Restore the last-active item from localStorage, if it still exists. */
  restoreActive(): void {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(this.storageKey);
    } catch {
      // ignore
    }
    if (saved && this.entries.has(saved)) {
      this.activateItem(saved, { fullpage: false });
    } else {
      this.collapse();
    }
  }

  /** Tear down observers (used in tests / hot-reload). */
  destroy(): void {
    this.overflowObserver?.disconnect();
    this.overflowObserver = null;
  }

  /** Test-only handle. */
  readonly __test__ = {
    longPressMs: LONG_PRESS_MS,
  };
}
