const BEDROCK_CAMP_INFERENCE_PROFILE_RE = /^(us|eu|global|apac|au|jp)\./;
const BEDROCK_CAMP_CLAUDE_RE = /\.anthropic\.claude-(opus|sonnet|haiku|fable)-(?:[4-9]|\d\d)/;

const BEDROCK_CAMP_ALLOWED_NON_CLAUDE_RE =
  /\.(?:openai\.(?:gpt-5\.6-(?:sol|terra|luna)|gpt-6-(?:sol|luna|astra))|moonshotai\.kimi-k3)$/;

const BEDROCK_RUNTIME_HOST_RE =
  /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/i;

export function bedrockCampRegionFromBaseUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  try {
    const { hostname } = new URL(baseUrl);
    return hostname.toLowerCase().match(BEDROCK_RUNTIME_HOST_RE)?.[1] ?? null;
  } catch {
    return null;
  }
}

const JP_REGIONS = new Set(['ap-northeast-1', 'ap-northeast-3']);
const AU_REGIONS = new Set(['ap-southeast-2', 'ap-southeast-4']);

function profileMatchesRegion(prefix: string, region: string): boolean {
  if (prefix === 'global') return true;
  if (prefix === 'us') return region.startsWith('us-');
  if (prefix === 'eu') return region.startsWith('eu-');
  if (prefix === 'apac') return region.startsWith('ap-');
  if (prefix === 'jp') return JP_REGIONS.has(region);
  if (prefix === 'au') return AU_REGIONS.has(region);
  return false;
}

export function isBedrockCampClaudeModel(model: { id: string }): boolean {
  return BEDROCK_CAMP_CLAUDE_RE.test(model.id);
}

type EffortLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type BedrockCampEffortMap = Readonly<Record<EffortLevel, string | null>>;

export const BEDROCK_CAMP_GPT6_EFFORT_MAP: BedrockCampEffortMap = Object.freeze({
  off: 'none',
  minimal: null,
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
});

export const BEDROCK_CAMP_GPT6_ASTRA_EFFORT_MAP: BedrockCampEffortMap = Object.freeze({
  ...BEDROCK_CAMP_GPT6_EFFORT_MAP,
  off: null,
});

const BEDROCK_CAMP_GPT6_RE = /\.openai\.gpt-6-(sol|luna|astra)$/;

export function bedrockCampOpenAIEffortMap(model: { id: string }): BedrockCampEffortMap | null {
  const variant = BEDROCK_CAMP_GPT6_RE.exec(model.id)?.[1];
  if (!variant) return null;
  return variant === 'astra' ? BEDROCK_CAMP_GPT6_ASTRA_EFFORT_MAP : BEDROCK_CAMP_GPT6_EFFORT_MAP;
}

export function isBedrockCampCompatible(model: { id: string }, region?: string | null): boolean {
  if (!BEDROCK_CAMP_INFERENCE_PROFILE_RE.test(model.id)) return false;
  if (
    !BEDROCK_CAMP_CLAUDE_RE.test(model.id) &&
    !BEDROCK_CAMP_ALLOWED_NON_CLAUDE_RE.test(model.id)
  ) {
    return false;
  }
  if (!region) return true;
  const prefix = model.id.split('.', 1)[0];
  return profileMatchesRegion(prefix, region);
}
