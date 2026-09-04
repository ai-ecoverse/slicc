/**
 * `TargetInfo` — the subset of `packages/webapp/src/cdp/types.ts` the thin
 * chrome extension needs (`Target.getTargets` results). The rest of that
 * file (command/response/event envelopes, connection state, page-level
 * types) stays webapp-internal; only this shape crosses the package
 * boundary (#2276 slice E).
 */

/** Target info returned by Target.getTargets. */
export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
  /** True if this is the user's active tab (extension mode only). */
  active?: boolean;
}
