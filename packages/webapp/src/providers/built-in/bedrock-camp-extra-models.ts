import {
  BEDROCK_CAMP_GPT6_ASTRA_EFFORT_MAP,
  BEDROCK_CAMP_GPT6_EFFORT_MAP,
} from './bedrock-camp-compat.js';

interface BedrockCampCostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface BedrockCampCostTier extends BedrockCampCostRates {
  inputTokensAbove: number;
}

interface BedrockCampCost extends BedrockCampCostRates {
  tiers?: BedrockCampCostTier[];
}

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

const REGIONAL_PREMIUM = 1.1;

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
  baseId: string;
  name: string;

  profiles: readonly ProfilePrefix[];

  globalCost: BedrockCampCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
}

const EXTRA_MODEL_SPECS: readonly ExtraModelSpec[] = [
  {
    baseId: 'anthropic.claude-opus-5-5',
    name: 'Claude Opus 5.5',
    profiles: ['global', 'us', 'eu', 'jp', 'au'],
    globalCost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
  },

  {
    baseId: 'anthropic.claude-fable-5-1',
    name: 'Claude Fable 5.1',
    profiles: ['global', 'us'],
    globalCost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
  },

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
    thinkingLevelMap: BEDROCK_CAMP_GPT6_EFFORT_MAP,
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
    thinkingLevelMap: BEDROCK_CAMP_GPT6_EFFORT_MAP,
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
    thinkingLevelMap: BEDROCK_CAMP_GPT6_ASTRA_EFFORT_MAP,
  },
  {
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
