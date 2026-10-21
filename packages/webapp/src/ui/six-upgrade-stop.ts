import { createLogger } from '../base/logger.js';
import { releaseTrayLeaderOnFatalBoot } from './tray-leader-fatal.js';

const log = createLogger('six-upgrade-stop');

export const SIX_UPGRADE_CHANNEL = 'slicc-six-upgrade';

export const SIX_KERNEL_LOCK = 'slicc-six-kernel';

export const SEVEN_OS_PATH = '/os/';
export const SIX_MOVED_TEXT = 'SLICC moved to seven in this browser.';

export interface SixUpgradeStopMessage {
  type: 'stop';
}

export function isSixUpgradeStop(data: unknown): data is SixUpgradeStopMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'stop';
}

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

let stopped = false;

type KernelStop = () => void | boolean | Promise<void | boolean>;

let kernelStop: KernelStop | null = null;
let lockRelease: (() => void) | null = null;
let noticeDoc: Document | null = null;

export function isSixStoppedForUpgrade(): boolean {
  return stopped;
}

export function registerSixKernelStop(stop: { drain: KernelStop; terminate(): void }): void {
  if (stopped) {
    try {
      stop.terminate();
    } catch (err) {
      log.error('Stopping for the upgrade threw', err);
    }
    return;
  }
  kernelStop = stop.drain;
}

async function runQuietly(fn: KernelStop): Promise<boolean> {
  try {
    return (await fn()) !== false;
  } catch (err) {
    log.error('Stopping for the upgrade threw', err);
    return false;
  }
}

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
  link.id = 'slicc-six-moved-link';
  link.hidden = true;
  box.append(title, link);
  doc.body.replaceChildren(box);
  doc.title = 'SLICC moved to seven';
}

export async function stopSixPageForUpgrade(): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (noticeDoc) await runQuietly(() => renderSixMovedNotice(noticeDoc!));
  const stop = kernelStop;
  kernelStop = null;
  const flushed = stop ? await runQuietly(stop) : true;
  await runQuietly(releaseTrayLeaderOnFatalBoot);
  const release = lockRelease;
  lockRelease = null;
  if (!flushed) {
    log.error('The kernel did not confirm its flush; keeping the upgrade waiting.');
    return;
  }
  release?.();

  const link = noticeDoc?.getElementById('slicc-six-moved-link');
  if (link) link.hidden = false;
}

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

export function holdSixKernelLock(release: () => void): void {
  if (stopped) {
    release();
    return;
  }
  lockRelease = release;
}

export function resetSixUpgradeStopForTests(): void {
  stopped = false;
  kernelStop = null;
  lockRelease = null;
  noticeDoc = null;
}
