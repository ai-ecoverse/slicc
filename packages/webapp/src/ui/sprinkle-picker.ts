/**
 * Sprinkle Picker — popup menu shown on [+] click.
 * Lists closed panels from the registry + available (unopened) sprinkles.
 * Selecting one opens it in the zone that triggered the picker.
 */

import type { PanelRegistry } from './panel-registry.js';
import type { ZoneId } from './panel-types.js';

export interface SprinklePickerCallbacks {
  /** Called when a registered (closed) panel is selected. */
  onSelectPanel(id: string, zone: ZoneId): void;
  /** Called when a sprinkle (not yet opened) is selected. */
  onSelectSprinkle(name: string, zone: ZoneId): void;
}

export interface SprinklePickerOptions {
  registry: PanelRegistry;
  callbacks: SprinklePickerCallbacks;
  /** Return available sprinkles that are not yet open. */
  getAvailableSprinkles?: () => Array<{ name: string; title: string }>;
}

/**
 * Show a sprinkle picker popup anchored to a button element.
 * Closes itself on selection or outside click.
 */
export function showSprinklePicker(
  anchor: HTMLElement,
  zone: ZoneId,
  options: SprinklePickerOptions
): void {
  // Toggle: if picker is already open, close it and return
  const existing = document.querySelector('.sprinkle-picker');
  if (existing) {
    existing.remove();
    return;
  }

  const { registry, callbacks, getAvailableSprinkles } = options;

  const closedPanels = registry.getClosed();
  const sprinkles = getAvailableSprinkles?.() ?? [];

  if (closedPanels.length === 0 && sprinkles.length === 0) {
    return; // Nothing to show
  }

  const menu = document.createElement('div');
  menu.className = 'sprinkle-picker';
  menu.style.cssText =
    'position: absolute; min-width: 160px; max-height: 300px; ' +
    'overflow-y: auto; background: var(--s2-bg-layer-2); border: 1px solid var(--s2-border-default); ' +
    'border-radius: var(--s2-radius-l); padding: 4px 0; box-shadow: var(--s2-shadow-elevated); z-index: 1000;';

  const dismiss = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outsideClick, true);
    document.removeEventListener('keydown', onKey, true);
  };

  // Closed built-in panels
  for (const panel of closedPanels) {
    const item = createMenuItem(panel.label, () => {
      callbacks.onSelectPanel(panel.id, zone);
      dismiss();
    });
    menu.appendChild(item);
  }

  // Separator if both groups exist
  if (closedPanels.length > 0 && sprinkles.length > 0) {
    const sep = document.createElement('div');
    sep.style.cssText = 'height: 1px; background: var(--s2-border-default); margin: 4px 0;';
    menu.appendChild(sep);
  }

  // Available sprinkles
  for (const sprinkle of sprinkles) {
    const item = createMenuItem(sprinkle.title, () => {
      callbacks.onSelectSprinkle(sprinkle.name, zone);
      dismiss();
    });
    menu.appendChild(item);
  }

  // Position relative to anchor
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;

  document.body.appendChild(menu);

  // Close on outside click/tap or Escape
  const outsideClick = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      dismiss();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') dismiss();
  };
  requestAnimationFrame(() => {
    document.addEventListener('pointerdown', outsideClick, true);
    document.addEventListener('keydown', onKey, true);
  });
}

function createMenuItem(label: string, onClick: () => void): HTMLElement {
  const item = document.createElement('div');
  item.className = 'sprinkle-picker__item';
  item.style.cssText =
    'padding: 6px 12px; cursor: pointer; font-size: 12px; color: var(--s2-content-default); ' +
    'border-radius: var(--s2-radius-s); margin: 0 4px; transition: background 130ms ease;';
  item.textContent = label;
  item.addEventListener('mouseenter', () => {
    item.style.background = 'var(--s2-bg-elevated)';
  });
  item.addEventListener('mouseleave', () => {
    item.style.background = '';
  });
  item.addEventListener('click', onClick);
  return item;
}
