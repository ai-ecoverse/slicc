export const LICK_TARGET_ENV = 'SLICC_LICK_TARGET';

export type LickTargetEnv =
  | { get(name: string): string | undefined }
  | Record<string, string | undefined>
  | undefined;

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
