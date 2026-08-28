/**
 * The shell variable naming a unit's own scratch directory, and the one place
 * a command turns it into a path.
 *
 * `buildScoopShellEnv` stamps it per unit — `/tmp/<cone>` for a cone,
 * `/tmp/<cone>/<scoop>` for a scoop — and `AlmostBashShellHeadless` sets the
 * bare `/tmp` floor for shells with no work unit behind them (the panel
 * terminal, tests). `mktemp` resolves against it, and so should any command
 * that invents a default output path (#2267).
 *
 * A command that hardcodes `/tmp` instead is not broken — the whole tree stays
 * writable by everyone — but it drops its output into the shared root, where a
 * sibling cone's "New chat" will not dispose of it and where two units writing
 * the same default name collide. That is the entire difference this variable
 * buys, so honouring it is a convention, not an enforcement boundary
 * ([#2568](https://github.com/ai-ecoverse/slicc/issues/2568)).
 *
 * The `/tmp` fallback is deliberate rather than an error: an unset `TMPDIR` is
 * how a host without a unit says "no opinion", and the shared root is the
 * answer every caller used before this existed.
 */
export const TMPDIR_ENV = 'TMPDIR';

/** Root of the shared scratch tree — the fallback when `TMPDIR` is unset. */
export const SHARED_TMP_ROOT = '/tmp';

/** A just-bash env (`Map`) or a plain record — some hosts hand commands either. */
export type TmpDirEnv =
  | { get(name: string): string | undefined }
  | Record<string, string | undefined>
  | undefined;

/**
 * The directory a command should put default-named scratch output in.
 *
 * Mirrors `defaultLickTarget` in `lick-target-env.ts`, including the
 * Map-or-record duality: the shell hands commands a `Map`, while several test
 * and host paths pass a plain object.
 */
export function scratchDir(env: TmpDirEnv): string {
  const fromEnv =
    env && typeof (env as { get?: unknown }).get === 'function'
      ? (env as { get(name: string): string | undefined }).get(TMPDIR_ENV)
      : (env as Record<string, string | undefined> | undefined)?.[TMPDIR_ENV];
  // An empty or whitespace-only value is a misconfiguration, not a request to
  // write to `''` — POSIX `mktemp` treats it the same way.
  return fromEnv?.trim() || SHARED_TMP_ROOT;
}
