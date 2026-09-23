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
  revision: string,
  endpoint: string = DEFAULT_HF_ENDPOINT
): Promise<HfRepoFile[]> {
  const resp = await fetchWithHostContext(fetchFn, hfApiUrl(endpoint, repo, revision), {
    method: 'GET',
  });
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
    const stat = await fs.stat(destPath);
    // Skip only a COMPLETE file. When the tree listing told us the declared
    // byte length, a present file of any other size is a torn write — a
    // download that died mid-stream, or a concurrent stager still writing
    // it — and "skipping" it would hand the caller a truncated weight file
    // that later fails to load with a size-mismatch EIO. Without a declared
    // size (explicit file list, or a listing without sizes) presence is the
    // best we can check.
    const complete = declaredSize === undefined || declaredSize <= 0 || stat.size === declaredSize;
    return complete ? (stat.size ?? 0) : undefined;
  } catch {
    return undefined;
  }
}

async function fetchOne(
  fetchFn: SecureFetch,
  fs: DownloadFs,
  url: string,
  file: string,
  destPath: string,
  signal: AbortSignal
): Promise<number> {
  const resp = await fetchWithHostContext(fetchFn, url, { method: 'GET', signal });
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
 * Weighted FIFO admission: a job enters when the bytes already in flight plus
 * its own weight fit the budget, or when nothing else is running (so an
 * oversized file still makes progress). FIFO keeps a large file from starving
 * behind a stream of small ones.
 *
 * The weight is asked for at admission time, not when the job starts
 * waiting: an unsized file's estimate improves as other files finish.
 * Resolves with the weight taken, which the caller hands back to `release`.
 */
class ByteBudget {
  private inFlight = 0;
  private running = 0;
  private readonly waiters: Array<{ weigh: () => number; admit: (w: number) => void }> = [];

  constructor(readonly capacity: number) {}

  acquire(weigh: () => number): Promise<number> {
    if (this.waiters.length === 0) {
      const weight = this.clamp(weigh());
      if (this.fits(weight)) {
        this.take(weight);
        return Promise.resolve(weight);
      }
    }
    return new Promise((admit) => this.waiters.push({ weigh, admit }));
  }

  release(weight: number): void {
    this.inFlight -= weight;
    this.running -= 1;
    for (let next = this.waiters[0]; next; next = this.waiters[0]) {
      const w = this.clamp(next.weigh());
      if (!this.fits(w)) break;
      this.waiters.shift();
      this.take(w);
      next.admit(w);
    }
  }

  private clamp(weight: number): number {
    return weight > 0 ? Math.min(weight, this.capacity) : this.capacity;
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
   * {@link DEFAULT_HF_MAX_BYTES_IN_FLIGHT}. A file without a declared size
   * (explicit file list) is weighed as the largest file seen so far in this
   * run, or as the whole budget before any size is known.
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
  private largestSeen = 0;
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

  private async one(file: string): Promise<{ status: 'downloaded' | 'skipped'; bytes: number }> {
    const { job } = this;
    const destPath = `${job.targetDir}/${file}`;
    const declared = job.declaredSizes.get(file);
    const present = job.force ? undefined : await completeSize(job.fs, destPath, declared);
    if (present !== undefined) return { status: 'skipped', bytes: present };

    const weight = await this.budget.acquire(() =>
      declared !== undefined && declared > 0 ? declared : this.largestSeen
    );
    try {
      if (this.abort.signal.aborted) throw new Error('aborted');
      const bytes = await fetchOne(
        job.fetch,
        job.fs,
        job.urlFor(file),
        file,
        destPath,
        this.abort.signal
      );
      // Before `release`, so the waiters it admits are weighed with this size.
      this.largestSeen = Math.max(this.largestSeen, bytes);
      return { status: 'downloaded', bytes };
    } finally {
      this.budget.release(weight);
    }
  }

  private record(file: string, r: { status: 'downloaded' | 'skipped'; bytes: number }): void {
    this.largestSeen = Math.max(this.largestSeen, r.bytes);
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

  let files = opts.files ?? [];
  /** Declared byte length per file, known only after a tree listing. */
  const declaredSizes = new Map<string, number>();
  if (files.length === 0) {
    const tree = await listRepoTree(opts.fetch, opts.repo, revision, endpoint);
    if (tree.length === 0) {
      throw new Error(`repo ${opts.repo}@${revision} has no files`);
    }
    files = tree.map((e) => e.path);
    for (const e of tree) declaredSizes.set(e.path, e.size);
    const totalBytes = tree.reduce((sum, e) => sum + e.size, 0);
    opts.progress?.onListed?.({ files, totalBytes });
  }

  await opts.fs.mkdir(opts.targetDir, { recursive: true });

  const pool = new DownloadPool(
    {
      fetch: opts.fetch,
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
