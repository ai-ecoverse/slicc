/**
 * Bedrock models that AWS already serves but pi-ai's `amazon-bedrock`
 * catalogue does not list yet.
 *
 * The bedrock-camp picker is built from pi-ai's catalogue, so a model missing
 * there is invisible in SLICC even when every inference profile answers. Each
 * entry here was verified live against `bedrock-runtime` before it was added:
 * the inference profile is listed by `GET /inference-profiles` in the regions
 * its prefix covers, and `POST /converse` answers.
 *
 * pi-ai wins on id collisions (`mergeBedrockCampCatalogue`), so an entry
 * becomes dead weight — not a conflict — once pi-ai learns the model. Delete
 * it then.
 *
 * Dependency-free on purpose, like `bedrock-camp-compat.ts`: the eagerly
 * loaded `account-store.ts` imports it, so it must not pull in pi-ai.
 */

interface BedrockCampCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The subset of pi-ai's `Model` shape the picker and stream function read. */
export interface BedrockCampExtraModel {
  id: string;
  name: string;
  api: 'bedrock-converse-stream';
  provider: 'amazon-bedrock';
  baseUrl: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: BedrockCampCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
}

/**
 * Bedrock bills regional inference profiles (`us.`, `eu.`, `jp.`, `au.`) at a
 * 10% premium over `global.`; pi-ai's catalogue carries the same split for
 * every Claude it lists (e.g. Opus 5 at $5 global vs $5.50 `us.`).
 */
const REGIONAL_PREMIUM = 1.1;

function regionalCost(cost: BedrockCampCost): BedrockCampCost {
  const bump = (n: number) => Math.round(n * REGIONAL_PREMIUM * 1000) / 1000;
  return {
    input: bump(cost.input),
    output: bump(cost.output),
    cacheRead: bump(cost.cacheRead),
    cacheWrite: bump(cost.cacheWrite),
  };
}

const PROFILE_LABELS = {
  global: 'Global',
  us: 'US',
  eu: 'EU',
  jp: 'JP',
  au: 'AU',
} as const;

type ProfilePrefix = keyof typeof PROFILE_LABELS;

interface ExtraModelSpec {
  /** Bedrock foundation-model id without a profile prefix. */
  baseId: string;
  name: string;
  /** Inference profiles AWS lists for this model. */
  profiles: readonly ProfilePrefix[];
  /** `global.` price; regional profiles get {@link REGIONAL_PREMIUM}. */
  globalCost: BedrockCampCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
}

const EXTRA_MODEL_SPECS: readonly ExtraModelSpec[] = [
  {
    // Verified 2026-09-22 against bedrock-runtime.us-west-2: `us.` and
    // `global.` answer, `temperature` 400s, only adaptive thinking is
    // accepted (effort up to `max`), and cachePoint writes then reads.
    // Profiles from `GET /inference-profiles` in us-east-1, eu-central-1,
    // ap-northeast-1 and ap-southeast-2. Pricing and limits match
    // Anthropic's `claude-opus-5-5`.
    baseId: 'anthropic.claude-opus-5-5',
    name: 'Claude Opus 5.5',
    profiles: ['global', 'us', 'eu', 'jp', 'au'],
    globalCost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
  },
];

function expandSpec(spec: ExtraModelSpec): BedrockCampExtraModel[] {
  return spec.profiles.map((prefix) => ({
    id: `${prefix}.${spec.baseId}`,
    name: `${spec.name} (${PROFILE_LABELS[prefix]})`,
    api: 'bedrock-converse-stream',
    provider: 'amazon-bedrock',
    // Placeholder like pi-ai's own entries; the configured endpoint replaces
    // it before any request is sent.
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    reasoning: true,
    input: ['text', 'image'],
    cost: prefix === 'global' ? { ...spec.globalCost } : regionalCost(spec.globalCost),
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(spec.thinkingLevelMap ? { thinkingLevelMap: { ...spec.thinkingLevelMap } } : {}),
  }));
}

export const BEDROCK_CAMP_EXTRA_MODELS: readonly BedrockCampExtraModel[] =
  EXTRA_MODEL_SPECS.flatMap(expandSpec);

/**
 * pi-ai's catalogue plus the extras it does not know yet. pi-ai's entry wins
 * on an id collision, so a pi-ai bump that learns a model supersedes the
 * hand-written entry without an edit here.
 */
export function mergeBedrockCampCatalogue<T extends { id: string }>(
  catalogue: readonly T[],
  extras: readonly T[]
): T[] {
  const known = new Set(catalogue.map((m) => m.id));
  return [...catalogue, ...extras.filter((m) => !known.has(m.id))];
}
