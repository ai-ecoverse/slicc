import type { SprinkleInstance } from './sprinkle-manager-handle.js';

export const LEADER_RUNTIME_ID = 'leader';

const SPRINKLE_INSTANCES_STORAGE_KEY = 'slicc.leaderSprinkleInstances';

let instancesGetter: (() => SprinkleInstance[]) | null = null;

export function setFollowerSprinkleInstancesGetter(
  getter: (() => SprinkleInstance[]) | null
): void {
  instancesGetter = getter;
}

export function getFollowerSprinkleInstances(): SprinkleInstance[] {
  if (instancesGetter) {
    try {
      return instancesGetter();
    } catch {}
  }
  try {
    const stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(
      SPRINKLE_INSTANCES_STORAGE_KEY
    );
    if (stored) return JSON.parse(stored) as SprinkleInstance[];
  } catch {}
  return [];
}

export function writeSprinkleInstancesToShim(
  instances: SprinkleInstance[],
  storage: Pick<Storage, 'setItem'> | undefined = (globalThis as { localStorage?: Storage })
    .localStorage
): void {
  try {
    storage?.setItem(SPRINKLE_INSTANCES_STORAGE_KEY, JSON.stringify(instances));
  } catch {}
}
