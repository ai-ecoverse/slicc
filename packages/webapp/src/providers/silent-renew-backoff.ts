/**
 * Failure backoff for silent token renewal.
 *
 * After a failed silent renewal we avoid re-hitting the IdP on every stream /
 * turn: a genuinely dead session won't recover by retrying, and pi-agent-core
 * stream retries amplify the traffic. The cooldown re-probes once it elapses
 * (so it recovers if the user re-authenticated elsewhere) and clears
 * immediately on a successful renewal. Callers are expected to gate this behind
 * their own expiry check, so a still-valid token normally never reaches here.
 *
 * Five minutes balances "stop hammering IMS on a dead session" against
 * "recover promptly after re-auth". Not derived from token lifetime; tune
 * freely.
 */
export const SILENT_RENEW_FAILURE_COOLDOWN_MS = 5 * 60_000;

export interface SilentRenewBackoff {
  /**
   * Run `renew` unless we're inside a post-failure cooldown. Returns the token
   * on success, or null if renewal failed/threw or was skipped due to cooldown.
   */
  run(renew: () => Promise<string | null>, now?: number): Promise<string | null>;
  /** True while a post-failure cooldown is active. */
  inCooldown(now?: number): boolean;
}

export function createSilentRenewBackoff(
  cooldownMs: number = SILENT_RENEW_FAILURE_COOLDOWN_MS
): SilentRenewBackoff {
  let cooldownUntil = 0;
  return {
    async run(renew, now = Date.now()) {
      if (now < cooldownUntil) return null;
      let token: string | null = null;
      try {
        token = await renew();
      } catch (err) {
        // renew() is expected to log its own failure reason; this is a safety
        // net so a caller whose renew() throws an un-logged reason still leaves
        // a trace instead of vanishing silently.
        console.debug(
          '[silent-renew-backoff] renew threw:',
          err instanceof Error ? err.message : String(err)
        );
        token = null;
      }
      cooldownUntil = token ? 0 : now + cooldownMs;
      return token;
    },
    inCooldown(now = Date.now()) {
      return now < cooldownUntil;
    },
  };
}
