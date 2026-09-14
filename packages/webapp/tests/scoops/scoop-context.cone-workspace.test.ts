import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { ensureDirectoryStructure } from '../../src/scoops/scoop-context/directory-structure.js';
import { ScoopContext, type ScoopContextCallbacks } from '../../src/scoops/scoop-context.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import { tmpDirFor } from '../../src/work-unit/descriptor.js';

let dbCounter = 0;
const open: VirtualFS[] = [];

async function makeFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `cone-workspace-${dbCounter++}`, wipe: true });
  open.push(fs);
  return fs;
}

afterEach(async () => {
  for (const fs of open.splice(0)) await fs.dispose?.();
});

function coneRecord(overrides: Partial<RegisteredScoop> = {}): RegisteredScoop {
  return {
    jid: 'cone_1',
    name: 'Cone',
    folder: 'cone',
    parentJid: null,
    requiresTrigger: false,
    assistantLabel: 'sliccy',
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

function callbacks(): ScoopContextCallbacks {
  return {
    onResponse: vi.fn(),
    onResponseDone: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    onSendMessage: vi.fn(),
    getScoops: vi.fn(() => []),
    getGlobalMemory: vi.fn(async () => ''),
    getBrowserAPI: vi.fn(() => ({}) as never),
  };
}

function seedDirs(ctx: ScoopContext): Promise<void> {
  const inner = ctx as unknown as { fs: VirtualFS; scoop: RegisteredScoop; unit: never };
  return ensureDirectoryStructure(
    inner.fs,
    inner.scoop,
    inner.unit,
    tmpDirFor([inner.scoop], inner.scoop)
  );
}

async function exists(fs: VirtualFS, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function read(fs: VirtualFS, path: string): Promise<string> {
  const raw = await fs.readFile(path, { encoding: 'utf-8' });
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
}

describe('cone workspace seeding', () => {
  it('boots an extra cone into its own root and leaves /workspace alone', async () => {
    const fs = await makeFs();
    const extra = coneRecord({
      jid: 'cone_2',
      name: 'Beta',
      folder: 'cone-beta',
      assistantLabel: 'Beta',
    });

    await seedDirs(new ScoopContext(extra, callbacks(), fs));

    expect(await exists(fs, '/cones/cone-beta/workspace')).toBe(true);
    expect(await read(fs, '/cones/cone-beta/CLAUDE.md')).toContain('Folder: cone-beta');

    expect(await exists(fs, '/workspace')).toBe(false);

    for (const dir of ['/shared', '/scoops', '/home', '/tmp', '/mnt']) {
      expect(await exists(fs, dir)).toBe(true);
    }
  });

  it('keeps the primary cone on /workspace', async () => {
    const fs = await makeFs();
    await seedDirs(new ScoopContext(coneRecord(), callbacks(), fs));

    expect(await exists(fs, '/workspace')).toBe(true);
    expect(await read(fs, '/workspace/CLAUDE.md')).toContain('Folder: cone');
    expect(await exists(fs, '/cones')).toBe(false);
  });

  it('gives two cones independent memory files', async () => {
    const fs = await makeFs();
    await seedDirs(new ScoopContext(coneRecord(), callbacks(), fs));
    await seedDirs(
      new ScoopContext(
        coneRecord({ jid: 'cone_2', name: 'Beta', folder: 'cone-beta', assistantLabel: 'Beta' }),
        callbacks(),
        fs
      )
    );

    await fs.writeFile('/workspace/CLAUDE.md', '# primary only\n');
    expect(await read(fs, '/cones/cone-beta/CLAUDE.md')).not.toContain('primary only');
  });
});
