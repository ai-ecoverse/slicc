export type FeatureFlagFloat =
  | 'standalone'
  | 'extension'
  | 'electron-overlay'
  | 'extension-detached'
  | 'hosted-leader'
  | 'connect'
  | 'cherry'
  | 'follower';

export type FeatureFlagId =
  | 'experimental-settings'
  | 'panel-layouts'
  | 'agentic-memory'
  | 'multiple-cones'
  | 'compact-on-idle'
  | 'memory-v2'
  | 'live-model-catalog';
export type FeatureFlagValues = Partial<Record<FeatureFlagId, string>>;

export interface FeatureFlagDefinition {
  readonly id: FeatureFlagId;
  readonly label: string;
  readonly description: string;
  readonly defaultValue: string;
  readonly floatDefaults?: Readonly<Partial<Record<FeatureFlagFloat, string>>>;
  readonly userToggleable: boolean;
  readonly overridableFloats?: readonly FeatureFlagFloat[];

  readonly since: string;
}

export const FEATURE_FLAG_STORAGE_KEY = 'slicc_feature_flags';

const FEATURE_FLAGS: readonly FeatureFlagDefinition[] = Object.freeze([
  Object.freeze({
    id: 'experimental-settings',
    label: 'Experimental settings',
    description: 'Show controls for experimental features.',
    defaultValue: 'on',
    floatDefaults: Object.freeze({ cherry: 'off' }),
    userToggleable: false,
    since: '2026-07-31',
  }),
  Object.freeze({
    id: 'panel-layouts',
    label: 'Panel layouts',
    description: 'Arrange the UI as movable, resizable panels instead of the fixed workbench.',

    defaultValue: 'off',
    userToggleable: true,
    since: '2026-08-03',
  }),
  Object.freeze({
    id: 'agentic-memory',
    label: 'Agentic memory',
    description:
      'Curate session memory with a background agent instead of a one-shot extraction call.',
    defaultValue: 'off',
    userToggleable: true,
    since: '2026-08-05',
  }),
  Object.freeze({
    id: 'multiple-cones',
    label: 'Multiple cones',
    description:
      'Add, switch between and remove cones from the freezer rail. Extra cones share the workspace.',

    defaultValue: 'on',
    floatDefaults: Object.freeze({ cherry: 'off' }),
    userToggleable: false,
    since: '2026-08-21',
  }),
  Object.freeze({
    id: 'compact-on-idle',
    label: 'Compact on idle',
    description:
      'When a cone has been idle for a while with a large context, summarize its history in the background. The full transcript is kept in /sessions.',

    defaultValue: 'on',
    userToggleable: false,
    since: '2026-09-02',
  }),
  Object.freeze({
    id: 'memory-v2',
    label: 'Memory v2',
    description:
      'Searchable session history, scoop pre-compaction snapshots, and the gelatiere — a resident advisor that reviews your sessions and suggests skills and use cases.',
    defaultValue: 'off',
    userToggleable: true,
    since: '2026-09-10',
  }),
  Object.freeze({
    id: 'live-model-catalog',
    label: 'Live model catalogue',
    description:
      "Refresh model lists from pi's hosted catalogue, so newly launched models appear without a release.",

    defaultValue: 'on',
    userToggleable: false,
    since: '2026-09-22',
  }),
]);

const FEATURE_FLAGS_BY_ID = new Map(FEATURE_FLAGS.map((flag) => [flag.id, flag]));
const ENABLED_VALUES = new Set(['1', 'on', 'true']);

let activeFloat: FeatureFlagFloat = 'standalone';
let remoteValues: FeatureFlagValues = {};

let hostValues: FeatureFlagValues = {};

interface FeatureFlagStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function listFlags(): readonly FeatureFlagDefinition[] {
  return FEATURE_FLAGS;
}

export function resolveFlagValue(
  id: FeatureFlagId,
  float: FeatureFlagFloat,
  overrides: Readonly<FeatureFlagValues> = {}
): string | undefined {
  const definition = FEATURE_FLAGS_BY_ID.get(id);
  if (!definition) return undefined;
  const override = overrides[id];
  if (typeof override === 'string' && canOverride(definition, float)) return override;
  const hostValue = hostValues[id];
  if (typeof hostValue === 'string' && canOverride(definition, float)) return hostValue;
  return getBundledDefault(definition, float);
}

export function resolveFlags(
  float: FeatureFlagFloat,
  centralValues: Readonly<FeatureFlagValues> = {},
  overrides: Readonly<FeatureFlagValues> = readFeatureFlagOverrides()
): FeatureFlagValues {
  const resolved: FeatureFlagValues = {};
  for (const definition of FEATURE_FLAGS) {
    const override = overrides[definition.id];
    if (typeof override === 'string' && canOverride(definition, float)) {
      resolved[definition.id] = override;
      continue;
    }
    const hostValue = hostValues[definition.id];
    if (typeof hostValue === 'string' && canOverride(definition, float)) {
      resolved[definition.id] = hostValue;
      continue;
    }
    const centralValue = centralValues[definition.id];
    resolved[definition.id] =
      typeof centralValue === 'string' ? centralValue : getBundledDefault(definition, float);
  }
  return resolved;
}

export function readFeatureFlagOverrides(): FeatureFlagValues {
  try {
    const raw = getStorage()?.getItem(FEATURE_FLAG_STORAGE_KEY);
    if (!raw) return {};
    return sanitizeValues(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function writeFeatureFlagOverrides(overrides: Readonly<FeatureFlagValues>): void {
  try {
    getStorage()?.setItem(FEATURE_FLAG_STORAGE_KEY, JSON.stringify(sanitizeValues(overrides)));
  } catch {}
}

export function canOverrideFlag(id: FeatureFlagId): boolean {
  const definition = FEATURE_FLAGS_BY_ID.get(id);
  return definition !== undefined && canOverride(definition, activeFloat);
}

export function setFeatureFlagOverride(id: FeatureFlagId, value: string | undefined): void {
  const definition = FEATURE_FLAGS_BY_ID.get(id);
  if (!definition || !canOverride(definition, activeFloat)) return;
  const overrides = readFeatureFlagOverrides();
  if (typeof value === 'string') overrides[id] = value;
  else delete overrides[id];
  writeFeatureFlagOverrides(overrides);
}

export function initFeatureFlags(
  float: FeatureFlagFloat,
  centralValues: Readonly<FeatureFlagValues> = {}
): void {
  activeFloat = float;
  remoteValues = sanitizeValues(centralValues);
  hostValues = {};
}

export function updateCentralFlagValues(
  float: FeatureFlagFloat,
  centralValues: Readonly<FeatureFlagValues>
): void {
  activeFloat = float;
  remoteValues = sanitizeValues(centralValues);
}

export interface UntrustedFlagValues {
  readonly [flagId: string]: unknown;
}

export function applyHostFlagOverrides(values: UntrustedFlagValues): FeatureFlagValues {
  const applied: FeatureFlagValues = {};
  for (const [id, value] of Object.entries(values)) {
    const definition = FEATURE_FLAGS_BY_ID.get(id as FeatureFlagId);
    if (!definition || typeof value !== 'string' || !canOverride(definition, activeFloat)) continue;
    applied[definition.id] = value;
  }
  hostValues = { ...hostValues, ...applied };
  return applied;
}

export function getFeatureValue(id: FeatureFlagId): string | undefined {
  return resolveFlags(activeFloat, remoteValues)[id];
}

export function coerceFeatureFlagValue(value: string | undefined): boolean {
  return typeof value === 'string' && ENABLED_VALUES.has(value.trim().toLowerCase());
}

export function isFeatureEnabled(id: FeatureFlagId): boolean {
  return coerceFeatureFlagValue(getFeatureValue(id));
}

function getBundledDefault(definition: FeatureFlagDefinition, float: FeatureFlagFloat): string {
  return definition.floatDefaults?.[float] ?? definition.defaultValue;
}

function canOverride(definition: FeatureFlagDefinition, float: FeatureFlagFloat): boolean {
  return (
    definition.userToggleable &&
    (definition.overridableFloats === undefined || definition.overridableFloats.includes(float))
  );
}

function sanitizeValues(value: unknown): FeatureFlagValues {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const candidate = value as UntrustedFlagValues;
  const sanitized: FeatureFlagValues = {};
  for (const definition of FEATURE_FLAGS) {
    const flagValue = candidate[definition.id];
    if (typeof flagValue === 'string') sanitized[definition.id] = flagValue;
  }
  return sanitized;
}

function getStorage(): FeatureFlagStorage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Partial<FeatureFlagStorage> }).localStorage;
    if (typeof storage?.getItem !== 'function' || typeof storage.setItem !== 'function') return;
    return storage as FeatureFlagStorage;
  } catch {
    return undefined;
  }
}
