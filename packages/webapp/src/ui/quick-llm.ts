/**
 * One-shot LLM helper for ad-hoc UI labels (placeholder hints, tool-cluster
 * summaries, follow-up suggestions). Wraps pi-ai's `completeSimple` so the
 * caller doesn't have to plumb credentials, model selection, or the Adobe
 * session-id header.
 *
 * Picks a cheaper sibling in the same model family when one exists
 * (Claude → haiku, GPT/o-series → mini/nano, Gemini → flash, Grok → fast/mini),
 * otherwise falls back to the active model.
 *
 * Returns `null` on any failure (no API key, network error, empty response)
 * so callers can quietly fall back to a static label without try/catch.
 */

import { completeSimple } from '@mariozechner/pi-ai';
import type { Api, Model, UserMessage } from '@mariozechner/pi-ai';
import { createLogger } from '../core/logger.js';
import {
  getApiKey,
  getProviderModels,
  getSelectedModelId,
  getSelectedProvider,
} from './provider-settings.js';

const log = createLogger('quick-llm');

export interface QuickLabelOptions {
  /** User-facing prompt. Keep it short — labels aren't conversations. */
  prompt: string;
  /** Optional system prompt. Use it to constrain output shape (length, tone). */
  system?: string;
  /** Maximum output tokens. Default: 60. */
  maxTokens?: number;
  /** Sampling temperature. Default: 0.3 (favor consistent labels). */
  temperature?: number;
  /** Abort signal for the underlying request. */
  signal?: AbortSignal;
  /**
   * Force a specific model id within the active provider. Skips the
   * cheap-fallback picker. Falls back to the active model if the id is
   * not registered for the active provider.
   */
  modelId?: string;
}

/**
 * Run a one-shot LLM call. Returns the trimmed assistant text, or `null`
 * when the call is unavailable or fails.
 */
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

// --- Model picking ---

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
      // Without a known family, accept any cheaper sibling in the same provider.
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

// --- Adobe session id for ad-hoc UI calls ---
//
// The Adobe LLM proxy groups requests by `X-Session-Id`. The cone/scoop
// session ids are scoped to scoop folders; ad-hoc UI labels don't have
// a scoop, so they get a separate daily-rotated UUID anchored to a
// fixed key. This keeps label calls visible to the proxy as their own
// session without leaking anything about the user's scoops.

const QUICK_LLM_SESSION_KEY = 'slicc:adobe-daily-uuid:ui-quick-llm';
let inMemoryQuickLlmSession: { uuid: string; date: string } | undefined;

function getQuickLlmAdobeSessionId(): string {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = localStorage.getItem(QUICK_LLM_SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { uuid?: string; date?: string };
      if (parsed.date === today && typeof parsed.uuid === 'string') return parsed.uuid;
    }
    const uuid = crypto.randomUUID();
    localStorage.setItem(QUICK_LLM_SESSION_KEY, JSON.stringify({ uuid, date: today }));
    return uuid;
  } catch {
    if (inMemoryQuickLlmSession?.date === today) return inMemoryQuickLlmSession.uuid;
    const uuid = crypto.randomUUID();
    inMemoryQuickLlmSession = { uuid, date: today };
    return uuid;
  }
}

/** Test-only: drop the in-memory Adobe session cache. */
export const __test__ = {
  resetAdobeSession(): void {
    inMemoryQuickLlmSession = undefined;
  },
  pickCheapModel,
  familyOf,
};
