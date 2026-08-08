import { describe, expect, it, vi } from 'vitest';
import type { SidecarIndexJson } from '../../src/fs/sidecar-merge.js';
import {
  repairSidecarDocument,
  resolveWithSidecarRepair,
  type SidecarProbe,
  type SidecarRepairSummary,
} from '../../src/fs/sidecar-repair.js';

const S_IFDIR = 0o40000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

const file = (size: number, perms = 0o644) => ({ mode: S_IFREG | perms, size });
const dir = (perms = 0o755) => ({ mode: S_IFDIR | perms });
const symlink = () => ({ mode: S_IFLNK | 0o777, size: 10 });

const probeFrom =
  (real: Record<string, { kind: 'file'; size: number } | { kind: 'directory' }>): SidecarProbe =>
  async (path) =>
    real[path] ?? { kind: 'missing' };

describe('repairSidecarDocument', () => {
  it('flips a file entry over a real directory to dir mode (the EISDIR brick)', async () => {
    const doc: SidecarIndexJson = {
      version: 1,
      entries: { '/': dir(), '/workspace': file(123) },
    };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({ '/workspace': { kind: 'directory' } })
    );
    expect(summary.changed).toBe(true);
    expect(summary.kindFixed).toEqual(['/workspace file→dir']);
    expect((doc.entries?.['/workspace'] as { mode: number }).mode & 0o170000).toBe(S_IFDIR);
  });

  it('flips a dir entry over a real file and preserves permission bits', async () => {
    const doc: SidecarIndexJson = { entries: { '/x': dir(0o700) } };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({ '/x': { kind: 'file', size: 1 } })
    );
    expect(summary.kindFixed).toEqual(['/x dir→file']);
    const mode = (doc.entries?.['/x'] as { mode: number }).mode;
    expect(mode & 0o170000).toBe(S_IFREG);
    expect(mode & 0o777).toBe(0o700);
  });

  it('trues up a stale size (the "file data size mismatch" storm)', async () => {
    const doc: SidecarIndexJson = { entries: { '/CLAUDE.md': file(16907) } };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({ '/CLAUDE.md': { kind: 'file', size: 16681 } })
    );
    expect(summary.sizesFixed).toBe(1);
    expect((doc.entries?.['/CLAUDE.md'] as { size: number }).size).toBe(16681);
  });

  it('drops entries whose paths are gone and leaves symlinks alone', async () => {
    const doc: SidecarIndexJson = {
      entries: { '/gone.txt': file(5), '/link': symlink() },
    };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({ '/link': { kind: 'file', size: 10 } })
    );
    expect(summary.dropped).toBe(1);
    expect(doc.entries).not.toHaveProperty('/gone.txt');
    // Symlink entry untouched even though the probe reports a plain file.
    expect(doc.entries?.['/link']).toEqual(symlink());
  });

  it('reports changed=false for a healthy sidecar', async () => {
    const doc: SidecarIndexJson = { entries: { '/': dir(), '/ok.txt': file(4) } };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({ '/ok.txt': { kind: 'file', size: 4 } })
    );
    expect(summary).toEqual({ kindFixed: [], sizesFixed: 0, dropped: 0, changed: false });
  });
});

describe('resolveWithSidecarRepair', () => {
  const repaired: SidecarRepairSummary = {
    kindFixed: ['/x'],
    sizesFixed: 0,
    dropped: 0,
    changed: true,
  };

  it('returns the first resolve on success without repairing', async () => {
    const repair = vi.fn();
    await expect(resolveWithSidecarRepair(async () => 'ok', repair, vi.fn())).resolves.toBe('ok');
    expect(repair).not.toHaveBeenCalled();
  });

  it('repairs and retries once after a failed mount (the boot brick path)', async () => {
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('EISDIR'), { code: 'EISDIR' }))
      .mockResolvedValueOnce('mounted');
    const onRepaired = vi.fn();
    await expect(resolveWithSidecarRepair(resolve, async () => repaired, onRepaired)).resolves.toBe(
      'mounted'
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(onRepaired).toHaveBeenCalledWith(repaired);
  });

  it('rethrows the ORIGINAL error when the repair found nothing to fix', async () => {
    const original = new Error('not a sidecar problem');
    const resolve = vi.fn().mockRejectedValue(original);
    await expect(
      resolveWithSidecarRepair(resolve, async () => ({ ...repaired, changed: false }), vi.fn())
    ).rejects.toBe(original);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('rethrows the original error when the repair itself throws', async () => {
    const original = new Error('mount failed');
    await expect(
      resolveWithSidecarRepair(
        vi.fn().mockRejectedValue(original),
        async () => {
          throw new Error('repair exploded');
        },
        vi.fn()
      )
    ).rejects.toBe(original);
  });

  it('surfaces the retry error when the repaired mount still fails', async () => {
    const retryError = new Error('still broken');
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(retryError);
    await expect(resolveWithSidecarRepair(resolve, async () => repaired, vi.fn())).rejects.toBe(
      retryError
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
