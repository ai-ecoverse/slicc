/**
 * `add-panel-menu.ts` — the "add UI component" affordance on the fixed avatar
 * strip.
 *
 * Lists every registered panel (built-in, sprinkle, agent-authored) with a
 * checkmark for the ones currently placed, so one menu both adds and removes.
 * Below that, the saved layouts and shipped presets.
 *
 * It lives in the trusted layer alongside the avatar (H2), which is why it is
 * built here rather than as a panel: it must stay reachable and unspoofable even
 * when the layout is locked or a panel is misbehaving.
 *
 * The menu re-reads the registry on every open rather than caching, because
 * sprinkle discovery is VFS-backed and kernel-gated — the panel list routinely
 * grows after first paint, and a cached menu would show a stale set.
 */

import { listPanels, panelRegistryEvents, type SliccLayout } from '@slicc/webcomponents';
import { iconSvg } from '@slicc/webcomponents/icons';
import { createLogger } from '../../base/logger.js';

const log = createLogger('add-panel-menu');

const STYLE_ID = 'slicc-add-panel-menu-style';
const CSS = [
  '.slicc-addpanel{position:relative;}',
  '.slicc-addpanel__btn{width:26px;height:26px;display:grid;place-items:center;',
  'border:1px solid var(--line);border-radius:7px;background:var(--canvas);',
  'color:var(--txt-2);cursor:pointer;padding:0;font-size:15px;line-height:1;}',
  '.slicc-addpanel__btn:hover{background:var(--ghost);color:var(--ink);}',
  '.slicc-addpanel__menu{position:absolute;top:32px;right:0;min-width:230px;',
  'max-height:70vh;overflow:auto;background:var(--canvas);border:1px solid var(--line);',
  'border-radius:10px;box-shadow:var(--shadow-pane);padding:6px;display:none;',
  'font-family:var(--ui);font-size:12.5px;}',
  '.slicc-addpanel__menu[open]{display:block;}',
  '.slicc-addpanel__group{padding:6px 8px 2px;color:var(--txt-3);font-size:10.5px;',
  'text-transform:uppercase;letter-spacing:.04em;}',
  '.slicc-addpanel__item{width:100%;display:flex;align-items:center;gap:8px;',
  'padding:6px 8px;border:none;background:none;border-radius:6px;cursor:pointer;',
  'color:var(--ink);text-align:left;font:inherit;}',
  '.slicc-addpanel__item:hover{background:var(--ghost);}',
  '.slicc-addpanel__check{width:12px;flex:0 0 12px;color:var(--accent);}',
  '.slicc-addpanel__sep{height:1px;background:var(--line);margin:5px 4px;}',
  // The delete button rides in the row, revealed on hover so the list stays calm
  // and a destructive control is never the first thing the eye lands on.
  '.slicc-addpanel__item{position:relative;}',
  '.slicc-addpanel__del{margin-left:auto;flex:0 0 auto;display:grid;place-items:center;',
  'width:18px;height:18px;padding:0;border:none;border-radius:4px;background:transparent;',
  'color:var(--ink);opacity:0;cursor:pointer;}',
  '.slicc-addpanel__item:hover .slicc-addpanel__del{opacity:0.65;}',
  '.slicc-addpanel__del:hover{opacity:1;background:var(--ghost);}',
  '.slicc-addpanel__del:focus-visible{opacity:1;}',
].join('');

/**
 * The native `prompt`, captured at module init.
 *
 * Same reasoning as `sudo/panel-responder.ts`: page-realm code (a sprinkle, an
 * agent-authored panel) can reassign `globalThis.prompt`, and this one names a file
 * that gets written. Binding the real function now means a later reassignment cannot
 * intercept the name — and when there is no `prompt` at all (a worker, a test
 * environment), saving declines rather than writing under a guessed name.
 */
const NATIVE_PROMPT: ((message?: string, defaultValue?: string) => string | null) | undefined =
  typeof globalThis.prompt === 'function' ? globalThis.prompt.bind(globalThis) : undefined;

/**
 * Reduce a user-supplied layout name to something safe as a filename.
 *
 * Path separators and traversal are the reason this exists rather than trusting the
 * string: the name becomes `/workspace/layouts/<name>.json`, so `../../etc/sudoers`
 * would otherwise escape the layouts directory entirely. Anything outside the
 * allowlist collapses to `-`.
 */
export function sanitizeLayoutName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}

function ensureMenuStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export interface AddPanelMenuDeps {
  layout: SliccLayout;
  /** Toggle a panel's visibility — routed through the document, not the element. */
  onToggle: (panelId: string, visible: boolean) => void;
  /** Load a named layout (saved document or shipped preset). */
  onLoadLayout: (name: string) => void;
  /** Save the current arrangement under `name`, as JSON in the VFS. */
  onSaveLayout: (name: string) => void;
  /** Delete a saved layout. Presets are not deletable. */
  onDeleteLayout: (name: string) => void;
  /** Saved layout names + preset names, re-read whenever the menu opens. */
  listLayoutNames: () => Promise<{ saved: string[]; presets: string[] }>;
  /**
   * Ask the user for a layout name. Injectable so tests don't block on a dialog,
   * and captured from `globalThis` at module init for the same reason
   * `panel-responder.ts` does it: page-realm code can reassign `window.prompt`,
   * and this writes a file.
   */
  promptForName?: (message: string, initial: string) => string | null;
}

/**
 * Build the add-panel control. The caller appends the returned element into the
 * avatar strip.
 */
export function createAddPanelMenu(deps: AddPanelMenuDeps): HTMLElement {
  ensureMenuStyles(document);

  const root = document.createElement('div');
  root.className = 'slicc-addpanel';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'slicc-addpanel__btn';
  button.title = 'Panels and layouts';
  button.setAttribute('aria-label', 'Panels and layouts');
  // A `layout-dashboard` glyph rather than a bare `+`: this menu both ADDS and
  // REMOVES panels and switches layouts, so "plus" described a third of it and
  // read as a generic "new" button next to the unrelated cost pill.
  // `iconSvg` returns markup, so parse it rather than assigning innerHTML (the
  // repo's no-innerHTML gate).
  const glyph = new DOMParser().parseFromString(
    iconSvg('layout-dashboard', { size: 14 }),
    'image/svg+xml'
  ).documentElement;
  button.appendChild(glyph);

  const menu = document.createElement('div');
  menu.className = 'slicc-addpanel__menu';
  menu.setAttribute('role', 'menu');

  const item = (label: string, checked: boolean, onClick: () => void): HTMLElement => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'slicc-addpanel__item';
    row.setAttribute('role', 'menuitem');
    const check = document.createElement('span');
    check.className = 'slicc-addpanel__check';
    check.textContent = checked ? '✓' : '';
    const text = document.createElement('span');
    text.textContent = label;
    row.append(check, text);
    row.addEventListener('click', () => {
      onClick();
      close();
    });
    return row;
  };

  /**
   * A saved layout's row: click to load, plus a delete affordance.
   *
   * The delete button lives inside the row rather than in a separate mode, and
   * stops propagation so it cannot also trigger the load underneath it.
   */
  const savedItem = (name: string): HTMLElement => {
    const row = item(name, false, () => deps.onLoadLayout(name));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'slicc-addpanel__del';
    del.title = `Delete "${name}"`;
    del.setAttribute('aria-label', `Delete layout ${name}`);
    del.appendChild(
      new DOMParser().parseFromString(iconSvg('trash-2', { size: 11 }), 'image/svg+xml')
        .documentElement
    );
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deps.onDeleteLayout(name);
      close();
    });
    row.appendChild(del);
    return row;
  };

  /** Prompt for a name and save the current arrangement under it. */
  function saveCurrent(): void {
    const ask = deps.promptForName ?? NATIVE_PROMPT;
    // No prompt available (worker, headless) → decline rather than inventing a name
    // and silently writing a file the user never asked for.
    if (!ask) {
      log.warn('cannot save a layout: no prompt available');
      return;
    }
    const raw = ask('Save this layout as:', deps.layout.getLayout().id);
    if (raw === null) return;
    const name = sanitizeLayoutName(raw);
    if (!name) {
      log.warn('layout not saved: the name reduced to nothing', { raw });
      return;
    }
    deps.onSaveLayout(name);
  }

  const group = (label: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'slicc-addpanel__group';
    el.textContent = label;
    return el;
  };

  async function render(): Promise<void> {
    const placed = new Set(deps.layout.getPlacedPanelIds());
    const children: HTMLElement[] = [];

    const byOrigin: Record<string, typeof entries> = {};
    const entries = listPanels();
    for (const entry of entries) (byOrigin[entry.origin] ??= []).push(entry);

    for (const [origin, label] of [
      ['builtin', 'Panels'],
      ['sprinkle', 'Sprinkles'],
      ['agent', 'Made by SLICC'],
    ] as const) {
      const groupEntries = byOrigin[origin];
      if (!groupEntries?.length) continue;
      children.push(group(label));
      for (const entry of groupEntries) {
        const isPlaced = placed.has(entry.meta.id);
        children.push(
          item(entry.meta.title, isPlaced, () => deps.onToggle(entry.meta.id, !isPlaced))
        );
      }
    }

    try {
      const { saved, presets } = await deps.listLayoutNames();
      const sep = document.createElement('div');
      sep.className = 'slicc-addpanel__sep';
      children.push(sep, group('Layouts'));
      // Saved documents first and marked deletable; presets are read-only and
      // always available, which is why this group renders even with nothing saved.
      for (const name of saved) {
        children.push(savedItem(name));
      }
      for (const name of presets) {
        children.push(item(name, false, () => deps.onLoadLayout(name)));
      }
      children.push(item('Save layout as…', false, saveCurrent));
    } catch (err) {
      // A failed layout listing must not blank the panel list above it — the
      // panel toggles are the primary function of this menu.
      log.warn('could not list layouts for the menu', { error: err });
    }

    menu.replaceChildren(...children);
  }

  function close(): void {
    menu.removeAttribute('open');
    document.removeEventListener('pointerdown', onDocPointerDown, true);
  }

  /** Close on any click outside — capture phase, so a panel can't swallow it. */
  const onDocPointerDown = (event: Event): void => {
    if (!root.contains(event.target as Node)) close();
  };

  button.addEventListener('click', () => {
    if (menu.hasAttribute('open')) {
      close();
      return;
    }
    // Re-read on every open: sprinkle discovery is kernel-gated and lands late,
    // so a cached list would be stale.
    void render().then(() => {
      menu.setAttribute('open', '');
      document.addEventListener('pointerdown', onDocPointerDown, true);
    });
  });

  // Keep an OPEN menu current when a panel registers mid-session (the agent
  // authoring one, discovery completing).
  panelRegistryEvents.addEventListener('panel-registry-change', () => {
    if (menu.hasAttribute('open')) void render();
  });

  root.append(button, menu);
  return root;
}
