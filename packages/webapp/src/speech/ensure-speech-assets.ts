import type { SecureFetch } from 'just-bash';
import { createLogger } from '../base/logger.js';
import { isExtensionRealm } from '../core/runtime-env.js';
import type { VirtualFS } from '../fs/index.js';
import { installPackages } from '../shell/ipk/installer.js';
import {
  downloadHfRepo,
  type HfFileEvent,
  resolveTargetDir,
} from '../shell/supplemental-commands/hf-download.js';
import { ESPEAK_DIST_VFS_PATH, ESPEAK_GLUE_FILE, ESPEAK_WASM_FILE } from './espeak-phonemizer.js';
import { KOKORO_MODEL_ID, WHISPER_MODEL_ID } from './model-ids.js';
import { ORT_DIST_VFS_PATH, ORT_WASM_DIST_FILES } from './transformers-env.js';

const log = createLogger('speech:ensure-assets');

const ORT_PACKAGE = 'onnxruntime-web';

const ESPEAK_PACKAGE = 'espeak-ng';
const ESPEAK_DIST_FILES: ReadonlyArray<string> = [ESPEAK_GLUE_FILE, ESPEAK_WASM_FILE];
const WORKSPACE_CWD = '/workspace';

const isExtensionFloat = isExtensionRealm;

export type SpeechAssetPhase =
  | 'staging'
  | 'listing'
  | 'downloaded'
  | 'skipped'
  | 'present'
  | 'done';

export interface SpeechAssetProgress {
  asset: string;
  phase: SpeechAssetPhase;

  file?: string;

  filesLoaded?: number;

  filesTotal?: number;

  bytesLoaded?: number;

  bytesTotal?: number;
}

export type SpeechAssetProgressFn = (progress: SpeechAssetProgress) => void;

export interface EnsureSpeechAssetsDeps {
  fs: VirtualFS;
  fetch: SecureFetch;

  repos?: string[];
}

export interface EnsureSpeechAssetsResult {
  skipped: boolean;

  ortStaged: boolean;

  espeakStaged: boolean;
  repos: Array<{ repo: string; downloaded: number; skipped: number }>;
}

const ORT_REQUIRED_DIST_FILES: ReadonlyArray<string> = ORT_WASM_DIST_FILES.filter(
  (f) => !/\.(asyncify|jspi)\./.test(f)
);

async function ensureOrtStaged(
  deps: EnsureSpeechAssetsDeps,
  onProgress?: SpeechAssetProgressFn
): Promise<boolean> {
  const present = await Promise.all(
    ORT_REQUIRED_DIST_FILES.map((f) => deps.fs.exists(`${ORT_DIST_VFS_PATH}${f}`))
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
