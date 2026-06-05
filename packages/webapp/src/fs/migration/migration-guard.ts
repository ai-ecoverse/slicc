/**
 * Extension migration caller guard.
 *
 * The legacy `slicc-fs` → OPFS migration is run from `host.ts`
 * (`createKernelHost`), which boots in the **offscreen document**
 * under the extension float and in the **kernel worker** under
 * standalone. The chrome extension **side panel** is a pure RPC
 * consumer of the offscreen-owned VFS and must never touch the legacy
 * IDB or the OPFS sentinel itself — that would race the offscreen
 * document on the same backing storage and break the canonical-owner
 * invariant.
 *
 * Structurally the panel cannot reach the migration today: `main.ts`'s
 * `mainExtension` path uses `OffscreenClient` and never calls
 * `createKernelHost`. This module is a **defensive assert** so any
 * future regression that calls `runLegacyMigrationFromVfs` from the
 * panel realm fails loud (clear error in the caller, warn log on the
 * `host.ts` fire-and-forget path) instead of silently corrupting the
 * sentinel gate.
 */
import { createLogger } from '../../core/logger.js';

const log = createLogger('migration-guard');

export interface MigrationCallerEnv {
  hasExtensionRuntime: boolean;
  hasDocument: boolean;
  pathname: string;
}

/**
 * Capture the live context the migration entry point was invoked
 * from. The snapshot is cheap and side-effect-free so callers can pin
 * it once at the boundary and pass it to {@link isExtensionSidePanelCaller}
 * for the actual decision (which is what tests exercise).
 */
export function snapshotMigrationCallerEnv(): MigrationCallerEnv {
  const root = globalThis as {
    window?: { location?: { pathname?: string } };
    document?: unknown;
    chrome?: { runtime?: { id?: string } };
  };
  return {
    hasExtensionRuntime: typeof root.chrome?.runtime?.id === 'string',
    hasDocument: typeof root.document !== 'undefined',
    pathname: root.window?.location?.pathname ?? '',
  };
}

/**
 * Return true when the given environment looks like the chrome
 * extension side panel: an extension-runtime DOM context whose
 * pathname is **not** `offscreen.html`. The offscreen document is the
 * sole legitimate VFS owner in extension mode; every other extension
 * surface (`index.html`, the detached popout, `sandbox.html`, ...) is
 * a panel-class caller.
 *
 * DedicatedWorker callers (the standalone kernel worker) have no
 * `document`, so they return false. Non-extension page contexts (the
 * standalone webapp) have no `chrome.runtime.id`, so they also return
 * false.
 */
export function isExtensionSidePanelCaller(env: MigrationCallerEnv): boolean {
  if (!env.hasExtensionRuntime) return false;
  if (!env.hasDocument) return false;
  return !/offscreen\.html$/.test(env.pathname);
}

/**
 * Hard-fail error thrown when migration is invoked from the side
 * panel. Surfaces in the `host.ts` warn log on the fire-and-forget
 * boot path and as a thrown error to any caller that awaits the
 * migration directly (tests, future direct callers).
 */
export class MigrationFromSidePanelError extends Error {
  constructor(env: MigrationCallerEnv) {
    super(
      'runLegacyMigrationFromVfs invoked from the chrome extension side panel ' +
        `(pathname='${env.pathname}'). Migration must run only in the offscreen document; ` +
        'the panel should wait on the kernel-ready RPC (OffscreenClient.onReady).'
    );
    this.name = 'MigrationFromSidePanelError';
  }
}

/**
 * Assert that the current caller is **not** the extension side panel.
 * Pass an explicit env in tests; production callers use the default
 * (live snapshot).
 */
export function assertMigrationNotInSidePanel(
  env: MigrationCallerEnv = snapshotMigrationCallerEnv()
): void {
  if (isExtensionSidePanelCaller(env)) {
    const err = new MigrationFromSidePanelError(env);
    log.error(err.message);
    throw err;
  }
}
