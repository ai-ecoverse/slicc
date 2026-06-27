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
 * Detect a cone failure caused by an invalid model id (e.g. the user is on a
 * stale alias the active provider doesn't accept). Bedrock CAMP wraps the
 * upstream message as `Validation error: Bedrock CAMP API error (400): … The
 * provided model identifier is invalid …` (see
 * `providers/built-in/bedrock-camp.ts:formatHttpError`); other providers may
 * pass the substring through verbatim. Match the substring case-insensitively
 * so future provider wrappings don't drift out of detection.
 */
export function isInvalidModelError(content: string | null | undefined): boolean {
  if (!content) return false;
  return content.toLowerCase().includes('the provided model identifier is invalid');
}

/**
 * Detect a cone failure caused by an expired/revoked auth session. The Adobe
 * `getValidAccessToken` session-expired message ends with `please log in
 * again`; the cone may wrap it with a `Scoop … failed with unrecoverable
 * error: ` prefix, so match the substring case-insensitively rather than the
 * whole string.
 */
export function isAuthExpiredError(content: string | null | undefined): boolean {
  if (!content) return false;
  return content.toLowerCase().includes('please log in again');
}

/** Whether an error belongs to one of the three user-fixable families. */
export function isUserFixableError(content: string | null | undefined): boolean {
  return isNoApiKeyError(content) || isInvalidModelError(content) || isAuthExpiredError(content);
}
