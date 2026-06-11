// @vitest-environment jsdom
/**
 * Workbench wiring tests: the VFS → file-tree mapper over a real
 * (fake-indexeddb) VirtualFS, and the lazy surface activator.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { SliccFileTree } from '@slicc/webcomponents';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { buildVfsTreeItems, createWorkbenchActivator } from '../../../src/ui/wc/wc-workbench.js';

async function seededFs(): Promise<VirtualFS> {
  const fs = await VirtualFS.create({ dbName: `wc-workbench-${Math.random()}`, wipe: true });
  await fs.mkdir('/workspace');
  await fs.mkdir('/workspace/skills');
  await fs.writeFile('/workspace/CLAUDE.md', '# memory');
  await fs.writeFile('/workspace/skills/SKILL.md', '# skill');
  await fs.mkdir('/shared');
  await fs.writeFile('/shared/notes.txt', 'hi');
  return fs;
}

describe('buildVfsTreeItems', () => {
  it('maps the workspace and shared roots into groups, dirs, and files', async () => {
    const fs = await seededFs();
    const items = await buildVfsTreeItems(fs);

    const groups = items.filter((i) => i.kind === 'group').map((i) => i.label);
    expect(groups).toEqual(['workspace/', 'shared/']);

    const skillsDir = items.find((i) => i.kind === 'dir' && i.id === '/workspace/skills');
    expect(skillsDir).toBeTruthy();
    // Directory rows show the bare name — the chevron already marks them as
    // folders, so no trailing slash (only the root group headers keep it).
    expect(skillsDir?.kind === 'dir' && skillsDir.label).toBe('skills');
    expect(
      skillsDir?.kind === 'dir' &&
        skillsDir.children.some((c) => c.kind === 'file' && c.id === '/workspace/skills/SKILL.md')
    ).toBe(true);

    expect(items.some((i) => i.kind === 'file' && i.id === '/workspace/CLAUDE.md')).toBe(true);
    expect(items.some((i) => i.kind === 'file' && i.id === '/shared/notes.txt')).toBe(true);
  });

  it('lists directories before files, alphabetically', async () => {
    const fs = await seededFs();
    await fs.writeFile('/workspace/aaa.txt', 'x');
    const items = await buildVfsTreeItems(fs);
    const workspaceIds = items
      .filter((i) => i.kind !== 'group' && 'id' in i && i.id.startsWith('/workspace'))
      .map((i) => ('id' in i ? i.id : ''));
    expect(workspaceIds.indexOf('/workspace/skills')).toBeLessThan(
      workspaceIds.indexOf('/workspace/aaa.txt')
    );
  });

  it('survives missing roots', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-empty-${Math.random()}`, wipe: true });
    const items = await buildVfsTreeItems(fs);
    expect(items.filter((i) => i.kind === 'group')).toHaveLength(2);
  });
});

describe('createWorkbenchActivator', () => {
  function makeDeps() {
    const fileTree = document.createElement('slicc-file-tree') as SliccFileTree;
    return {
      fileTree,
      termSurface: document.createElement('div'),
      openFs: vi.fn(async () => await seededFs()),
      mountTerminal: vi.fn(async () => undefined),
      log: { error: vi.fn() },
    };
  }

  it('populates the file tree on files activation and refreshes on re-activation', async () => {
    const deps = makeDeps();
    const activate = createWorkbenchActivator(deps);
    activate('files');
    await vi.waitFor(() => {
      expect(deps.fileTree.items?.length).toBeGreaterThan(0);
    });
    activate('files');
    expect(deps.openFs).toHaveBeenCalledTimes(2);
    expect(deps.mountTerminal).not.toHaveBeenCalled();
  });

  it('mounts the terminal once on first term activation', async () => {
    const deps = makeDeps();
    const activate = createWorkbenchActivator(deps);
    activate('term');
    activate('term');
    await vi.waitFor(() => expect(deps.mountTerminal).toHaveBeenCalledTimes(1));
    expect(deps.mountTerminal).toHaveBeenCalledWith(deps.termSurface);
  });

  it('allows a terminal mount retry after failure', async () => {
    const deps = makeDeps();
    deps.mountTerminal.mockRejectedValueOnce(new Error('no worker'));
    const activate = createWorkbenchActivator(deps);
    activate('term');
    await vi.waitFor(() => expect(deps.log.error).toHaveBeenCalled());
    activate('term');
    await vi.waitFor(() => expect(deps.mountTerminal).toHaveBeenCalledTimes(2));
  });

  it('logs file-tree refresh failures', async () => {
    const deps = makeDeps();
    deps.openFs.mockRejectedValueOnce(new Error('idb gone'));
    const activate = createWorkbenchActivator(deps);
    activate('files');
    await vi.waitFor(() => expect(deps.log.error).toHaveBeenCalled());
  });
});
