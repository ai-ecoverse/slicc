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
  it('maps the workspace and shared roots into expanded dir items', async () => {
    const fs = await seededFs();
    const items = await buildVfsTreeItems(fs);

    // Roots are now dir items (open by default), not group headers.
    const roots = items.filter((i) => i.kind === 'dir').map((i) => i.id);
    expect(roots).toEqual(['/workspace', '/shared']);
    const wsRoot = items.find((i) => i.kind === 'dir' && i.id === '/workspace');
    expect(wsRoot?.kind === 'dir' && wsRoot.open).toBe(true);
    expect(wsRoot?.kind === 'dir' && wsRoot.label).toBe('workspace');

    // Children are nested inside the root dir.
    const wsChildren = wsRoot?.kind === 'dir' ? wsRoot.children : [];
    const skillsDir = wsChildren.find((c) => c.kind === 'dir' && c.id === '/workspace/skills');
    expect(skillsDir).toBeTruthy();
    expect(skillsDir?.kind === 'dir' && skillsDir.label).toBe('skills');
    expect(
      skillsDir?.kind === 'dir' &&
        skillsDir.children.some((c) => c.kind === 'file' && c.id === '/workspace/skills/SKILL.md')
    ).toBe(true);

    expect(wsChildren.some((i) => i.kind === 'file' && i.id === '/workspace/CLAUDE.md')).toBe(true);
    const sharedRoot = items.find((i) => i.kind === 'dir' && i.id === '/shared');
    const sharedChildren = sharedRoot?.kind === 'dir' ? sharedRoot.children : [];
    expect(sharedChildren.some((i) => i.kind === 'file' && i.id === '/shared/notes.txt')).toBe(
      true
    );
  });

  it('lists directories before files, alphabetically', async () => {
    const fs = await seededFs();
    await fs.writeFile('/workspace/aaa.txt', 'x');
    const items = await buildVfsTreeItems(fs);
    const wsRoot = items.find((i) => i.kind === 'dir' && i.id === '/workspace');
    const children = wsRoot?.kind === 'dir' ? wsRoot.children : [];
    const childIds = children.filter((c) => 'id' in c).map((c) => ('id' in c ? c.id : ''));
    expect(childIds.indexOf('/workspace/skills')).toBeLessThan(
      childIds.indexOf('/workspace/aaa.txt')
    );
  });

  it('survives missing roots', async () => {
    const fs = await VirtualFS.create({ dbName: `wc-empty-${Math.random()}`, wipe: true });
    const items = await buildVfsTreeItems(fs);
    // Still emits both root dir items, each with empty children.
    expect(items.filter((i) => i.kind === 'dir')).toHaveLength(2);
  });

  it('includes a size field on file items', async () => {
    const fs = await seededFs();
    const items = await buildVfsTreeItems(fs);
    const wsRoot = items.find((i) => i.kind === 'dir' && i.id === '/workspace');
    const wsChildren = wsRoot?.kind === 'dir' ? wsRoot.children : [];
    const claudeMd = wsChildren.find((i) => i.kind === 'file' && i.id === '/workspace/CLAUDE.md');
    expect(claudeMd?.kind).toBe('file');
    // size comes from stat(); the content is '# memory' (9 bytes).
    expect(claudeMd?.kind === 'file' && typeof claudeMd.size).toBe('number');
    expect(claudeMd?.kind === 'file' && (claudeMd.size ?? 0) > 0).toBe(true);
  });
});

describe('createWorkbenchActivator', () => {
  function makeDeps() {
    const fileTree = document.createElement('slicc-file-tree') as SliccFileTree;
    return {
      fileTree,
      termSurface: document.createElement('div'),
      memoryHost: document.createElement('div'),
      openFs: vi.fn(async () => await seededFs()),
      openWriter: vi.fn(async () => await seededFs()),
      mountTerminal: vi.fn(async () => undefined),
      // In tests the "kernel" is always ready — fire the callback immediately.
      onKernelReady: vi.fn((fn: () => void) => fn()),
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

  it('polls the file tree every 3 s while files surface is active', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const activate = createWorkbenchActivator(deps);
    activate('files');
    // Advance past the first tick and let promises settle
    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.openFs.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it('stops polling when another surface is activated', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const activate = createWorkbenchActivator(deps);
    activate('files');
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = deps.openFs.mock.calls.length;
    activate('term');
    await vi.advanceTimersByTimeAsync(6000);
    // No additional openFs calls after switching away from files
    expect(deps.openFs.mock.calls.length).toBe(callsAfterFirst);
    vi.useRealTimers();
  });
});
