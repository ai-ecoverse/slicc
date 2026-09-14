export const SILENT_RENEW_FAILURE_COOLDOWN_MS = 5 * 60_000;

export interface SilentRenewBackoff {
  run(renew: () => Promise<string | null>, now?: number): Promise<string | null>;

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
