import type { Api, Model, UserMessage } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { hasIcon } from '@slicc/webcomponents/icons';

import { icons as lucideIcons } from 'lucide';
import { createLogger } from '../base/logger.js';
import { getDailyAdobeUuid } from '../scoops/llm-session-id.js';
import {
  getApiKey,
  getProviderModels,
  getSelectedModelId,
  getSelectedProvider,
} from './account-store.js';

const log = createLogger('quick-llm');

export interface QuickLabelOptions {
  prompt: string;

  system?: string;

  maxTokens?: number;

  temperature?: number;

  signal?: AbortSignal;

  modelId?: string;
}

export async function quickLabel(opts: QuickLabelOptions): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    log.debug('No API key for active provider — skipping');
    return null;
  }

  const providerId = getSelectedProvider();
  const activeModelId = getSelectedModelId();

  let model: Model<Api> | undefined;
  if (opts.modelId) {
    model = findModel(providerId, opts.modelId) ?? findModel(providerId, activeModelId);
  } else {
    model = pickCheapModel(providerId, activeModelId);
  }
  if (!model) {
    log.debug('No model available for provider', { providerId });
    return null;
  }

  const userMessage: UserMessage = {
    role: 'user',
    content: opts.prompt,
    timestamp: Date.now(),
  };

  const headers: Record<string, string> = {};
  if (model.provider === 'adobe') {
    headers['X-Session-Id'] = getQuickLlmAdobeSessionId();
  }

  try {
    const message = await completeSimple(
      model,
      { systemPrompt: opts.system, messages: [userMessage] },
      {
        apiKey,
        maxTokens: opts.maxTokens ?? 60,
        temperature: opts.temperature ?? 0.3,
        signal: opts.signal,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
      }
    );

    const text = message.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();

    return text.length > 0 ? text : null;
  } catch (err) {
    log.debug('Quick label call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

let cachedIconNames: string[] | null = null;

function pascalToKebab(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Za-z])(\d)/g, '$1-$2')
    .toLowerCase();
}

export function lucideIconNames(): string[] {
  if (!cachedIconNames) {
    cachedIconNames = Object.keys(lucideIcons).map(pascalToKebab).sort();
  }
  return cachedIconNames;
}

export interface PickLucideIconOptions {
  subject: string;
  signal?: AbortSignal;

  labelFn?: (opts: QuickLabelOptions) => Promise<string | null>;
}

export async function pickLucideIcon(opts: PickLucideIconOptions): Promise<string | null> {
  const names = lucideIconNames();
  const labelFn = opts.labelFn ?? quickLabel;
  const raw = await labelFn({
    system:
      'You pick ONE icon for a UI element. Respond with exactly one icon name ' +
      'from the provided list — lowercase, no quotes, no punctuation, nothing else.',
    prompt: `Pick the single most fitting icon for: ${opts.subject}\n\nValid icon names:\n${names.join(' ')}`,
    maxTokens: 16,
    temperature: 0.2,
    signal: opts.signal,
  });
  if (!raw) return null;
  const candidate = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return hasIcon(candidate) ? candidate : null;
}

type ModelFamily = 'claude' | 'gpt' | 'gemini' | 'grok' | 'unknown';

function pickCheapModel(providerId: string, activeModelId: string): Model<Api> | undefined {
  const all = getProviderModels(providerId);
  if (all.length === 0) return undefined;

  const active = all.find((m) => m.id === activeModelId) ?? all[0];
  const family = familyOf(active.id);

  const candidates = all.filter((m) => isCheapSibling(m, active, family));
  if (candidates.length === 0) return active;

  candidates.sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0));
  return candidates[0];
}

function isCheapSibling(m: Model<Api>, active: Model<Api>, family: ModelFamily): boolean {
  if (m.id === active.id) return false;
  const activeCost = active.cost?.input ?? Number.POSITIVE_INFINITY;
  const candidateCost = m.cost?.input ?? Number.POSITIVE_INFINITY;
  if (candidateCost >= activeCost) return false;

  const id = m.id.toLowerCase();
  switch (family) {
    case 'claude':
      return id.includes('haiku');
    case 'gpt':
      return /(^|-)mini(-|$)|(^|-)nano(-|$)/.test(id);
    case 'gemini':
      return id.includes('flash');
    case 'grok':
      return /(^|-)mini(-|$)|(^|-)fast(-|$)/.test(id);
    case 'unknown':
      return true;
  }
}

function familyOf(id: string): ModelFamily {
  const lower = id.toLowerCase();
  if (lower.includes('claude')) return 'claude';
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('grok')) return 'grok';
  if (/^(gpt|o\d)/.test(lower)) return 'gpt';
  return 'unknown';
}

function findModel(providerId: string, modelId: string): Model<Api> | undefined {
  return getProviderModels(providerId).find((m) => m.id === modelId);
}

const QUICK_LLM_SESSION_ANCHOR = 'ui-quick-llm';

function getQuickLlmAdobeSessionId(): string {
  return getDailyAdobeUuid(QUICK_LLM_SESSION_ANCHOR);
}

export const __test__ = {
  pickCheapModel,
  familyOf,
};
