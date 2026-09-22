import { WebAccessFS } from '@zenfs/dom';
import { describe, expect, it, vi } from 'vitest';

const bytes = new TextEncoder().encode('after!');

function setupReader(reads: Array<() => Promise<ArrayBuffer>>) {
  const getFile = vi.fn();
  for (const arrayBuffer of reads) getFile.mockResolvedValueOnce({ arrayBuffer });
  const handle = { getFile } as unknown as FileSystemFileHandle;
  const getFileHandle = vi.fn().mockResolvedValue(handle);
  const backend = new WebAccessFS({ getFileHandle } as unknown as FileSystemDirectoryHandle);
  const output = new Uint8Array(bytes.length);
  return {
    getFileHandle,
    getFile,
    output,
    read: () => backend.read('/race.txt', output, 0, bytes.length),
  };
}

const readable = () => Promise.resolve(bytes.slice().buffer);
const unreadable = (error: DOMException) => () => Promise.reject(error);

describe('WebAccess File snapshot retry', () => {
  it('reads a stable snapshot once', async () => {
    const reader = setupReader([readable]);
    await reader.read();
    expect(reader.output).toEqual(bytes);
    expect(reader.getFile).toHaveBeenCalledTimes(1);
  });

  it('reacquires File snapshots after concurrent writes invalidate two reads', async () => {
    const stale = new DOMException('Snapshot changed', 'NotReadableError');
    const reader = setupReader([unreadable(stale), unreadable(stale), readable]);
    await reader.read();
    expect(reader.output).toEqual(bytes);
    expect(reader.getFile).toHaveBeenCalledTimes(3);
  });

  it('stops after three invalidated snapshots and preserves the last error', async () => {
    const errors = [1, 2, 3].map((n) => new DOMException(`Snapshot ${n}`, 'NotReadableError'));
    const reader = setupReader([...errors.map(unreadable), readable]);
    await expect(reader.read()).rejects.toBe(errors[2]);
    expect(reader.getFile).toHaveBeenCalledTimes(3);
    expect(reader.output).toEqual(new Uint8Array(bytes.length));
  });

  it.each(['NotAllowedError', 'NotFoundError', 'AbortError'])('does not retry %s', async (name) => {
    const error = new DOMException('Read failed', name);
    const reader = setupReader([unreadable(error), readable]);
    await expect(reader.read()).rejects.toBe(error);
    expect(reader.getFile).toHaveBeenCalledTimes(1);
  });

  it('retries NotReadableError thrown by getFile itself', async () => {
    const stale = new DOMException(
      'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.',
      'NotReadableError'
    );
    const reader = setupReader([readable]);
    reader.getFile
      .mockReset()
      .mockRejectedValueOnce(stale)
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce({ arrayBuffer: readable });
    await reader.read();
    expect(reader.output).toEqual(bytes);
    expect(reader.getFile).toHaveBeenCalledTimes(3);
  });

  it('stops after three NotReadableError failures from getFile', async () => {
    const errors = [1, 2, 3].map((n) => new DOMException(`Snapshot ${n}`, 'NotReadableError'));
    const reader = setupReader([readable]);
    reader.getFile.mockReset();
    for (const error of errors) reader.getFile.mockRejectedValueOnce(error);
    reader.getFile.mockResolvedValueOnce({ arrayBuffer: readable });
    await expect(reader.read()).rejects.toBe(errors[2]);
    expect(reader.getFile).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-native error with the same name', async () => {
    const error = Object.assign(new Error('Not a native snapshot failure'), {
      name: 'NotReadableError',
    });
    const reader = setupReader([() => Promise.reject(error), readable]);
    await expect(reader.read()).rejects.toBe(error);
    expect(reader.getFile).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed handle lookup', async () => {
    const error = new DOMException('Permission denied', 'NotAllowedError');
    const reader = setupReader([readable]);
    reader.getFileHandle.mockRejectedValue(error);
    await expect(reader.read()).rejects.toMatchObject({ code: 'EACCES' });
    expect(reader.getFile).not.toHaveBeenCalled();
  });

  it('reads a window through a sync access handle and does not snapshot the file', async () => {
    const file = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const read = vi.fn((view: Uint8Array, opts: { at: number }) => {
      view.set(file.subarray(opts.at, opts.at + view.length));
      return view.length;
    });
    const close = vi.fn();
    const getFile = vi.fn();
    const handle = {
      getFile,
      createSyncAccessHandle: vi.fn(async () => ({ read, close })),
    };
    const getFileHandle = vi.fn().mockResolvedValue(handle);
    const backend = new WebAccessFS({ getFileHandle } as unknown as FileSystemDirectoryHandle);
    const output = new Uint8Array(4);
    await backend.read('/model.onnx.data', output, 2, 6);
    expect(Array.from(output)).toEqual([2, 3, 4, 5]);
    expect(getFile).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('falls back to a snapshot when the sync access handle is locked', async () => {
    const reader = setupReader([readable]);
    const locked = {
      getFile: reader.getFile,
      createSyncAccessHandle: vi.fn(async () => {
        throw new DOMException('locked', 'NoModificationAllowedError');
      }),
    };
    reader.getFileHandle.mockReset();
    reader.getFileHandle.mockResolvedValue(locked);
    await reader.read();
    expect(reader.output).toEqual(bytes);
    expect(locked.createSyncAccessHandle).toHaveBeenCalledOnce();
    expect(reader.getFile).toHaveBeenCalledTimes(1);
  });
});
