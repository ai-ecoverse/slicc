import type { ConeEntry } from './types.js';

/**
 * Per-user (or per-machine) registry of cloud cones. Two implementations:
 *  - node-server uses `FileRegistry` (backed by ~/.slicc/cloud-sessions.json)
 *  - cloudflare-worker uses `LocalRegistry` (backed by DurableObject storage)
 *
 * Both implementations:
 *  - Persist the `{ sessions: ConeEntry[] }` JSON shape (legacy schema, do not
 *    rename — existing CLI files in the wild depend on it).
 *  - Have UPSERT semantics on `append`: replacing an entry by sandboxId, not
 *    throwing on duplicate. Same upsert behavior as the previous file-backed
 *    implementation and is load-bearing for reconciliation passes.
 */
export interface Registry {
  /** Read all entries. */
  list(): Promise<ConeEntry[]>;
  /** Resolve a query (sandboxId OR name) to a single entry, or null. */
  findByNameOrId(query: string): Promise<ConeEntry | null>;
  /** Add or replace an entry. Idempotent: re-appending an existing sandboxId
   * replaces the previous record in place. */
  append(entry: ConeEntry): Promise<void>;
  /** Partial update by sandboxId. Throws if not found. */
  update(sandboxId: string, patch: Partial<ConeEntry>): Promise<void>;
  /** Remove by sandboxId. Idempotent — no-op if absent. */
  remove(sandboxId: string): Promise<void>;
}
