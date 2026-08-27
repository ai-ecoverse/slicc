/**
 * The shell variable that names the unit an untargeted lick should go to.
 *
 * Untargeted licks (no `--scoop`, no `targetScoop`) route to the **default
 * root** — `rootsOf(scoops)[0]`, the oldest one. That is right for the default
 * root itself, but a second cone (or a scoop) registering a watcher, a cron
 * task or a webhook from its own shell expects the events back in *its* own
 * chat — so every unit EXCEPT that default root carries its folder here
 * (`ownLickTargetFor` decides, `buildScoopShellEnv` stamps), and every
 * lick-producing command (`fswatch`, `crontask`, `webhook`) falls back to it
 * when `--scoop` is absent (#2272, #2311, #2525).
 *
 * So the variable is missing from exactly one shell — the default root's,
 * whose folder is not worth spending as an alias when an untargeted lick
 * already lands there. Absent both, the value is `undefined` and the lick is
 * untargeted, which is a routable answer rather than an error: omitting
 * `--scoop` is how a caller says "whoever I am" without knowing who that
 * is (#2525).
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
