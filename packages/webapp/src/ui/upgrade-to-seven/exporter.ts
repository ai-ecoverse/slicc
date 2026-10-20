/**
 * The in-place exporter for the upgrade to seven on www.sliccy.ai
 * (slicc#4051). Seven's BIOS at `/7/` runs `/upgrade-to-seven.html` in a
 * hidden same-origin frame; this is what that page does:
 *
 * 1. Stops every six page: broadcasts `{ type: 'stop' }` on
 *    `slicc-six-upgrade`, then takes `slicc-six-kernel` exclusive, which it
 *    gets once each page has terminated its kernel and released the lock. It
 *    keeps the lock until the frame goes away, so no six page boots meanwhile.
 *    Then it asks tabs on an older six build, which know neither, to reload
 *    (`nuke-reload`), so they come back on this build and stop too.
 * 2. Plans the profile's version 2 directory form (`planProfileDirectory`).
 * 3. Writes it to `/slicc-v6-upgrade/<exportId>/`, `manifest.json` last.
 *
 * It reports to its parent, and only to a same-origin parent:
 * `{ type: 'slicc-six-upgrade', phase, done, total }` while it runs, then
 * `{ type: 'slicc-six-upgrade', done: true, exportId, dir }` or
 * `{ type: 'slicc-six-upgrade', error }`.
 */

import type { NukeReloadMsg } from '../../shell/supplemental-commands/nuke-channel.js';
import type {
  ProfileDirectoryPlan,
  ProfileDirectoryWriter,
} from '../../transcript/profile-export.js';
import {
  SIX_KERNEL_LOCK,
  type SixChannel,
  type SixLockManager,
  type SixUpgradeStopMessage,
} from '../six-upgrade-stop.js';

/** The `type` of every message the exporter posts to its parent. */
export const SIX_UPGRADE_MESSAGE_TYPE = 'slicc-six-upgrade';

export type SixUpgradePhase = 'stopping' | 'reading' | 'writing';

export type SixUpgradeMessage =
  | { type: typeof SIX_UPGRADE_MESSAGE_TYPE; phase: SixUpgradePhase; done: number; total: number }
  | { type: typeof SIX_UPGRADE_MESSAGE_TYPE; done: true; exportId: string; dir: string }
  | { type: typeof SIX_UPGRADE_MESSAGE_TYPE; error: string };

/** How long six's pages get to stop before the export gives up. */
export const SIX_STOP_TIMEOUT_MS = 30_000;
/** The stop is re-sent this often while the exporter waits, for pages still booting. */
export const SIX_STOP_RESEND_MS = 2_000;
/** How long tabs on an older six build get to unload after the reload request. */
export const SIX_LEGACY_SETTLE_MS = 1_500;

export const SIX_STOP_TIMEOUT_ERROR =
  "A SLICC 6 tab didn't stop. Close your SLICC 6 tabs and try again.";
export const SIX_NO_LOCKS_ERROR = "This browser can't stop SLICC 6's tabs (no Web Locks).";

/** The window facts the frame check needs. */
export interface FrameWindowLike {
  location: { origin: string; ancestorOrigins?: { length: number; [index: number]: string } };
  parent: unknown;
}

/**
 * True when this page runs in a frame whose ancestors are all on its own
 * origin. The exporter does nothing otherwise: it is not a page to open, and
 * a cross-origin embedder must never drive it (the worker also sends
 * `frame-ancestors 'self'`).
 */
export function isFramedBySameOrigin(win: FrameWindowLike): boolean {
  if (win.parent === win || win.parent === null || win.parent === undefined) return false;
  const origin = win.location.origin;
  const ancestors = win.location.ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    for (let i = 0; i < ancestors.length; i++) if (ancestors[i] !== origin) return false;
    return true;
  }
  try {
    return (win.parent as { location: { origin: string } }).location.origin === origin;
  } catch {
    return false;
  }
}

/** Post to the parent on this origin only: never `'*'`. */
export function postToSameOriginParent(
  win: FrameWindowLike & { parent: { postMessage(message: unknown, targetOrigin: string): void } }
): (message: SixUpgradeMessage) => void {
  return (message) => win.parent.postMessage(message, win.location.origin);
}

export interface SixUpgradeExportDeps {
  post(message: SixUpgradeMessage): void;
  channel: SixChannel | null;
  locks: SixLockManager | null;
  plan(
    onProgress: (phase: 'reading' | 'writing', done: number, total: number) => void
  ): Promise<ProfileDirectoryPlan>;
  openWriter(exportId: string): Promise<ProfileDirectoryWriter>;
  stopTimeoutMs?: number;
  resendMs?: number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
  /**
   * The channel six builds from before this protocol reload on
   * (`slicc-nuke-control`). Reloaded, they boot this build, which finds the
   * lock taken and stops. Null skips the fence.
   */
  legacyReloadChannel?: Pick<SixChannel, 'postMessage' | 'close'> | null;
  /** How long older tabs get to unload after the reload request. */
  legacySettleMs?: number;
}

/**
 * Tell six's pages to stop and wait until none holds `slicc-six-kernel`.
 * Resolves once this page holds it exclusively; it is never released here,
 * so it goes when the frame does.
 */
export async function stopSixPages(deps: SixUpgradeExportDeps): Promise<void> {
  const { locks, channel } = deps;
  if (!locks) throw new Error(SIX_NO_LOCKS_ERROR);
  const stop: SixUpgradeStopMessage = { type: 'stop' };
  const send = (): void => {
    try {
      channel?.postMessage(stop);
    } catch {
      /* a closed channel only means no page hears the resend */
    }
  };
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const controller = new AbortController();
  const timeoutMs = deps.stopTimeoutMs ?? SIX_STOP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  send();
  const resend = every(send, deps.resendMs ?? SIX_STOP_RESEND_MS);
  try {
    await new Promise<void>((resolve, reject) => {
      locks
        .request(SIX_KERNEL_LOCK, { mode: 'exclusive', signal: controller.signal }, () => {
          resolve();
          return new Promise<void>(() => {});
        })
        .catch(() => reject(new Error(SIX_STOP_TIMEOUT_ERROR)));
    });
  } finally {
    clearTimeout(timer);
    clear(resend);
  }
  await fenceLegacySixTabs(deps);
}

/**
 * Tabs on a six build from before this protocol neither hold the lock nor
 * hear the stop. They all listen for `nuke-reload` (with no keys to clear it
 * is a plain reload), so ask them to reload, after this build's pages have
 * already flushed and stopped, and give them a moment to unload. A reloaded
 * tab boots this build, finds the lock taken, and shows the moved notice.
 */
async function fenceLegacySixTabs(deps: SixUpgradeExportDeps): Promise<void> {
  const channel = deps.legacyReloadChannel;
  if (!channel) return;
  try {
    channel.postMessage({ type: 'nuke-reload' } satisfies NukeReloadMsg);
  } catch {
    /* no listener can hear it then either */
  } finally {
    channel.close();
  }
  await new Promise((resolve) => setTimeout(resolve, deps.legacySettleMs ?? SIX_LEGACY_SETTLE_MS));
}

/** Run the whole export and report it. Never throws: failures are posted. */
export async function runSixUpgradeExport(deps: SixUpgradeExportDeps): Promise<void> {
  const type = SIX_UPGRADE_MESSAGE_TYPE;
  try {
    deps.post({ type, phase: 'stopping', done: 0, total: 1 });
    await stopSixPages(deps);
    deps.post({ type, phase: 'stopping', done: 1, total: 1 });
    const progress = (phase: 'reading' | 'writing', done: number, total: number): void =>
      deps.post({ type, phase, done, total });
    const plan = await deps.plan(progress);
    const writer = await deps.openWriter(plan.exportId);
    await plan.write(writer, { onProgress: progress });
    deps.post({ type, done: true, exportId: plan.exportId, dir: plan.dir });
  } catch (err) {
    deps.post({ type, error: err instanceof Error ? err.message : String(err) });
  }
}
