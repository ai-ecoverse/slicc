import {
  type DockSpec,
  LAYOUT_SCHEMA_VERSION,
  type LayoutDocument,
  type LayoutVariant,
} from '@slicc/webcomponents';
import { PANEL_IDS } from './builtin-panels.js';

function narrowVariant(): LayoutVariant {
  return {
    when: { maxWidth: 700 },
    docks: [],
    zones: { center: [PANEL_IDS.chat] },
    floating: [],
  };
}

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

export const LAYOUT_DOCS: Record<string, LayoutDocument> = {
  default: DEFAULT_LAYOUT_DOC,
};

export const DEFAULT_LAYOUT_ID = 'default';

export function getLayoutDoc(name: string): LayoutDocument | null {
  return LAYOUT_DOCS[name] ?? null;
}

export function layoutDocNames(): string[] {
  return Object.keys(LAYOUT_DOCS);
}
