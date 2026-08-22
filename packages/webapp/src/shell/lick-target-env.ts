/**
 * The shell variable that names the unit an untargeted lick should go to.
 *
 * Untargeted licks (no `--scoop`, no `targetScoop`) route to the **primary**
 * cone. That is right for the primary and for scoops (their licks are the
 * cone's business), but a second cone registering a watcher or a cron task
 * from its own shell expects the events back in *its* chat — so every
 * non-primary root's shell carries its folder here, and the lick-producing
 * command (`fswatch`; `crontask` follows in #2311, its file sits behind the
 * boy-scout debt gate) falls back to it when `--scoop` is absent (#2272).
 */
export const LICK_TARGET_ENV = 'SLICC_LICK_TARGET';

/** A just-bash env (`Map`) or a plain record — some hosts hand commands either. */
export type LickTargetEnv =
  | { get(name: string): string | undefined }
  | Record<string, string | undefined>
  | undefined;

/** `--scoop` value to use: the explicit one, else the shell's default target. */
export function defaultLickTarget(
  explicit: string | undefined,
  env: LickTargetEnv
): string | undefined {
  if (explicit) return explicit;
  const fromEnv =
    env && typeof (env as { get?: unknown }).get === 'function'
      ? (env as { get(name: string): string | undefined }).get(LICK_TARGET_ENV)
      : (env as Record<string, string | undefined> | undefined)?.[LICK_TARGET_ENV];
  return fromEnv || undefined;
}
