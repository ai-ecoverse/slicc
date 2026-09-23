/**
 * The small, dependency-free part of `hf download`: defaults and target-dir
 * resolution. The `hf` command imports only this eagerly and loads the
 * download core (`hf-download.ts`) on first use, so the pool stays out of the
 * kernel worker's boot graph.
 */

/** Files fetched at once when the caller does not say. */
export const DEFAULT_HF_CONCURRENCY = 4;

/**
 * Declared bytes allowed in flight at once when the caller does not say.
 * `proxied-fetch.ts` buffers every response whole and the VFS holds another
 * copy until the write syncs (#3441), so peak memory is a small multiple of
 * this budget — which is why the pool is sized by bytes, not only by file
 * count. A single file larger than the budget still downloads, alone.
 */
export const DEFAULT_HF_MAX_BYTES_IN_FLIGHT = 128 * 1024 * 1024;

/**
 * Resolve the target VFS dir for `--to` (defaults to
 * `/workspace/models/<repo>/`). Trims any trailing slash for joining and
 * always returns an absolute path.
 */
export function resolveTargetDir(repo: string, to: string | null, cwd: string): string {
  const raw = to ?? `/workspace/models/${repo}`;
  const absolute = raw.startsWith('/') ? raw : `${cwd.replace(/\/+$/, '')}/${raw}`;
  return absolute.replace(/\/+$/, '');
}
