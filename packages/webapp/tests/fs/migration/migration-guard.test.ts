import { describe, expect, it } from 'vitest';
import {
  assertMigrationNotInSidePanel,
  isExtensionSidePanelCaller,
  type MigrationCallerEnv,
  MigrationFromSidePanelError,
  snapshotMigrationCallerEnv,
} from '../../../src/fs/migration/migration-guard.js';

function envOf(partial: Partial<MigrationCallerEnv>): MigrationCallerEnv {
  return {
    hasExtensionRuntime: false,
    hasDocument: false,
    pathname: '',
    ...partial,
  };
}

describe('migration-guard.isExtensionSidePanelCaller', () => {
  it('returns true for the chrome extension side panel (index.html)', () => {
    expect(
      isExtensionSidePanelCaller(
        envOf({ hasExtensionRuntime: true, hasDocument: true, pathname: '/index.html' })
      )
    ).toBe(true);
  });

  it('returns true for the side panel root pathname (/)', () => {
    expect(
      isExtensionSidePanelCaller(
        envOf({ hasExtensionRuntime: true, hasDocument: true, pathname: '/' })
      )
    ).toBe(true);
  });

  it('returns true for the detached popout (still a panel surface)', () => {
    expect(
      isExtensionSidePanelCaller(
        envOf({ hasExtensionRuntime: true, hasDocument: true, pathname: '/index.html' })
      )
    ).toBe(true);
  });

  it('returns false for the offscreen document', () => {
    expect(
      isExtensionSidePanelCaller(
        envOf({ hasExtensionRuntime: true, hasDocument: true, pathname: '/offscreen.html' })
      )
    ).toBe(false);
  });

  it('returns false for the offscreen document under a sub-path', () => {
    expect(
      isExtensionSidePanelCaller(
        envOf({
          hasExtensionRuntime: true,
          hasDocument: true,
          pathname: '/packages/chrome-extension/offscreen.html',
        })
      )
    ).toBe(false);
  });

  it('returns false for the standalone DedicatedWorker (no document)', () => {
    expect(
      isExtensionSidePanelCaller(envOf({ hasExtensionRuntime: false, hasDocument: false }))
    ).toBe(false);
  });

  it('returns false for the standalone page (no extension runtime)', () => {
    expect(
      isExtensionSidePanelCaller(
        envOf({ hasExtensionRuntime: false, hasDocument: true, pathname: '/index.html' })
      )
    ).toBe(false);
  });
});

describe('migration-guard.assertMigrationNotInSidePanel', () => {
  it('throws MigrationFromSidePanelError when called from the side panel', () => {
    const env = envOf({
      hasExtensionRuntime: true,
      hasDocument: true,
      pathname: '/index.html',
    });
    expect(() => assertMigrationNotInSidePanel(env)).toThrow(MigrationFromSidePanelError);
  });

  it('error message references the kernel-ready RPC and the offending pathname', () => {
    const env = envOf({
      hasExtensionRuntime: true,
      hasDocument: true,
      pathname: '/index.html',
    });
    try {
      assertMigrationNotInSidePanel(env);
      throw new Error('guard did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationFromSidePanelError);
      const msg = (err as Error).message;
      expect(msg).toContain(
        'runLegacyMigrationFromVfs invoked from the chrome extension side panel'
      );
      expect(msg).toContain('OffscreenClient.onReady');
      expect(msg).toContain('/index.html');
    }
  });

  it('does not throw from the offscreen document', () => {
    const env = envOf({
      hasExtensionRuntime: true,
      hasDocument: true,
      pathname: '/offscreen.html',
    });
    expect(() => assertMigrationNotInSidePanel(env)).not.toThrow();
  });

  it('does not throw from the standalone DedicatedWorker', () => {
    const env = envOf({ hasExtensionRuntime: false, hasDocument: false });
    expect(() => assertMigrationNotInSidePanel(env)).not.toThrow();
  });

  it('does not throw from the standalone page', () => {
    const env = envOf({
      hasExtensionRuntime: false,
      hasDocument: true,
      pathname: '/index.html',
    });
    expect(() => assertMigrationNotInSidePanel(env)).not.toThrow();
  });

  it('snapshots globalThis by default — vitest node env reads as a non-panel caller', () => {
    // The default vitest `environment: node` has no `window`, no
    // `document`, no `chrome.runtime` — so the live snapshot must NOT
    // be flagged as the side panel. This protects every other
    // migration test (e.g. migration-run.test.ts) from spurious
    // throws when they call the entry point with no overrides.
    const live = snapshotMigrationCallerEnv();
    expect(live.hasExtensionRuntime).toBe(false);
    expect(live.hasDocument).toBe(false);
    expect(() => assertMigrationNotInSidePanel()).not.toThrow();
  });
});
