/**
 * The exporter page's protocol (slicc#4051): it runs only in a same-origin
 * frame, posts only to its own origin, reports stopping → reading → writing
 * → done (or an error), and what it writes is a valid version 2 directory.
 */
import { validateSliccProfileManifest } from '@slicc/shared-ts';
import { describe, expect, it } from 'vitest';
import { openOpfsProfileDirectory } from '../../src/transcript/profile-directory-opfs.js';
import { planProfileDirectory } from '../../src/transcript/profile-export.js';
import {
  isFramedBySameOrigin,
  postToSameOriginParent,
  runSixUpgradeExport,
  SIX_NO_LOCKS_ERROR,
  type SixUpgradeMessage,
} from '../../src/ui/upgrade-to-seven/exporter.js';
import { seedProfile } from '../transcript/profile-export-seed.js';
import { FakeWebLocks } from './fake-web-locks.js';

const ORIGIN = 'https://www.sliccy.ai';

function frame(opts: { parentOrigin?: string; ancestors?: string[]; top?: boolean } = {}) {
  const posted: { message: unknown; targetOrigin: string }[] = [];
  const parent = {
    get location() {
      if (opts.parentOrigin === undefined) throw new DOMException('cross-origin', 'SecurityError');
      return { origin: opts.parentOrigin };
    },
    postMessage: (message: unknown, targetOrigin: string) => posted.push({ message, targetOrigin }),
  };
  const ancestors = opts.ancestors;
  const win = {
    location: {
      origin: ORIGIN,
      ...(ancestors
        ? { ancestorOrigins: Object.assign([...ancestors], { length: ancestors.length }) }
        : {}),
    },
    parent: parent as typeof parent | null,
  };
  if (opts.top) win.parent = win as never;
  return { win, posted };
}

describe('isFramedBySameOrigin', () => {
  it('accepts a frame whose ancestors are all on its origin', () => {
    expect(isFramedBySameOrigin(frame({ ancestors: [ORIGIN] }).win)).toBe(true);
    expect(isFramedBySameOrigin(frame({ parentOrigin: ORIGIN }).win)).toBe(true);
  });

  it('refuses a top-level page', () => {
    expect(isFramedBySameOrigin(frame({ top: true }).win)).toBe(false);
  });

  it('refuses a cross-origin parent or any cross-origin ancestor', () => {
    expect(isFramedBySameOrigin(frame({ ancestors: ['https://evil.example'] }).win)).toBe(false);
    expect(isFramedBySameOrigin(frame({ ancestors: [ORIGIN, 'https://evil.example'] }).win)).toBe(
      false
    );
    expect(isFramedBySameOrigin(frame({ parentOrigin: 'https://seven.sliccy.ai' }).win)).toBe(
      false
    );
    // No ancestorOrigins and a parent it can't read: cross-origin.
    expect(isFramedBySameOrigin(frame({}).win)).toBe(false);
  });
});

describe('postToSameOriginParent', () => {
  it("targets the page's own origin, never '*'", () => {
    const { win, posted } = frame({ ancestors: [ORIGIN] });
    postToSameOriginParent(win as never)({ type: 'slicc-six-upgrade', error: 'x' });
    expect(posted).toEqual([
      { message: { type: 'slicc-six-upgrade', error: 'x' }, targetOrigin: ORIGIN },
    ]);
  });
});

describe('runSixUpgradeExport', () => {
  it('stops six, reads, writes, and reports done with exportId and dir', async () => {
    const { deps } = await seedProfile();
    const posts: SixUpgradeMessage[] = [];
    const files = new Map<string, Uint8Array>();
    let opened: string | null = null;
    await runSixUpgradeExport({
      post: (m) => posts.push(m),
      channel: null,
      locks: new FakeWebLocks(),
      plan: (onProgress) => planProfileDirectory(deps, { onProgress }),
      openWriter: async (exportId) => {
        opened = exportId;
        return { writeFile: async (path, bytes) => void files.set(path, bytes) };
      },
    });
    const exportId = '0b9d6c1e-3f4a-4b5c-8d6e-7f8091a2b3c4';
    expect(opened).toBe(exportId);
    expect(posts[0]).toEqual({ type: 'slicc-six-upgrade', phase: 'stopping', done: 0, total: 1 });
    expect(posts[1]).toEqual({ type: 'slicc-six-upgrade', phase: 'stopping', done: 1, total: 1 });
    const phases = posts.flatMap((m) => ('phase' in m ? [m.phase] : []));
    expect(phases.indexOf('reading')).toBeGreaterThan(phases.lastIndexOf('stopping'));
    expect(phases.indexOf('writing')).toBeGreaterThan(phases.lastIndexOf('reading'));
    for (const m of posts) {
      if ('phase' in m) expect(m.done).toBeLessThanOrEqual(m.total);
    }
    expect(posts.at(-1)).toEqual({
      type: 'slicc-six-upgrade',
      done: true,
      exportId,
      dir: `/slicc-v6-upgrade/${exportId}/`,
    });
    const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')!));
    expect(validateSliccProfileManifest(manifest)).toEqual({ ok: true });
    expect(manifest.version).toBe(2);
  });

  it('reports a failure as { error } and nothing after it', async () => {
    const posts: SixUpgradeMessage[] = [];
    await runSixUpgradeExport({
      post: (m) => posts.push(m),
      channel: null,
      locks: new FakeWebLocks(),
      plan: async () => {
        throw new Error('redaction unavailable');
      },
      openWriter: async () => {
        throw new Error('unused');
      },
    });
    expect(posts.at(-1)).toEqual({ type: 'slicc-six-upgrade', error: 'redaction unavailable' });
  });

  it('refuses to read without Web Locks, since it could not stop six', async () => {
    const posts: SixUpgradeMessage[] = [];
    let planned = false;
    await runSixUpgradeExport({
      post: (m) => posts.push(m),
      channel: null,
      locks: null,
      plan: async () => {
        planned = true;
        throw new Error('unused');
      },
      openWriter: async () => {
        throw new Error('unused');
      },
    });
    expect(planned).toBe(false);
    expect(posts.at(-1)).toEqual({ type: 'slicc-six-upgrade', error: SIX_NO_LOCKS_ERROR });
  });
});

// ---------------------------------------------------------------------------
// The OPFS writer, over an in-memory directory handle
// ---------------------------------------------------------------------------

class MemDir {
  readonly dirs = new Map<string, MemDir>();
  readonly files = new Map<string, Uint8Array>();
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<MemDir> {
    let dir = this.dirs.get(name);
    if (!dir) {
      if (!opts?.create) throw new DOMException('missing', 'NotFoundError');
      dir = new MemDir();
      this.dirs.set(name, dir);
    }
    return dir;
  }
  async getFileHandle(name: string, _opts?: { create?: boolean }) {
    return {
      createWritable: async () => {
        const parts: Uint8Array[] = [];
        return {
          write: async (bytes: Uint8Array) => void parts.push(bytes),
          abort: async () => {},
          close: async () => void this.files.set(name, parts[0] ?? new Uint8Array()),
        };
      },
    };
  }
}

describe('openOpfsProfileDirectory', () => {
  it('writes entries under slicc-v6-upgrade/<exportId>/, outside slicc-fs', async () => {
    const root = new MemDir();
    const writer = await openOpfsProfileDirectory(root as never, 'id-1');
    await writer.writeFile('manifest.json', new Uint8Array([1]));
    await writer.writeFile('files/cones/cone/notes.md', new Uint8Array([2]));
    await writer.writeFile('files/cones/cone/more.md', new Uint8Array([3]));
    expect([...root.dirs.keys()]).toEqual(['slicc-v6-upgrade']);
    const base = root.dirs.get('slicc-v6-upgrade')!.dirs.get('id-1')!;
    expect(base.files.get('manifest.json')).toEqual(new Uint8Array([1]));
    const cone = base.dirs.get('files')!.dirs.get('cones')!.dirs.get('cone')!;
    expect([...cone.files.keys()].sort()).toEqual(['more.md', 'notes.md']);
  });
});
