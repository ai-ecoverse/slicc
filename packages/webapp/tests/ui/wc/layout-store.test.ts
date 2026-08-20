/**
 * Layout document store — the two VFS roots and their different protection.
 *
 * The sudo enforcement itself lives in `base/sudoers.ts` (and is tested
 * there); these tests cover the store's own contract: where files land, the
 * user-shadows-protected lookup rule, and that one corrupt document never hides
 * the good ones.
 */

// Straight from the schema module, NOT the package barrel: the barrel
// side-effect-registers every component, which needs `CSSStyleSheet` and blows up
// in this node-environment suite. `layout-schema.ts` is DOM-free by design.
import {
  LAYOUT_SCHEMA_VERSION,
  type LayoutDocument,
} from '@slicc/webcomponents/panel/layout-schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { PROTECTED_LAYOUTS_DIR } from '../../../src/base/sudoers.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  deleteLayout,
  layoutPath,
  listLayouts,
  loadLayoutByName,
  readLayout,
  USER_LAYOUTS_DIR,
  writeLayout,
} from '../../../src/ui/wc/layout-store.js';

let dbCounter = 0;
let fs: VirtualFS;

function doc(id: string): LayoutDocument {
  return {
    version: LAYOUT_SCHEMA_VERSION,
    id,
    base: { center: { panel: 'chat' } },
  };
}

beforeEach(async () => {
  // Unique db per test — a shared VirtualFS leaks state across cases.
  fs = await VirtualFS.create({ dbName: `layout-store-${++dbCounter}`, wipe: true });
});

describe('layoutPath', () => {
  it('defaults to the freely-writable user root', () => {
    expect(layoutPath('mine')).toBe(`${USER_LAYOUTS_DIR}/mine.json`);
  });

  it('targets the sudo-protected root on request', () => {
    expect(layoutPath('pinned', { protected: true })).toBe(`${PROTECTED_LAYOUTS_DIR}/pinned.json`);
  });
});

describe('writeLayout / readLayout', () => {
  it('round-trips a document through the user root, creating the directory', async () => {
    const path = await writeLayout(fs, doc('mine'));
    expect(path).toBe(`${USER_LAYOUTS_DIR}/mine.json`);
    expect(await readLayout(fs, path)).toEqual(doc('mine'));
  });

  it('writes to the protected root when asked', async () => {
    const path = await writeLayout(fs, doc('pinned'), { protected: true });
    expect(path).toBe(`${PROTECTED_LAYOUTS_DIR}/pinned.json`);
    expect(await readLayout(fs, path)).not.toBeNull();
  });

  it('uses an explicit name over the document id', async () => {
    const path = await writeLayout(fs, doc('original'), { name: 'renamed' });
    expect(path).toBe(`${USER_LAYOUTS_DIR}/renamed.json`);
  });

  it('returns null for a missing file rather than throwing', async () => {
    expect(await readLayout(fs, `${USER_LAYOUTS_DIR}/nope.json`)).toBeNull();
  });

  it('returns null for unparseable JSON — a corrupt layout must not break boot', async () => {
    await fs.mkdir(USER_LAYOUTS_DIR, { recursive: true });
    await fs.writeFile(`${USER_LAYOUTS_DIR}/bad.json`, '{ not json');
    expect(await readLayout(fs, `${USER_LAYOUTS_DIR}/bad.json`)).toBeNull();
  });

  it('returns null for JSON that fails schema validation', async () => {
    await fs.mkdir(USER_LAYOUTS_DIR, { recursive: true });
    // Valid JSON, invalid document (no id, no version).
    await fs.writeFile(`${USER_LAYOUTS_DIR}/wrong.json`, '{"hello":"world"}');
    expect(await readLayout(fs, `${USER_LAYOUTS_DIR}/wrong.json`)).toBeNull();
  });
});

describe('listLayouts', () => {
  it('is empty when neither root exists', async () => {
    expect(await listLayouts(fs)).toEqual([]);
  });

  it('lists both roots, flagging which are protected', async () => {
    await writeLayout(fs, doc('mine'));
    await writeLayout(fs, doc('pinned'), { protected: true });

    const found = await listLayouts(fs);
    expect(found.map((e) => e.name).sort()).toEqual(['mine', 'pinned']);
    expect(found.find((e) => e.name === 'mine')?.protected).toBe(false);
    expect(found.find((e) => e.name === 'pinned')?.protected).toBe(true);
  });

  it('a USER layout shadows a protected one of the same name', async () => {
    // So a user can override a shipped/pinned layout locally without needing
    // write access to the protected copy.
    await writeLayout(fs, { ...doc('shared'), title: 'protected version' }, { protected: true });
    await writeLayout(fs, { ...doc('shared'), title: 'user version' });

    const found = await listLayouts(fs);
    expect(found).toHaveLength(1);
    expect(found[0].doc.title).toBe('user version');
    expect(found[0].protected).toBe(false);
  });

  it('skips a corrupt document without hiding the valid ones', async () => {
    await writeLayout(fs, doc('good'));
    await fs.writeFile(`${USER_LAYOUTS_DIR}/broken.json`, 'nonsense');

    const found = await listLayouts(fs);
    expect(found.map((e) => e.name)).toEqual(['good']);
  });

  it('ignores non-JSON files', async () => {
    await writeLayout(fs, doc('good'));
    await fs.writeFile(`${USER_LAYOUTS_DIR}/README.md`, '# notes');
    expect((await listLayouts(fs)).map((e) => e.name)).toEqual(['good']);
  });
});

describe('loadLayoutByName', () => {
  it('finds a user layout', async () => {
    await writeLayout(fs, doc('mine'));
    const found = await loadLayoutByName(fs, 'mine');
    expect(found?.doc.id).toBe('mine');
    expect(found?.protected).toBe(false);
  });

  it('falls through to the protected root', async () => {
    await writeLayout(fs, doc('pinned'), { protected: true });
    const found = await loadLayoutByName(fs, 'pinned');
    expect(found?.protected).toBe(true);
  });

  it('prefers the user root when both exist', async () => {
    await writeLayout(fs, { ...doc('both'), title: 'protected' }, { protected: true });
    await writeLayout(fs, { ...doc('both'), title: 'user' });
    expect((await loadLayoutByName(fs, 'both'))?.doc.title).toBe('user');
  });

  it('returns null for an unknown name, so the caller can try a preset', async () => {
    expect(await loadLayoutByName(fs, 'ghost')).toBeNull();
  });
});

describe('deleteLayout', () => {
  it('removes a user layout and reports it', async () => {
    await writeLayout(fs, doc('mine'));
    expect(await deleteLayout(fs, 'mine')).toBe(true);
    expect(await loadLayoutByName(fs, 'mine')).toBeNull();
  });

  it('removes a protected layout when targeted', async () => {
    await writeLayout(fs, doc('pinned'), { protected: true });
    expect(await deleteLayout(fs, 'pinned', { protected: true })).toBe(true);
  });

  it('reports false for a name that was never saved', async () => {
    expect(await deleteLayout(fs, 'ghost')).toBe(false);
  });
});
