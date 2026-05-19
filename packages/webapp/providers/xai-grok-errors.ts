/**
 * Typed errors for the xAI Grok provider.
 *
 * Codes let the login flow and stream handlers distinguish retryable failures
 * (network, OIDC discovery) from fatal ones (revoked refresh token).
 *
 * Adapted from https://github.com/stnly/pi-grok/blob/main/errors.ts.
 */

export class XaiOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly reloginRequired = false
  ) {
    super(message);
    this.name = 'XaiOAuthError';
  }
}

/** Well-known error codes. */
export const XaiErrorCode = {
  /** Authorization was denied or errored in the browser. */
  AUTHORIZATION_FAILED: 'authorization_failed',
  /** CSRF state mismatch between request and callback. */
  STATE_MISMATCH: 'state_mismatch',
  /** Callback did not include an authorization code. */
  CODE_MISSING: 'code_missing',
  /** Token exchange failed (network, invalid response). */
  TOKEN_EXCHANGE_FAILED: 'token_exchange_failed',
  /** Token exchange returned an invalid payload. */
  TOKEN_EXCHANGE_INVALID: 'token_exchange_invalid',
  /** Refresh token is missing or empty. */
  REFRESH_MISSING: 'refresh_missing',
  /** Token refresh failed (expired, revoked). */
  REFRESH_FAILED: 'refresh_failed',
  /** No credentials stored. */
  AUTH_MISSING: 'auth_missing',
  /** Capture step (CDP intercept) timed out. */
  CALLBACK_TIMEOUT: 'callback_timeout',
} as const;
