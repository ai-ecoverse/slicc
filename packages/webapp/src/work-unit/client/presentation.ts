import type { WorkUnitModel } from '../../scoops/types.js';
import type { WorkUnitId, WorkUnitPresentationState, WorkUnitSummary } from './types.js';

export interface WorkUnitTabDescriptor {
  key: string;
  type: 'cone' | 'scoop';
  color: string;
  label: string;
  eyes: 'open' | 'dead' | 'none';
  state: WorkUnitPresentationState;

  fill: number;
  phase?: 'thinking' | 'tool';
  awaiting?: boolean;

  unread?: number;
}

export function isRootSummary(unit: Pick<WorkUnitSummary, 'role'>): boolean {
  return unit.role === 'primary';
}

export function modelForUnit(
  units: readonly WorkUnitSummary[],
  id: WorkUnitId | null | undefined,
  previous?: WorkUnitModel
): WorkUnitModel | undefined {
  const owner = ownerRootOf(units, id) ?? units.find((unit) => unit.id === id);

  if (owner) return owner.model;
  return previous;
}

export function ownerRootOf(
  units: readonly WorkUnitSummary[],
  id: WorkUnitId | null | undefined
): WorkUnitSummary | undefined {
  let current = id ? units.find((unit) => unit.id === id) : undefined;
  for (let hops = 0; current && hops <= units.length; hops++) {
    if (isRootSummary(current)) return current;
    const parentId = current.parentId;
    current = parentId ? units.find((unit) => unit.id === parentId) : undefined;
  }
  return undefined;
}

function descendantsOf(
  units: readonly WorkUnitSummary[],
  owner: WorkUnitSummary,
  placed: Set<string>,
  out: WorkUnitSummary[]
): WorkUnitSummary[] {
  for (const unit of units) {
    if (unit.parentId === owner.id && !placed.has(unit.id)) {
      placed.add(unit.id);
      out.push(unit);
      descendantsOf(units, unit, placed, out);
    }
  }
  return out;
}

export function orderUnits(
  units: readonly WorkUnitSummary[],
  selectedId?: WorkUnitId | null
): readonly WorkUnitSummary[] {
  if (!units.some((unit) => unit.parentId !== undefined)) {
    const roots = orderRoots(units.filter(isRootSummary));
    return [...roots, ...units.filter((unit) => !isRootSummary(unit))];
  }
  const placed = new Set<string>();
  const roots = orderRoots(units.filter(isRootSummary));
  for (const root of roots) placed.add(root.id);
  const selectedRoot = ownerRootOf(units, selectedId);
  const mine = selectedRoot ? descendantsOf(units, selectedRoot, placed, []) : [];
  const others = roots.flatMap((root) => descendantsOf(units, root, placed, []));
  const tail = units.filter((unit) => !placed.has(unit.id));
  return [...roots, ...mine, ...others, ...tail];
}

export function orderRoots(roots: readonly WorkUnitSummary[]): WorkUnitSummary[] {
  if (roots.length < 2 || !roots.every((root) => root.addedAt)) return [...roots];
  return [...roots].sort(
    (a, b) => (a.addedAt ?? '').localeCompare(b.addedAt ?? '') || a.id.localeCompare(b.id)
  );
}

export function isReadOnlyUnit(unit: Pick<WorkUnitSummary, 'role'>): boolean {
  return unit.role === 'child';
}

function eyesFor(state: WorkUnitPresentationState): WorkUnitTabDescriptor['eyes'] {
  if (state === 'broken') return 'dead';
  if (state === 'initializing') return 'none';
  return 'open';
}

export function toTabDescriptors(
  units: readonly WorkUnitSummary[],
  selectedId: WorkUnitId | null | undefined,
  colorFor: (unit: { isRoot: boolean; name: string }) => string,

  unread?: ReadonlyMap<string, number>
): WorkUnitTabDescriptor[] {
  return orderUnits(units, selectedId).map((unit) => {
    const isRoot = isRootSummary(unit);
    return {
      key: unit.id,
      type: isRoot ? 'cone' : 'scoop',
      color: colorFor({ isRoot, name: unit.name }),
      label: isRoot ? unit.assistantLabel : unit.name,
      eyes: eyesFor(unit.state),
      state: unit.state,
      fill: unit.fill,

      ...(unit.state === 'working' && unit.phase ? { phase: unit.phase } : {}),
      ...(unit.state === 'idle' && unit.awaiting ? { awaiting: true as const } : {}),

      ...(isRoot && unit.id !== selectedId && (unread?.get(unit.id) ?? 0) > 0
        ? { unread: unread?.get(unit.id) }
        : {}),
    };
  });
}
