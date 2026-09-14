import type { FFFSType } from '@ffmpeg/ffmpeg';
import { isCoreFault } from '../ffmpeg-wasm.js';

export interface StagedFile {
  name: string;
  data: Blob;
}

export interface StagingFs {
  createDir(path: string): Promise<boolean>;
  mount(fsType: FFFSType, options: { blobs: StagedFile[] }, mountPoint: string): Promise<boolean>;
  unmount(mountPoint: string): Promise<boolean>;
  deleteDir(path: string): Promise<boolean>;
  deleteFile(path: string): Promise<boolean>;
}

export interface StageNames {
  id: string;

  dir: string;
}

const WORKERFS = 'WORKERFS' as FFFSType;

let stageSeq = 0;

export function newStage(): StageNames {
  stageSeq = (stageSeq + 1) >>> 0;
  const id = `${stageSeq}_${Date.now().toString(36)}`;
  return { id, dir: `__in${id}` };
}

export function stagedPath(stage: StageNames, name: string): string {
  return `${stage.dir}/${name}`;
}

export function stagedBasename(ffmpegName: string): string {
  return ffmpegName.slice(ffmpegName.lastIndexOf('/') + 1);
}

export function stagedOutputName(stage: StageNames, outputPath: string): string {
  return `__out${stage.id}_${outputPath.split('/').pop() || 'out.bin'}`;
}

export async function mountStagedInputs(
  ffmpeg: StagingFs,
  stage: StageNames,
  files: StagedFile[]
): Promise<void> {
  if (files.length === 0) return;
  await ffmpeg.createDir(`/${stage.dir}`);
  await ffmpeg.mount(WORKERFS, { blobs: files }, `/${stage.dir}`);
}

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

export async function deleteStagedFile(ffmpeg: StagingFs, name: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(name);
  } catch (err) {
    if (isCoreFault(err)) throw err;
  }
}
