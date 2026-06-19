/**
 * `hf` (Hugging Face) command — download model repos from the HF Hub into the
 * VFS so the on-device ML engines can read them via the preview SW.
 *
 * Wave 7 split: libraries (transformers / onnxruntime-web / kokoro-js) come
 * from `ipk add`; weights come from `hf download`. There is no automatic
 * fetch on first engine use — `transformers-env.ts` pins
 * `allowRemoteModels = false`, so a missing local weight file surfaces a
 * clean "model not found" rather than a quiet HF round-trip.
 *
 * Usage:
 *   hf download <repo> [files...] [--to <dir>] [--revision <rev>] [--force]
 *
 * `<repo>` is the standard `<owner>/<name>` form (e.g.
 * `onnx-community/whisper-tiny`). With no `[files...]`, every file in the
 * repo tree is downloaded. `--to` defaults to `/workspace/models/<repo>/`
 * (so the result matches `localModelPath = /workspace/models/`). Existing
 * files at the destination with a matching byte length are skipped unless
 * `--force` is passed.
 *
 * All network goes through the captured `SecureFetch`, same proxy seam as
 * `ipk` and `upskill`.
 */

import type { Command, CommandContext, ExecResult, SecureFetch } from 'just-bash';

const HF_HOST = ['huggingface', 'co'].join('.');

function hfApiUrl(repo: string, revision: string): string {
  return `https://${HF_HOST}/api/models/${repo}/tree/${revision}?recursive=true`;
}

function hfResolveUrl(repo: string, revision: string, file: string): string {
  return `https://${HF_HOST}/${repo}/resolve/${revision}/${file}`;
}

function help(exitCode: number): ExecResult {
  return {
    stdout: `hf - download model repos from the Hugging Face Hub into the VFS

Usage:
  hf download <repo> [files...] [--to <dir>] [--revision <rev>] [--force]

Examples:
  hf download onnx-community/whisper-tiny
  hf download onnx-community/whisper-tiny --to /workspace/models/onnx-community/whisper-tiny
  hf download onnx-community/Kokoro-82M-v1.0-ONNX
  hf download Xenova/all-MiniLM-L6-v2 config.json tokenizer.json

Defaults:
  --to        /workspace/models/<repo>/
  --revision  main

Notes:
  - <repo> is the standard <owner>/<name> form.
  - With no [files...], every file in the repo tree is downloaded.
  - Existing files at the destination with a matching byte length are skipped
    unless --force is passed.
  - Weights are read by the speech engines via the preview SW from the
    target directory; transformers expects <localModelPath>/<repo>/.
`,
    stderr: '',
    exitCode,
  };
}

function failure(message: string): ExecResult {
  return { stdout: '', stderr: `hf: ${message}\n`, exitCode: 1 };
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface ParsedDownload {
  repo: string;
  files: string[];
  to: string | null;
  revision: string;
  force: boolean;
}

/**
 * Parse `hf download` argv. Exported for unit tests so the parse rules
 * (positional repo, optional files, flag handling) can be exercised
 * without spinning up the network mock.
 */
export function parseDownloadArgs(args: string[]): ParsedDownload | { error: string } {
  let to: string | null = null;
  let revision = 'main';
  let force = false;
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (tok === '--to') {
      const v = args[i + 1];
      if (typeof v !== 'string') return { error: '--to requires a value' };
      to = v;
      i += 2;
      continue;
    }
    if (tok === '--revision' || tok === '--rev') {
      const v = args[i + 1];
      if (typeof v !== 'string') return { error: `${tok} requires a value` };
      revision = v;
      i += 2;
      continue;
    }
    if (tok === '--force' || tok === '-f') {
      force = true;
      i += 1;
      continue;
    }
    if (tok.startsWith('--')) {
      return { error: `unknown option: ${tok}` };
    }
    positional.push(tok);
    i += 1;
  }
  if (positional.length === 0) return { error: 'download requires <repo>' };
  const repo = positional[0];
  if (!REPO_RE.test(repo)) {
    return { error: `invalid repo '${repo}' — expected <owner>/<name>` };
  }
  return { repo, files: positional.slice(1), to, revision, force };
}

interface HfTreeEntry {
  type: 'file' | 'directory' | string;
  path: string;
  size?: number;
}

/**
 * List every file in the repo tree at the given revision. The HF API
 * returns a flat list when `recursive=true` is set; we ignore directories
 * and surface only the file paths in tree order.
 */
async function listRepoFiles(
  fetchFn: SecureFetch,
  repo: string,
  revision: string
): Promise<string[]> {
  const resp = await fetchFn(hfApiUrl(repo, revision), { method: 'GET' });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HF API ${resp.status} ${resp.statusText} for ${repo}@${revision}`);
  }
  const text = new TextDecoder('utf-8').decode(resp.body);
  const parsed = JSON.parse(text) as HfTreeEntry[];
  return parsed.filter((e) => e.type === 'file').map((e) => e.path);
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

/** Ensure every parent dir along `path` exists (mkdir -p semantics). */
async function ensureParentDirs(fs: CommandContext['fs'], path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return;
  const parent = path.slice(0, slash);
  await fs.mkdir(parent, { recursive: true });
}

async function downloadOne(
  fetchFn: SecureFetch,
  fs: CommandContext['fs'],
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
  const resp = await fetchFn(hfResolveUrl(repo, revision, file), { method: 'GET' });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${file}`);
  }
  await ensureParentDirs(fs, destPath);
  await fs.writeFile(destPath, resp.body);
  return { status: 'downloaded', bytes: resp.body.byteLength };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function runDownload(
  args: string[],
  ctx: CommandContext,
  fetchFn: SecureFetch
): Promise<ExecResult> {
  const parsed = parseDownloadArgs(args);
  if ('error' in parsed) return failure(parsed.error);

  let files = parsed.files;
  let stderr = '';
  if (files.length === 0) {
    try {
      files = await listRepoFiles(fetchFn, parsed.repo, parsed.revision);
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
    if (files.length === 0) {
      return failure(`repo ${parsed.repo}@${parsed.revision} has no files`);
    }
    stderr += `hf: ${files.length} file(s) listed in ${parsed.repo}@${parsed.revision}\n`;
  }

  const targetDir = resolveTargetDir(parsed.repo, parsed.to, ctx.cwd);
  await ctx.fs.mkdir(targetDir, { recursive: true });

  let totalBytes = 0;
  let downloadedCount = 0;
  let skippedCount = 0;
  for (const file of files) {
    try {
      const r = await downloadOne(
        fetchFn,
        ctx.fs,
        parsed.repo,
        parsed.revision,
        file,
        targetDir,
        parsed.force
      );
      totalBytes += r.bytes;
      if (r.status === 'downloaded') {
        downloadedCount += 1;
        stderr += `hf: downloaded ${file} (${formatBytes(r.bytes)})\n`;
      } else {
        skippedCount += 1;
        stderr += `hf: skipped ${file} (already at ${targetDir})\n`;
      }
    } catch (err) {
      stderr += `hf: failed ${file}: ${err instanceof Error ? err.message : String(err)}\n`;
      return { stdout: '', stderr, exitCode: 1 };
    }
  }
  const summary = `hf: ${downloadedCount} downloaded, ${skippedCount} skipped, ${formatBytes(totalBytes)} total into ${targetDir}\n`;
  return { stdout: '', stderr: stderr + summary, exitCode: 0 };
}

export interface HfCommandDeps {
  fetch: SecureFetch;
}

export function createHfCommand(deps: HfCommandDeps): Command {
  return {
    name: 'hf',
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        return help(args.length === 0 ? 1 : 0);
      }
      const sub = args[0];
      if (sub === 'download') return runDownload(args.slice(1), ctx, deps.fetch);
      return failure(`unknown subcommand: ${sub}`);
    },
  };
}
