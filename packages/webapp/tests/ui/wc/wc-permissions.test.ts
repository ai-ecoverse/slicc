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

import { loadAndClearPendingHandle } from '../../../src/fs/mount-picker-popup.js';
import {
  installLeaderPermissionsSurface,
  type MountPendingDetail,
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
