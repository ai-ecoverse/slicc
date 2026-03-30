/**
 * Browser-safe stub for @mariozechner/pi-coding-agent/dist/core/session-manager.js
 *
 * The compaction submodule imports buildSessionContext at module scope, but the
 * webapp only uses pure functions (estimateTokens, shouldCompact, generateSummary,
 * DEFAULT_COMPACTION_SETTINGS) that never call it. This stub prevents Node-only
 * transitive dependencies from entering the browser bundle.
 *
 * See: packages/webapp/src/core/context-compaction.ts
 */

/** No-op stub — never called in browser context. */
export function buildSessionContext(): never {
  throw new Error('buildSessionContext is not available in the browser');
}
