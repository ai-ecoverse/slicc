export type FeatureFlagFloat =
  | 'standalone'
  | 'extension'
  | 'electron-overlay'
  | 'extension-detached'
  | 'hosted-leader'
  | 'connect'
  | 'cherry'
  | 'follower';

export type FeatureFlagId = 'experimental-settings';
export type FeatureFlagValues = Partial<Record<FeatureFlagId, string>>;

export interface FeatureFlagDefinition {
  readonly id: FeatureFlagId;
  readonly label: string;
  readonly description: string;
  readonly defaultValue: string;
  readonly floatDefaults?: Readonly<Partial<Record<FeatureFlagFloat, string>>>;
  readonly userToggleable: boolean;
  readonly overridableFloats?: readonly FeatureFlagFloat[];
}

export const FEATURE_FLAG_STORAGE_KEY = 'slicc_feature_flags';

const WEB_UI_FLOATS: readonly FeatureFlagFloat[] = [
  'standalone',
  'extension',
  'electron-overlay',
  'extension-detached',
  'hosted-leader',
  'connect',
  'follower',
];

const FEATURE_FLAGS: readonly FeatureFlagDefinition[] = Object.freeze([
  Object.freeze({
    id: 'experimental-settings',
    label: 'Experimental settings',
    description: 'Show controls for experimental features.',
    defaultValue: 'on',
    floatDefaults: Object.freeze({ cherry: 'off' }),
    userToggleable: true,
    overridableFloats: WEB_UI_FLOATS,
  }),
]);

const FEATURE_FLAGS_BY_ID = new Map(FEATURE_FLAGS.map((flag) => [flag.id, flag]));
const ENABLED_VALUES = new Set(['1', 'on', 'true']);

let activeFloat: FeatureFlagFloat = 'standalone';
let remoteValues: FeatureFlagValues = {};

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
  return getBundledDefault(definition, float);
}

/** Resolve every registered flag using local override → remote value → bundled default. */
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
  } catch {
    // Storage is best-effort; bundled and central values remain available without it.
  }
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
}

export function getFeatureValue(id: FeatureFlagId): string | undefined {
  return resolveFlags(activeFloat, remoteValues)[id];
}

/** `on`, `true`, and `1` (case-insensitive, surrounding whitespace ignored) are enabled. */
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
  const candidate = value as Record<string, unknown>;
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
