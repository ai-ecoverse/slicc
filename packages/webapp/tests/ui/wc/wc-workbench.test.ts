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
import {
  buildVfsTreeItems,
  createWorkbenchActivator,
  type WcWorkbenchDeps,
} from '../../../src/ui/wc/wc-workbench.js';
import { PRIMARY_WORKSPACE, workspaceFor } from '../../../src/work-unit/descriptor.js';

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

  // #2271: the tree follows the SELECTED cone, so an extra cone sees its own
  // files instead of the primary cone's.
  it('maps an extra cone workspace root beside /shared', async () => {
    const fs = await seededFs();
    await fs.mkdir('/cones/cone-beta/workspace', { recursive: true });
    await fs.writeFile('/cones/cone-beta/workspace/beta.txt', 'b');

    const beta = workspaceFor({ parentJid: null, folder: 'cone-beta' });
    const items = await buildVfsTreeItems(fs, beta.root);

    expect(items.filter((i) => i.kind === 'dir').map((i) => i.id)).toEqual([
      '/cones/cone-beta/workspace',
      '/shared',
    ]);
    const root = items.find((i) => i.kind === 'dir' && i.id === beta.root);
    expect(root?.kind === 'dir' && root.label).toBe('cone-beta/workspace');
    expect(
      root?.kind === 'dir' &&
        root.children.some(
          (c) => c.kind === 'file' && c.id === '/cones/cone-beta/workspace/beta.txt'
        )
    ).toBe(true);
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
    const memoryHost = Object.assign(document.createElement('div'), { setRows: vi.fn() });
    const deps = {
      fileTree,
      termSurface: document.createElement('div'),
      memoryHost,
      // createWorkbenchActivator wires the refresh-button listener at
      // construction time (unconditionally, regardless of whether `monitor`
      // is ever activated) — needs a real element even when unused.
      monitor: document.createElement('slicc-monitor'),
      openFs: vi.fn(async () => await seededFs()),
      openWriter: vi.fn(async () => await seededFs()),
      mountTerminal: vi.fn(async () => undefined),
      // In tests the "kernel" is always ready — fire the callback immediately.
      onKernelReady: vi.fn((fn: () => void) => fn()),
      insertReference: vi.fn(),
      getWorkspace: vi.fn(() => PRIMARY_WORKSPACE),
      log: { error: vi.fn() },
    };
    // Partial deps: the activation paths under test never touch
    // `getMonitorDeps`, and the seeded VirtualFS is structurally compatible
    // with the VFS clients for the reads these tests perform.
    return deps as unknown as WcWorkbenchDeps & typeof deps;
  }

  it('populates the file tree on files activation and refreshes on re-activation', async () => {
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.waitFor(() => {
      expect(deps.fileTree.items?.length).toBeGreaterThan(0);
    });
    activator.activate('files');
    expect(deps.openFs).toHaveBeenCalledTimes(2);
    expect(deps.mountTerminal).not.toHaveBeenCalled();
  });

  it('mounts the terminal once on first term activation', async () => {
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('term');
    activator.activate('term');
    await vi.waitFor(() => expect(deps.mountTerminal).toHaveBeenCalledTimes(1));
    expect(deps.mountTerminal).toHaveBeenCalledWith(deps.termSurface);
  });

  // #2271: both panels read the selected cone's coordinates per refresh.
  it('reads the selected cone workspace and memory file', async () => {
    const deps = makeDeps();
    const beta = workspaceFor({ parentJid: null, folder: 'cone-beta' });
    deps.getWorkspace.mockReturnValue(beta);
    const activator = createWorkbenchActivator(deps);

    activator.activate('files');
    await vi.waitFor(() => {
      expect(deps.fileTree.items?.length).toBeGreaterThan(0);
    });
    // The seeded FS has no `/cones/...` tree — the point is that the tree asked
    // for the extra cone's root, not the primary's.
    expect(deps.fileTree.items?.map((i) => ('id' in i ? i.id : ''))).toEqual([
      '/cones/cone-beta/workspace',
      '/shared',
    ]);

    activator.activate('memory');
    await vi.waitFor(() => expect(deps.memoryHost.setRows).toHaveBeenCalled());
    expect(deps.getWorkspace).toHaveBeenCalled();
  });

  it('re-reads memory when the selection moves while the panel is open (#2271)', async () => {
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);

    activator.activate('memory');
    await vi.waitFor(() => expect(deps.memoryHost.setRows).toHaveBeenCalledTimes(1));

    // Switching cones re-points the panel: memory reads once per activation
    // (no poller), so without this the open panel would keep showing the
    // previous cone's memory indefinitely.
    deps.getWorkspace.mockReturnValue(workspaceFor({ parentJid: null, folder: 'cone-beta' }));
    activator.refreshMemory();
    await vi.waitFor(() => expect(deps.memoryHost.setRows).toHaveBeenCalledTimes(2));
    expect(deps.getWorkspace).toHaveBeenCalled();
  });

  it('never lets a slower earlier memory read overwrite a newer one (#2271)', async () => {
    const deps = makeDeps();
    const fs = await seededFs();
    // The window is the memory READ, not `openFs`: the workspace path is
    // resolved when the read starts, so a read that began under cone A
    // carries A's rows however late it lands.
    let releaseFirstRead: (() => void) | undefined;
    let firstReadDone = false;
    const slowFs = Object.create(fs) as typeof fs;
    slowFs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      await new Promise<void>((resolve) => {
        releaseFirstRead = resolve;
      });
      try {
        return await fs.readFile(...args);
      } finally {
        firstReadDone = true;
      }
    }) as typeof fs.readFile;
    deps.openFs.mockImplementationOnce(async () => slowFs).mockImplementationOnce(async () => fs);
    const activator = createWorkbenchActivator(deps);

    activator.activate('memory'); // cone A — blocked mid-read
    await vi.waitFor(() => expect(releaseFirstRead).toBeDefined());

    deps.getWorkspace.mockReturnValue(workspaceFor({ parentJid: null, folder: 'cone-beta' }));
    activator.refreshMemory(); // cone B — reads and paints while A is stuck
    await vi.waitFor(() => expect(deps.memoryHost.setRows).toHaveBeenCalledTimes(1));

    releaseFirstRead?.();
    // A's rows are cone A's, and they arrive last. The sequence guard drops
    // them; without it the panel would sit on the previous cone's memory
    // indefinitely, since memory has no poller to correct it.
    // Once A's read has settled, its paint decision is a fixed, small number
    // of microtasks away (`buildMemoryRows` is one read plus synchronous row
    // building) — no wall-clock tick-counting, which would go flaky under
    // full-suite load.
    await vi.waitFor(() => expect(firstReadDone).toBe(true));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(deps.memoryHost.setRows).toHaveBeenCalledTimes(1);
  });

  it('ignores a selection change while the memory panel is closed', async () => {
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);

    activator.refreshMemory();
    activator.activate('memory');
    activator.deactivate('memory');
    activator.refreshMemory();

    await vi.waitFor(() => expect(deps.memoryHost.setRows).toHaveBeenCalledTimes(1));
  });

  it('hands parsed rows to the memory panel on memory activation', async () => {
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('memory');
    await vi.waitFor(() => expect(deps.memoryHost.setRows).toHaveBeenCalledWith([]));
  });

  it('allows a terminal mount retry after failure', async () => {
    const deps = makeDeps();
    deps.mountTerminal.mockRejectedValueOnce(new Error('no worker'));
    const activator = createWorkbenchActivator(deps);
    activator.activate('term');
    await vi.waitFor(() => expect(deps.log.error).toHaveBeenCalled());
    activator.activate('term');
    await vi.waitFor(() => expect(deps.mountTerminal).toHaveBeenCalledTimes(2));
  });

  it('logs file-tree refresh failures', async () => {
    const deps = makeDeps();
    deps.openFs.mockRejectedValueOnce(new Error('idb gone'));
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.waitFor(() => expect(deps.log.error).toHaveBeenCalled());
  });

  it('polls the file tree every 3 s while files surface is active', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    // Advance past the first tick and let promises settle
    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.openFs.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it('activating a second independent panel does not stop the first panel poller (both are permanent leaves now)', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = deps.openFs.mock.calls.length;
    activator.activate('term');
    await vi.advanceTimersByTimeAsync(6000);
    // The files poller keeps running — no more show-one exclusivity.
    expect(deps.openFs.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    vi.useRealTimers();
  });

  it('deactivate stops the files poller (leaf closed)', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = deps.openFs.mock.calls.length;
    activator.deactivate('files');
    await vi.advanceTimersByTimeAsync(6000);
    expect(deps.openFs.mock.calls.length).toBe(callsAfterFirst);
    vi.useRealTimers();
  });
});
