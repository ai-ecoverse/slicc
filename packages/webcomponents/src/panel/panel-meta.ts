export type PanelSize = string | number;

export type PanelPresentation = 'docked' | 'floating';

export type PanelAnchor = 'top' | 'right' | 'bottom' | 'left' | 'center';

const PANEL_ANCHORS: readonly PanelAnchor[] = ['top', 'right', 'bottom', 'left', 'center'];

export function isPanelAnchor(value: string | null): value is PanelAnchor {
  return value != null && (PANEL_ANCHORS as readonly string[]).includes(value);
}

export interface PanelMeta {
  id: string;

  title: string;

  icon?: string;

  minWidth?: number;
  minHeight?: number;

  preferredSize?: PanelSize;

  presentation?: PanelPresentation;

  anchor?: PanelAnchor;

  realm?: 'main' | 'sandboxed';
}

export function panelMetaOf(ctor: unknown): PanelMeta | undefined {
  const meta = (ctor as { panelMeta?: PanelMeta } | null | undefined)?.panelMeta;
  return meta && typeof meta.id === 'string' ? meta : undefined;
}
