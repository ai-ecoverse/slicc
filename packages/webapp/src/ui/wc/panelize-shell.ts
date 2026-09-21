import type { LayoutDocument, SliccLayout, SliccPanel } from '@slicc/webcomponents';
import { parseLayoutDocument } from '@slicc/webcomponents/panel/layout-schema';
import { registerPanel, unregisterPanel } from '@slicc/webcomponents/panel/registry';
import { createLogger } from '../../base/logger.js';
import type { VirtualFS } from '../../fs/index.js';
import { createAddPanelMenu } from './add-panel-menu.js';
import { applyLayoutDoc, isLayoutDocMsg } from './apply-layout-doc.js';
import {
  PANEL_IDS,
  registerBuiltinPanels,
  sprinkleNameFromPanelId,
  wrapInPanel,
} from './builtin-panels.js';
import { DEFAULT_LAYOUT_DOC, layoutDocNames } from './default-layouts.js';
import { setLayoutApplier } from './layout-apply-registry.js';
import { listLayouts } from './layout-store.js';
import { setPanelVisible } from './panel-visibility.js';
import { mountTrusted } from './trusted-layer.js';
import type { WcShellRefs } from './wc-shell.js';

const log = createLogger('panelize-shell');

const STYLE_ID = 'slicc-panelize-style';
const CSS = [
  '.wcui-avatar-strip{position:absolute;top:0;right:0;height:var(--barh,36px);',

  'display:flex;align-items:center;gap:12px;padding:0 9px 0 14px;box-sizing:border-box;',
  'pointer-events:auto;z-index:1;}',

  '.wcui-frame slicc-layout{position:relative;z-index:1;}',

  'slicc-layout .slicc-layout__dock--left,slicc-layout .slicc-layout__dock--right{flex:0 0 auto;}',
  'slicc-layout .slicc-layout__dock--top,slicc-layout .slicc-layout__dock--bottom{flex:0 0 auto;}',

  'slicc-layout .slicc-layout__dock--left{flex:0 0 auto!important;width:auto!important;}',
  'slicc-layout .slicc-layout__dock--right{flex:0 0 auto!important;width:auto!important;}',
  'slicc-panel[panel-id="sessions-rail"],slicc-panel[panel-id="dock-rail"]{',
  'flex:0 0 auto;height:100%;align-self:stretch;overflow:hidden;}',
  'slicc-panel[panel-id="dock-rail"]{width:48px;}',

  'slicc-panel[panel-id="sessions-rail"]{width:auto;}',

  'slicc-panel[panel-id="sessions-rail"]>*,slicc-panel[panel-id="dock-rail"]>*{',
  'height:100%;flex:1 1 auto;min-height:0;}',

  'slicc-panel[panel-id="scoop-switcher"],slicc-panel[panel-id="floatbar"]{',
  'height:var(--barh,36px);min-height:var(--barh,36px);max-height:var(--barh,36px);}',

  'slicc-panel[panel-id="chat"] slicc-chatpane{flex:1 1 0;width:100%;min-height:0;}',

  'slicc-panel[panel-id="chat"] slicc-chat-thread{flex:1 1 0;min-height:0;overflow-y:auto;}',

  'slicc-panel[panel-id="chat"] slicc-composer{flex:0 0 auto;}',

  'slicc-panel[panel-id="scoop-switcher"]{flex:0 0 auto;justify-content:center;padding-left:14px;}',
  'slicc-panel[panel-id="floatbar"]{flex:1 1 auto;align-items:center;justify-content:flex-end;',

  'padding-right:var(--avatar-strip-w, 96px);}',
  'slicc-panel[panel-id="scoop-switcher"],slicc-panel[panel-id="floatbar"]{flex-direction:row;}',

  'slicc-panel[panel-id="term"][presentation="floating"]{',
  'background:var(--term-bg,#0c0c0e);border-color:var(--term-border,#232329);',
  'box-shadow:rgba(0,0,0,.35) 0 14px 36px -12px,rgba(0,0,0,.2) 0 4px 10px -4px;}',
].join('');

function ensurePanelizeStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function activateSurface(surface: HTMLElement): void {
  surface.setAttribute('active', '');
  surface.style.display = 'flex';
  surface.style.flexDirection = 'column';
  surface.style.position = 'relative';
  surface.style.inset = 'auto';
  surface.style.flex = '1 1 auto';
  surface.style.minHeight = '0';
}

const TOOL_PANEL_IDS: ReadonlySet<string> = new Set<string>([
  PANEL_IDS.files,
  PANEL_IDS.term,
  PANEL_IDS.memory,
  PANEL_IDS.monitor,
  PANEL_IDS.browser,
]);

function wireDockRailToLayout(
  dock: HTMLElement,
  layout: SliccLayout,
  overlaySurfaces: ReadonlySet<string>,
  hooks?: {
    onToolPanelActivate?: (id: string) => void;
    onToolPanelDeactivate?: (id: string) => void;
  }
): void {
  const handle = (event: Event, visible: boolean): void => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id || !TOOL_PANEL_IDS.has(id)) return;

    if (overlaySurfaces.has(id)) return;
    event.stopImmediatePropagation();
    setPanelVisible(layout, id, visible);
    if (visible) hooks?.onToolPanelActivate?.(id);
    else hooks?.onToolPanelDeactivate?.(id);
  };
  dock.addEventListener('slicc-dock-select', (e) => handle(e, true), true);
  dock.addEventListener('slicc-dock-collapse', (e) => handle(e, false), true);
}

function sprinkleHostHooks(
  layout: SliccLayout,
  panels: Map<string, SliccPanel>
): Pick<PanelizedShell, 'hostSprinkleSurface' | 'removeSprinkleSurface'> {
  return {
    hostSprinkleSurface: (surfaceId, surface) => {
      const panel = wrapInPanel(surfaceId, surface);

      activateSurface(surface);
      panels.set(surfaceId, panel);
      layout.appendChild(panel);
      registerPanel({
        meta: { id: surfaceId, title: sprinkleNameFromPanelId(surfaceId) ?? surfaceId },
        source: { kind: 'element', tag: 'slicc-panel' },
        origin: 'sprinkle',
      });
      setPanelVisible(layout, surfaceId, true);
      log.info('sprinkle panel hosted', { surfaceId });
    },
    removeSprinkleSurface: (surfaceId) => {
      panels.get(surfaceId)?.remove();
      panels.delete(surfaceId);
      unregisterPanel(surfaceId);
      const next = layout.getLayout();
      next.panels = { ...next.panels, [surfaceId]: { visible: false } };
      layout.setLayout(next);
    },
  };
}

export const PANEL_LAYOUT_STORAGE_KEY = 'slicc-panel-layout:default';

function wireLayoutPersistence(layout: SliccLayout, doc: LayoutDocument): void {
  layout.addEventListener('slicc-layout-change', (event) => {
    const reason = event.detail?.reason;
    if (reason !== 'rearrange' && reason !== 'resize') return;
    try {
      localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(layout.getLayout()));
    } catch {}
  });

  let restored: LayoutDocument | null = null;
  try {
    const raw = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = parseLayoutDocument(JSON.parse(raw));

      if ('error' in parsed) {
        log.warn('stored layout rejected — using the default', { error: parsed.error });
      } else {
        restored = parsed;
      }
    }
  } catch (err) {
    log.warn('stored layout unreadable — using the default', err);
  }
  layout.setLayout(restored ?? doc);
}

export interface PanelizedShell {
  layout: SliccLayout;

  avatarStrip: HTMLElement;

  panels: Map<string, SliccPanel>;

  attachFs: (fs: VirtualFS) => void;

  hostSprinkleSurface: (surfaceId: string, surface: HTMLElement) => void;

  removeSprinkleSurface: (surfaceId: string) => void;
}

let current: PanelizedShell | null = null;

export function getPanelizedShell(): PanelizedShell | null {
  return current;
}

export function panelizeShell(
  refs: WcShellRefs,
  doc: LayoutDocument = DEFAULT_LAYOUT_DOC,

  initialFs?: VirtualFS,

  hooks?: {
    onToolPanelActivate?: (id: string) => void;
    onToolPanelDeactivate?: (id: string) => void;
  }
): PanelizedShell | null {
  if (refs.frame.dataset.sliccPanelized === '1') {
    log.warn('panelizeShell called twice — ignoring the second call');
    return null;
  }
  ensurePanelizeStyles(document);
  registerBuiltinPanels();

  let fs: VirtualFS | undefined = initialFs;

  const layout = document.createElement('slicc-layout') as SliccLayout;
  const panels = new Map<string, SliccPanel>();

  const add = (id: string, inner: HTMLElement | null | undefined): void => {
    if (!inner) return;
    const panel = wrapInPanel(id, inner);
    panels.set(id, panel);
    layout.appendChild(panel);
  };

  refs.freezer.setAttribute('docked', '');

  const appCol = refs.frame.querySelector('.wcui-appcol') as HTMLElement | null;
  appCol?.style.setProperty('--rail-w', '0px');

  add(PANEL_IDS.scoopSwitcher, refs.switcher);
  add(PANEL_IDS.floatbar, refs.floatbar);
  add(PANEL_IDS.sessionsRail, refs.freezer);
  add(PANEL_IDS.dockRail, refs.dock);
  add(PANEL_IDS.chat, refs.chatPane);

  for (const id of [
    PANEL_IDS.files,
    PANEL_IDS.term,
    PANEL_IDS.memory,
    PANEL_IDS.monitor,
    PANEL_IDS.browser,
  ]) {
    const surface = refs.dockTree.querySelector(`slicc-surface[surface-id="${id}"]`);
    if (!(surface instanceof HTMLElement)) continue;
    activateSurface(surface);
    add(id, surface);
  }

  const avatarStrip = document.createElement('div');
  avatarStrip.className = 'wcui-avatar-strip';

  avatarStrip.appendChild(
    createAddPanelMenu({
      layout,
      onToggle: (panelId, visible) => {
        void applyLayoutDoc(
          { layout, fs },
          {
            kind: visible ? 'show' : 'hide',
            panelId,
          }
        );
      },
      onLoadLayout: (name) => {
        void applyLayoutDoc({ layout, fs }, { kind: 'load', name });
      },

      onSaveLayout: (name) => {
        void applyLayoutDoc({ layout, fs }, { kind: 'save', name, protected: false }).then(
          (result) => {
            if (result.error) log.warn('layout save failed', { name, error: result.error });
            else log.info('layout saved', { name, output: result.output });
          }
        );
      },
      onDeleteLayout: (name) => {
        void applyLayoutDoc({ layout, fs }, { kind: 'delete', name });
      },
      listLayoutNames: async () => ({
        saved: fs ? (await listLayouts(fs)).map((entry) => entry.name) : [],
        presets: layoutDocNames(),
      }),
    })
  );
  avatarStrip.appendChild(refs.avatarMenu);
  mountTrusted(avatarStrip, document);

  const shellRow = refs.shell;
  shellRow.replaceWith(layout);

  refs.frame.querySelector('slicc-nav')?.remove();

  wireLayoutPersistence(layout, doc);

  wireDockRailToLayout(refs.dock, layout, refs.overlaySurfaces, hooks);

  setLayoutApplier((msg) => {
    if (isLayoutDocMsg(msg)) return applyLayoutDoc({ layout, fs }, msg);

    return {
      applied: false,
      error: `"${msg.kind}" targets the old dock-tree; with panels use: load, save, show, hide, docs, panels`,
    };
  });

  refs.frame.dataset.sliccPanelized = '1';
  log.info('shell panelized', { panels: panels.size, layout: doc.id });

  const handle: PanelizedShell = {
    layout,
    avatarStrip,
    panels,
    attachFs: (next) => {
      fs = next;
      log.info('layout store attached');
    },
    ...sprinkleHostHooks(layout, panels),
  };
  current = handle;
  return handle;
}
