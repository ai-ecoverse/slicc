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

import type { PanelToOffscreenMessage } from '../../../../chrome-extension/src/messages.js';
import type { Layout } from '../layout.js';

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
