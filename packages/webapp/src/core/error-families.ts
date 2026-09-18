export const NO_API_KEY_ERROR_PREFIX = 'No API key configured';

export function isNoApiKeyError(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.startsWith(NO_API_KEY_ERROR_PREFIX);
}

export function isInvalidModelError(content: string | null | undefined): boolean {
  if (typeof content !== 'string' || !content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes('the provided model identifier is invalid') ||
    lower.includes('model not allowed')
  );
}

export function isAuthExpiredError(content: string | null | undefined): boolean {
  if (typeof content !== 'string' || !content) return false;
  return content.toLowerCase().includes('please log in again');
}

export interface ExhaustedBudgetDetail {
  message: string;

  resetsAt: string | null;
}

const ADOBE_QUOTA_ERROR_TYPE = 'quota_exceeded';

const GROK_RESOURCE_MARKERS = [
  'run out of available resources',
  'ran out of available resources',
  'run out of credits',
  'ran out of credits',
] as const;
const GROK_SUBSCRIPTION_MARKERS = [
  'active grok subscription',
  'need a grok subscription',
  'needs a grok subscription',
] as const;

const ADOBE_QUOTA_FALLBACK_MESSAGE = 'The usage budget for this provider has been fully used.';

const GROK_EXHAUSTED_MESSAGE =
  'Your Grok account has run out of credits or does not have an active subscription.';

const QUOTA_CONNECT_CTA_RE = /\s*You can (?:also )?connect your own LLM provider\.?\s*$/i;

export function isExhaustedBudgetError(content: string | null | undefined): boolean {
  if (typeof content !== 'string' || !content) return false;
  const lower = content.toLowerCase();
  if (lower.includes(ADOBE_QUOTA_ERROR_TYPE)) return true;
  return (
    GROK_RESOURCE_MARKERS.some((marker) => lower.includes(marker)) &&
    GROK_SUBSCRIPTION_MARKERS.some((marker) => lower.includes(marker))
  );
}

interface QuotaEnvelope {
  error?: { message?: unknown; resets_at?: unknown };
}

function embeddedJsonObject(content: string): QuotaEnvelope | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as QuotaEnvelope;
  } catch {
    return null;
  }
}

export function parseExhaustedBudgetError(
  content: string | null | undefined
): ExhaustedBudgetDetail | null {
  if (typeof content !== 'string' || !isExhaustedBudgetError(content)) return null;
  if (!content.toLowerCase().includes(ADOBE_QUOTA_ERROR_TYPE)) {
    return { message: GROK_EXHAUSTED_MESSAGE, resetsAt: null };
  }
  const envelope = embeddedJsonObject(content);
  const raw = typeof envelope?.error?.message === 'string' ? envelope.error.message : '';
  const message = raw.replace(QUOTA_CONNECT_CTA_RE, '').trim();
  const resetsAt =
    typeof envelope?.error?.resets_at === 'string' && envelope.error.resets_at.length > 0
      ? envelope.error.resets_at
      : null;
  return { message: message || ADOBE_QUOTA_FALLBACK_MESSAGE, resetsAt };
}

export function isUserFixableError(content: string | null | undefined): boolean {
  return (
    isNoApiKeyError(content) ||
    isInvalidModelError(content) ||
    isAuthExpiredError(content) ||
    isExhaustedBudgetError(content)
  );
}
