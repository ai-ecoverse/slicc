/**
 * Browser-safe stub for @earendil-works/pi-coding-agent/dist/core/session-manager.js
 *
 * The compaction submodule imports buildSessionContext and
 * sessionEntryToContextMessages at module scope, but the webapp only uses pure
 * functions that never call them. This stub prevents Node-only transitive
 * dependencies from entering the browser bundle.
 *
 * See: packages/webapp/src/core/context-compaction.ts
 */

/** No-op stub — never called in browser context. */
export function buildSessionContext(): never {
  throw new Error('buildSessionContext is not available in the browser');
}

/** No-op stub — never called in browser context. */
export function sessionEntryToContextMessages(): never {
  throw new Error('sessionEntryToContextMessages is not available in the browser');
}
