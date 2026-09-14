export type DockZoneName = 'top' | 'left' | 'middle' | 'right' | 'bottom';

export interface DockTreeSpecLike {
  zones: Record<DockZoneName, unknown>;
  rowFr: { top: number; center: number; bottom: number };
  colFr: { left: number; middle: number; right: number };
}

export interface SurfaceSizeSpecLike {
  widthPx?: number;
  widthPercent?: number;
  heightPx?: number;
  heightPercent?: number;
}

export type DockNodeLike =
  | { type: 'leaf'; surfaceId: string; locked?: boolean }
  | {
      type: 'split';
      dir: 'row' | 'col';
      children: DockNodeLike[];
      sizes: number[];
      locked?: boolean;
    };

export interface NamedDockTreeSpec {
  name: string;
  tree: DockTreeSpecLike;
}

export const DEFAULT_LAYOUT = 'focus';

const CHAT_LEAF: DockNodeLike = { type: 'leaf', surfaceId: 'chat' };

function tree(
  zones: Partial<Record<DockZoneName, DockNodeLike | null>>,
  colFr: Partial<{ left: number; middle: number; right: number }> = {},
  rowFr: Partial<{ top: number; center: number; bottom: number }> = {}
): DockTreeSpecLike {
  return {
    zones: {
      top: null,
      left: null,
      middle: null,
      right: null,
      bottom: null,
      ...zones,
    } as Record<DockZoneName, unknown>,
    rowFr: { top: 1, center: 1, bottom: 1, ...rowFr },
    colFr: { left: 1, middle: 1, right: 1, ...colFr },
  };
}

export const LAYOUT_PRESETS: Record<string, NamedDockTreeSpec> = {
  focus: {
    name: 'focus',
    tree: tree({ left: CHAT_LEAF }, { left: 3, middle: 1 }),
  },
};

export function getPreset(name: string): NamedDockTreeSpec | null {
  return LAYOUT_PRESETS[name] ?? null;
}
