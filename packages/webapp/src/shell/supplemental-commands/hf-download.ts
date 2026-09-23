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
import type { StreamedFetchResponse, StreamingFetch } from '../proxied-fetch.js';
import { DEFAULT_HF_CONCURRENCY, DEFAULT_HF_MAX_BYTES_IN_FLIGHT } from './hf-defaults.js';

export {
  DEFAULT_HF_CONCURRENCY,
  DEFAULT_HF_MAX_BYTES_IN_FLIGHT,
  resolveTargetDir,
} from './hf-defaults.js';

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
  /** Needed, with `rm`, for the streamed path (`DownloadHfRepoOptions.streamFetch`). */
  appendFile?(path: string, data: Uint8Array): Promise<unknown>;
  rm?(path: string): Promise<unknown>;
}

/**
 * The streamed path appends to the destination in pieces of this size, so a
 * download holds at most about this much (plus one network chunk) however
 * large the file is. It is also what a streamed file is charged against the
 * bytes-in-flight budget, so several large files can stream at once.
 */
export const HF_STREAM_WRITE_BYTES = 8 * 1024 * 1024;

/**
 * Suffix of the marker a streamed download keeps next to its file until the
 * last byte is written. A present marker means the file is torn (the worker
 * died, or the transfer failed), so a later run re-downloads it even when no
 * declared size is known to compare against.
 */
export const HF_INCOMPLETE_SUFFIX = '.hf-incomplete';

const HF_HOST = ['huggingface', 'co'].join('.');
/** Default hub origin; `HF_ENDPOINT` (the Hugging Face convention) overrides it. */
export const DEFAULT_HF_ENDPOINT = `https://${HF_HOST}`;

/**
 * Normalize an `HF_ENDPOINT` value to an origin-ish base URL (scheme + host +
 * optional path, no trailing slash). Anything that is not an absolute
 * http(s) URL falls back to the default so a typo cannot send weights
 * requests to a relative path on the leader origin.
 */
export function resolveHfEndpoint(raw: string | undefined | null): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_HF_ENDPOINT;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_HF_ENDPOINT;
    return url.href.replace(/\/+$/, '');
  } catch {
    return DEFAULT_HF_ENDPOINT;
  }
}

function hfApiUrl(endpoint: string, repo: string, revision: string): string {
  return `${endpoint}/api/models/${repo}/tree/${revision}?recursive=true`;
}

function hfResolveUrl(endpoint: string, repo: string, revision: string, file: string): string {
  return `${endpoint}/${repo}/resolve/${revision}/${file}`;
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
  return withHostContext(url, () => fetchFn(url, init));
}

async function withHostContext<T>(url: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
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
  revision: string,
  endpoint: string = DEFAULT_HF_ENDPOINT,
  signal?: AbortSignal
): Promise<HfRepoFile[]> {
  const resp = await fetchWithHostContext(fetchFn, hfApiUrl(endpoint, repo, revision), {
    method: 'GET',
    signal,
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HF API ${resp.status} ${resp.statusText} for ${repo}@${revision}`);
  }
  return fileEntries(resp.body);
}

function fileEntries(body: Uint8Array): HfRepoFile[] {
  const parsed = JSON.parse(new TextDecoder('utf-8').decode(body)) as HfTreeEntry[];
  return parsed
    .filter((e) => e.type === 'file')
    .map((e) => ({ path: e.path, size: typeof e.size === 'number' ? e.size : 0 }));
}

/**
 * Declared sizes for an explicit file list, from one non-recursive tree
 * listing per parent directory. Best effort: a directory whose listing fails
 * (or is paginated past the requested file) leaves those files unsized, and
 * the pool then charges each of them the whole byte budget.
 */
async function lookupDeclaredSizes(
  fetchFn: SecureFetch,
  endpoint: string,
  repo: string,
  revision: string,
  files: readonly string[],
  signal: AbortSignal | undefined
): Promise<Map<string, number>> {
  const wanted = new Set(files);
  const dirs = new Set(files.map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')));
  const sizes = new Map<string, number>();
  await Promise.all(
    [...dirs].map(async (dir) => {
      const url = `${endpoint}/api/models/${repo}/tree/${revision}${dir ? `/${dir}` : ''}`;
      try {
        const resp = await fetchFn(url, { method: 'GET', signal });
        if (resp.status < 200 || resp.status >= 300) return;
        for (const e of fileEntries(resp.body)) {
          if (wanted.has(e.path) && e.size > 0) sizes.set(e.path, e.size);
        }
      } catch {
        // Unsized files still download, just one at a time.
      }
    })
  );
  return sizes;
}

/** Ensure every parent dir along `path` exists (mkdir -p semantics). */
async function ensureParentDirs(fs: DownloadFs, path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return;
  const parent = path.slice(0, slash);
  await fs.mkdir(parent, { recursive: true });
}

/**
 * Byte length of a COMPLETE file already at `destPath`, or `undefined` when it
 * must be (re-)fetched.
 */
async function completeSize(
  fs: DownloadFs,
  destPath: string,
  declaredSize: number | undefined
): Promise<number | undefined> {
  if (!(await fs.exists(destPath))) return undefined;
  try {
    // A streamed download that never finished left its marker behind.
    if (await fs.exists(`${destPath}${HF_INCOMPLETE_SUFFIX}`)) return undefined;
    const stat = await fs.stat(destPath);
    // Skip only a COMPLETE file. When the tree listing told us the declared
    // byte length, a present file of any other size is a torn write — a
    // download that died mid-stream, or a concurrent stager still writing
    // it — and "skipping" it would hand the caller a truncated weight file
    // that later fails to load with a size-mismatch EIO. Without a declared
    // size (a listing that failed or carried no size) the incomplete marker
    // above is the only tell, so presence without one counts as complete.
    const complete = declaredSize === undefined || declaredSize <= 0 || stat.size === declaredSize;
    return complete ? (stat.size ?? 0) : undefined;
  } catch {
    return undefined;
  }
}

async function fetchOne(
  job: PoolJob,
  url: string,
  file: string,
  destPath: string,
  signal: AbortSignal
): Promise<number> {
  const { fs } = job;
  if (job.streamFetch && fs.appendFile && fs.rm) {
    return fetchStreamed(job.streamFetch, fs as Required<DownloadFs>, url, file, destPath, signal);
  }
  const resp = await fetchWithHostContext(job.fetch, url, { method: 'GET', signal });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${file}`);
  }
  // Another file failed (or the caller cancelled) while this body was in
  // flight: do not leave a file behind that the caller was told failed.
  if (signal.aborted) throw new Error('aborted');
  await ensureParentDirs(fs, destPath);
  await fs.writeFile(destPath, resp.body);
  return resp.body.byteLength;
}

/**
 * Write a response body to `destPath` in {@link HF_STREAM_WRITE_BYTES}
 * pieces as it arrives, so memory stays bounded whatever the file size (and
 * however many downloads run at once). The incomplete marker is written
 * before the first byte and removed after the last, so a download killed with
 * the kernel worker, or aborted by the pool, is re-fetched on the next run
 * instead of skipped.
 */
async function fetchStreamed(
  streamFetch: StreamingFetch,
  fs: Required<DownloadFs>,
  url: string,
  file: string,
  destPath: string,
  signal: AbortSignal
): Promise<number> {
  const resp: StreamedFetchResponse = await withHostContext(url, () =>
    streamFetch(url, { method: 'GET', signal })
  );
  if (resp.status < 200 || resp.status >= 300) {
    await resp.cancel();
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${file}`);
  }
  if (signal.aborted) {
    await resp.cancel();
    throw new Error('aborted');
  }
  const marker = `${destPath}${HF_INCOMPLETE_SUFFIX}`;
  await ensureParentDirs(fs, destPath);
  await fs.writeFile(marker, new Uint8Array(0));
  await fs.writeFile(destPath, new Uint8Array(0));
  const written = await appendInPieces(fs, destPath, resp.body, signal);
  // Only a SHORT body is an error: a proxy that inflates an undeclared gzip
  // body legitimately delivers more than the upstream length.
  if (resp.contentLength !== undefined && written < resp.contentLength) {
    throw new Error(`short read for ${file}: got ${written} of ${resp.contentLength} bytes`);
  }
  await fs.rm(marker);
  return written;
}

/** Coalesce network chunks into bounded pieces and append each one. */
async function appendInPieces(
  fs: Required<DownloadFs>,
  destPath: string,
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal
): Promise<number> {
  let piece = new Uint8Array(HF_STREAM_WRITE_BYTES);
  let filled = 0;
  let written = 0;
  for await (const chunk of body) {
    // Breaking out of the loop cancels the body; the marker stays behind.
    if (signal.aborted) throw new Error('aborted');
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(chunk.byteLength - offset, piece.byteLength - filled);
      piece.set(chunk.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === piece.byteLength) {
        await fs.appendFile(destPath, piece);
        written += filled;
        // The VFS may keep a reference to what it was handed until the write
        // syncs, so never refill a buffer that was just appended.
        piece = new Uint8Array(HF_STREAM_WRITE_BYTES);
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    await fs.appendFile(destPath, piece.subarray(0, filled));
    written += filled;
  }
  return written;
}

/**
 * Weighted FIFO admission: a job enters when the bytes already in flight plus
 * its own weight fit the budget, or when nothing else is running (so an
 * oversized file still makes progress). FIFO keeps a large file from starving
 * behind a stream of small ones. An unknown size (0) is charged the whole
 * budget: nothing bounds what it will buffer.
 *
 * Resolves with the weight taken, which the caller hands back to `release`.
 */
class ByteBudget {
  private inFlight = 0;
  private running = 0;
  private readonly waiters: Array<{ weight: number; admit: () => void }> = [];

  constructor(readonly capacity: number) {}

  async acquire(size: number): Promise<number> {
    const weight = size > 0 ? Math.min(size, this.capacity) : this.capacity;
    if (this.waiters.length === 0 && this.fits(weight)) this.take(weight);
    else await new Promise<void>((admit) => this.waiters.push({ weight, admit }));
    return weight;
  }

  release(weight: number): void {
    this.inFlight -= weight;
    this.running -= 1;
    for (let next = this.waiters[0]; next && this.fits(next.weight); next = this.waiters[0]) {
      this.waiters.shift();
      this.take(next.weight);
      next.admit();
    }
  }

  private fits(weight: number): boolean {
    return this.running === 0 || this.inFlight + weight <= this.capacity;
  }

  private take(weight: number): void {
    this.inFlight += weight;
    this.running += 1;
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

/** Per-file lifecycle event surfaced as `downloadHfRepo` progresses. */
export interface HfFileEvent {
  file: string;
  status: 'downloaded' | 'skipped';
  /** Byte length of this file (downloaded or already-present). */
  bytes: number;
  /**
   * Files finished so far, this one included (1-based). Files finish in
   * completion order, not list order, because several download at once.
   */
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
  /** Fired after each file is downloaded or skipped, in completion order. */
  onFile?: (evt: HfFileEvent) => void;
}

export interface DownloadHfRepoOptions {
  fetch: SecureFetch;
  /**
   * Streaming fetch for file bodies. When given (and `fs` has `appendFile` +
   * `rm`), each file is written in bounded pieces as it arrives instead of
   * being buffered whole; the tree listing still uses `fetch`.
   */
  streamFetch?: StreamingFetch;
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
  /**
   * Hub base URL (`HF_ENDPOINT`). Defaults to huggingface.co; CI points it at
   * a local caching mirror (`packages/dev-tools/tools/hf-cache-mirror.mjs`).
   */
  endpoint?: string;
  progress?: HfRepoDownloadProgress;
  /** Most files downloading at once. Defaults to {@link DEFAULT_HF_CONCURRENCY}. */
  concurrency?: number;
  /**
   * Byte budget for downloads in flight. Defaults to
   * {@link DEFAULT_HF_MAX_BYTES_IN_FLIGHT}. Sizes come from the tree listing
   * (for an explicit file list, one listing per parent directory); a file
   * whose size is still unknown is charged the whole budget.
   */
  maxBytesInFlight?: number;
  /** Cancels the download; in-flight requests are aborted. */
  signal?: AbortSignal;
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

interface PoolJob {
  fetch: SecureFetch;
  streamFetch?: StreamingFetch;
  fs: DownloadFs;
  urlFor: (file: string) => string;
  targetDir: string;
  force: boolean;
  declaredSizes: ReadonlyMap<string, number>;
  onFile?: (evt: HfFileEvent) => void;
}

interface PoolTotals {
  downloaded: number;
  skipped: number;
  totalBytes: number;
}

/**
 * Downloads `files` over `concurrency` workers gated by a {@link ByteBudget}.
 * The first per-file failure aborts every in-flight request and stops new
 * ones, then surfaces as the rejection once all workers have settled — so no
 * request is left running (or writing) behind a failed command.
 */
class DownloadPool {
  private next = 0;
  private finished = 0;
  private failure: HfFileDownloadError | undefined;
  private readonly abort = new AbortController();
  private readonly totals: PoolTotals = { downloaded: 0, skipped: 0, totalBytes: 0 };

  constructor(
    private readonly job: PoolJob,
    private readonly files: readonly string[],
    private readonly budget: ByteBudget
  ) {}

  async run(concurrency: number, signal: AbortSignal | undefined): Promise<PoolTotals> {
    const onCancel = () => this.abort.abort();
    if (signal?.aborted) onCancel();
    signal?.addEventListener('abort', onCancel, { once: true });
    try {
      const workers = Math.min(concurrency, this.files.length);
      await Promise.all(Array.from({ length: workers }, () => this.worker()));
    } finally {
      signal?.removeEventListener('abort', onCancel);
    }
    if (this.failure) throw this.failure;
    if (signal?.aborted) throw new Error('download aborted');
    return this.totals;
  }

  private async worker(): Promise<void> {
    while (!this.abort.signal.aborted && this.next < this.files.length) {
      const file = this.files[this.next++];
      try {
        this.record(file, await this.one(file));
      } catch (err) {
        // A rejection after the pool is already aborting is fallout from that
        // abort (first failure or caller cancel), not a new failure.
        if (!this.abort.signal.aborted) this.failure = new HfFileDownloadError(file, err);
        this.abort.abort();
        return;
      }
    }
  }

  /**
   * Bytes a download holds in memory, for the budget. A buffered body is the
   * whole file (0 = unknown, charged the full budget). A streamed body is at
   * most one write piece, whatever the file size.
   */
  private weightOf(declared: number | undefined): number {
    const { fs, streamFetch } = this.job;
    if (!streamFetch || !fs.appendFile || !fs.rm) return declared ?? 0;
    return declared && declared > 0
      ? Math.min(declared, HF_STREAM_WRITE_BYTES)
      : HF_STREAM_WRITE_BYTES;
  }

  private async one(file: string): Promise<{ status: 'downloaded' | 'skipped'; bytes: number }> {
    const { job } = this;
    const destPath = `${job.targetDir}/${file}`;
    const declared = job.declaredSizes.get(file);
    const present = job.force ? undefined : await completeSize(job.fs, destPath, declared);
    if (present !== undefined) return { status: 'skipped', bytes: present };

    const weight = await this.budget.acquire(this.weightOf(declared));
    try {
      if (this.abort.signal.aborted) throw new Error('aborted');
      const bytes = await fetchOne(job, job.urlFor(file), file, destPath, this.abort.signal);
      return { status: 'downloaded', bytes };
    } finally {
      this.budget.release(weight);
    }
  }

  private record(file: string, r: { status: 'downloaded' | 'skipped'; bytes: number }): void {
    this.totals.totalBytes += r.bytes;
    if (r.status === 'downloaded') this.totals.downloaded += 1;
    else this.totals.skipped += 1;
    this.finished += 1;
    this.job.onFile?.({
      file,
      status: r.status,
      bytes: r.bytes,
      index: this.finished,
      total: this.files.length,
    });
  }
}

/**
 * Download a HF repo (or a subset of files) into `targetDir`, skipping files
 * already present at a matching byte length unless `force` is set. Lists the
 * repo tree when `files` is empty. Several files download at once, bounded by
 * both `concurrency` and a bytes-in-flight budget. Throws on a list failure
 * (plain `Error`) or a per-file failure (`HfFileDownloadError`); the first
 * failing file aborts the rest, matching the `hf` command's fail-fast
 * behavior.
 */
export async function downloadHfRepo(opts: DownloadHfRepoOptions): Promise<HfRepoDownloadResult> {
  const revision = opts.revision ?? 'main';
  const force = opts.force ?? false;
  const endpoint = resolveHfEndpoint(opts.endpoint);

  const { signal } = opts;
  let files = opts.files ?? [];
  /** Declared byte length per file, from a tree listing. */
  let declaredSizes = new Map<string, number>();
  if (files.length === 0) {
    const tree = await listRepoTree(opts.fetch, opts.repo, revision, endpoint, signal).catch(
      (err: unknown) => {
        throw signal?.aborted ? new Error('download aborted') : err;
      }
    );
    if (tree.length === 0) {
      throw new Error(`repo ${opts.repo}@${revision} has no files`);
    }
    files = tree.map((e) => e.path);
    for (const e of tree) declaredSizes.set(e.path, e.size);
    const totalBytes = tree.reduce((sum, e) => sum + e.size, 0);
    opts.progress?.onListed?.({ files, totalBytes });
  } else {
    declaredSizes = await lookupDeclaredSizes(
      opts.fetch,
      endpoint,
      opts.repo,
      revision,
      files,
      signal
    );
  }
  if (signal?.aborted) throw new Error('download aborted');

  await opts.fs.mkdir(opts.targetDir, { recursive: true });

  const pool = new DownloadPool(
    {
      fetch: opts.fetch,
      streamFetch: opts.streamFetch,
      fs: opts.fs,
      urlFor: (file) => hfResolveUrl(endpoint, opts.repo, revision, file),
      targetDir: opts.targetDir,
      force,
      declaredSizes,
      onFile: opts.progress?.onFile,
    },
    files,
    new ByteBudget(positiveOr(opts.maxBytesInFlight, DEFAULT_HF_MAX_BYTES_IN_FLIGHT))
  );
  const totals = await pool.run(positiveOr(opts.concurrency, DEFAULT_HF_CONCURRENCY), opts.signal);

  return { repo: opts.repo, revision, targetDir: opts.targetDir, files, ...totals };
}
