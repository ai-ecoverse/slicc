import { describe, expect, it } from 'vitest';
import {
  mergeSidecarEntries,
  type SidecarDirtyState,
  type SidecarEntries,
  type SidecarIndexJson,
  type SidecarInodeJson,
  stripSidecarSelfEntry,
} from '../../src/fs/sidecar-merge.js';

/** Test stub: distinct tag plus the numeric fields consumers actually read. */
const entry = (tag: string): SidecarInodeJson & { tag: string } => ({
  tag,
  mode: 0o100644,
  size: 0,
});

const dirty = (paths: string[] = [], prefixes: string[] = []): SidecarDirtyState => ({
  paths: new Set(paths),
  prefixes: new Set(prefixes),
});

const doc = (entries: SidecarEntries, rest: Partial<SidecarIndexJson> = {}) => ({
  version: 1,
  maxSize: 100,
  ...rest,
  entries,
});

describe('mergeSidecarEntries', () => {
  it('regression #1992: preserves foreign entries a stale context never touched', () => {
    // On disk: an externally repaired sidecar (e.g. the manual EISDIR fix).
    const onDisk = doc({
      '/': entry('root-disk'),
      '/workspace': entry('dir-repaired'),
      '/etc': entry('dir-repaired'),
      '/scoops/x/.github': entry('dir-repaired'),
    });
    // This context's stale in-memory index still believes the old poison.
    const own = doc({
      '/': entry('root-own'),
      '/workspace': entry('file-poison'),
      '/etc': entry('file-poison'),
      '/scoops/x/.github': entry('file-poison'),
      '/tmp/own-new.txt': entry('file-own'),
    });
    // The context only ever wrote /tmp/own-new.txt.
    const merged = mergeSidecarEntries(onDisk, own, dirty(['/tmp/own-new.txt', '/tmp']));

    // The repair SURVIVES; only the genuinely-dirty path is overwritten.
    expect(merged.entries?.['/workspace']).toEqual(entry('dir-repaired'));
    expect(merged.entries?.['/etc']).toEqual(entry('dir-repaired'));
    expect(merged.entries?.['/scoops/x/.github']).toEqual(entry('dir-repaired'));
    expect(merged.entries?.['/tmp/own-new.txt']).toEqual(entry('file-own'));
  });

  it('never persists a self-referential /.metadata.json entry (the boot brick)', () => {
    // ZenFS indexes its own sidecar file, so the entry can arrive from either
    // the on-disk base or this context's own index. A persisted self-entry
    // re-bricks the next cold-boot crossCopy; the merge must strip it.
    const onDisk = doc({ '/': entry('root'), '/.metadata.json': entry('disk-self') });
    const own = doc({ '/': entry('root'), '/.metadata.json': entry('own-self') });
    const merged = mergeSidecarEntries(onDisk, own, dirty(['/.metadata.json']));
    expect(merged.entries).not.toHaveProperty('/.metadata.json');
  });

  it('an empty dirty set leaves the on-disk entries untouched (root aside)', () => {
    const onDisk = doc({ '/': entry('root-disk'), '/a.txt': entry('disk') });
    const own = doc({ '/': entry('root-own'), '/a.txt': entry('stale'), '/b.txt': entry('stale') });
    const merged = mergeSidecarEntries(onDisk, own, dirty());
    expect(merged.entries).toEqual({ '/': entry('root-own'), '/a.txt': entry('disk') });
  });

  it('a dirty path missing from the own index is deleted from the sidecar', () => {
    const onDisk = doc({ '/gone.txt': entry('disk') });
    const own = doc({});
    const merged = mergeSidecarEntries(onDisk, own, dirty(['/gone.txt']));
    expect(merged.entries).not.toHaveProperty('/gone.txt');
  });

  it('a dirty prefix drops every on-disk child and copies every own child', () => {
    const onDisk = doc({
      '/dir': entry('disk-dir'),
      '/dir/old-child.txt': entry('disk-child'),
      '/dir/sub/deep.txt': entry('disk-deep'),
      '/other.txt': entry('disk-other'),
    });
    const own = doc({
      '/dir': entry('own-dir'),
      '/dir/new-child.txt': entry('own-child'),
    });
    const merged = mergeSidecarEntries(onDisk, own, dirty([], ['/dir']));
    expect(merged.entries).toEqual({
      '/dir': entry('own-dir'),
      '/dir/new-child.txt': entry('own-child'),
      '/other.txt': entry('disk-other'),
    });
  });

  it('a prefix does not swallow a sibling that merely shares the name prefix', () => {
    const onDisk = doc({ '/ab': entry('disk-ab'), '/a': entry('disk-a') });
    const own = doc({});
    const merged = mergeSidecarEntries(onDisk, own, dirty([], ['/a']));
    // '/a' removed (own has nothing under it); '/ab' is NOT under '/a'.
    expect(merged.entries).toEqual({ '/ab': entry('disk-ab') });
  });

  it('rename shape: old prefix disappears, new prefix comes wholly from own', () => {
    const onDisk = doc({
      '/old': entry('disk'),
      '/old/f.txt': entry('disk'),
    });
    const own = doc({
      '/new': entry('own'),
      '/new/f.txt': entry('own'),
    });
    const merged = mergeSidecarEntries(onDisk, own, dirty([], ['/old', '/new']));
    expect(merged.entries).toEqual({ '/new': entry('own'), '/new/f.txt': entry('own') });
  });

  it('takes root entry and top-level fields from the own index', () => {
    const onDisk = doc({ '/': entry('root-disk') }, { version: 0, maxSize: 5 });
    const own = doc({ '/': entry('root-own') }, { version: 2, maxSize: 200 });
    const merged = mergeSidecarEntries(onDisk, own, dirty());
    expect(merged.version).toBe(2);
    expect(merged.maxSize).toBe(200);
    expect(merged.entries?.['/']).toEqual(entry('root-own'));
  });

  it('tolerates documents with absent entries maps', () => {
    const merged = mergeSidecarEntries({ version: 1 }, { version: 1 }, dirty(['/x']));
    expect(merged.entries).toEqual({});
  });
});

describe('stripSidecarSelfEntry', () => {
  // The writer applies this to its full-snapshot recovery path, which skips
  // mergeSidecarEntries — the raw ZenFS index there still carries the self-entry.
  it('drops the self-referential entry, leaving real entries intact', () => {
    const d = doc({ '/': entry('root'), '/.metadata.json': entry('self'), '/a.txt': entry('a') });
    const out = stripSidecarSelfEntry(d);
    expect(out.entries).not.toHaveProperty('/.metadata.json');
    expect(out.entries?.['/a.txt']).toEqual(entry('a'));
    expect(out).toBe(d); // mutates in place and returns the same doc
  });

  it('is a no-op when the self-entry is absent', () => {
    const d = doc({ '/a.txt': entry('a') });
    expect(stripSidecarSelfEntry(d).entries).toEqual({ '/a.txt': entry('a') });
  });

  it('tolerates a document with no entries map', () => {
    expect(() => stripSidecarSelfEntry({ version: 1 })).not.toThrow();
  });
});
