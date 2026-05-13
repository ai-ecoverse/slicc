/**
 * enterDetachedActiveState — Layer 1/2/3 of the detached-popout mutual
 * exclusion. Called by the panel-side `detached-active` broadcast
 * handler in main.ts when a detached tab claims the lock.
 *
 * Spec: docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md
 */

import type { OffscreenClient } from './offscreen-client.js';
import type { Layout } from './layout.js';

export function enterDetachedActiveState(client: OffscreenClient, layout: Layout): void {
  // Order: close → lock → overlay.
  //  - window.close() is the happy path; Chrome may defer or no-op it,
  //    so the next two layers must be independently sufficient.
  //  - setLocked(true) flips the OffscreenClient.send() chokepoint so
  //    any user-action message queued after this point (including events
  //    racing the document teardown) is rejected. Must happen before any
  //    code that can yield to the event loop (e.g., overlay paint),
  //    otherwise a click could still slip through to send().
  //  - showDetachedActiveOverlay() provides visible feedback and a
  //    user-initiated close button as the only escape.
  try {
    window.close();
  } catch {
    // window.close() may no-op in some Chrome configurations;
    // layers 2+3 cover it.
  }
  client.setLocked(true);
  layout.showDetachedActiveOverlay();
}
