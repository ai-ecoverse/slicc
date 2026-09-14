export interface AdobeModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AdobeModelMetadata {
  id: string;
  name?: string;
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: AdobeModelCost;
}

export interface AdobeModelCompat {
  supportsEagerToolInputStreaming: boolean;
}

export interface EnrichedAdobeModel {
  id: string;
  name: string;
  api?: 'anthropic' | 'openai';
  context_window?: number;
  max_tokens?: number;
  reasoning?: boolean;
  input?: string[];
  cost?: AdobeModelCost;
  compat?: AdobeModelCompat;
  thinkingLevelMap?: Record<string, string | null>;
}

export function enrichAdobeModel(
  entry: AdobeModelMetadata,
  cached?: AdobeModelMetadata
): EnrichedAdobeModel {
  const out: EnrichedAdobeModel = { id: entry.id, name: entry.name ?? entry.id };

  const api = cached?.api ?? entry.api;
  const contextWindow = cached?.context_window ?? entry.context_window;
  const maxTokens = cached?.max_tokens ?? entry.max_tokens;
  const reasoning = cached?.reasoning ?? entry.reasoning;
  const input = cached?.input ?? entry.input;

  if (api) out.api = api;
  if (contextWindow !== undefined) out.context_window = contextWindow;
  if (maxTokens !== undefined) out.max_tokens = maxTokens;
  if (reasoning !== undefined) out.reasoning = reasoning;
  if (input) out.input = input;

  const cost = cached?.cost ?? entry.cost;
  if (cost) out.cost = cost;

  if (/haiku/i.test(entry.id)) {
    out.compat = { supportsEagerToolInputStreaming: false };
  }

  if (/sonnet-5\b/i.test(entry.id) && !out.thinkingLevelMap) {
    out.thinkingLevelMap = { xhigh: 'xhigh' };
  }

  return out;
}
