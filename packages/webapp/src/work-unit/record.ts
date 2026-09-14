import { slugify } from '@slicc/shared-ts';
import type { RegisteredScoop, WorkUnitModel, WorkUnitThinking } from '../scoops/types.js';
import { isRootUnit, rootsOf } from './policy.js';

interface LegacyRoleFields {
  isCone?: boolean;
  type?: 'cone' | 'scoop';
}

export function legacyRecordIsCone(scoop: RegisteredScoop): boolean {
  return (scoop as RegisteredScoop & LegacyRoleFields).isCone === true;
}

export function normalizeScoopRecord(scoop: RegisteredScoop): RegisteredScoop {
  liftLegacyModelConfig(scoop);
  const legacy = scoop as RegisteredScoop & LegacyRoleFields;
  delete legacy.isCone;
  delete legacy.type;
  const root = isRootUnit(scoop);
  if (root) {
    scoop.trigger = undefined;
    scoop.requiresTrigger = false;
    scoop.assistantLabel = scoop.assistantLabel || 'sliccy';

    scoop.approvesGuestRequests = undefined;

    scoop.onParentClose = undefined;
  }
  return scoop;
}

export function uniqueFolder(folder: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(folder)) return folder;

  for (let n = 2; n <= used.size + 2; n++) {
    const candidate = `${folder}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  /* c8 ignore next -- unreachable: the loop above exhausts every taken name */
  return `${folder}-${used.size + 3}`;
}

export const PRIMARY_CONE_FOLDER = 'cone';

export function chatSessionIdFor(scoop: Pick<RegisteredScoop, 'folder'>): string {
  return `session-${scoop.folder}`;
}

export function isPrimaryRoot(scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>): boolean {
  return isRootUnit(scoop) && scoop.folder === PRIMARY_CONE_FOLDER;
}

export function leadingRootOf<
  T extends Pick<RegisteredScoop, 'parentJid' | 'folder' | 'addedAt' | 'jid'>,
>(units: Iterable<T>): T | undefined {
  const roots = rootsOf(units);
  return roots.find((root) => isPrimaryRoot(root)) ?? roots[0];
}

export function slugifyUnitName(name: string): string {
  return slugify(name, { maxLen: 40, fallback: 'cone' });
}

export function coneFolderFor(
  name: string,
  existing: Iterable<Pick<RegisteredScoop, 'folder'>>
): string {
  const taken = new Set<string>();
  for (const scoop of existing) taken.add(scoop.folder);
  if (!taken.has(PRIMARY_CONE_FOLDER)) return PRIMARY_CONE_FOLDER;
  const base = `cone-${slugifyUnitName(name)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function processOwnerKindFor(scoop: Pick<RegisteredScoop, 'parentJid'>): 'cone' | 'scoop' {
  return isRootUnit(scoop) ? 'cone' : 'scoop';
}

export function sourceLabelFor(
  scoop: Pick<RegisteredScoop, 'parentJid' | 'name' | 'folder'>
): string {
  return isRootUnit(scoop) ? 'cone' : (scoop.name ?? scoop.folder);
}

export function modelFor(
  scoop: Pick<RegisteredScoop, 'model' | 'config'>
): WorkUnitModel | undefined {
  if (scoop.model) return scoop.model;
  const id = scoop.config?.modelId;
  const provider = scoop.config?.modelProviderId;

  return id !== undefined && provider !== undefined ? { provider, id } : undefined;
}

export function parseQualifiedModelId(qualified: string): WorkUnitModel | null {
  const colon = qualified.indexOf(':');
  if (colon <= 0) return null;
  return { provider: qualified.slice(0, colon), id: qualified.slice(colon + 1) };
}

export function qualifiedModelId(model: WorkUnitModel): string {
  return `${model.provider}:${model.id}`;
}

export function modelIdFor(scoop: Pick<RegisteredScoop, 'model' | 'config'>): string | undefined {
  return scoop.model?.id ?? scoop.config?.modelId;
}

export function modelProviderFor(
  scoop: Pick<RegisteredScoop, 'model' | 'config'>
): string | undefined {
  return scoop.model?.provider ?? scoop.config?.modelProviderId;
}

export function thinkingFor(scoop: Pick<RegisteredScoop, 'thinking' | 'config'>): WorkUnitThinking {
  if (scoop.thinking) return scoop.thinking;
  const level = scoop.config?.thinkingLevel;
  const effortOverride = scoop.config?.effortOverride;
  return level === undefined && effortOverride === undefined ? {} : { level, effortOverride };
}

export function setUnitModel(
  scoop: RegisteredScoop,
  model: WorkUnitModel | undefined
): RegisteredScoop {
  if (model) scoop.model = { provider: model.provider, id: model.id };
  else scoop.model = undefined;
  clearLegacyModelConfig(scoop);
  return scoop;
}

export function setUnitThinking(
  scoop: RegisteredScoop,
  thinking: WorkUnitThinking | undefined
): RegisteredScoop {
  const next =
    thinking && (thinking.level !== undefined || thinking.effortOverride !== undefined)
      ? { level: thinking.level, effortOverride: thinking.effortOverride }
      : undefined;
  scoop.thinking = next;
  clearLegacyThinkingConfig(scoop);
  return scoop;
}

function liftLegacyModelConfig(scoop: RegisteredScoop): void {
  const config = scoop.config;
  if (!config) return;
  if (!scoop.model && config.modelId !== undefined && config.modelProviderId !== undefined) {
    scoop.model = { provider: config.modelProviderId, id: config.modelId };
  }
  if (
    !scoop.thinking &&
    (config.thinkingLevel !== undefined || config.effortOverride !== undefined)
  ) {
    scoop.thinking = { level: config.thinkingLevel, effortOverride: config.effortOverride };
  }

  if (scoop.model) clearLegacyModelConfig(scoop);
  if (scoop.thinking) clearLegacyThinkingConfig(scoop);
}

function clearLegacyModelConfig(scoop: RegisteredScoop): void {
  if (!scoop.config) return;
  if (scoop.config.modelId === undefined && scoop.config.modelProviderId === undefined) return;
  const { modelId: _id, modelProviderId: _provider, ...rest } = scoop.config;
  scoop.config = rest;
}

function clearLegacyThinkingConfig(scoop: RegisteredScoop): void {
  if (!scoop.config) return;
  if (scoop.config.thinkingLevel === undefined && scoop.config.effortOverride === undefined) return;
  const { thinkingLevel: _level, effortOverride: _effort, ...rest } = scoop.config;
  scoop.config = rest;
}
