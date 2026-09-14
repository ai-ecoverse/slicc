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

export const XaiErrorCode = {
  AUTHORIZATION_FAILED: 'authorization_failed',

  STATE_MISMATCH: 'state_mismatch',

  CODE_MISSING: 'code_missing',

  TOKEN_EXCHANGE_FAILED: 'token_exchange_failed',

  TOKEN_EXCHANGE_INVALID: 'token_exchange_invalid',

  REFRESH_MISSING: 'refresh_missing',

  REFRESH_FAILED: 'refresh_failed',

  AUTH_MISSING: 'auth_missing',

  CALLBACK_TIMEOUT: 'callback_timeout',
} as const;
