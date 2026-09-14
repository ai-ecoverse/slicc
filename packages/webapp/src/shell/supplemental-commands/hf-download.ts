import type { SecureFetch } from 'just-bash';

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
  force: boolean,
  endpoint: string,
  declaredSize?: number
): Promise<{ status: 'downloaded' | 'skipped'; bytes: number }> {
  const destPath = `${targetDir}/${file}`;
  if (!force && (await fs.exists(destPath))) {
    try {
      const stat = await fs.stat(destPath);

      const complete =
        declaredSize === undefined || declaredSize <= 0 || stat.size === declaredSize;
      if (complete) return { status: 'skipped', bytes: stat.size ?? 0 };
    } catch {}
  }
  const resp = await fetchWithHostContext(fetchFn, hfResolveUrl(endpoint, repo, revision, file), {
    method: 'GET',
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${file}`);
  }
  await ensureParentDirs(fs, destPath);
  await fs.writeFile(destPath, resp.body);
  return { status: 'downloaded', bytes: resp.body.byteLength };
}

export function resolveTargetDir(repo: string, to: string | null, cwd: string): string {
  const raw = to ?? `/workspace/models/${repo}`;
  const absolute = raw.startsWith('/') ? raw : `${cwd.replace(/\/+$/, '')}/${raw}`;
  return absolute.replace(/\/+$/, '');
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

export async function downloadHfRepo(opts: DownloadHfRepoOptions): Promise<HfRepoDownloadResult> {
  const revision = opts.revision ?? 'main';
  const force = opts.force ?? false;
  const endpoint = resolveHfEndpoint(opts.endpoint);

  let files = opts.files ?? [];

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

  let downloaded = 0;
  let skipped = 0;
  let totalBytes = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let r: { status: 'downloaded' | 'skipped'; bytes: number };
    try {
      r = await downloadOne(
        opts.fetch,
        opts.fs,
        opts.repo,
        revision,
        file,
        opts.targetDir,
        force,
        endpoint,
        declaredSizes.get(file)
      );
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
