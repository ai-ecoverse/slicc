/**
 * Module-level hook for the extension offscreen agent path to mint
 * previews in-realm. Mirrors `setCherryEmitter` precedent at
 * `packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts`.
 *
 * The offscreen `extension-leader-tray.ts` calls `setPreviewMinter(...)`
 * during `startExtensionLeaderTray()` and `setPreviewMinter(null)` on
 * stop. The `serve` shell command (running inside the offscreen kernel
 * worker) calls `getPreviewMinter()?.(...)` as its primary mint path.
 *
 * Standalone (where `serve` lives in a different realm from
 * `LeaderSyncManager`) does NOT use this hook — it uses the
 * `tray-open-preview` panel-RPC op instead.
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
}

export interface MintPreviewResult {
  url: string;
  pushed: number;
}

export type PreviewMinter = (opts: MintPreviewOpts) => Promise<MintPreviewResult>;

let directMinter: PreviewMinter | null = null;

export function setPreviewMinter(minter: PreviewMinter | null): void {
  directMinter = minter;
}

export function getPreviewMinter(): PreviewMinter | null {
  return directMinter;
}
