// @vitest-environment jsdom

import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type { SliccFileTree } from '@slicc/webcomponents';
import { FsWatcher } from '../../../src/fs/fs-watcher.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import type { LocalVfsClient } from '../../../src/kernel/local-vfs-client.js';
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

    const roots = items.filter((i) => i.kind === 'dir').map((i) => i.id);
    expect(roots).toEqual(['/workspace', '/shared']);
    const wsRoot = items.find((i) => i.kind === 'dir' && i.id === '/workspace');
    expect(wsRoot?.kind === 'dir' && wsRoot.open).toBe(true);
    expect(wsRoot?.kind === 'dir' && wsRoot.label).toBe('workspace');

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

    expect(items.filter((i) => i.kind === 'dir')).toHaveLength(2);
  });

  it('includes a size field on file items', async () => {
    const fs = await seededFs();
    const items = await buildVfsTreeItems(fs);
    const wsRoot = items.find((i) => i.kind === 'dir' && i.id === '/workspace');
    const wsChildren = wsRoot?.kind === 'dir' ? wsRoot.children : [];
    const claudeMd = wsChildren.find((i) => i.kind === 'file' && i.id === '/workspace/CLAUDE.md');
    expect(claudeMd?.kind).toBe('file');

    expect(claudeMd?.kind === 'file' && typeof claudeMd.size).toBe('number');
    expect(claudeMd?.kind === 'file' && (claudeMd.size ?? 0) > 0).toBe(true);
  });

  it('takes sizes from the listing instead of stat’ing every file', async () => {
    const base = await seededFs();
    let stats = 0;
    const counting: LocalVfsClient = {
      readDir: (path) => base.readDir(path),
      readFile: (path, options) => base.readFile(path, options),
      stat: (path) => {
        stats++;
        return base.stat(path);
      },
    };

    const items = await buildVfsTreeItems(counting);

    const wsRoot = items.find((i) => i.kind === 'dir' && i.id === '/workspace');
    const wsChildren = wsRoot?.kind === 'dir' ? wsRoot.children : [];
    const claudeMd = wsChildren.find((i) => i.kind === 'file' && i.id === '/workspace/CLAUDE.md');
    expect(claudeMd?.kind === 'file' && claudeMd.size).toBe(8);
    expect(stats).toBe(0);
  });

  it('still stats a file whose listing carried no size', async () => {
    const base = await seededFs();
    let stats = 0;
    const stripped: LocalVfsClient = {
      readDir: async (path) =>
        (await base.readDir(path)).map((e) => ({ name: e.name, type: e.type })),
      readFile: (path, options) => base.readFile(path, options),
      stat: (path) => {
        stats++;
        return base.stat(path);
      },
    };

    const items = await buildVfsTreeItems(stripped);

    const wsRoot = items.find((i) => i.kind === 'dir' && i.id === '/workspace');
    const wsChildren = wsRoot?.kind === 'dir' ? wsRoot.children : [];
    const claudeMd = wsChildren.find((i) => i.kind === 'file' && i.id === '/workspace/CLAUDE.md');
    expect(claudeMd?.kind === 'file' && claudeMd.size).toBe(8);
    expect(stats).toBeGreaterThan(0);
  });
});

async function watchableFs(): Promise<{
  fs: LocalVfsClient;
  watcher: FsWatcher;
  base: VirtualFS;
}> {
  const base = await seededFs();
  const watcher = new FsWatcher();
  base.setWatcher(watcher);
  const fs = Object.create(base) as VirtualFS & LocalVfsClient;
  return { fs, watcher, base };
}

describe('createWorkbenchActivator', () => {
  function makeDeps() {
    const fileTree = document.createElement('slicc-file-tree') as SliccFileTree;
    const memoryHost = Object.assign(document.createElement('div'), { setRows: vi.fn() });
    const deps = {
      fileTree,
      termSurface: document.createElement('div'),
      memoryHost,

      monitor: document.createElement('slicc-monitor'),
      openFs: vi.fn(async () => await seededFs()),
      openWriter: vi.fn(async () => await seededFs()),
      mountTerminal: vi.fn(async () => undefined),

      onKernelReady: vi.fn((fn: () => void) => fn()),
      insertReference: vi.fn(),
      getWorkspace: vi.fn(() => PRIMARY_WORKSPACE),
      log: { error: vi.fn() },
    };

    return deps as unknown as WcWorkbenchDeps & typeof deps;
  }

  it('populates the file tree on files activation and refreshes on re-activation', async () => {
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.waitFor(() => {
      expect(deps.fileTree.items?.length).toBeGreaterThan(0);
    });

    const beforeReactivate = deps.openFs.mock.calls.length;
    activator.activate('files');
    expect(deps.openFs.mock.calls.length).toBeGreaterThan(beforeReactivate);
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

  it('reads the selected cone workspace and memory file', async () => {
    const deps = makeDeps();
    const beta = workspaceFor({ parentJid: null, folder: 'cone-beta' });
    deps.getWorkspace.mockReturnValue(beta);
    const activator = createWorkbenchActivator(deps);

    activator.activate('files');
    await vi.waitFor(() => {
      expect(deps.fileTree.items?.length).toBeGreaterThan(0);
    });

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

    deps.getWorkspace.mockReturnValue(workspaceFor({ parentJid: null, folder: 'cone-beta' }));
    activator.refreshMemory();
    await vi.waitFor(() => expect(deps.memoryHost.setRows).toHaveBeenCalledTimes(2));
    expect(deps.getWorkspace).toHaveBeenCalled();
  });

  it('never lets a slower earlier memory read overwrite a newer one (#2271)', async () => {
    const deps = makeDeps();
    const fs = await seededFs();

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

    activator.activate('memory');
    await vi.waitFor(() => expect(releaseFirstRead).toBeDefined());

    deps.getWorkspace.mockReturnValue(workspaceFor({ parentJid: null, folder: 'cone-beta' }));
    activator.refreshMemory();
    await vi.waitFor(() => expect(deps.memoryHost.setRows).toHaveBeenCalledTimes(1));

    releaseFirstRead?.();

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

  it('re-arms the terminal mount latch when the mount stalls instead of rejecting', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.mountTerminal.mockReturnValueOnce(new Promise<undefined>(() => {}));
      const activator = createWorkbenchActivator(deps);

      activator.activate('term');
      expect(deps.mountTerminal).toHaveBeenCalledTimes(1);

      activator.activate('term');
      expect(deps.mountTerminal).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(45_000);
      expect(deps.log.error).toHaveBeenCalled();

      activator.activate('term');
      expect(deps.mountTerminal).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms after a stall at most once', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      deps.mountTerminal.mockReturnValue(new Promise<undefined>(() => {}));
      const activator = createWorkbenchActivator(deps);

      activator.activate('term');
      await vi.advanceTimersByTimeAsync(45_000);
      activator.activate('term');
      expect(deps.mountTerminal).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(45_000);
      activator.activate('term');
      expect(deps.mountTerminal).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-arm after the mount resolves', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const activator = createWorkbenchActivator(deps);
      activator.activate('term');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(45_000);

      expect(deps.log.error).not.toHaveBeenCalled();
      activator.activate('term');
      expect(deps.mountTerminal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs file-tree refresh failures', async () => {
    const deps = makeDeps();
    deps.openFs.mockRejectedValueOnce(new Error('idb gone'));
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.waitFor(() => expect(deps.log.error).toHaveBeenCalled());
  });

  it('falls back to polling every 3 s when the reader cannot watch', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');

    await vi.advanceTimersByTimeAsync(3000);
    expect(deps.openFs.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });

  it('activating a second independent panel does not stop the first panel refresh (both are permanent leaves now)', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.advanceTimersByTimeAsync(0);
    const callsAfterFirst = deps.openFs.mock.calls.length;
    activator.activate('term');
    await vi.advanceTimersByTimeAsync(6000);

    expect(deps.openFs.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    vi.useRealTimers();
  });

  it('deactivate stops the files fallback poller (leaf closed)', async () => {
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

describe('createWorkbenchActivator — event-driven file tree (#2409)', () => {
  function makeWatchDeps(fs: LocalVfsClient) {
    const fileTree = document.createElement('slicc-file-tree') as SliccFileTree;
    const deps = {
      fileTree,
      termSurface: document.createElement('div'),
      memoryHost: Object.assign(document.createElement('div'), { setRows: vi.fn() }),
      monitor: document.createElement('slicc-monitor'),
      openFs: vi.fn(async () => fs),
      openWriter: vi.fn(async () => fs),
      mountTerminal: vi.fn(async () => undefined),
      onKernelReady: vi.fn((fn: () => void) => fn()),
      insertReference: vi.fn(),
      getWorkspace: vi.fn(() => PRIMARY_WORKSPACE),
      log: { error: vi.fn() },
    };
    return deps as unknown as WcWorkbenchDeps & typeof deps;
  }

  it('rebuilds on a change event and issues no timer traffic while idle', async () => {
    const { fs, watcher, base } = await watchableFs();
    const deps = makeWatchDeps(fs);
    const activator = createWorkbenchActivator(deps);

    activator.activate('files');
    await vi.waitFor(() => expect(deps.fileTree.items?.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(watcher.size).toBe(2));
    const afterFirstBuild = deps.openFs.mock.calls.length;

    await new Promise((r) => setTimeout(r, 400));
    expect(deps.openFs.mock.calls.length).toBe(afterFirstBuild);

    await base.writeFile('/workspace/appeared.txt', 'x');
    await vi.waitFor(() => {
      const root = deps.fileTree.items?.find((i) => 'id' in i && i.id === '/workspace');
      expect(
        root?.kind === 'dir' &&
          root.children.some((c) => 'id' in c && c.id === '/workspace/appeared.txt')
      ).toBe(true);
    });
  });

  it('coalesces a burst of writes into a small number of rebuilds', async () => {
    const { fs, watcher } = await watchableFs();
    const deps = makeWatchDeps(fs);
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.waitFor(() => expect(watcher.size).toBe(2));
    const afterFirstBuild = deps.openFs.mock.calls.length;

    for (let i = 0; i < 500; i++) {
      watcher.notify([{ type: 'create', path: `/workspace/f${i}.txt`, entryType: 'file' }]);
    }
    await vi.waitFor(() => expect(deps.openFs.mock.calls.length).toBeGreaterThan(afterFirstBuild));
    await new Promise((r) => setTimeout(r, 300));

    expect(deps.openFs.mock.calls.length - afterFirstBuild).toBeLessThan(5);
  });

  it('never lets the debounce defer a rebuild indefinitely under a write loop', async () => {
    const { fs, watcher } = await watchableFs();
    const deps = makeWatchDeps(fs);
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.waitFor(() => expect(watcher.size).toBe(2));
    const afterFirstBuild = deps.openFs.mock.calls.length;

    const stopAt = Date.now() + 1400;
    while (Date.now() < stopAt) {
      watcher.notify([{ type: 'modify', path: '/workspace/busy.txt', entryType: 'file' }]);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(deps.openFs.mock.calls.length).toBeGreaterThan(afterFirstBuild);
  });

  it('unsubscribes on deactivate and leaks nothing across 10 open/close cycles', async () => {
    const { fs, watcher } = await watchableFs();
    const deps = makeWatchDeps(fs);
    const activator = createWorkbenchActivator(deps);

    for (let i = 0; i < 10; i++) {
      activator.activate('files');
      await vi.waitFor(() => expect(watcher.size).toBe(2));
      activator.deactivate('files');
      expect(watcher.size).toBe(0);
    }

    const calls = deps.openFs.mock.calls.length;
    watcher.notify([{ type: 'create', path: '/workspace/late.txt', entryType: 'file' }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(deps.openFs.mock.calls.length).toBe(calls);
  });

  it('re-points the tree and the subscription when the selection moves (#2271)', async () => {
    const { fs, watcher } = await watchableFs();
    const deps = makeWatchDeps(fs);
    const activator = createWorkbenchActivator(deps);
    activator.activate('files');
    await vi.waitFor(() => expect(watcher.size).toBe(2));

    deps.getWorkspace.mockReturnValue(workspaceFor({ parentJid: null, folder: 'cone-beta' }));
    activator.refreshFiles();
    await vi.waitFor(() => {
      expect(deps.fileTree.items?.map((i) => ('id' in i ? i.id : ''))).toEqual([
        '/cones/cone-beta/workspace',
        '/shared',
      ]);
    });

    await vi.waitFor(() => expect(watcher.size).toBe(2));
  });

  it('ignores a selection change while the files panel is closed', async () => {
    const { fs } = await watchableFs();
    const deps = makeWatchDeps(fs);
    const activator = createWorkbenchActivator(deps);
    activator.refreshFiles();
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.openFs).not.toHaveBeenCalled();
  });
});
