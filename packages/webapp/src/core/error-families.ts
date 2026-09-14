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

export interface QuotaExceededDetail {
  message: string;

  resetsAt: string | null;
}

const QUOTA_ERROR_TYPE = 'quota_exceeded';

const QUOTA_FALLBACK_MESSAGE = 'The usage budget for this provider has been fully used.';

const QUOTA_CONNECT_CTA_RE = /\s*You can (?:also )?connect your own LLM provider\.?\s*$/i;

export function isQuotaExceededError(content: string | null | undefined): boolean {
  if (typeof content !== 'string' || !content) return false;
  return content.toLowerCase().includes(QUOTA_ERROR_TYPE);
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

export function parseQuotaExceededError(
  content: string | null | undefined
): QuotaExceededDetail | null {
  if (!isQuotaExceededError(content)) return null;
  const envelope = embeddedJsonObject(content as string);
  const raw = typeof envelope?.error?.message === 'string' ? envelope.error.message : '';
  const message = raw.replace(QUOTA_CONNECT_CTA_RE, '').trim();
  const resetsAt =
    typeof envelope?.error?.resets_at === 'string' && envelope.error.resets_at.length > 0
      ? envelope.error.resets_at
      : null;
  return { message: message || QUOTA_FALLBACK_MESSAGE, resetsAt };
}

export function isUserFixableError(content: string | null | undefined): boolean {
  return (
    isNoApiKeyError(content) ||
    isInvalidModelError(content) ||
    isAuthExpiredError(content) ||
    isQuotaExceededError(content)
  );
}
