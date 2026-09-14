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

  '.slicc-addpanel__item{position:relative;}',
  '.slicc-addpanel__del{margin-left:auto;flex:0 0 auto;display:grid;place-items:center;',
  'width:18px;height:18px;padding:0;border:none;border-radius:4px;background:transparent;',
  'color:var(--ink);opacity:0;cursor:pointer;}',
  '.slicc-addpanel__item:hover .slicc-addpanel__del{opacity:0.65;}',
  '.slicc-addpanel__del:hover{opacity:1;background:var(--ghost);}',
  '.slicc-addpanel__del:focus-visible{opacity:1;}',
].join('');

const NATIVE_PROMPT: ((message?: string, defaultValue?: string) => string | null) | undefined =
  typeof globalThis.prompt === 'function' ? globalThis.prompt.bind(globalThis) : undefined;

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

  onToggle: (panelId: string, visible: boolean) => void;

  onLoadLayout: (name: string) => void;

  onSaveLayout: (name: string) => void;

  onDeleteLayout: (name: string) => void;

  listLayoutNames: () => Promise<{ saved: string[]; presets: string[] }>;

  promptForName?: (message: string, initial: string) => string | null;
}

export function createAddPanelMenu(deps: AddPanelMenuDeps): HTMLElement {
  ensureMenuStyles(document);

  const root = document.createElement('div');
  root.className = 'slicc-addpanel';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'slicc-addpanel__btn';
  button.title = 'Panels and layouts';
  button.setAttribute('aria-label', 'Panels and layouts');

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

  function saveCurrent(): void {
    const ask = deps.promptForName ?? NATIVE_PROMPT;

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

      for (const name of saved) {
        children.push(savedItem(name));
      }
      for (const name of presets) {
        children.push(item(name, false, () => deps.onLoadLayout(name)));
      }
      children.push(item('Save layout as…', false, saveCurrent));
    } catch (err) {
      log.warn('could not list layouts for the menu', { error: err });
    }

    menu.replaceChildren(...children);
  }

  function close(): void {
    menu.removeAttribute('open');
    document.removeEventListener('pointerdown', onDocPointerDown, true);
  }

  const onDocPointerDown = (event: Event): void => {
    if (!root.contains(event.target as Node)) close();
  };

  button.addEventListener('click', () => {
    if (menu.hasAttribute('open')) {
      close();
      return;
    }

    void render().then(() => {
      menu.setAttribute('open', '');
      document.addEventListener('pointerdown', onDocPointerDown, true);
    });
  });

  panelRegistryEvents.addEventListener('panel-registry-change', () => {
    if (menu.hasAttribute('open')) void render();
  });

  root.append(button, menu);
  return root;
}
