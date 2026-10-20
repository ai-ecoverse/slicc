/**
 * Six's half of the in-place upgrade to seven on www.sliccy.ai (slicc#4051):
 * how a six tab stops so the exporter (`/upgrade-to-seven.html`, run by
 * seven's BIOS in a hidden frame) can read a profile nothing writes any more.
 *
 * - Every six page holds the Web Lock {@link SIX_KERNEL_LOCK} in `shared`
 *   mode from boot until it has stopped. A kernel-owning tab holds it from
 *   before it spawns its kernel worker until that worker is terminated. The
 *   Python realm and the wasm process workers are nested workers of the
 *   kernel worker, so they end with it.
 * - The exporter broadcasts `{ type: 'stop' }` on {@link SIX_UPGRADE_CHANNEL}
 *   and then takes the lock `exclusive`, which it gets once every six page
 *   has stopped and released it. It keeps the lock until its frame goes away.
 * - A six page that boots while the exporter waits or holds the lock gets no
 *   lock (`ifAvailable`). It shows the moved notice and boots nothing: no
 *   kernel, and no service worker that could take scope `/` from seven.
 *
 * Stopping is one-way for the page: it terminates the kernel, stops the
 * leader tray, and shows "SLICC moved to seven in this browser" with a link
 * to `/os/`.
 */

import { createLogger } from '../base/logger.js';
import { releaseTrayLeaderOnFatalBoot } from './tray-leader-fatal.js';

const log = createLogger('six-upgrade-stop');

/** BroadcastChannel the exporter tells six's tabs to stop on. */
export const SIX_UPGRADE_CHANNEL = 'slicc-six-upgrade';
/** Held `shared` by every six page, taken `exclusive` by the exporter. */
export const SIX_KERNEL_LOCK = 'slicc-six-kernel';
/** Where seven's UI lives on www. */
export const SEVEN_OS_PATH = '/os/';
export const SIX_MOVED_TEXT = 'SLICC moved to seven in this browser.';

export interface SixUpgradeStopMessage {
  type: 'stop';
}

export function isSixUpgradeStop(data: unknown): data is SixUpgradeStopMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'stop';
}

/** The sliver of the Web Locks API both sides use. */
export interface SixLockManager {
  request(
    name: string,
    options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>
  ): Promise<unknown>;
}

export interface SixChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export function defaultSixLockManager(): SixLockManager | null {
  const locks = (globalThis as { navigator?: { locks?: SixLockManager } }).navigator?.locks;
  return typeof locks?.request === 'function' ? locks : null;
}

export function openSixUpgradeChannel(): SixChannel | null {
  if (typeof BroadcastChannel !== 'function') return null;
  try {
    return new BroadcastChannel(SIX_UPGRADE_CHANNEL) as unknown as SixChannel;
  } catch {
    return null;
  }
}

/**
 * Take {@link SIX_KERNEL_LOCK} in `shared` mode. Resolves with its release,
 * or null when the exporter holds it or waits for it. Without Web Locks the
 * page runs as before (there is no exporter to wait for then either).
 */
export async function claimSixKernelLock(
  locks: SixLockManager | null
): Promise<{ release(): void } | null> {
  if (!locks) return { release: () => {} };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return new Promise((resolve, reject) => {
    locks
      .request(SIX_KERNEL_LOCK, { mode: 'shared', ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(null);
          return Promise.resolve();
        }
        resolve({ release });
        return held;
      })
      .catch(reject);
  });
}

// ---------------------------------------------------------------------------
// The page's stop
// ---------------------------------------------------------------------------

let stopped = false;
let kernelStop: (() => void | Promise<void>) | null = null;
let lockRelease: (() => void) | null = null;
let noticeDoc: Document | null = null;

/** True once this page has stopped for the upgrade. */
export function isSixStoppedForUpgrade(): boolean {
  return stopped;
}

/**
 * Register how this page terminates its kernel: flush its conversations,
 * then terminate it (`SpawnedKernelHost.drain`). A page that has already
 * stopped runs it at once, so a kernel spawned after the stop never runs.
 */
export function registerSixKernelStop(stop: () => void | Promise<void>): void {
  if (stopped) {
    void runQuietly(stop);
    return;
  }
  kernelStop = stop;
}

async function runQuietly(fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error('Stopping for the upgrade threw', err);
  }
}

/** Replace the page with "SLICC moved to seven in this browser" and a link to `/os/`. */
export function renderSixMovedNotice(doc: Document): void {
  const box = doc.createElement('main');
  box.id = 'slicc-six-moved';
  box.setAttribute('role', 'status');
  box.style.cssText =
    'max-width:28rem;margin:18vh auto 0;padding:0 1.5rem;text-align:center;' +
    'font:15px/1.5 system-ui,-apple-system,sans-serif;color:CanvasText;';
  const title = doc.createElement('h1');
  title.style.cssText = 'font-size:20px;font-weight:600;margin:0 0 .5rem;';
  title.textContent = SIX_MOVED_TEXT;
  const link = doc.createElement('a');
  link.href = SEVEN_OS_PATH;
  link.textContent = 'Open SLICC 7';
  link.style.cssText = 'font-weight:600;';
  box.append(title, link);
  doc.body.replaceChildren(box);
  doc.title = 'SLICC moved to seven';
}

/**
 * Stop this page for the upgrade: the notice, then the kernel (its
 * conversations flushed first), the tray, and only then the lock, so the
 * exporter never reads before the last checkpoint landed. Idempotent.
 */
export async function stopSixPageForUpgrade(): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (noticeDoc) await runQuietly(() => renderSixMovedNotice(noticeDoc!));
  const stop = kernelStop;
  kernelStop = null;
  if (stop) await runQuietly(stop);
  await runQuietly(releaseTrayLeaderOnFatalBoot);
  const release = lockRelease;
  lockRelease = null;
  release?.();
}

/**
 * Listen for the exporter's stop and hold the page's lock. Call it before
 * {@link claimSixKernelLock}'s result is known to be granted, so a stop that
 * arrives while the claim is pending is not missed; then hand the claim's
 * release to {@link holdSixKernelLock}.
 */
export function installSixUpgradeStopListener(
  doc: Document,
  channel: SixChannel | null = openSixUpgradeChannel()
): () => void {
  noticeDoc = doc;
  if (!channel) return () => {};
  channel.addEventListener('message', (event) => {
    if (!isSixUpgradeStop(event.data)) return;
    log.error('SLICC 7 is taking over this browser; stopping this tab.');
    void stopSixPageForUpgrade();
  });
  return () => channel.close();
}

/** Keep `release` until the page stops; a page that already stopped releases at once. */
export function holdSixKernelLock(release: () => void): void {
  if (stopped) {
    release();
    return;
  }
  lockRelease = release;
}

/** Test-only. */
export function resetSixUpgradeStopForTests(): void {
  stopped = false;
  kernelStop = null;
  lockRelease = null;
  noticeDoc = null;
}
