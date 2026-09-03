/**
 * Per-invocation input staging for the wasm ffmpeg core.
 *
 * Inputs are not copied into MEMFS any more. Each `ffmpeg` / `ffprobe` run
 * gets its own directory in the core's filesystem with a WORKERFS mount
 * over the input `Blob`s: emscripten's WORKERFS serves reads straight from
 * `Blob.slice()` via `FileReaderSync`, so an input costs the wasm heap
 * nothing and the size limit moves from "fits in the 2 GiB heap twice" to
 * "fits on disk". Only the OUTPUT still lives in MEMFS until it is read
 * back.
 *
 * The directory name doubles as the invocation id, so two shell runs that
 * share the realm-cached core no longer collide on `__out_<basename>`, and
 * everything the run staged is unmounted and removed together.
 *
 * Names are relative (`__in3_kx1v/clip.mp4`, no leading slash) because the
 * concat demuxer's `safe` mode rejects absolute paths; the core's cwd is
 * `/`, so relative and absolute address the same node.
 */

import type { FFFSType } from '@ffmpeg/ffmpeg';
import { isCoreFault } from '../ffmpeg-wasm.js';

/** One entry of a WORKERFS mount: a flat name and its lazily-read bytes. */
export interface StagedFile {
  name: string;
  data: Blob;
}

/** The slice of `FFmpeg` the staging helpers drive. */
export interface StagingFs {
  createDir(path: string): Promise<boolean>;
  mount(fsType: FFFSType, options: { blobs: StagedFile[] }, mountPoint: string): Promise<boolean>;
  unmount(mountPoint: string): Promise<boolean>;
  deleteDir(path: string): Promise<boolean>;
  deleteFile(path: string): Promise<boolean>;
}

/** Names of one invocation's staging area inside the core's filesystem. */
export interface StageNames {
  /** Unique per invocation within the realm. */
  id: string;
  /** Relative mount directory, e.g. `__in3_kx1v`. */
  dir: string;
}

/** `FFFSType.WORKERFS` by value — avoids a runtime import of the enum. */
const WORKERFS = 'WORKERFS' as FFFSType;

let stageSeq = 0;

/** Fresh names for one invocation. Exported for tests. */
export function newStage(): StageNames {
  stageSeq = (stageSeq + 1) >>> 0;
  const id = `${stageSeq}_${Date.now().toString(36)}`;
  return { id, dir: `__in${id}` };
}

/** Path inside the core's FS of a file staged under `stage`. */
export function stagedPath(stage: StageNames, name: string): string {
  return `${stage.dir}/${name}`;
}

/** Flat name of a staged path — the `name` a WORKERFS entry needs. */
export function stagedBasename(ffmpegName: string): string {
  return ffmpegName.slice(ffmpegName.lastIndexOf('/') + 1);
}

/**
 * MEMFS name for this invocation's encode artifact. Carries the stage id
 * so concurrent runs with the same output basename cannot clobber each
 * other; keeps the basename so ffmpeg's muxer sniffing still works.
 */
export function stagedOutputName(stage: StageNames, outputPath: string): string {
  return `__out${stage.id}_${outputPath.split('/').pop() || 'out.bin'}`;
}

/**
 * Mount `files` read-only at the stage directory. A no-op with no files
 * (an all-lavfi invocation) so cleanup has nothing to unmount either.
 * Throws whatever the core throws — the caller decides whether that was a
 * fault worth recycling for.
 */
export async function mountStagedInputs(
  ffmpeg: StagingFs,
  stage: StageNames,
  files: StagedFile[]
): Promise<void> {
  if (files.length === 0) return;
  await ffmpeg.createDir(`/${stage.dir}`);
  await ffmpeg.mount(WORKERFS, { blobs: files }, `/${stage.dir}`);
}

/**
 * Unmount and remove the stage directory. Ordinary misses (nothing was
 * mounted, already gone) are swallowed; a core fault is rethrown so the
 * caller recycles instead of caching a dead instance.
 */
export async function unmountStagedInputs(ffmpeg: StagingFs, stage: StageNames): Promise<void> {
  try {
    await ffmpeg.unmount(`/${stage.dir}`);
  } catch (err) {
    if (isCoreFault(err)) throw err;
  }
  try {
    await ffmpeg.deleteDir(`/${stage.dir}`);
  } catch (err) {
    if (isCoreFault(err)) throw err;
  }
}

/** Delete one MEMFS file, rethrowing only core faults. */
export async function deleteStagedFile(ffmpeg: StagingFs, name: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(name);
  } catch (err) {
    if (isCoreFault(err)) throw err;
  }
}
