// @vitest-environment jsdom
/**
 * Leader-tab permissions surface wiring: cherry mode is a no-op (Spike A
 * confirmed cross-origin iframes can't hold writable FS handles); leader
 * modes mount a single `<slicc-permissions>` host, and a folder-drop
 * `slicc-permission-grant` stashes the handle in IDB + re-broadcasts as
 * a document-level `slicc-mount-pending` event.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import {
  loadAndClearPendingHandle,
  storePendingHandle,
} from '../../../src/fs/mount-picker-popup.js';
import {
  installLeaderPermissionsSurface,
  installMountPendingConsumer,
  type MountPendingDetail,
  type MountShellResult,
  parseMountPaths,
  pickFreeMountPath,
  sanitizeMountSegment,
} from '../../../src/ui/wc/wc-permissions.js';

// Minimal `<slicc-permissions>` stub: a plain HTMLElement so the wiring
// integration runs under jsdom without pulling the real custom element
// (which depends on the browser-only `iconEl` SVG factories).
class StubPermissions extends HTMLElement {
  providers: unknown = {};
}
if (!customElements.get('slicc-permissions')) {
  customElements.define('slicc-permissions', StubPermissions);
}

function fakeDir(name: string): FileSystemDirectoryHandle {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
}

describe('installLeaderPermissionsSurface', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('returns null for cherry follower mode', () => {
    const installed = installLeaderPermissionsSurface({ runtimeMode: 'cherry' });
    expect(installed).toBeNull();
    expect(document.querySelector('slicc-permissions')).toBeNull();
  });

  it('mounts the surface for standalone / electron-overlay / hosted-leader', () => {
    for (const mode of ['standalone', 'electron-overlay', 'hosted-leader'] as const) {
      document.body.replaceChildren();
      const installed = installLeaderPermissionsSurface({ runtimeMode: mode });
      expect(installed).not.toBeNull();
      expect(document.querySelector('slicc-permissions')).toBe(installed?.element);
      installed?.dispose();
      expect(document.querySelector('slicc-permissions')).toBeNull();
    }
  });

  it('stashes a dropped FS handle and emits slicc-mount-pending', async () => {
    const installed = installLeaderPermissionsSurface({ runtimeMode: 'standalone' });
    expect(installed).not.toBeNull();
    const { element } = installed!;

    const pendingEvent = new Promise<MountPendingDetail>((resolve) => {
      document.addEventListener(
        'slicc-mount-pending',
        (e) => resolve((e as CustomEvent<MountPendingDetail>).detail),
        { once: true }
      );
    });

    const handle = fakeDir('mounted-repo');
    element.dispatchEvent(
      new CustomEvent('slicc-permission-grant', {
        detail: { kind: 'filesystem', handle, source: 'drop', permission: 'granted' },
        bubbles: true,
        composed: true,
      })
    );

    const detail = await pendingEvent;
    expect(detail.source).toBe('drop');
    expect(detail.dirName).toBe('mounted-repo');
    expect(detail.idbKey).toMatch(/^pendingMount:perm-/);

    // The handle landed in the shared `slicc-pending-mount` IDB store and
    // round-trips back through `loadAndClearPendingHandle`.
    // IDB structured-clones on store/retrieve, so the round-tripped value
    // is shape-equal but not the same instance.
    const round = await loadAndClearPendingHandle(detail.idbKey);
    expect(round).toStrictEqual(handle);
    installed?.dispose();
  });

  it('ignores non-drop grants (picker grants are routed by the caller of request())', async () => {
    const installed = installLeaderPermissionsSurface({ runtimeMode: 'standalone' });
    const { element } = installed!;
    const listener = vi.fn();
    document.addEventListener('slicc-mount-pending', listener);

    element.dispatchEvent(
      new CustomEvent('slicc-permission-grant', {
        detail: {
          kind: 'filesystem',
          handle: fakeDir('picked'),
          source: 'picker',
          permission: 'granted',
        },
        bubbles: true,
        composed: true,
      })
    );
    element.dispatchEvent(
      new CustomEvent('slicc-permission-grant', {
        detail: { kind: 'usb', device: { productName: 'demo' } },
        bubbles: true,
        composed: true,
      })
    );

    // Drain one microtask cycle.
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
    document.removeEventListener('slicc-mount-pending', listener);
    installed?.dispose();
  });
});

describe('mount-path helpers', () => {
  it('parses `mount list` output into a set of target paths', () => {
    expect(parseMountPaths('No active mounts\n')).toEqual(new Set());
    expect(
      parseMountPaths('/mnt/a (indexed: 3 entries)\n/mnt/b (indexing: 1 entries...)\n')
    ).toEqual(new Set(['/mnt/a', '/mnt/b']));
  });

  it('sanitizes a directory name into a single safe segment', () => {
    expect(sanitizeMountSegment('My Project')).toBe('My-Project');
    expect(sanitizeMountSegment('a/b/c')).toBe('a-b-c');
    expect(sanitizeMountSegment('  ...  ')).toBe('folder');
  });

  it('picks the first free /mnt path with a numeric fallback', () => {
    expect(pickFreeMountPath('repo', new Set())).toBe('/mnt/repo');
    expect(pickFreeMountPath('repo', new Set(['/mnt/repo']))).toBe('/mnt/repo-2');
    expect(pickFreeMountPath('repo', new Set(['/mnt/repo', '/mnt/repo-2']))).toBe('/mnt/repo-3');
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const TERM_KEY = (p: string): string => `pendingMount:term:${p}`;

describe('installMountPendingConsumer', () => {
  it('adopts a dropped handle and mounts it under /mnt via the worker shell', async () => {
    const idbKey = 'pendingMount:perm-consumer-1';
    const handle = fakeDir('mounted-repo');
    await storePendingHandle(idbKey, handle);

    const calls: string[] = [];
    const mounted = deferred<void>();
    const runShell = async (command: string): Promise<MountShellResult> => {
      calls.push(command);
      if (command === 'mount list') {
        return { stdout: 'No active mounts\n', stderr: '', exitCode: 0 };
      }
      mounted.resolve();
      return { stdout: 'Mounted\n', stderr: '', exitCode: 0 };
    };

    const doc = document.implementation.createHTMLDocument('t');
    const dispose = installMountPendingConsumer({ runShell, doc, mountKeyFor: TERM_KEY });
    doc.dispatchEvent(
      new CustomEvent<MountPendingDetail>('slicc-mount-pending', {
        detail: { idbKey, dirName: 'mounted-repo', source: 'drop' },
      })
    );
    await mounted.promise;

    expect(calls).toEqual(['mount list', 'mount /mnt/mounted-repo']);
    // The handle was re-keyed under the worker adopt key the worker's
    // `tryAdoptPrePickedHandle` reads.
    const adopted = await loadAndClearPendingHandle(TERM_KEY('/mnt/mounted-repo'));
    expect(adopted).toStrictEqual(handle);
    dispose();
  });

  it('falls back to /mnt/<name>-2 when the path is already taken', async () => {
    const idbKey = 'pendingMount:perm-consumer-2';
    await storePendingHandle(idbKey, fakeDir('repo'));

    const calls: string[] = [];
    const mounted = deferred<void>();
    const runShell = async (command: string): Promise<MountShellResult> => {
      calls.push(command);
      if (command === 'mount list') {
        return { stdout: '/mnt/repo (indexed: 3 entries)\n', stderr: '', exitCode: 0 };
      }
      mounted.resolve();
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const doc = document.implementation.createHTMLDocument('t');
    const dispose = installMountPendingConsumer({ runShell, doc, mountKeyFor: TERM_KEY });
    doc.dispatchEvent(
      new CustomEvent<MountPendingDetail>('slicc-mount-pending', {
        detail: { idbKey, dirName: 'repo', source: 'drop' },
      })
    );
    await mounted.promise;

    expect(calls[1]).toBe('mount /mnt/repo-2');
    dispose();
  });

  it('skips the mount and never touches the shell when the handle is gone', async () => {
    const calls: string[] = [];
    const runShell = async (command: string): Promise<MountShellResult> => {
      calls.push(command);
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const loaded = deferred<void>();

    const doc = document.implementation.createHTMLDocument('t');
    const dispose = installMountPendingConsumer({
      runShell,
      doc,
      loadHandle: async () => {
        loaded.resolve();
        return null;
      },
      storeHandle: async () => {},
      mountKeyFor: TERM_KEY,
    });
    doc.dispatchEvent(
      new CustomEvent<MountPendingDetail>('slicc-mount-pending', {
        detail: { idbKey: 'missing', dirName: 'x', source: 'drop' },
      })
    );
    await loaded.promise;
    await new Promise((r) => setTimeout(r, 0));

    expect(calls).toEqual([]);
    dispose();
  });

  it('registers the document listener only once', async () => {
    const idbKey = 'pendingMount:perm-consumer-3';
    await storePendingHandle(idbKey, fakeDir('once'));

    let mountCount = 0;
    const mounted = deferred<void>();
    const runShell = async (command: string): Promise<MountShellResult> => {
      if (command.startsWith('mount /')) {
        mountCount++;
        mounted.resolve();
      }
      return { stdout: 'No active mounts\n', stderr: '', exitCode: 0 };
    };

    const doc = document.implementation.createHTMLDocument('t');
    const dispose1 = installMountPendingConsumer({ runShell, doc, mountKeyFor: TERM_KEY });
    const dispose2 = installMountPendingConsumer({ runShell, doc, mountKeyFor: TERM_KEY });
    doc.dispatchEvent(
      new CustomEvent<MountPendingDetail>('slicc-mount-pending', {
        detail: { idbKey, dirName: 'once', source: 'drop' },
      })
    );
    await mounted.promise;
    await new Promise((r) => setTimeout(r, 0));

    expect(mountCount).toBe(1);
    dispose1();
    dispose2();
  });
});
