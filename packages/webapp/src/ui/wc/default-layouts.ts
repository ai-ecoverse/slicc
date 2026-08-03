/**
 * The shipped layout document.
 *
 * There is exactly ONE: `DEFAULT_LAYOUT_DOC`, the arrangement SLICC boots with. The
 * five other presets that used to live here (`split`, `dashboard`, `dev`, `stage`,
 * `glance`) are gone — canned arrangements are the user's to make and save, not the
 * app's to guess. `layout save <name>` and the panels menu cover that, and a skill
 * ships its own layout as a document (see `docs/layouts.md`).
 *
 * The plural API (`LAYOUT_DOCS`, `getLayoutDoc`, `layoutDocNames`) is kept rather
 * than collapsed to a constant, because the shipped set is a lookup namespace that
 * saved documents share and shadow — `layout load <name>` resolves against both.
 */

import {
  type DockSpec,
  LAYOUT_SCHEMA_VERSION,
  type LayoutDocument,
  type LayoutVariant,
} from '@slicc/webcomponents';
import { PANEL_IDS } from './builtin-panels.js';

/**
 * The narrow-viewport variant: below 700px the two rails are dropped and the
 * working area collapses to chat alone. What makes the extension side panel and a
 * phone-sized viewport usable.
 *
 * A factory rather than a shared constant so the document owns its own arrays —
 * `setLayout` clones, but a shared mutable array would still be a trap for anyone
 * editing it in place.
 */
function narrowVariant(): LayoutVariant {
  return {
    when: { maxWidth: 700 },
    docks: [],
    zones: { center: [PANEL_IDS.chat] },
    floating: [],
  };
}

/**
 * The three docks: top strip plus both rails.
 *
 * All three are `locked`. A rail is a fixed-width strip of icons and the top bar a
 * fixed-height row, so resizing or moving them can only produce a broken gap — they
 * are visible or not, and that is the whole of their configurability. Stating it in
 * the DOCUMENT (rather than only in the CSS that pins their size) means a saved or
 * Cherry-pushed layout carries the intent too.
 */
function standardDocks(): DockSpec[] {
  return [
    {
      edge: 'top',
      size: '36px',
      panels: [PANEL_IDS.scoopSwitcher, PANEL_IDS.floatbar],
      locked: true,
    },
    { edge: 'left', size: '44px', panels: [PANEL_IDS.sessionsRail], locked: true },
    { edge: 'right', size: '48px', panels: [PANEL_IDS.dockRail], locked: true },
  ];
}

/**
 * The arrangement SLICC boots with: the sessions rail on the left, the tool rail on
 * the right, a top strip carrying the scoop switcher and the floatbar, and chat
 * filling the center.
 *
 * Tool panels are absent — they start closed and open on demand into `right`, as
 * they always have.
 */
export const DEFAULT_LAYOUT_DOC: LayoutDocument = {
  version: LAYOUT_SCHEMA_VERSION,
  id: 'default',
  title: 'Default',
  base: {
    docks: standardDocks(),
    zones: { center: [PANEL_IDS.chat] },
  },
  variants: [narrowVariant()],
};

/** Every shipped document, keyed by id. One entry, by design — see the file note. */
export const LAYOUT_DOCS: Record<string, LayoutDocument> = {
  default: DEFAULT_LAYOUT_DOC,
};

/** The document loaded when nothing is persisted. */
export const DEFAULT_LAYOUT_ID = 'default';

/** Look up a shipped document by name. */
export function getLayoutDoc(name: string): LayoutDocument | null {
  return LAYOUT_DOCS[name] ?? null;
}

/** Shipped document names, for `layout list` and the panels menu. */
export function layoutDocNames(): string[] {
  return Object.keys(LAYOUT_DOCS);
}
