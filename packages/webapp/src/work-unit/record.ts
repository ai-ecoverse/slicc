/**
 * Record-level helpers that keep `RegisteredScoop`'s presentation fields
 * consistent with the ownership edge (#1666, Phase 3).
 *
 * `isCone` / `type` stay on the record and on the wire for followers, but
 * they are *derived* — written here from `parentJid`, never branched on by
 * kernel or scoop lifecycle code. The final phase deletes them.
 */

import type { RegisteredScoop, WorkUnitModel, WorkUnitThinking } from '../scoops/types.js';
import { isRootUnit } from './policy.js';

/**
 * Rewrite the derived presentation fields from the ownership edge. Applied
 * on register and on restore so a record can never say `isCone: true` while
 * naming a parent (or vice versa). Mutates and returns `scoop`.
 */
export function normalizeScoopRecord(scoop: RegisteredScoop): RegisteredScoop {
  liftLegacyModelConfig(scoop);
  const root = isRootUnit(scoop);
  scoop.isCone = root;
  scoop.type = root ? 'cone' : 'scoop';
  if (root) {
    // A root is addressed directly; trigger patterns are a child concept.
    scoop.trigger = undefined;
    scoop.requiresTrigger = false;
    scoop.assistantLabel = scoop.assistantLabel || 'sliccy';
  }
  return scoop;
}

/** Folder of the primary root — the one a fresh profile bootstraps. */
export const PRIMARY_CONE_FOLDER = 'cone';

/**
 * The persisted chat/session store key of a unit: `session-<folder>`. The
 * primary root's folder is `cone`, so its history stays under the historical
 * `session-cone` key; every other unit — extra cones included — gets its own.
 */
export function chatSessionIdFor(scoop: Pick<RegisteredScoop, 'folder'>): string {
  return `session-${scoop.folder}`;
}

/** `true` for the primary root (folder `cone`): URL context `cone`, session `session-cone`. */
export function isPrimaryRoot(scoop: Pick<RegisteredScoop, 'parentJid' | 'folder'>): boolean {
  return isRootUnit(scoop) && scoop.folder === PRIMARY_CONE_FOLDER;
}

/** Lower-case, dash-separated, ASCII-only slug of a user-typed name. */
export function slugifyUnitName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cone'
  );
}

/**
 * Storage folder for a new root. The first root is the primary `cone`; later
 * ones are `cone-<slug>`, de-duplicated against the existing registry so two
 * cones named alike never share a session key.
 */
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

/**
 * Process-owner label for the kernel process table (`ps` shows `cone` /
 * `scoop`). Presentation of the role, not a capability.
 */
export function processOwnerKindFor(scoop: Pick<RegisteredScoop, 'parentJid'>): 'cone' | 'scoop' {
  return isRootUnit(scoop) ? 'cone' : 'scoop';
}

/**
 * Human label used in logs, message sources and prompts: `cone` for a
 * root, the unit's name for a child.
 */
export function sourceLabelFor(
  scoop: Pick<RegisteredScoop, 'parentJid' | 'name' | 'folder'>
): string {
  return isRootUnit(scoop) ? 'cone' : (scoop.name ?? scoop.folder);
}

/**
 * The model a unit runs on (#2310), or `undefined` when it has none yet
 * (a record written before the field existed and not yet backfilled — the
 * caller falls back to the global selection).
 *
 * THE read path: runtime code must never reach into `config.modelId`, which
 * is legacy creation input `normalizeScoopRecord` has already lifted here.
 */
export function modelFor(
  scoop: Pick<RegisteredScoop, 'model' | 'config'>
): WorkUnitModel | undefined {
  if (scoop.model) return scoop.model;
  const id = scoop.config?.modelId;
  const provider = scoop.config?.modelProviderId;
  // A legacy pin with no provider stays unpinned-by-provider: `resolveModelById`
  // then resolves it against the selected provider exactly as it did before.
  return id !== undefined && provider !== undefined ? { provider, id } : undefined;
}

/** Legacy-tolerant read of the bare model id a unit is pinned to, if any. */
export function modelIdFor(scoop: Pick<RegisteredScoop, 'model' | 'config'>): string | undefined {
  return scoop.model?.id ?? scoop.config?.modelId;
}

/** Legacy-tolerant read of the provider a unit's model is pinned to, if any. */
export function modelProviderFor(
  scoop: Pick<RegisteredScoop, 'model' | 'config'>
): string | undefined {
  return scoop.model?.provider ?? scoop.config?.modelProviderId;
}

/** Reasoning configuration of a unit (#2310), record first, legacy config second. */
export function thinkingFor(scoop: Pick<RegisteredScoop, 'thinking' | 'config'>): WorkUnitThinking {
  if (scoop.thinking) return scoop.thinking;
  const level = scoop.config?.thinkingLevel;
  const effortOverride = scoop.config?.effortOverride;
  return level === undefined && effortOverride === undefined ? {} : { level, effortOverride };
}

/**
 * Set (or clear) a unit's model on the record. Mutates and returns `scoop`;
 * the caller persists it. Never touches any other unit — per-cone model
 * means exactly one record changes (#2310).
 */
export function setUnitModel(
  scoop: RegisteredScoop,
  model: WorkUnitModel | undefined
): RegisteredScoop {
  if (model) scoop.model = { provider: model.provider, id: model.id };
  else scoop.model = undefined;
  clearLegacyModelConfig(scoop);
  return scoop;
}

/** Set (or clear) a unit's reasoning configuration on the record. */
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

/**
 * Migrate a record written before `model` / `thinking` existed: a spawn-time
 * `config.modelId` (+ `config.modelProviderId`) pin becomes the record's
 * model, `config.thinkingLevel` (+ `config.effortOverride`) its thinking.
 * The legacy fields are then cleared so exactly one place holds the truth —
 * a stale duplicate is how a model swap silently keeps the old value.
 *
 * A record with no pin at all is left without a model here: the orchestrator
 * backfills it on restore (inherited or seeded from `selected-model`), which
 * is the only place that can resolve a provider.
 */
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
  // A provider-less legacy pin keeps its `config.modelId` (see `modelFor`):
  // inventing a provider for it would re-create the #2195 mis-billing.
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
