/**
 * URL query name/value that marks the pinned hosted leader tab the thin
 * extension opens (`?slicc=leader`).
 *
 * Lives in `base/` (bottom rung) so `scoops/` can read it without a value
 * import into `kernel/messages.ts` (#3231). `kernel/messages.ts` re-exports
 * the same bindings for existing wire-protocol callers.
 */

export const LEADER_RUNTIME_QUERY_NAME = 'slicc';
export const LEADER_RUNTIME_QUERY_VALUE = 'leader';
