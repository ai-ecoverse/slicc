export const TMPDIR_ENV = 'TMPDIR';

export const SHARED_TMP_ROOT = '/tmp';

export type TmpDirEnv =
  | { get(name: string): string | undefined }
  | Record<string, string | undefined>
  | undefined;

export function scratchDir(env: TmpDirEnv): string {
  const fromEnv =
    env && typeof (env as { get?: unknown }).get === 'function'
      ? (env as { get(name: string): string | undefined }).get(TMPDIR_ENV)
      : (env as Record<string, string | undefined> | undefined)?.[TMPDIR_ENV];

  return fromEnv?.trim() ? fromEnv : SHARED_TMP_ROOT;
}
