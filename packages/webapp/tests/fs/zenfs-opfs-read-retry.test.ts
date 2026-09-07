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

  it('does not retry failed snapshot acquisition', async () => {
    const error = new DOMException('Snapshot unavailable', 'NotReadableError');
    const reader = setupReader([readable]);
    reader.getFile.mockReset().mockRejectedValue(error);
    await expect(reader.read()).rejects.toBe(error);
    expect(reader.getFile).toHaveBeenCalledTimes(1);
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
});
