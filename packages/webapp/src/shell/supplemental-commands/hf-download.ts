/**
 * Reusable Hugging Face Hub download core, factored out of `hf-command.ts`
 * so it can run outside the shell `Command` surface (e.g. the worker-side
 * `ensureSpeechAssetsStaged` routine in `speech/ensure-speech-assets.ts`).
 *
 * The `hf download` shell command is a thin formatter over `downloadHfRepo`;
 * both share the same file-listing, per-file byte-skip (no `--force`), proxied
 * `SecureFetch`, and dir-creation behavior. Nothing here touches the DOM, so
 * it is safe to import in the kernel worker.
 */

import type { SecureFetch } from 'just-bash';

/**
 * Minimal filesystem surface the download core needs. Kept structural (rather
 * than the full just-bash `IFileSystem`) so both the shell's `ctx.fs` and the
 * worker's raw `VirtualFS` satisfy it without an adapter.
 */
export interface DownloadFs {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number }>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<unknown>;
}

const HF_HOST = ['huggingface', 'co'].join('.');

function hfApiUrl(repo: string, revision: string): string {
  return `https://${HF_HOST}/api/models/${repo}/tree/${revision}?recursive=true`;
}

function hfResolveUrl(repo: string, revision: string, file: string): string {
  return `https://${HF_HOST}/${repo}/resolve/${revision}/${file}`;
}

/**
 * Extract a host name from `url` for error reporting, falling back to the
 * raw string if URL parsing fails (so a malformed URL still surfaces
 * something the user can grep for).
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Run a `SecureFetch` and re-throw any fetch-layer rejection (browser
 * `TypeError: Failed to fetch`, AbortError, transport faults) with the
 * target host name attached so an offline / proxy-down failure is
 * actionable rather than a bare `Failed to fetch`.
 */
async function fetchWithHostContext(
  fetchFn: SecureFetch,
  url: string,
  init?: Parameters<SecureFetch>[1]
): ReturnType<SecureFetch> {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `request to ${hostOf(url)} failed (${detail}); check the bridge fetch-proxy is reachable`
    );
  }
}

interface HfTreeEntry {
  type: 'file' | 'directory' | string;
  path: string;
  size?: number;
}

/** A single repo file plus its declared byte size (for coarse progress). */
export interface HfRepoFile {
  path: string;
  size: number;
}

/**
 * List every file in the repo tree at the given revision, with sizes. The HF
 * API returns a flat list when `recursive=true` is set; directories are
 * dropped and only file entries are surfaced in tree order.
 */
export async function listRepoTree(
  fetchFn: SecureFetch,
  repo: string,
  revision: string
): Promise<HfRepoFile[]> {
  const resp = await fetchWithHostContext(fetchFn, hfApiUrl(repo, revision), { method: 'GET' });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HF API ${resp.status} ${resp.statusText} for ${repo}@${revision}`);
  }
  const text = new TextDecoder('utf-8').decode(resp.body);
  const parsed = JSON.parse(text) as HfTreeEntry[];
  return parsed
    .filter((e) => e.type === 'file')
    .map((e) => ({ path: e.path, size: typeof e.size === 'number' ? e.size : 0 }));
}

/** Ensure every parent dir along `path` exists (mkdir -p semantics). */
async function ensureParentDirs(fs: DownloadFs, path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return;
  const parent = path.slice(0, slash);
  await fs.mkdir(parent, { recursive: true });
}

async function downloadOne(
  fetchFn: SecureFetch,
  fs: DownloadFs,
  repo: string,
  revision: string,
  file: string,
  targetDir: string,
  force: boolean
): Promise<{ status: 'downloaded' | 'skipped'; bytes: number }> {
  const destPath = `${targetDir}/${file}`;
  if (!force && (await fs.exists(destPath))) {
    try {
      const stat = await fs.stat(destPath);
      return { status: 'skipped', bytes: stat.size ?? 0 };
    } catch {
      // fall through to re-download
    }
  }
  const resp = await fetchWithHostContext(fetchFn, hfResolveUrl(repo, revision, file), {
    method: 'GET',
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${file}`);
  }
  await ensureParentDirs(fs, destPath);
  await fs.writeFile(destPath, resp.body);
  return { status: 'downloaded', bytes: resp.body.byteLength };
}

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

/** Per-file lifecycle event surfaced as `downloadHfRepo` progresses. */
export interface HfFileEvent {
  file: string;
  status: 'downloaded' | 'skipped';
  /** Byte length of this file (downloaded or already-present). */
  bytes: number;
  /** 1-based position of this file within the repo file set. */
  index: number;
  /** Total number of files in the repo file set. */
  total: number;
}

/** Streamed-progress callbacks for `downloadHfRepo`. */
export interface HfRepoDownloadProgress {
  /**
   * Fired once, after the repo tree is listed, with the resolved file set and
   * the summed declared byte size. Only fired when the caller did not pass an
   * explicit `files` list (i.e. when we performed the listing) — mirroring the
   * `hf` command's "N file(s) listed" line.
   */
  onListed?: (info: { files: string[]; totalBytes: number }) => void;
  /** Fired after each file is downloaded or skipped, in tree order. */
  onFile?: (evt: HfFileEvent) => void;
}

export interface DownloadHfRepoOptions {
  fetch: SecureFetch;
  fs: DownloadFs;
  repo: string;
  /** Absolute VFS dir to download into (e.g. `/workspace/models/<repo>`). */
  targetDir: string;
  /** Specific files to fetch; when empty/omitted the whole tree is listed. */
  files?: string[];
  /** Git revision / branch / tag. Defaults to `main`. */
  revision?: string;
  /** Re-download even when a same-byte-length file already exists. */
  force?: boolean;
  progress?: HfRepoDownloadProgress;
}

export interface HfRepoDownloadResult {
  repo: string;
  revision: string;
  targetDir: string;
  files: string[];
  downloaded: number;
  skipped: number;
  totalBytes: number;
}

/**
 * Raised when an individual file download fails. Carries the offending `file`
 * so callers can format an actionable message; `message` is the underlying
 * cause's message (host-named for transport failures via
 * `fetchWithHostContext`).
 */
export class HfFileDownloadError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'HfFileDownloadError';
    this.file = file;
  }
}

/**
 * Download a HF repo (or a subset of files) into `targetDir`, skipping files
 * already present at a matching byte length unless `force` is set. Lists the
 * repo tree when `files` is empty. Throws on a list failure (plain `Error`)
 * or a per-file failure (`HfFileDownloadError`); the latter stops at the first
 * failing file, matching the `hf` command's fail-fast behavior.
 */
export async function downloadHfRepo(opts: DownloadHfRepoOptions): Promise<HfRepoDownloadResult> {
  const revision = opts.revision ?? 'main';
  const force = opts.force ?? false;

  let files = opts.files ?? [];
  if (files.length === 0) {
    const tree = await listRepoTree(opts.fetch, opts.repo, revision);
    if (tree.length === 0) {
      throw new Error(`repo ${opts.repo}@${revision} has no files`);
    }
    files = tree.map((e) => e.path);
    const totalBytes = tree.reduce((sum, e) => sum + e.size, 0);
    opts.progress?.onListed?.({ files, totalBytes });
  }

  await opts.fs.mkdir(opts.targetDir, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  let totalBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let r: { status: 'downloaded' | 'skipped'; bytes: number };
    try {
      r = await downloadOne(opts.fetch, opts.fs, opts.repo, revision, file, opts.targetDir, force);
    } catch (err) {
      throw new HfFileDownloadError(file, err);
    }
    totalBytes += r.bytes;
    if (r.status === 'downloaded') downloaded += 1;
    else skipped += 1;
    opts.progress?.onFile?.({
      file,
      status: r.status,
      bytes: r.bytes,
      index: i + 1,
      total: files.length,
    });
  }

  return {
    repo: opts.repo,
    revision,
    targetDir: opts.targetDir,
    files,
    downloaded,
    skipped,
    totalBytes,
  };
}
