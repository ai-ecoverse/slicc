import { type CommandId, commandForSurfaceId, isCommandId } from './wc-shortcuts.js';

export interface UsageEntry {
  id: CommandId;
  count: number;
}

export interface ShortcutUsage {
  record(id: CommandId): void;

  used(id: CommandId): boolean;

  ranked(): UsageEntry[];
  dispose(): void;
}

const DOCK_SELECT = 'slicc-dock-select';
const FREEZER_TOGGLE = 'freezer-toggle';

function selectedSurfaceId(event: Event): string | null {
  const detail = (event as CustomEvent<{ id?: unknown }>).detail;
  return typeof detail?.id === 'string' ? detail.id : null;
}

export function createShortcutUsage(doc: Document): ShortcutUsage {
  const counts = new Map<CommandId, number>();

  const lastAt = new Map<CommandId, number>();
  let tick = 0;

  const count = (id: CommandId): void => {
    if (!isCommandId(id)) return;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    tick += 1;
    lastAt.set(id, tick);
  };

  let keyedTurn = false;

  const record = (id: CommandId): void => {
    count(id);
    if (keyedTurn) return;
    keyedTurn = true;
    queueMicrotask(() => {
      keyedTurn = false;
    });
  };

  const fromSurface = (id: CommandId): void => {
    if (keyedTurn) return;
    count(id);
  };

  const onDockSelect = (event: Event): void => {
    const surfaceId = selectedSurfaceId(event);
    if (surfaceId === null) return;
    const id = commandForSurfaceId(surfaceId);

    fromSurface(id ?? 'sprinkles');
  };
  const onFreezerToggle = (): void => fromSurface('leftRail');

  doc.addEventListener(DOCK_SELECT, onDockSelect, true);
  doc.addEventListener(FREEZER_TOGGLE, onFreezerToggle, true);

  return {
    record,
    used: (id) => counts.has(id),
    ranked: () =>
      [...counts.entries()]
        .map(([id, count]) => ({ id, count }))
        .sort((a, b) => b.count - a.count || (lastAt.get(b.id) ?? 0) - (lastAt.get(a.id) ?? 0)),
    dispose: () => {
      doc.removeEventListener(DOCK_SELECT, onDockSelect, true);
      doc.removeEventListener(FREEZER_TOGGLE, onFreezerToggle, true);
      counts.clear();
      lastAt.clear();
    },
  };
}
