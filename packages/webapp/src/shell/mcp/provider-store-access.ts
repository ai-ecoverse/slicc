/**
 * Re-exports of the MCP server store auth accessors.
 *
 * Historically this file held a separate placeholder reader for the auth
 * block. The full read/write store now lives in `store.ts`; we keep the
 * surface here as a re-export so existing callers (`provider.ts` and any
 * dynamic imports) continue to work without churn.
 */

export {
  readMcpAuthEntries,
  readMcpAuthEntry,
  testOnlyResetStoreCache,
  testOnlySetFsModule,
} from './store.js';
export type { McpAuthEntry, McpServerAuthRecord } from './types.js';
