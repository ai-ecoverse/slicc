import { type PanelMeta, registerPanel, type SliccPanel } from '@slicc/webcomponents';

export const PANEL_IDS = {
  chat: 'chat',
  sessionsRail: 'sessions-rail',
  dockRail: 'dock-rail',
  scoopSwitcher: 'scoop-switcher',
  floatbar: 'floatbar',
  files: 'files',
  term: 'term',
  memory: 'memory',
  monitor: 'monitor',
  browser: 'browser',
} as const;

export const SPRINKLE_PANEL_PREFIX = 'sprinkle:';

export const BUILTIN_PANEL_META: Record<string, PanelMeta> = {
  [PANEL_IDS.chat]: {
    id: PANEL_IDS.chat,
    title: 'Chat',
    icon: 'message-circle',
    minWidth: 320,
    preferredSize: 3,
  },
  [PANEL_IDS.sessionsRail]: {
    id: PANEL_IDS.sessionsRail,
    title: 'Sessions',
    icon: 'history',

    preferredSize: '44px',
  },
  [PANEL_IDS.dockRail]: {
    id: PANEL_IDS.dockRail,
    title: 'Dock',
    icon: 'layout-grid',
    preferredSize: '48px',
  },
  [PANEL_IDS.scoopSwitcher]: {
    id: PANEL_IDS.scoopSwitcher,
    title: 'Scoops',
    icon: 'users',
  },
  [PANEL_IDS.floatbar]: {
    id: PANEL_IDS.floatbar,
    title: 'Runtime',
    icon: 'activity',
  },
  [PANEL_IDS.files]: { id: PANEL_IDS.files, title: 'Files', icon: 'folder', minWidth: 220 },
  [PANEL_IDS.term]: { id: PANEL_IDS.term, title: 'Terminal', icon: 'square-terminal' },
  [PANEL_IDS.memory]: { id: PANEL_IDS.memory, title: 'Memory', icon: 'brain' },
  [PANEL_IDS.monitor]: { id: PANEL_IDS.monitor, title: 'Monitor', icon: 'activity' },
  [PANEL_IDS.browser]: { id: PANEL_IDS.browser, title: 'Browser', icon: 'globe' },
};

export function wrapInPanel(panelId: string, inner: HTMLElement): SliccPanel {
  const panel = document.createElement('slicc-panel') as SliccPanel;
  panel.setAttribute('panel-id', panelId);
  const meta = BUILTIN_PANEL_META[panelId];
  if (meta?.title) panel.setAttribute('aria-label', meta.title);
  panel.appendChild(inner);
  return panel;
}

export function registerBuiltinPanels(): void {
  for (const meta of Object.values(BUILTIN_PANEL_META)) {
    registerPanel({ meta, source: { kind: 'element', tag: 'slicc-panel' }, origin: 'builtin' });
  }
}

export function sprinklePanelId(name: string): string {
  return `${SPRINKLE_PANEL_PREFIX}${name}`;
}

export function sprinkleNameFromPanelId(id: string | null | undefined): string | null {
  if (!id?.startsWith(SPRINKLE_PANEL_PREFIX)) return null;
  const name = id.slice(SPRINKLE_PANEL_PREFIX.length);
  return name.length > 0 ? name : null;
}
