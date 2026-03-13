/**
 * Panel Picker — popup menu shown on [+] click.
 * Lists closed panels from the registry + available (unopened) SHTML panels.
 * Selecting one opens it in the zone that triggered the picker.
 */

import type { PanelRegistry } from './panel-registry.js';
import type { ZoneId } from './panel-types.js';

export interface PanelPickerCallbacks {
  /** Called when a registered (closed) panel is selected. */
  onSelectPanel(id: string, zone: ZoneId): void;
  /** Called when an SHTML panel (not yet opened) is selected. */
  onSelectShtml(name: string, zone: ZoneId): void;
}

export interface PanelPickerOptions {
  registry: PanelRegistry;
  callbacks: PanelPickerCallbacks;
  /** Return available SHTML panels that are not yet open. */
  getAvailableShtml?: () => Array<{ name: string; title: string }>;
}

/**
 * Show a panel picker popup anchored to a button element.
 * Closes itself on selection or outside click.
 */
export function showPanelPicker(
  anchor: HTMLElement,
  zone: ZoneId,
  options: PanelPickerOptions,
): void {
  // Remove any existing picker
  const existing = document.querySelector('.panel-picker');
  if (existing) existing.remove();

  const { registry, callbacks, getAvailableShtml } = options;

  const closedPanels = registry.getClosed();
  const shtmlPanels = getAvailableShtml?.() ?? [];

  if (closedPanels.length === 0 && shtmlPanels.length === 0) {
    return; // Nothing to show
  }

  const menu = document.createElement('div');
  menu.className = 'panel-picker';
  menu.style.cssText =
    'position: absolute; min-width: 160px; max-height: 300px; ' +
    'overflow-y: auto; background: var(--s2-bg-layer-2); border: 1px solid var(--s2-border-default); ' +
    'border-radius: var(--s2-radius-l); padding: 4px 0; box-shadow: var(--s2-shadow-elevated); z-index: 1000;';

  const dismiss = () => {
    menu.remove();
    document.removeEventListener('click', outsideClick);
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
  if (closedPanels.length > 0 && shtmlPanels.length > 0) {
    const sep = document.createElement('div');
    sep.style.cssText = 'height: 1px; background: var(--s2-border-default); margin: 4px 0;';
    menu.appendChild(sep);
  }

  // Available SHTML panels
  for (const panel of shtmlPanels) {
    const item = createMenuItem(panel.title, () => {
      callbacks.onSelectShtml(panel.name, zone);
      dismiss();
    });
    menu.appendChild(item);
  }

  // Position relative to anchor
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;

  document.body.appendChild(menu);

  // Close on outside click (deferred to avoid catching the triggering click)
  const outsideClick = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) {
      dismiss();
    }
  };
  requestAnimationFrame(() => {
    document.addEventListener('click', outsideClick);
  });
}

function createMenuItem(label: string, onClick: () => void): HTMLElement {
  const item = document.createElement('div');
  item.className = 'panel-picker__item';
  item.style.cssText =
    'padding: 6px 12px; cursor: pointer; font-size: 12px; color: var(--s2-content-default); ' +
    'border-radius: var(--s2-radius-s); margin: 0 4px; transition: background 130ms ease;';
  item.textContent = label;
  item.addEventListener('mouseenter', () => { item.style.background = 'var(--s2-bg-elevated)'; });
  item.addEventListener('mouseleave', () => { item.style.background = ''; });
  item.addEventListener('click', onClick);
  return item;
}
