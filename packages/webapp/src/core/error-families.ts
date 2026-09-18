/**
 * Detection predicates for user-fixable agent error families. Lives in a
 * standalone module so both the UI render path (`wc-message-view.ts`, where
 * these flip the error-card CTA) and the telemetry path (`telemetry.ts`,
 * where they suppress noisy RUM beacons for known-good remediation UX) can
 * share the same definitions without forming an import cycle —
 * `wc-message-view.ts` already imports `telemetry.ts` for `trackImageView`.
 */

/**
 * Literal prefix shared by both `No API key configured…` variants emitted by
 * `scoop-context.ts` (`No API key configured for provider "<id>". …` and the
 * provider-less `No API key configured. …`). Prefix-match rather than full
 * string match so the interpolated provider name doesn't break detection.
 */
export const NO_API_KEY_ERROR_PREFIX = 'No API key configured';

/** Whether an error message string is the "no API key" failure. */
export function isNoApiKeyError(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.startsWith(NO_API_KEY_ERROR_PREFIX);
}

/**
 * Detect a cone failure caused by an invalid or unauthorized model id (e.g.
 * the user is on a stale alias the active provider doesn't accept, or the
 * selected model isn't entitled for the account). Bedrock CAMP wraps the
 * upstream message as `Validation error: Bedrock CAMP API error (400): … The
 * provided model identifier is invalid …` (see
 * `providers/built-in/bedrock-camp.ts:formatHttpError`); the Adobe proxy
 * returns `403 {"error":{"type":"forbidden","message":"Model not allowed:
 * <id>"}}` for accounts without entitlement; other providers may pass either
 * substring through verbatim. Match case-insensitively so future provider
 * wrappings don't drift out of detection. Both families flow to the same
 * `change-model` error-card action, so grouping them here keeps the
 * remediation UX consistent.
 */
export function isInvalidModelError(content: string | null | undefined): boolean {
  if (typeof content !== 'string' || !content) return false;
  const lower = content.toLowerCase();
  return (
    lower.includes('the provided model identifier is invalid') ||
    lower.includes('model not allowed')
  );
}

/**
 * Detect a cone failure caused by an expired/revoked auth session. The Adobe
 * `getValidAccessToken` session-expired message ends with `please log in
 * again`; the cone may wrap it with a `Scoop … failed with unrecoverable
 * error: ` prefix, so match the substring case-insensitively rather than the
 * whole string.
 */
export function isAuthExpiredError(content: string | null | undefined): boolean {
  if (typeof content !== 'string' || !content) return false;
  return content.toLowerCase().includes('please log in again');
}

/**
 * Provider-neutral detail parsed out of an exhausted AI budget. The Adobe
 * proxy answers an exhausted budget with
 * `429 {"error":{"type":"quota_exceeded","message":"Weekly budget has been
 * fully used. Resets on 2026-09-14. You can also connect your own LLM
 * provider.","resets_at":"2026-09-14T00:00:00.000Z"}}` — the whole envelope
 * reaches the error card verbatim. Grok answers the same user state as a 403
 * explaining that the account ran out of resources or has no active Grok
 * subscription. Both become this shape so rendering, retries, transcripts,
 * and telemetry agree despite the providers' different status codes.
 */
export interface ExhaustedBudgetDetail {
  /**
   * Provider-appropriate explanation, with any trailing "connect your own LLM
   * provider" sentence dropped: the card's CTAs now DO that, so leaving it in
   * would tell the user to find an affordance they are already looking at.
   */
  message: string;
  /** ISO-8601 instant the budget refills, when the provider sent one. */
  resetsAt: string | null;
}

/** The `error.type` the Adobe proxy stamps on an exhausted-budget refusal. */
const ADOBE_QUOTA_ERROR_TYPE = 'quota_exceeded';

/**
 * Stable halves of Grok's 403 credit/subscription refusal. Subscription
 * markers keep the "Grok" token so a third provider's generic credits +
 * subscription prose cannot enter this family and inherit Grok-branded copy.
 */
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

/**
 * Fallback body for a `quota_exceeded` envelope whose `message` is missing or
 * empty — the type alone still tells the user what happened.
 */
const ADOBE_QUOTA_FALLBACK_MESSAGE = 'The usage budget for this provider has been fully used.';

/** Readable copy for Grok's status-prefixed or JSON-wrapped 403 body. */
const GROK_EXHAUSTED_MESSAGE =
  'Your Grok account has run out of credits or does not have an active subscription.';

/** Trailing self-service sentence the card's CTAs replace. */
const QUOTA_CONNECT_CTA_RE = /\s*You can (?:also )?connect your own LLM provider\.?\s*$/i;

/**
 * Detect a cone failure caused by an exhausted provider budget. Adobe is
 * matched on its machine-readable `error.type`; Grok is matched on a resource
 * half plus a Grok-named subscription half of its 403 refusal. The Grok token
 * in the subscription markers keeps ordinary permission failures, transient
 * 429s, and other providers' generic credits/subscription prose outside this
 * family. Substring matching also survives a `Scoop … failed with
 * unrecoverable error: ` wrapper.
 */
export function isExhaustedBudgetError(content: string | null | undefined): boolean {
  if (typeof content !== 'string' || !content) return false;
  const lower = content.toLowerCase();
  if (lower.includes(ADOBE_QUOTA_ERROR_TYPE)) return true;
  return (
    GROK_RESOURCE_MARKERS.some((marker) => lower.includes(marker)) &&
    GROK_SUBSCRIPTION_MARKERS.some((marker) => lower.includes(marker))
  );
}

/** Envelope shape read out of a `quota_exceeded` body — every field unverified. */
interface QuotaEnvelope {
  error?: { message?: unknown; resets_at?: unknown };
}

/**
 * The `{ … }` JSON object embedded in an error string (the provider status
 * line prefixes it, e.g. `429 {…}`). Widest span from the first `{` to the
 * last `}` so a wrapper prefix never breaks the parse; `null` when the string
 * carries no parseable object.
 */
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

/**
 * Parse an exhausted-budget failure into the pieces the error card renders.
 * Returns `null` for anything outside that family, so callers can use it as
 * the detect-and-parse step in one call. A malformed or truncated Adobe
 * envelope still yields a detail; a Grok refusal gets stable provider-specific
 * prose instead of exposing an adapter prefix or management URL.
 */
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

/** Whether an error belongs to one of the four user-fixable families. */
export function isUserFixableError(content: string | null | undefined): boolean {
  return (
    isNoApiKeyError(content) ||
    isInvalidModelError(content) ||
    isAuthExpiredError(content) ||
    isExhaustedBudgetError(content)
  );
}
