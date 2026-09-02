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
  | 'multiple-cones';
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

const FEATURE_FLAGS: readonly FeatureFlagDefinition[] = Object.freeze([
  Object.freeze({
    id: 'experimental-settings',
    label: 'Experimental settings',
    description: 'Show controls for experimental features.',
    defaultValue: 'on',
    floatDefaults: Object.freeze({ cherry: 'off' }),
    userToggleable: false,
  }),
  Object.freeze({
    id: 'panel-layouts',
    label: 'Panel layouts',
    description: 'Arrange the UI as movable, resizable panels instead of the fixed workbench.',
    // Off everywhere while the dock-tree is still the shipping layout. No
    // `floatDefaults`: the gate is uniform across floats, including a Cherry embed
    // pushing its own layout, so there is one answer to "are panels on here".
    defaultValue: 'off',
    userToggleable: true,
  }),
  Object.freeze({
    id: 'agentic-memory',
    label: 'Agentic memory',
    description:
      'Curate session memory with a background agent instead of a one-shot extraction call.',
    defaultValue: 'off',
    userToggleable: true,
  }),
  Object.freeze({
    id: 'multiple-cones',
    label: 'Multiple cones',
    description:
      'Add, switch between and remove cones from the freezer rail. Extra cones share the workspace.',
    // Graduated (#2280): on for every float that runs the leader shell, and
    // OFF for a Cherry embed — a garnish in someone else's page is a
    // single-cone surface, not a place to spawn work units. Not
    // `userToggleable`: the graduation takes it out of Settings →
    // Experimental, so the only remaining switches are this bundled default
    // and the worker's central `FEATURE_FLAGS` (which, being central, also
    // outranks the Cherry default — a central `base` value for this flag must
    // carry a matching `floats.cherry` entry).
    defaultValue: 'on',
    floatDefaults: Object.freeze({ cherry: 'off' }),
    userToggleable: false,
  }),
]);

const FEATURE_FLAGS_BY_ID = new Map(FEATURE_FLAGS.map((flag) => [flag.id, flag]));
const ENABLED_VALUES = new Set(['1', 'on', 'true']);

let activeFloat: FeatureFlagFloat = 'standalone';
let remoteValues: FeatureFlagValues = {};
/**
 * Session-only overrides pushed by a Cherry host in `handshake.welcome.flags`
 * (or any other embedder-supplied source). Never written to `localStorage` —
 * like a pushed `theme`/`layout`, this must not persist or drift on the
 * shared origin. Reset on every `initFeatureFlags` call (i.e. every boot).
 */
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

/** Resolve every registered flag using local override → host-pushed value → remote value → bundled default. */
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
  hostValues = {};
}

/**
 * Apply session-only flag overrides pushed by an embedder (a Cherry host's
 * `handshake.welcome.flags`). Silently drops any id that isn't a known flag
 * or isn't `userToggleable`-and-allowed for the active float — the same gate
 * a local user override must pass via `canOverride`. This is what keeps a
 * host page from flipping a flag nobody decided was safe for it to touch;
 * unlike the worker's own `centralValues`, an embedder is not a trusted
 * operator of this deployment.
 *
 * Returns the subset that was actually applied, so a caller can warn about
 * anything dropped. Never touches `localStorage` — reset on every
 * `initFeatureFlags` call, exactly like a pushed `theme`/`layout`.
 */
/**
 * Flag values as they arrive from an untrusted source (an embedder's
 * handshake, parsed `localStorage`): keyed by flag id, values unchecked until
 * {@link sanitizeValues} / {@link applyHostFlagOverrides} narrow them.
 */
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
