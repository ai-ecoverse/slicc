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

export const SIX_UPGRADE_MESSAGE_TYPE = 'slicc-six-upgrade';

export type SixUpgradePhase = 'stopping' | 'reading' | 'writing';

export type SixUpgradeMessage =
  | { type: typeof SIX_UPGRADE_MESSAGE_TYPE; phase: SixUpgradePhase; done: number; total: number }
  | { type: typeof SIX_UPGRADE_MESSAGE_TYPE; done: true; exportId: string; dir: string }
  | { type: typeof SIX_UPGRADE_MESSAGE_TYPE; error: string };

export const SIX_STOP_TIMEOUT_MS = 30_000;

export const SIX_STOP_RESEND_MS = 2_000;

export const SIX_LEGACY_SETTLE_MS = 1_500;

export const SIX_STOP_TIMEOUT_ERROR =
  "A SLICC 6 tab didn't stop. Close your SLICC 6 tabs and try again.";
export const SIX_NO_LOCKS_ERROR = "This browser can't stop SLICC 6's tabs (no Web Locks).";

export interface FrameWindowLike {
  location: { origin: string; ancestorOrigins?: { length: number; [index: number]: string } };
  parent: unknown;
}

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

  legacyReloadChannel?: Pick<SixChannel, 'postMessage' | 'close'> | null;

  legacySettleMs?: number;
}

export async function stopSixPages(deps: SixUpgradeExportDeps): Promise<void> {
  const { locks, channel } = deps;
  if (!locks) throw new Error(SIX_NO_LOCKS_ERROR);
  const stop: SixUpgradeStopMessage = { type: 'stop' };
  const send = (): void => {
    try {
      channel?.postMessage(stop);
    } catch {}
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

async function fenceLegacySixTabs(deps: SixUpgradeExportDeps): Promise<void> {
  const channel = deps.legacyReloadChannel;
  if (!channel) return;
  try {
    channel.postMessage({ type: 'nuke-reload' } satisfies NukeReloadMsg);
  } catch {
  } finally {
    channel.close();
  }
  await new Promise((resolve) => setTimeout(resolve, deps.legacySettleMs ?? SIX_LEGACY_SETTLE_MS));
}

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
    try {
      await plan.write(writer, { onProgress: progress });
    } catch (err) {
      await writer.remove?.().catch(() => {});
      throw err;
    }
    deps.post({ type, done: true, exportId: plan.exportId, dir: plan.dir });
  } catch (err) {
    deps.post({ type, error: err instanceof Error ? err.message : String(err) });
  }
}
