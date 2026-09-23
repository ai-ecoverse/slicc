import type { SecureFetch } from 'just-bash';
import { DEFAULT_HF_CONCURRENCY, DEFAULT_HF_MAX_BYTES_IN_FLIGHT } from './hf-defaults.js';

export {
  DEFAULT_HF_CONCURRENCY,
  DEFAULT_HF_MAX_BYTES_IN_FLIGHT,
  resolveTargetDir,
} from './hf-defaults.js';

export interface DownloadFs {
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ size: number }>;
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<unknown>;
}

const HF_HOST = ['huggingface', 'co'].join('.');

export const DEFAULT_HF_ENDPOINT = `https://${HF_HOST}`;

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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

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

export interface HfRepoFile {
  path: string;
  size: number;
}

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
      } catch {}
    })
  );
  return sizes;
}

async function ensureParentDirs(fs: DownloadFs, path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return;
  const parent = path.slice(0, slash);
  await fs.mkdir(parent, { recursive: true });
}

async function completeSize(
  fs: DownloadFs,
  destPath: string,
  declaredSize: number | undefined
): Promise<number | undefined> {
  if (!(await fs.exists(destPath))) return undefined;
  try {
    const stat = await fs.stat(destPath);

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

  if (signal.aborted) throw new Error('aborted');
  await ensureParentDirs(fs, destPath);
  await fs.writeFile(destPath, resp.body);
  return resp.body.byteLength;
}

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

export interface HfFileEvent {
  file: string;
  status: 'downloaded' | 'skipped';

  bytes: number;

  index: number;

  total: number;
}

export interface HfRepoDownloadProgress {
  onListed?: (info: { files: string[]; totalBytes: number }) => void;

  onFile?: (evt: HfFileEvent) => void;
}

export interface DownloadHfRepoOptions {
  fetch: SecureFetch;
  fs: DownloadFs;
  repo: string;

  targetDir: string;

  files?: string[];

  revision?: string;

  force?: boolean;

  endpoint?: string;
  progress?: HfRepoDownloadProgress;

  concurrency?: number;

  maxBytesInFlight?: number;

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

    const weight = await this.budget.acquire(declared ?? 0);
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

export async function downloadHfRepo(opts: DownloadHfRepoOptions): Promise<HfRepoDownloadResult> {
  const revision = opts.revision ?? 'main';
  const force = opts.force ?? false;
  const endpoint = resolveHfEndpoint(opts.endpoint);

  const { signal } = opts;
  let files = opts.files ?? [];

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
