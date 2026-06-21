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
import { downloadHfRepo, HfFileDownloadError, resolveTargetDir } from './hf-download.js';

// `resolveTargetDir` now lives in the reusable core; re-export it so existing
// importers (and tests) keep resolving it from this module.
export { resolveTargetDir } from './hf-download.js';

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

  const targetDir = resolveTargetDir(parsed.repo, parsed.to, ctx.cwd);
  let stderr = '';
  try {
    const result = await downloadHfRepo({
      fetch: fetchFn,
      fs: ctx.fs,
      repo: parsed.repo,
      targetDir,
      files: parsed.files,
      revision: parsed.revision,
      force: parsed.force,
      progress: {
        onListed: ({ files }) => {
          stderr += `hf: ${files.length} file(s) listed in ${parsed.repo}@${parsed.revision}\n`;
        },
        onFile: (evt) => {
          stderr +=
            evt.status === 'downloaded'
              ? `hf: downloaded ${evt.file} (${formatBytes(evt.bytes)})\n`
              : `hf: skipped ${evt.file} (already at ${targetDir})\n`;
        },
      },
    });
    const summary = `hf: ${result.downloaded} downloaded, ${result.skipped} skipped, ${formatBytes(result.totalBytes)} total into ${targetDir}\n`;
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
