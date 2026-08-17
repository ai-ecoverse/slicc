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
    const fixed = doc.entries?.['/x'] as { mode: number; size?: number };
    expect(fixed.mode & 0o170000).toBe(S_IFREG);
    expect(fixed.mode & 0o777).toBe(0o700);
    // A directory entry carried no size — the flipped file entry must state
    // the real one, or the retry mount re-enters the size-mismatch storm.
    expect(fixed.size).toBe(1);
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
      entries: {
        '/gone.txt': { ...file(5), ino: 3, data: 4 },
        '/link': { ...symlink(), ino: 5, data: 6 },
      } as SidecarIndexJson['entries'],
    };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({ '/link': { kind: 'file', size: 10 } })
    );
    expect(summary.dropped).toBe(1);
    expect(doc.entries).not.toHaveProperty('/gone.txt');
    // Symlink entry untouched even though the probe reports a plain file.
    expect(doc.entries?.['/link']).toEqual({ ...symlink(), ino: 5, data: 6 });
  });

  it('reports changed=false for a healthy sidecar', async () => {
    // Healthy now includes unique inos (#2146) — ino-less entries are
    // legitimately reassigned, so the no-op fixture must carry them.
    const doc: SidecarIndexJson = {
      entries: {
        '/': { ...dir(), ino: 0, data: 0 },
        '/ok.txt': { ...file(4), ino: 1, data: 2 },
      } as SidecarIndexJson['entries'],
    };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({ '/ok.txt': { kind: 'file', size: 4 } })
    );
    expect(summary).toEqual({
      kindFixed: [],
      sizesFixed: 0,
      dropped: 0,
      selfEntryDropped: false,
      inosReassigned: 0,
      changed: false,
    });
  });

  it('drops the self-referential /.metadata.json entry instead of truing it up', async () => {
    // The live boot brick: the sidecar records its OWN size, which can never
    // match reality because writing the sidecar changes that very size. Pre-fix
    // the repair trued the size up and the rewrite invalidated it again — a
    // non-converging boot loop. Now the entry is dropped and real files are left
    // untouched.
    const doc: SidecarIndexJson = {
      entries: { '/': dir(), '/.metadata.json': file(3403559), '/ok.txt': file(4) },
    };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({
        '/.metadata.json': { kind: 'file', size: 3336477 },
        '/ok.txt': { kind: 'file', size: 4 },
      })
    );
    expect(summary.selfEntryDropped).toBe(true);
    expect(summary.changed).toBe(true);
    expect(summary.sizesFixed).toBe(0); // dropped, NOT trued up
    expect(doc.entries).not.toHaveProperty('/.metadata.json');
    expect(doc.entries).toHaveProperty('/ok.txt'); // real files survive
  });

  it('converges: a repaired sidecar has no self-entry left to re-fix', async () => {
    const doc: SidecarIndexJson = { entries: { '/.metadata.json': file(100) } };
    const probe = probeFrom({ '/.metadata.json': { kind: 'file', size: 50 } });
    const first = await repairSidecarDocument(doc, probe);
    expect(first.changed).toBe(true);
    // Second pass over the already-repaired doc finds nothing — the
    // non-converging boot-repair loop cannot recur.
    const second = await repairSidecarDocument(doc, probe);
    expect(second.changed).toBe(false);
    expect(second.selfEntryDropped).toBe(false);
  });
});

describe('repairSidecarDocument — ino uniqueness (#2146)', () => {
  it('reassigns zero and duplicate inos to fresh unique ids above the max', async () => {
    const doc: SidecarIndexJson = {
      entries: {
        '/': { ...dir(), ino: 0, data: 0 },
        '/a.txt': { ...file(10), ino: 0, data: 0 },
        '/b.txt': { ...file(20), ino: 0, data: 0 },
        '/c.txt': { ...file(30), ino: 7, data: 8 },
        '/dup.txt': { ...file(40), ino: 7, data: 9 },
      } as SidecarIndexJson['entries'],
    };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({
        '/a.txt': { kind: 'file', size: 10 },
        '/b.txt': { kind: 'file', size: 20 },
        '/c.txt': { kind: 'file', size: 30 },
        '/dup.txt': { kind: 'file', size: 40 },
      })
    );
    expect(summary.inosReassigned).toBe(3); // a, b, dup — c keeps 7, / exempt
    expect(summary.changed).toBe(true);
    const entries = doc.entries as Record<string, { ino?: number; data?: number }>;
    expect(entries['/'].ino).toBe(0); // ZenFS forces / to ino 0 — leave it
    expect(entries['/c.txt'].ino).toBe(7); // first claimant keeps its id
    const reassigned = ['/a.txt', '/b.txt', '/dup.txt'].map((p) => entries[p].ino);
    // Fresh ids are unique, nonzero, and above the pre-existing max (9).
    expect(new Set(reassigned).size).toBe(3);
    for (const ino of reassigned) {
      expect(ino).toBeGreaterThan(9);
    }
    for (const p of ['/a.txt', '/b.txt', '/dup.txt']) {
      expect(entries[p].data).toBe((entries[p].ino as number) + 1);
    }
  });

  it('a document with already-unique inos is untouched', async () => {
    const doc: SidecarIndexJson = {
      entries: {
        '/': { ...dir(), ino: 0 },
        '/x.txt': { ...file(1), ino: 3, data: 4 },
        '/y.txt': { ...file(2), ino: 5, data: 6 },
      } as SidecarIndexJson['entries'],
    };
    const summary = await repairSidecarDocument(
      doc,
      probeFrom({
        '/x.txt': { kind: 'file', size: 1 },
        '/y.txt': { kind: 'file', size: 2 },
      })
    );
    expect(summary.inosReassigned).toBe(0);
    expect(summary.changed).toBe(false);
  });
});

describe('resolveWithSidecarRepair', () => {
  const repaired: SidecarRepairSummary = {
    kindFixed: ['/x'],
    sizesFixed: 0,
    dropped: 0,
    selfEntryDropped: false,
    inosReassigned: 0,
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
