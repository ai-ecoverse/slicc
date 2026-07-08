/**
 * `ensureSpeechAssetsStaged` — idempotent kernel-worker routine that stages the
 * enhanced-speech VFS assets on demand:
 *
 *   1. the `onnxruntime-web` wasm runtime into
 *      `/workspace/node_modules/onnxruntime-web/dist/` (reusing the `ipk add`
 *      installer code path), and
 *   2. the whisper + kokoro weight repos into `/workspace/models/<repo>/`
 *      (reusing the `hf download` core — list + per-file byte-skip + proxied
 *      `SecureFetch` + dir creation).
 *
 * The multilingual `espeak-ng` wasm is staged best-effort after the core assets:
 * non-English Kokoro voices use it, but Whisper and English Kokoro should still
 * come up if that optional package is unavailable.
 *
 * Already-staged assets are skipped, so a second call is a fast no-op (the ort
 * fast path avoids the network entirely when every dist file is present; weight
 * repos still list the tree once, then skip every byte-matching file).
 *
 * Network goes through the captured `SecureFetch` (the bridge fetch-proxy), so
 * fetch-layer failures surface host-named, actionable errors (offline / HF
 * unreachable / proxy down) via the shared `hf-download` core.
 *
 * The page-realm caller invokes this over the dedicated page→worker bridge in
 * `kernel/speech-assets-bridge.ts`. Cross-runtime parity: the extension float
 * loads speech assets directly under `host_permissions` (no VFS staging), so
 * this routine early-returns there — N/A by design.
 */

import type { SecureFetch } from 'just-bash';
import { createLogger } from '../core/logger.js';
import { isExtensionRealm } from '../core/runtime-env.js';
import type { VirtualFS } from '../fs/index.js';
import { installPackages } from '../shell/ipk/installer.js';
import {
  downloadHfRepo,
  type HfFileEvent,
  resolveTargetDir,
} from '../shell/supplemental-commands/hf-download.js';
import { ESPEAK_DIST_VFS_PATH, ESPEAK_GLUE_FILE, ESPEAK_WASM_FILE } from './espeak-phonemizer.js';
import { KOKORO_MODEL_ID } from './kokoro-engine.js';
import { ORT_DIST_VFS_PATH, ORT_WASM_DIST_FILES } from './transformers-env.js';
import { WHISPER_MODEL_ID } from './whisper-engine.js';

const log = createLogger('speech:ensure-assets');

const ORT_PACKAGE = 'onnxruntime-web';
/** Multilingual espeak-ng wasm — phonemizes the non-English on-device voices
 *  (es/fr/it/hi/pt). Staged like ort; not bundled (~17 MB). */
const ESPEAK_PACKAGE = 'espeak-ng';
const ESPEAK_DIST_FILES: ReadonlyArray<string> = [ESPEAK_GLUE_FILE, ESPEAK_WASM_FILE];
const WORKSPACE_CWD = '/workspace';

const isExtensionFloat = isExtensionRealm;

/** Lifecycle phase of a single asset (the ort package or one weight repo). */
export type SpeechAssetPhase =
  | 'staging'
  | 'listing'
  | 'downloaded'
  | 'skipped'
  | 'present'
  | 'done';

/** Coarse progress for one speech asset, streamed back to the page caller. */
export interface SpeechAssetProgress {
  /** The ort package name or a model repo id. */
  asset: string;
  phase: SpeechAssetPhase;
  /** Current file (weight repos only). */
  file?: string;
  /** Files completed so far for this asset. */
  filesLoaded?: number;
  /** Total files for this asset (known after listing). */
  filesTotal?: number;
  /** Cumulative bytes downloaded/skipped for this asset. */
  bytesLoaded?: number;
  /** Total declared bytes for this asset (weight repos, after listing). */
  bytesTotal?: number;
}

export type SpeechAssetProgressFn = (progress: SpeechAssetProgress) => void;

export interface EnsureSpeechAssetsDeps {
  fs: VirtualFS;
  fetch: SecureFetch;
  /** Override the staged weight repos (defaults to whisper + kokoro). Test seam. */
  repos?: string[];
}

export interface EnsureSpeechAssetsResult {
  /** True on the extension float — no VFS staging performed (N/A by design). */
  skipped: boolean;
  /** True when the ort runtime was (re)installed this call. */
  ortStaged: boolean;
  /** True when the espeak-ng multilingual phonemizer was (re)installed. */
  espeakStaged: boolean;
  repos: Array<{ repo: string; downloaded: number; skipped: number }>;
}

/** Stage the ort wasm runtime if any known dist file is missing. */
async function ensureOrtStaged(
  deps: EnsureSpeechAssetsDeps,
  onProgress?: SpeechAssetProgressFn
): Promise<boolean> {
  const present = await Promise.all(
    ORT_WASM_DIST_FILES.map((f) => deps.fs.exists(`${ORT_DIST_VFS_PATH}${f}`))
  );
  if (present.every(Boolean)) {
    onProgress?.({ asset: ORT_PACKAGE, phase: 'present' });
    return false;
  }
  onProgress?.({ asset: ORT_PACKAGE, phase: 'staging' });
  const { errors } = await installPackages([ORT_PACKAGE], {
    fs: deps.fs,
    fetch: deps.fetch,
    cwd: WORKSPACE_CWD,
  });
  if (errors.length > 0) {
    throw new Error(`failed to stage ${ORT_PACKAGE} wasm runtime: ${errors[0].error.message}`);
  }
  onProgress?.({ asset: ORT_PACKAGE, phase: 'done' });
  return true;
}

/** Stage the multilingual espeak-ng wasm if either dist file is missing —
 *  parallel to `ensureOrtStaged`, reusing the same `ipk` installer path. */
async function ensureEspeakStaged(
  deps: EnsureSpeechAssetsDeps,
  onProgress?: SpeechAssetProgressFn
): Promise<boolean> {
  const present = await Promise.all(
    ESPEAK_DIST_FILES.map((f) => deps.fs.exists(`${ESPEAK_DIST_VFS_PATH}${f}`))
  );
  if (present.every(Boolean)) {
    onProgress?.({ asset: ESPEAK_PACKAGE, phase: 'present' });
    return false;
  }
  onProgress?.({ asset: ESPEAK_PACKAGE, phase: 'staging' });
  const { errors } = await installPackages([ESPEAK_PACKAGE], {
    fs: deps.fs,
    fetch: deps.fetch,
    cwd: WORKSPACE_CWD,
  });
  if (errors.length > 0) {
    throw new Error(`failed to stage ${ESPEAK_PACKAGE} wasm: ${errors[0].error.message}`);
  }
  onProgress?.({ asset: ESPEAK_PACKAGE, phase: 'done' });
  return true;
}

/** Best-effort espeak staging: non-English Kokoro can retry later, but core
 * speech assets must not fail just because this optional package is blocked. */
async function ensureEspeakStagedBestEffort(
  deps: EnsureSpeechAssetsDeps,
  onProgress?: SpeechAssetProgressFn
): Promise<boolean> {
  try {
    return await ensureEspeakStaged(deps, onProgress);
  } catch (err) {
    log.warn('optional espeak-ng staging failed; non-English Kokoro voices may fall back', err);
    return false;
  }
}

/** Stage one weight repo via the shared `hf download` core. */
async function stageRepo(
  deps: EnsureSpeechAssetsDeps,
  repo: string,
  onProgress?: SpeechAssetProgressFn
): Promise<{ repo: string; downloaded: number; skipped: number }> {
  const targetDir = resolveTargetDir(repo, null, WORKSPACE_CWD);
  let bytesLoaded = 0;
  const result = await downloadHfRepo({
    fetch: deps.fetch,
    fs: deps.fs,
    repo,
    targetDir,
    progress: {
      onListed: ({ files, totalBytes }) =>
        onProgress?.({
          asset: repo,
          phase: 'listing',
          filesLoaded: 0,
          filesTotal: files.length,
          bytesLoaded: 0,
          bytesTotal: totalBytes,
        }),
      onFile: (evt: HfFileEvent) => {
        bytesLoaded += evt.bytes;
        onProgress?.({
          asset: repo,
          phase: evt.status,
          file: evt.file,
          filesLoaded: evt.index,
          filesTotal: evt.total,
          bytesLoaded,
        });
      },
    },
  });
  onProgress?.({
    asset: repo,
    phase: 'done',
    filesLoaded: result.files.length,
    filesTotal: result.files.length,
    bytesLoaded,
    bytesTotal: bytesLoaded,
  });
  return { repo, downloaded: result.downloaded, skipped: result.skipped };
}

/**
 * Idempotently stage every enhanced-speech asset (ort runtime + whisper +
 * kokoro weights). Resolves when all assets are present; rejects with a
 * host-named, actionable error on any fetch / install failure.
 */
export async function ensureSpeechAssetsStaged(
  deps: EnsureSpeechAssetsDeps,
  onProgress?: SpeechAssetProgressFn
): Promise<EnsureSpeechAssetsResult> {
  if (isExtensionFloat()) {
    return { skipped: true, ortStaged: false, espeakStaged: false, repos: [] };
  }
  const ortStaged = await ensureOrtStaged(deps, onProgress);
  const repos = deps.repos ?? [WHISPER_MODEL_ID, KOKORO_MODEL_ID];
  const repoResults: Array<{ repo: string; downloaded: number; skipped: number }> = [];
  for (const repo of repos) {
    repoResults.push(await stageRepo(deps, repo, onProgress));
  }
  const espeakStaged = await ensureEspeakStagedBestEffort(deps, onProgress);
  log.info('speech assets staged', { ortStaged, espeakStaged, repos: repoResults.length });
  return { skipped: false, ortStaged, espeakStaged, repos: repoResults };
}
