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
 *               [--concurrency <n>] [--max-in-flight-mb <n>]
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
import type { StreamingFetch } from '../proxied-fetch.js';
import {
  DEFAULT_HF_CONCURRENCY,
  DEFAULT_HF_MAX_BYTES_IN_FLIGHT,
  resolveTargetDir,
} from './hf-defaults.js';
import { isHelpRequest } from './subcommand-help.js';

// Re-exported so existing importers (and tests) keep resolving it here.
export { resolveTargetDir } from './hf-defaults.js';

function help(exitCode: number): ExecResult {
  return {
    stdout: `hf - download model repos from the Hugging Face Hub into the VFS

Usage:
  hf download <repo> [files...] [--to <dir>] [--revision <rev>] [--force]
                     [--concurrency <n>] [--max-in-flight-mb <n>]

Examples:
  hf download onnx-community/whisper-tiny
  hf download onnx-community/whisper-tiny --to /workspace/models/onnx-community/whisper-tiny
  hf download onnx-community/Kokoro-82M-v1.0-ONNX
  hf download Xenova/all-MiniLM-L6-v2 config.json tokenizer.json
  hf download owner/sharded-model --concurrency 8 --max-in-flight-mb 256

Defaults:
  --to                 /workspace/models/<repo>/
  --revision           main
  --concurrency, -j    ${DEFAULT_HF_CONCURRENCY} files at once
  --max-in-flight-mb   ${DEFAULT_HF_MAX_BYTES_IN_FLIGHT / (1024 * 1024)} MB of downloads in flight at once

Notes:
  - <repo> is the standard <owner>/<name> form.
  - With no [files...], every file in the repo tree is downloaded.
  - Existing files at the destination with a matching byte length are skipped
    unless --force is passed.
  - A file starts only while the ones in flight fit --max-in-flight-mb. Where
    bodies stream to disk (CLI), each file counts as one 8 MiB write piece;
    where they are buffered whole, larger or unsized files run alone.
  - The first failed file stops the rest.
  - Background-job logs get a progress line every few seconds.
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
  concurrency?: number;
  maxInFlightMb?: number;
}

function parsePositiveInt(flag: string, raw: string | undefined): number | { error: string } {
  if (typeof raw !== 'string') return { error: `${flag} requires a value` };
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
    return { error: `${flag} must be a positive integer, got '${raw}'` };
  }
  return n;
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
  let concurrency: number | undefined;
  let maxInFlightMb: number | undefined;
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const tok = args[i];
    if (tok === '--concurrency' || tok === '-j' || tok === '--max-in-flight-mb') {
      const n = parsePositiveInt(tok, args[i + 1]);
      if (typeof n !== 'number') return n;
      if (tok === '--max-in-flight-mb') maxInFlightMb = n;
      else concurrency = n;
      i += 2;
      continue;
    }
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
  return { repo, files: positional.slice(1), to, revision, force, concurrency, maxInFlightMb };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Minimum gap between two live progress lines. */
export const HF_PROGRESS_INTERVAL_MS = 5000;

/**
 * Running totals for one `hf download`: files done, bytes, rate, ETA. Rate
 * counts only bytes actually fetched this run, so a resumed download does not
 * report the skipped files as throughput.
 */
export class DownloadProgress {
  private filesDone = 0;
  private bytesDone = 0;
  private bytesFetched = 0;
  private lastLineAt = Number.NEGATIVE_INFINITY;
  private readonly startedAt: number;

  constructor(
    private filesTotal: number,
    private bytesTotal: number | undefined,
    private readonly now: () => number = Date.now
  ) {
    this.startedAt = now();
  }

  listed(files: number, bytes: number): void {
    this.filesTotal = files;
    this.bytesTotal = bytes > 0 ? bytes : undefined;
  }

  file(status: 'downloaded' | 'skipped', bytes: number): void {
    this.filesDone += 1;
    this.bytesDone += bytes;
    if (status === 'downloaded') this.bytesFetched += bytes;
  }

  /** Bytes per second fetched so far, or 0 before any time has passed. */
  rate(): number {
    const secs = (this.now() - this.startedAt) / 1000;
    return secs > 0 ? this.bytesFetched / secs : 0;
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** A status line when one is due (throttled; always on the last file). */
  line(): string | null {
    const t = this.now();
    const last = this.filesDone >= this.filesTotal;
    if (!last && t - this.lastLineAt < HF_PROGRESS_INTERVAL_MS) return null;
    this.lastLineAt = t;
    const rate = this.rate();
    let bytes = formatBytes(this.bytesDone);
    let eta = '';
    if (this.bytesTotal !== undefined) {
      bytes += ` of ${formatBytes(this.bytesTotal)}`;
      const left = this.bytesTotal - this.bytesDone;
      if (rate > 0 && left > 0) eta = `, ~${formatDuration((left / rate) * 1000)} left`;
    }
    return `hf: ${this.filesDone}/${this.filesTotal} files, ${bytes}, ${formatBytes(rate)}/s${eta}\n`;
  }
}

/**
 * Live output sink the shell attaches when someone is reading output while
 * the command runs (the agent's bash tool, background jobs, `jshd`). The
 * human terminal has none; it sees the result when the command exits.
 */
function liveSinkOf(ctx: CommandContext): ((chunk: string) => void) | undefined {
  const extra = ctx as CommandContext & { writeStdout?: (chunk: string) => void };
  return typeof extra.writeStdout === 'function' ? extra.writeStdout.bind(extra) : undefined;
}

async function runDownload(
  args: string[],
  ctx: CommandContext,
  deps: HfCommandDeps,
  now: () => number
): Promise<ExecResult> {
  const parsed = parseDownloadArgs(args);
  if ('error' in parsed) return failure(parsed.error);

  const targetDir = resolveTargetDir(parsed.repo, parsed.to, ctx.cwd);
  const { downloadHfRepo, HfFileDownloadError } = await import('./hf-download.js');
  const live = liveSinkOf(ctx);
  const tally = new DownloadProgress(parsed.files.length, undefined, now);
  let stderr = '';
  try {
    const result = await downloadHfRepo({
      fetch: deps.fetch,
      streamFetch: deps.streamFetch,
      fs: ctx.fs,
      repo: parsed.repo,
      targetDir,
      files: parsed.files,
      revision: parsed.revision,
      force: parsed.force,
      concurrency: parsed.concurrency,
      maxBytesInFlight:
        parsed.maxInFlightMb === undefined ? undefined : parsed.maxInFlightMb * 1024 * 1024,
      signal: ctx.signal,
      // `HF_ENDPOINT` (Hugging Face's own convention) points the download at
      // a mirror — CI uses it for a disk-cached local one.
      endpoint: ctx.env.get('HF_ENDPOINT'),
      progress: {
        onListed: ({ files, totalBytes }) => {
          tally.listed(files.length, totalBytes);
          const line = `hf: ${files.length} file(s) listed in ${parsed.repo}@${parsed.revision}\n`;
          stderr += line;
          live?.(line);
        },
        onFile: (evt) => {
          stderr +=
            evt.status === 'downloaded'
              ? `hf: downloaded ${evt.file} (${formatBytes(evt.bytes)})\n`
              : `hf: skipped ${evt.file} (already at ${targetDir})\n`;
          tally.file(evt.status, evt.bytes);
          // Status lines are for whoever watches a long download; the result
          // keeps its per-file lines, so they are not repeated there.
          const line = live ? tally.line() : null;
          if (line) live?.(line);
        },
      },
    });
    const took =
      result.downloaded > 0
        ? ` in ${formatDuration(tally.elapsedMs())} (${formatBytes(tally.rate())}/s)`
        : '';
    const summary = `hf: ${result.downloaded} downloaded, ${result.skipped} skipped, ${formatBytes(result.totalBytes)} total into ${targetDir}${took}\n`;
    return { stdout: '', stderr: stderr + summary, exitCode: 0 };
  } catch (err) {
    if (err instanceof HfFileDownloadError) {
      stderr += `hf: failed ${err.file}: ${err.message}\n`;
      return { stdout: '', stderr, exitCode: 1 };
    }
    return failure(err instanceof Error ? err.message : String(err));
  }
}

export interface HfCommandDeps {
  fetch: SecureFetch;
  /** Clock for rate and progress throttling; injectable for tests. */
  now?: () => number;
  /** When set, file bodies stream to the VFS in bounded pieces. */
  streamFetch?: StreamingFetch;
}

const VALUE_FLAGS = ['--to', '--revision', '--rev', '--concurrency', '-j', '--max-in-flight-mb'];

export function createHfCommand(deps: HfCommandDeps): Command {
  const now = deps.now ?? Date.now;
  return {
    name: 'hf',
    async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
      if (args.length === 0 || isHelpRequest(args, { valueFlags: VALUE_FLAGS })) {
        return help(args.length === 0 ? 1 : 0);
      }
      const sub = args[0];
      if (sub === 'download') return runDownload(args.slice(1), ctx, deps, now);
      return failure(`unknown subcommand: ${sub}`);
    },
  };
}
