import {
  isReadOnlyUnit,
  isRootSummary,
  orderRoots,
  orderUnits,
  ownerRootOf,
} from '../../work-unit/client/presentation.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import { PRIMARY_CONE_FOLDER } from '../../work-unit/record.js';

type UnitLike = Pick<WorkUnitSummary, 'role' | 'folder' | 'name' | 'assistantLabel'>;

function isPrimaryRootSummary(unit: Pick<UnitLike, 'role' | 'folder'>): boolean {
  return isRootSummary(unit) && unit.folder === PRIMARY_CONE_FOLDER;
}

export function switcherLabelFor(unit: Pick<UnitLike, 'role' | 'name' | 'assistantLabel'>): string {
  return isRootSummary(unit) ? unit.assistantLabel : unit.name;
}

export function threadContextFor(unit: UnitLike): string {
  if (isPrimaryRootSummary(unit)) return 'cone';
  return isRootSummary(unit) ? `cone:${unit.folder}` : `scoop:${unit.name}`;
}

export function unitSlugFor(unit: UnitLike): string {
  if (isPrimaryRootSummary(unit)) return 'cone';
  return isRootSummary(unit) ? unit.folder : unit.name;
}

export function unitForContext(
  units: readonly WorkUnitSummary[],
  ctx: string
): WorkUnitSummary | undefined {
  if (ctx.startsWith('scoop:')) {
    const name = ctx.slice('scoop:'.length);
    return units.find((unit) => !isRootSummary(unit) && unit.name === name);
  }
  if (ctx.startsWith('cone:')) {
    const folder = ctx.slice('cone:'.length);
    return units.find((unit) => isRootSummary(unit) && unit.folder === folder);
  }
  return defaultRootOf(units);
}

function isSelectScoopTarget(ctx: string): boolean {
  if (ctx === 'cone') return true;
  if (ctx.startsWith('scoop:') && ctx.length > 'scoop:'.length) return true;
  if (ctx.startsWith('cone:') && ctx.length > 'cone:'.length) return true;
  return false;
}

export function selectScoopForContext(
  units: readonly WorkUnitSummary[],
  ctx: string,
  selectedId: string | null | undefined,
  select: (unit: WorkUnitSummary) => void
): boolean {
  if (!isSelectScoopTarget(ctx)) return false;
  const unit = unitForContext(units, ctx);
  if (!unit) return false;
  if (unit.id !== selectedId) select(unit);
  return true;
}

export function defaultRootOf(units: readonly WorkUnitSummary[]): WorkUnitSummary | undefined {
  const roots = orderRoots(units.filter(isRootSummary));
  return roots.find(isPrimaryRootSummary) ?? roots[0];
}

export function orderForSwitcher(
  units: readonly WorkUnitSummary[],
  selectedJid?: string | null
): WorkUnitSummary[] {
  return [...orderUnits(units, selectedJid)];
}

export function rootForSelection(
  units: readonly WorkUnitSummary[],
  selected: Pick<WorkUnitSummary, 'id'> | null | undefined
): WorkUnitSummary | undefined {
  const owner = ownerRootOf(units, selected?.id);
  if (owner) return owner;
  if (hasUnknownOwner(units, selected?.id)) return undefined;
  return defaultRootOf(units);
}

function hasUnknownOwner(units: readonly WorkUnitSummary[], id: string | undefined): boolean {
  if (id === undefined) return false;
  const unit = units.find((candidate) => candidate.id === id);
  return unit !== undefined && !isRootSummary(unit) && unit.parentId === undefined;
}

export function rootFolderForContext(ctx: string | null | undefined): string | null {
  if (ctx == null || ctx === 'cone') return PRIMARY_CONE_FOLDER;
  if (ctx.startsWith('cone:')) return ctx.slice('cone:'.length) || PRIMARY_CONE_FOLDER;
  return null;
}

export function rootForConeFolder(
  units: readonly WorkUnitSummary[],
  folder: string | undefined
): WorkUnitSummary | undefined {
  if (!folder) return defaultRootOf(units);
  return (
    units.find((unit) => isRootSummary(unit) && unit.folder === folder) ?? defaultRootOf(units)
  );
}

export type UnitRole = 'cone' | 'scoop';

export function unitRoleFor(unit: Pick<WorkUnitSummary, 'role'>): UnitRole {
  return isRootSummary(unit) ? 'cone' : 'scoop';
}

export function isReadOnlyRole(role: UnitRole): boolean {
  return isReadOnlyUnit({ role: role === 'cone' ? 'primary' : 'child' });
}
