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

interface BedrockCampCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Mirrors pi-ai's `ModelCostTier`: `calculateCost` bills the whole request at it. */
interface BedrockCampCostTier extends BedrockCampCostRates {
  inputTokensAbove: number;
}

interface BedrockCampCost extends BedrockCampCostRates {
  tiers?: BedrockCampCostTier[];
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

// Six decimals, not three: GPT-6 Luna's $0.125 cache write becomes $0.1375
// regionally, which a three-decimal round would bill as $0.138.
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

function scaleRates(rates: BedrockCampCostRates, factor: number): BedrockCampCostRates {
  return {
    input: round6(rates.input * factor),
    output: round6(rates.output * factor),
    cacheRead: round6(rates.cacheRead * factor),
    cacheWrite: round6(rates.cacheWrite * factor),
  };
}

function scaleCost(cost: BedrockCampCost, factor: number): BedrockCampCost {
  const scaled: BedrockCampCost = scaleRates(cost, factor);
  if (cost.tiers) {
    scaled.tiers = cost.tiers.map((tier) => ({
      ...scaleRates(tier, factor),
      inputTokensAbove: tier.inputTokensAbove,
    }));
  }
  return scaled;
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
  // The five below were verified 2026-09-25 against bedrock-runtime.us-west-2.
  // `GET /inference-profiles` lists only `global.` and `us.` for each, in
  // us-west-2 and us-east-1; eu-central-1, ap-northeast-1 and ap-southeast-2
  // list only `global.`. Every one answers `temperature` with a 400.
  // Prices, context window and max tokens are pi's hosted catalogue
  // (`https://pi.dev/api/models/providers/amazon-bedrock`, the list pi-ai's
  // `models.generated` is built from) unless noted; models.dev's
  // `amazon-bedrock` entries agree on every figure.
  {
    // Adaptive thinking only: `thinking.type.enabled` and `.disabled` both
    // 400, effort low/high/xhigh/max accepted. The $0.25 cache read (2.5% of
    // input, not Fable 5's 10%) is what both sources list.
    baseId: 'anthropic.claude-fable-5-1',
    name: 'Claude Fable 5.1',
    profiles: ['global', 'us'],
    globalCost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
  },
  // GPT-6: implicit prompt caching and tool calls verified live (see
  // `BEDROCK_CAMP_ALLOWED_NON_CLAUDE_RE`). The only thinking shape accepted
  // is `additionalModelRequestFields.reasoning.effort`, which
  // `buildAdditionalModelRequestFields` does not send (it is Claude-only).
  // The long-context tier (input above 272k tokens) is from models.dev;
  // pi's catalogue omits it for Bedrock, and leaving it out would under-bill
  // long turns.
  {
    baseId: 'openai.gpt-6-sol',
    name: 'GPT-6 Sol',
    profiles: ['global', 'us'],
    globalCost: {
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh' },
  },
  {
    baseId: 'openai.gpt-6-luna',
    name: 'GPT-6 Luna',
    profiles: ['global', 'us'],
    globalCost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [
        { inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
      ],
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh' },
  },
  {
    baseId: 'openai.gpt-6-astra',
    name: 'GPT-6 Astra',
    profiles: ['global', 'us'],
    globalCost: {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh' },
  },
  {
    // Open weights. Implicit caching and tool calls verified live. Accepts
    // every thinking shape tried and ignores all of them, so there is no
    // thinkingLevelMap. Price also matches the AWS Bedrock pricing page
    // (Standard tier): $3 / $15 / $0.30 read / $3.75 write, US +10%.
    baseId: 'moonshotai.kimi-k3',
    name: 'Kimi K3',
    profiles: ['global', 'us'],
    globalCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_048_576,
    maxTokens: 128_000,
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
    cost: scaleCost(spec.globalCost, prefix === 'global' ? 1 : REGIONAL_PREMIUM),
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(spec.thinkingLevelMap ? { thinkingLevelMap: { ...spec.thinkingLevelMap } } : {}),
  }));
}

export const BEDROCK_CAMP_EXTRA_MODELS: readonly BedrockCampExtraModel[] =
  EXTRA_MODEL_SPECS.flatMap(expandSpec);

interface MergeableModel {
  id: string;
  cost?: BedrockCampCostRates & { tiers?: readonly BedrockCampCostTier[] };
}

function sameBaseRates(a: BedrockCampCostRates, b: BedrockCampCostRates): boolean {
  return (
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  );
}

/**
 * Tiers are the one thing an extra keeps after pi-ai learns its model: pi's
 * Bedrock entries omit long-context tiers (and the live-catalogue overlay
 * strips any it gets), so without this GPT-6 turns above 272k input would
 * bill at base rates. Only grafted onto a price sheet identical to ours; if
 * pi's base rates differ, ours are stale and so are our tiers.
 */
function withExtraTiers<T extends MergeableModel>(model: T, extra: T | undefined): T {
  const extraCost = extra?.cost;
  if (
    !extraCost?.tiers ||
    !model.cost ||
    model.cost.tiers ||
    !sameBaseRates(model.cost, extraCost)
  ) {
    return model;
  }
  return { ...model, cost: { ...model.cost, tiers: extraCost.tiers.map((t) => ({ ...t })) } };
}

/**
 * pi-ai's catalogue plus the extras it does not know yet. pi-ai's entry wins
 * on an id collision, so a pi-ai bump that learns a model supersedes the
 * hand-written entry without an edit here — apart from cost tiers, see
 * {@link withExtraTiers}.
 */
export function mergeBedrockCampCatalogue<T extends MergeableModel>(
  catalogue: readonly T[],
  extras: readonly T[]
): T[] {
  const extrasById = new Map(extras.map((m) => [m.id, m]));
  const known = new Set(catalogue.map((m) => m.id));
  return [
    ...catalogue.map((m) => withExtraTiers(m, extrasById.get(m.id))),
    ...extras.filter((m) => !known.has(m.id)),
  ];
}
