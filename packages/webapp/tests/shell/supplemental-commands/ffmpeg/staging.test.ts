import { describe, expect, it, vi } from 'vitest';
import {
  deleteStagedFile,
  mountStagedInputs,
  newStage,
  type StagingFs,
  stagedBasename,
  stagedOutputName,
  stagedPath,
  unmountStagedInputs,
} from '../../../../src/shell/supplemental-commands/ffmpeg/staging.js';

function fakeFs(): StagingFs & { [K in keyof StagingFs]: ReturnType<typeof vi.fn> } {
  return {
    createDir: vi.fn().mockResolvedValue(true),
    mount: vi.fn().mockResolvedValue(true),
    unmount: vi.fn().mockResolvedValue(true),
    deleteDir: vi.fn().mockResolvedValue(true),
    deleteFile: vi.fn().mockResolvedValue(true),
  };
}

describe('stage names', () => {
  it('are unique per invocation and safe for the concat demuxer', () => {
    const a = newStage();
    const b = newStage();
    expect(a.id).not.toBe(b.id);
    expect(a.dir).not.toBe(b.dir);
    // Relative (no leading slash), and every path component starts with a
    // character the demuxer's `safe` mode accepts.
    expect(a.dir).toMatch(/^__in[0-9]+_[a-z0-9]+$/);
    expect(stagedPath(a, 'clip.mp4')).toBe(`${a.dir}/clip.mp4`);
  });

  it('derive a per-invocation output name that keeps the basename', () => {
    const stage = newStage();
    expect(stagedOutputName(stage, '/videos/out.mp4')).toBe(`__out${stage.id}_out.mp4`);
    expect(stagedOutputName(stage, '')).toBe(`__out${stage.id}_out.bin`);
    expect(stagedOutputName(newStage(), '/videos/out.mp4')).not.toBe(
      stagedOutputName(stage, '/videos/out.mp4')
    );
  });

  it('recover the flat WORKERFS entry name from a staged path', () => {
    const stage = newStage();
    expect(stagedBasename(stagedPath(stage, '__cat0_1_x.mp4'))).toBe('__cat0_1_x.mp4');
    expect(stagedBasename('plain.mp4')).toBe('plain.mp4');
  });
});

describe('mountStagedInputs', () => {
  it('creates the stage directory and mounts every blob read-only in one call', async () => {
    const fs = fakeFs();
    const stage = newStage();
    const files = [
      { name: 'a.mp4', data: new Blob([new Uint8Array([1])]) },
      { name: 'list.txt', data: new Blob(['file a.mp4']) },
    ];
    await mountStagedInputs(fs, stage, files);
    expect(fs.createDir).toHaveBeenCalledWith(`/${stage.dir}`);
    expect(fs.mount).toHaveBeenCalledTimes(1);
    expect(fs.mount).toHaveBeenCalledWith('WORKERFS', { blobs: files }, `/${stage.dir}`);
  });

  it('does nothing for an all-virtual invocation', async () => {
    const fs = fakeFs();
    await mountStagedInputs(fs, newStage(), []);
    expect(fs.createDir).not.toHaveBeenCalled();
    expect(fs.mount).not.toHaveBeenCalled();
  });

  it('propagates a mount failure so the caller can classify it', async () => {
    const fs = fakeFs();
    fs.mount.mockRejectedValue(new Error('FS error'));
    await expect(
      mountStagedInputs(fs, newStage(), [{ name: 'a', data: new Blob(['x']) }])
    ).rejects.toThrow('FS error');
  });
});

describe('unmountStagedInputs', () => {
  it('unmounts then removes the stage directory', async () => {
    const fs = fakeFs();
    const stage = newStage();
    await unmountStagedInputs(fs, stage);
    expect(fs.unmount).toHaveBeenCalledWith(`/${stage.dir}`);
    expect(fs.deleteDir).toHaveBeenCalledWith(`/${stage.dir}`);
  });

  it('swallows ordinary misses (nothing mounted) but still removes the dir', async () => {
    const fs = fakeFs();
    fs.unmount.mockRejectedValue(new Error('FS error: EINVAL'));
    fs.deleteDir.mockRejectedValue(new Error('FS error: ENOENT'));
    await expect(unmountStagedInputs(fs, newStage())).resolves.toBeUndefined();
    expect(fs.deleteDir).toHaveBeenCalled();
  });

  it('rethrows a core fault so the caller recycles instead of caching a dead core', async () => {
    const fs = fakeFs();
    fs.unmount.mockRejectedValue(new WebAssembly.RuntimeError('memory access out of bounds'));
    await expect(unmountStagedInputs(fs, newStage())).rejects.toBeInstanceOf(
      WebAssembly.RuntimeError
    );
    // The fault short-circuits: no second re-entry into the dead module.
    expect(fs.deleteDir).not.toHaveBeenCalled();
  });
});

describe('deleteStagedFile', () => {
  it('swallows a missing file and rethrows a fault', async () => {
    const fs = fakeFs();
    fs.deleteFile.mockRejectedValueOnce(new Error('FS error: ENOENT'));
    await expect(deleteStagedFile(fs, '__out1_x.mp4')).resolves.toBeUndefined();
    fs.deleteFile.mockRejectedValueOnce(new Error('Aborted(OOM)'));
    await expect(deleteStagedFile(fs, '__out1_x.mp4')).rejects.toThrow('Aborted');
  });
});
