/**
 * Typed dependency and result contracts for `ui/boot/*` stage modules.
 *
 * Each boot stage is a single-concern function that accepts a small
 * typed deps object and returns the handles the next stage needs. No
 * stage reaches into shared module state; the orchestrator in
 * `main.ts` threads handles forward between stages explicitly.
 *
 * See `docs/superpowers/specs/...` and issue #902 for the decomposition
 * plan that introduced this layer.
 */

import type {
  ExtensionMessage,
  PanelToOffscreenMessage,
} from '../../../../chrome-extension/src/messages.js';
import type { VirtualFS } from '../../fs/index.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { KernelTransport } from '../../kernel/types.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import type { Layout } from '../layout.js';

/** Minimal logger surface used by the boot stages. */
export interface BootStageLogger {
  debug(message: string, ...data: unknown[]): void;
  info(message: string, ...data: unknown[]): void;
  warn(message: string, ...data: unknown[]): void;
  error(message: string, ...data: unknown[]): void;
}

/**
 * Dependencies for `setupElectronOverlay()` — applies overlay-specific
 * runtime tweaks (tab-bar hiding, initial tab from URL hash, parent
 * `set-tab` message listener, ⌘; toggle shortcut) once the {@link Layout}
 * is mounted. No-op for non-electron-overlay floats.
 */
export interface ElectronOverlaySetupDeps {
  /** The mounted page layout. */
  layout: Layout;
  /** True iff the current runtime mode is `electron-overlay`. */
  isElectronOverlay: boolean;
  /** Page-level `window` (injectable for tests). */
  window: Window;
  /** Page-level `document` (injectable for tests). */
  document: Document;
}

/**
 * Minimal transport surface used by `setupStorageSync()`. Mirrors the
 * `sendRaw` method on `OffscreenClient` without dragging the full
 * client surface into boot-stage tests.
 */
export interface StorageSyncTransport {
  sendRaw(message: PanelToOffscreenMessage): void;
}

/**
 * Dependencies for `setupStorageSync()` — installs the page→worker
 * `localStorage` interceptor and pushes a fresh snapshot of the
 * current `localStorage` so writes that landed between
 * `collectLocalStorageSeed()` and this point are not lost.
 */
export interface StorageSyncSetupDeps {
  /** Transport used to ship `local-storage-*` envelopes to the worker. */
  client: StorageSyncTransport;
  /** Page-level `localStorage` (injectable for tests). */
  localStorage: Storage;
}

/**
 * Handle returned by `setupStorageSync()`. The orchestrator wires
 * `stopStorageSync` into the `beforeunload` cleanup.
 */
export interface StorageSyncHandle {
  /** Restore the original `Storage` methods (cleanup hook for unload). */
  stopStorageSync(): void;
}

/**
 * Dependencies for `setupVfs()` — selects the page-side `localFs`,
 * runs the OPFS cross-tab leader election under `slicc_opfs_vfs=opfs`,
 * wires the file-browser panel for the page-VFS path, kicks off the
 * page-side mount-table recovery, and installs the page-side
 * `preview-vfs` BroadcastChannel responder.
 */
export interface VfsSetupDeps {
  /** The mounted page layout. */
  layout: Layout;
  /** Logger for status / warn messages. */
  log: BootStageLogger;
}

/**
 * Handle returned by `setupVfs()`. `panelReadVfs` and `writableFs`
 * start out pointing at `localFs` and are mutated in place by
 * `attachWorkerVfs()` once the kernel-worker client is up under
 * `slicc_opfs_vfs=opfs`. Consumers that need the *current* value at
 * call time must read through the handle rather than capturing the
 * initial reference.
 */
export interface VfsHandle {
  /** Page-side VirtualFS (IDB-backed flag off; memory-backed under OPFS). */
  readonly localFs: VirtualFS;
  /** True iff `resolveVfsBackendFromEnv() === 'opfs'`. */
  readonly useRpcVfs: boolean;
  /** OPFS leader-election result. `{isLeader:true,dispose:no-op}` when flag is off. */
  readonly opfsLeader: { isLeader: boolean; dispose: () => void };
  /** Preview-vfs BroadcastChannel; held so callers can close it on teardown. */
  readonly previewVfsCh: BroadcastChannel;
  /**
   * Read-only VFS used by panels (file browser, frozen-sessions list,
   * frozen archive reader, sprinkle reader). Swapped to a
   * `RemoteVfsClient` by `attachWorkerVfs()` under `slicc_opfs_vfs=opfs`.
   */
  panelReadVfs: LocalVfsClient;
  /**
   * Writable VFS used by page-side writers (session freezer, pending
   * enrichment, sprinkle writer). Swapped to a
   * `RemoteWritableVfsClient` by `attachWorkerVfs()` under
   * `slicc_opfs_vfs=opfs` AND only on the OPFS leader.
   */
  writableFs: WritableVfsClient;
}

/**
 * Minimal client surface used by `attachWorkerVfs()` — just the
 * transport getter. Avoids dragging the full `OffscreenClient` into
 * boot-stage tests.
 */
export interface VfsWorkerAttachClient {
  getTransport(): KernelTransport<ExtensionMessage, PanelToOffscreenMessage>;
}

/**
 * Dependencies for `attachWorkerVfs()` — the post-client-construction
 * phase of VFS setup. Under `slicc_opfs_vfs=opfs` this routes
 * file-browser reads, the preview-vfs responder, and (leader-only)
 * the freezer's writer through the worker's `VfsRpcHost` via the
 * shared kernel transport.
 */
export interface VfsWorkerAttachDeps {
  /** Handle returned by `setupVfs()`. Mutated in place. */
  handle: VfsHandle;
  /** Kernel client with `getTransport()` available. */
  client: VfsWorkerAttachClient;
  /** The mounted page layout. */
  layout: Layout;
  /** Logger for status messages. */
  log: BootStageLogger;
}

/**
 * Dependencies for `setupFrozenSessions()` — installs
 * `layout.onFrozenSessionOpen` (reads + parses the archive markdown
 * via the VFS handle's current `panelReadVfs` and displays it
 * read-only in the chat panel) and returns an
 * `attachScoopsVfs()` hook to be called *after* `host.ready` resolves
 * so the scoops-panel's eager `/sessions/index.json` read sees the
 * worker's `VfsRpcHost` live.
 */
export interface FrozenSessionsSetupDeps {
  /** The mounted page layout. */
  layout: Layout;
  /** Shared VFS handle. `panelReadVfs` is read at callback-fire time. */
  vfs: VfsHandle;
  /** Logger for warn messages from the open handler. */
  log: BootStageLogger;
}

/**
 * Handle returned by `setupFrozenSessions()`. The orchestrator calls
 * `attachScoopsVfs()` after `await host.ready` so the scoops-panel
 * sidebar reads the canonical OPFS view under `slicc_opfs_vfs=opfs`.
 */
export interface FrozenSessionsHandle {
  /**
   * Wire the scoops-panel's frozen-sessions sidebar to the current
   * `panelReadVfs`. Deferred until after `host.ready` because
   * `setVfs()` eagerly reads `/sessions/index.json` and the worker's
   * `VfsRpcHost` only starts listening at the tail of `boot()`.
   */
  attachScoopsVfs(): void;
}
