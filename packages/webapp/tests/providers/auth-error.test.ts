import { describe, it, expect } from 'vitest';
import { AuthError, isAuthError, authErrorMeta } from '../../src/providers/auth-error.js';

describe('AuthError', () => {
  it('carries the providerId and actionHint', () => {
    const err = new AuthError('adobe', 'Adobe session expired — please log in again');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AuthError);
    expect(err.name).toBe('AuthError');
    expect(err.providerId).toBe('adobe');
    expect(err.actionHint).toBe('reauth');
    expect(err.message).toBe('Adobe session expired — please log in again');
  });

  it('is recognized by isAuthError via instanceof', () => {
    const err = new AuthError('adobe', 'x');
    expect(isAuthError(err)).toBe(true);
  });

  it('is recognized by isAuthError via structural fallback (cross-boundary case)', () => {
    // Simulate an error that crossed a chrome.runtime message channel
    // and lost its constructor identity — a plain Error with the right
    // shape. isAuthError must still identify it so the UI renders the
    // re-auth button in the extension float.
    const fake: Error & { providerId: string; actionHint: 'reauth' } = Object.assign(
      new Error('expired'),
      { providerId: 'adobe', actionHint: 'reauth' as const }
    );
    expect(fake instanceof AuthError).toBe(false);
    expect(isAuthError(fake)).toBe(true);
  });

  it('rejects plain Errors and non-Errors', () => {
    expect(isAuthError(new Error('x'))).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError('AuthError')).toBe(false);
    expect(isAuthError({ providerId: 'adobe', actionHint: 'reauth' })).toBe(false);
  });

  it('authErrorMeta strips the error down to a serializable payload', () => {
    const err = new AuthError('adobe', 'expired');
    const meta = authErrorMeta(err);
    expect(meta).toEqual({ providerId: 'adobe', actionHint: 'reauth' });
    // Should survive JSON round-trip (chrome.runtime / session store).
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta);
  });
});
