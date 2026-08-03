/**
 * Module-level hooks for the extension offscreen agent path.
 * Mirrors `setCherryEmitter` precedent at
 * `packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts`.
 *
 * Standalone (where `serve` lives in a different realm from
 * `LeaderSyncManager`) does NOT use these hooks — it uses the
 * `tray-open-preview` / `tray-revoke-preview` / `tray-list-previews` and
 * preview lifecycle panel-RPC ops instead.
 *
 * NOTE: `setPreviewMinter` and `setPreviewOp` have no production
 * callers today. They are placeholders for the extension offscreen
 * leader path that will register these hooks during tray start/stop.
 * Until then, the panel-RPC path is the only active route.
 */

export interface MintPreviewOpts {
  entryPath: string;
  servedRoot: string;
  /**
   * `--bridge` user intent: opt in to leader-managed live updates.
   * The mint site combines this with `noBridge` and the
   * Cherry-follower runtime check to compute `effectiveAllowLive`.
   * (Cherry-attached followers default-on; `--no-bridge` always wins.)
   */
  bridge: boolean;
  /** `--no-bridge` user intent: force-off override. Wins over both `bridge` and Cherry-default-on. */
  noBridge: boolean;
  /** Max tabs allowed (from `--max-tabs`). Passed to the DO record. */
  maxTabs?: number;
  /** `--quiet` flag: durably suppress the preview's first-visit announcement. */
  quiet?: boolean;
  /** Webhook id (from pre-mint webhook creation for `--bridge`). Stored on the DO record. */
  webhookId?: string;
  ttlMs?: number;
  snapshotFiles?: Array<{ path: string; content: Uint8Array; mime: string }>;
}

export interface MintPreviewResult {
  url: string;
  pushed: number;
  /** Preview token returned by the worker mint. Used for `serve --stop`. */
  previewToken: string;
}

export type PreviewMinter = (opts: MintPreviewOpts) => Promise<MintPreviewResult>;

let directMinter: PreviewMinter | null = null;

export function setPreviewMinter(minter: PreviewMinter | null): void {
  directMinter = minter;
}

export function getPreviewMinter(): PreviewMinter | null {
  return directMinter;
}

// ────────────────────────────────────────────────────────────────────────
// In-realm preview operations (--stop / --list / logs / truncate) for the extension path.
// Mirrors the same pattern as `setPreviewMinter`.
// ────────────────────────────────────────────────────────────────────────

export interface PreviewOpRequest {
  type: 'stop' | 'list' | 'logs' | 'truncate';
  previewToken?: string;
}

export interface PreviewLifecycleRecordResult {
  timestamp: string;
  lifecycle: 'connected' | 'disconnected';
  connId: string;
  previewToken?: string;
  origin?: string;
  userAgent?: string;
  connectedAt?: string;
  reason?: string;
  announced: boolean;
}

export interface PreviewOpListItem {
  previewToken: string;
  url: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
  createdAt: string;
  mode?: 'live' | 'persistent';
  expiresAt?: string;
}

export interface PreviewOpResult {
  revoked?: boolean;
  previews?: PreviewOpListItem[];
  lifecycleRecords?: PreviewLifecycleRecordResult[];
  cleared?: number;
  rearmed?: number;
  /** Webhook id of a revoked bridged preview (for `serve --stop` webhook cleanup). */
  webhookId?: string;
}

export type PreviewOp = (req: PreviewOpRequest) => Promise<PreviewOpResult>;

let directOp: PreviewOp | null = null;

export function setPreviewOp(op: PreviewOp | null): void {
  directOp = op;
}

export function getPreviewOp(): PreviewOp | null {
  return directOp;
}
