// @vitest-environment jsdom
/**
 * Page-realm accessor for the leader `<slicc-permissions>` surface.
 * `installLeaderPermissionsSurface` registers the element on mount and
 * clears it on dispose; pre-boot / post-dispose lookups return `null`.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import { installLeaderPermissionsSurface } from '../../../src/ui/wc/wc-permissions.js';
import {
  getLeaderPermissionsSurface,
  setLeaderPermissionsSurface,
} from '../../../src/ui/wc/wc-permissions-registry.js';

class StubPermissions extends HTMLElement {
  providers: unknown = {};
}
if (!customElements.get('slicc-permissions')) {
  customElements.define('slicc-permissions', StubPermissions);
}

describe('wc-permissions-registry', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    setLeaderPermissionsSurface(null);
  });

  it('returns null before any surface is installed', () => {
    expect(getLeaderPermissionsSurface()).toBeNull();
  });

  it('publishes the mounted element after install and clears on dispose', () => {
    const installed = installLeaderPermissionsSurface({ runtimeMode: 'standalone' });
    expect(installed).not.toBeNull();
    expect(getLeaderPermissionsSurface()).toBe(installed?.element);
    installed?.dispose();
    expect(getLeaderPermissionsSurface()).toBeNull();
  });

  it('does not publish in cherry mode (no surface mounted)', () => {
    const installed = installLeaderPermissionsSurface({ runtimeMode: 'cherry' });
    expect(installed).toBeNull();
    expect(getLeaderPermissionsSurface()).toBeNull();
  });

  it('forwards injected providers onto the element at install time', () => {
    const fakeUsb = { requestDevice: async () => ({}) };
    const installed = installLeaderPermissionsSurface({
      runtimeMode: 'standalone',
      providers: { usb: fakeUsb },
    });
    expect(installed).not.toBeNull();
    const el = installed!.element as unknown as { providers: { usb?: unknown } };
    expect(el.providers.usb).toBe(fakeUsb);
    installed?.dispose();
  });
});
