/**
 * Typed error for "this OAuth provider needs the user to log in again".
 *
 * Thrown from provider token-refresh paths (e.g., `getAdobeAccessToken`
 * when silent renewal fails). Carries the `providerId` so UI layers can
 * offer a direct re-authentication affordance — a clickable "Log in
 * again" button that calls `providerConfig.onOAuthLogin(...)` without
 * forcing the user to open Settings → Provider → Re-login.
 *
 * The surface is intentionally narrow. If we later add other
 * auth-related actions (e.g., 'connect' for not-logged-in states), we
 * can widen `actionHint`; for now a single `'reauth'` tag keeps the
 * error bubble's rendering logic trivial.
 */
export interface AuthErrorMeta {
  /** Provider ID from `ProviderConfig.id` (e.g., `'adobe'`). */
  providerId: string;
  /** What UI affordance to offer. Currently only re-authentication. */
  actionHint: 'reauth';
}

export class AuthError extends Error {
  readonly providerId: string;
  readonly actionHint = 'reauth' as const;

  constructor(providerId: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.providerId = providerId;
    // Ensure `instanceof AuthError` works across bundled/minified code
    // where ES subclassing prototype-chain shenanigans can drop the link.
    Object.setPrototypeOf(this, AuthError.prototype);
  }
}

/**
 * Structural type guard. Prefers `instanceof AuthError` semantically
 * but falls back to duck-typed checks because an error can cross a
 * worker/message-channel boundary (offscreen → side panel) where the
 * constructor identity is lost — we still want the UI to render the
 * re-auth button in that case.
 */
export function isAuthError(e: unknown): e is AuthError {
  if (e instanceof AuthError) return true;
  if (!(e instanceof Error)) return false;
  const anyErr = e as unknown as Partial<AuthError>;
  return anyErr.actionHint === 'reauth' && typeof anyErr.providerId === 'string';
}

/** Extract a plain AuthErrorMeta for event/serialization payloads. */
export function authErrorMeta(err: AuthError): AuthErrorMeta {
  return { providerId: err.providerId, actionHint: err.actionHint };
}
