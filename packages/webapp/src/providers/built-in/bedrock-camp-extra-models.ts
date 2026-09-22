interface BedrockCampCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
    cost: prefix === 'global' ? { ...spec.globalCost } : regionalCost(spec.globalCost),
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(spec.thinkingLevelMap ? { thinkingLevelMap: { ...spec.thinkingLevelMap } } : {}),
  }));
}

export const BEDROCK_CAMP_EXTRA_MODELS: readonly BedrockCampExtraModel[] =
  EXTRA_MODEL_SPECS.flatMap(expandSpec);

export function mergeBedrockCampCatalogue<T extends { id: string }>(
  catalogue: readonly T[],
  extras: readonly T[]
): T[] {
  const known = new Set(catalogue.map((m) => m.id));
  return [...catalogue, ...extras.filter((m) => !known.has(m.id))];
}
