import { describe, expect, it, vi } from 'vitest';
import { FsError } from '../../../src/fs/types.js';
import {
  readWholeFile,
  WHOLE_FILE_MAX_BYTES,
  type WholeFileFs,
} from '../../../src/kernel/realm/read-whole-file.js';

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

function cappedFs(content: Uint8Array, cap: number) {
  return {
    readFileBuffer: vi.fn(async (path: string) => {
      if (content.byteLength > cap) throw new FsError('EFBIG', 'over the body cap', path);
      return content.slice();
    }),
    readFileRange: vi.fn(async (_path: string, start: number, end: number) =>
      content.slice(start, Math.min(end, content.byteLength))
    ),
    stat: vi.fn(async () => ({ size: content.byteLength })),
  } satisfies WholeFileFs;
}

describe('readWholeFile', () => {
  it('returns a whole read under the cap without ranged reads', async () => {
    const fs = cappedFs(bytes(10), 100);
    await expect(readWholeFile(fs, '/m/small')).resolves.toEqual(bytes(10));
    expect(fs.readFileRange).not.toHaveBeenCalled();
  });

  it('assembles a file past the cap from ranged windows (#3762)', async () => {
    const fs = cappedFs(bytes(250), 100);
    await expect(readWholeFile(fs, '/m/big', 64)).resolves.toEqual(bytes(250));
    expect(fs.readFileRange.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [0, 64],
      [64, 128],
      [128, 192],
      [192, 250],
    ]);
  });

  it('ends where the file did when it shrank since the stat', async () => {
    const fs = cappedFs(bytes(250), 100);
    fs.stat.mockResolvedValueOnce({ size: 300 });
    const out = await readWholeFile(fs, '/m/big', 64);
    expect(out).toEqual(bytes(250));
  });

  it('keeps EFBIG when the backend has no ranged read', async () => {
    const { readFileBuffer, stat } = cappedFs(bytes(250), 100);
    await expect(readWholeFile({ readFileBuffer, stat }, '/m/big')).rejects.toMatchObject({
      code: 'EFBIG',
    });
  });

  it('refuses a file over the whole-read ceiling without allocating it', async () => {
    const fs = cappedFs(bytes(250), 100);
    fs.stat.mockResolvedValueOnce({ size: WHOLE_FILE_MAX_BYTES + 1 });
    await expect(readWholeFile(fs, '/m/huge')).rejects.toMatchObject({ code: 'EFBIG' });
    expect(fs.readFileRange).not.toHaveBeenCalled();
  });

  it('rethrows any other whole-read failure as it is', async () => {
    const fs = cappedFs(bytes(10), 100);
    fs.readFileBuffer.mockRejectedValueOnce(new FsError('EACCES', 'denied', '/m/x'));
    await expect(readWholeFile(fs, '/m/x')).rejects.toMatchObject({ code: 'EACCES' });
    expect(fs.readFileRange).not.toHaveBeenCalled();
  });
});
