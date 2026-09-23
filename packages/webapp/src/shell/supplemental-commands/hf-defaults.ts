export const DEFAULT_HF_CONCURRENCY = 4;

export const DEFAULT_HF_MAX_BYTES_IN_FLIGHT = 128 * 1024 * 1024;

export function resolveTargetDir(repo: string, to: string | null, cwd: string): string {
  const raw = to ?? `/workspace/models/${repo}`;
  const absolute = raw.startsWith('/') ? raw : `${cwd.replace(/\/+$/, '')}/${raw}`;
  return absolute.replace(/\/+$/, '');
}
