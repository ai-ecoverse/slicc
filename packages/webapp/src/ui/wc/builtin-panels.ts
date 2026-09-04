/**
 * Built-in panel definitions — the bridge between the components SLICC already
 * ships and the panel system that arranges them.
 *
 * ## Wrapping, not rewriting
 *
 * Each entry pairs a panel id with a factory that returns a `<slicc-panel>`
 * WRAPPING an existing element (`<slicc-chatpane>`, `<slicc-freezer>`,
 * `<slicc-dock>`, …) rather than converting those components into `SliccPanel`
 * subclasses. Two reasons, both practical:
 *
 *  1. `WcShellRefs` hands out those inner elements to five other modules
 *     (`wc-live`, `wc-nav`, `wc-sprinkles`, `wc-tray`, `wc-browser`), which call
 *     component-specific APIs on them. Wrapping keeps every one of those refs
 *     pointing at the same element it always did, so the migration is additive
 *     instead of a five-file rewrite.
 *  2. A component like `<slicc-dock>` is genuinely not a panel — it is a rail
 *     that happens to live in one. Making it extend `SliccPanel` would conflate
 *     "I am a dock rail" with "I am placeable", and the panel contract
 *     (visibility, lock, presentation) belongs to the placement, not the widget.
 *
 * The wrapper is where panel identity and metadata live; the inner element keeps
 * doing exactly what it did before.
 */

import { type PanelMeta, registerPanel, type SliccPanel } from '@slicc/webcomponents';

/** Panel ids the shell composes at boot. Exported so callers don't stringly-type them. */
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

/** Prefix for sprinkle-backed panel ids (mirrors `wc-sprinkles.ts`). */
export const SPRINKLE_PANEL_PREFIX = 'sprinkle:';

/** The `panelMeta` for every built-in, keyed by id. */
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
    // The rail is 44px collapsed / 260px open and drives that itself via its
    // `open` attribute, so the layout pins the collapsed width and lets the
    // component's own transition widen it.
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

/**
 * Wrap `inner` in a `<slicc-panel>` carrying `panelId`.
 *
 * The wrapper is a plain `<slicc-panel>` (not a subclass), so its metadata comes
 * from the `panel-id` attribute plus the registry rather than a static — which is
 * what lets one generic wrapper back every built-in and every sprinkle.
 */
export function wrapInPanel(panelId: string, inner: HTMLElement): SliccPanel {
  const panel = document.createElement('slicc-panel') as SliccPanel;
  panel.setAttribute('panel-id', panelId);
  const meta = BUILTIN_PANEL_META[panelId];
  if (meta?.title) panel.setAttribute('aria-label', meta.title);
  panel.appendChild(inner);
  return panel;
}

/**
 * Register every built-in panel in the registry so the add-panel menu can list
 * them and a layout document can reference them by id. Idempotent — the registry
 * replaces on a duplicate id, so a re-mount (HMR, a second shell in a test) is
 * harmless.
 *
 * `source.kind` is `element` with the generic `slicc-panel` tag because the
 * built-ins are wrapped rather than subclassed (see the module doc): the registry
 * entry describes the panel's identity, and `buildWcShellFrame` supplies the actual
 * instance.
 */
export function registerBuiltinPanels(): void {
  for (const meta of Object.values(BUILTIN_PANEL_META)) {
    registerPanel({ meta, source: { kind: 'element', tag: 'slicc-panel' }, origin: 'builtin' });
  }
}

/** A sprinkle's panel id. */
export function sprinklePanelId(name: string): string {
  return `${SPRINKLE_PANEL_PREFIX}${name}`;
}

/** The sprinkle name behind a panel id, or `null` when it isn't a sprinkle panel. */
export function sprinkleNameFromPanelId(id: string | null | undefined): string | null {
  if (!id?.startsWith(SPRINKLE_PANEL_PREFIX)) return null;
  const name = id.slice(SPRINKLE_PANEL_PREFIX.length);
  return name.length > 0 ? name : null;
}
