import {
  type CdpLike,
  type CdpTargetInfo,
  findSliccPageTarget,
  restartLeader,
} from './leader-restart.js';

const DEFAULT_GRACE_MS = 12_000;
const DEFAULT_STUCK_MS = 30_000;
const DEFAULT_POLL_MS = 1_000;

const DEFAULT_CDP_OP_MS = 8_000;

export type HostedPageWatchdogOutcome = 'alive' | 'gave-up';

export interface HostedPageWatchdogOptions {
  cdp: CdpLike;
  cdpPort: number;
  launchUrl: string;
  pageUrlPrefix: string;

  isAlive: () => boolean;
  openPage?: (cdpPort: number, url: string) => Promise<void>;
  reload?: (cdp: CdpLike, pageUrlPrefix: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  graceMs?: number;
  stuckMs?: number;
  pollMs?: number;

  cdpOpMs?: number;
  log?: (msg: string) => void;
}

export async function withCdpOpTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function findIdlePageTarget(targets: CdpTargetInfo[]): CdpTargetInfo | null {
  const idle = targets.filter((t) => {
    if (t.type !== 'page') return false;
    const url = t.url.toLowerCase();
    return (
      url === 'about:blank' ||
      url.startsWith('chrome://newtab') ||
      url.startsWith('chrome://new-tab-page') ||
      url === ''
    );
  });
  if (idle.length === 0) return null;
  return idle.find((t) => t.attached) ?? idle[0];
}

export async function openNewCdpPage(
  cdpPort: number,
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_CDP_OP_MS
): Promise<void> {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let res = await fetchImpl(endpoint, { method: 'PUT', signal });
  if (!res.ok) {
    res = await fetchImpl(endpoint, { signal });
  }
  if (!res.ok) {
    throw new Error(`CDP /json/new failed: HTTP ${res.status}`);
  }
}

export async function navigatePageToUrl(
  cdp: CdpLike,
  target: CdpTargetInfo,
  launchUrl: string
): Promise<void> {
  const tid = target.targetId ?? target.id;
  if (!tid) throw new Error('target missing id');
  const { sessionId } = (await cdp.send('Target.attachToTarget', {
    targetId: tid,
    flatten: true,
  })) as { sessionId: string };
  await cdp.send('Page.navigate', { url: launchUrl }, sessionId);
}

export async function ensureHostedLeaderPage(options: {
  cdp: CdpLike;
  cdpPort: number;
  launchUrl: string;
  pageUrlPrefix: string;
  openPage?: (cdpPort: number, url: string) => Promise<void>;
}): Promise<'had-slicc' | 'navigated' | 'opened'> {
  const openPage = options.openPage ?? openNewCdpPage;
  const result = (await options.cdp.send('Target.getTargets')) as {
    targetInfos: CdpTargetInfo[];
  };
  const targets = result.targetInfos ?? [];
  if (findSliccPageTarget(targets, options.pageUrlPrefix)) return 'had-slicc';

  const idle = findIdlePageTarget(targets);
  if (idle) {
    await navigatePageToUrl(options.cdp, idle, options.launchUrl);
    return 'navigated';
  }

  const anyPage = targets.find((t) => t.type === 'page');
  if (anyPage) {
    await navigatePageToUrl(options.cdp, anyPage, options.launchUrl);
    return 'navigated';
  }

  await openPage(options.cdpPort, options.launchUrl);
  return 'opened';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function watchdogEnsure(
  options: HostedPageWatchdogOptions,
  log: (msg: string) => void,
  cdpOpMs: number
): Promise<void> {
  try {
    const action = await withCdpOpTimeout(
      ensureHostedLeaderPage({
        cdp: options.cdp,
        cdpPort: options.cdpPort,
        launchUrl: options.launchUrl,
        pageUrlPrefix: options.pageUrlPrefix,
        openPage: options.openPage,
      }),
      cdpOpMs,
      'page watchdog ensure'
    );
    if (action === 'had-slicc') {
      log('[hosted] page watchdog: SLICC tab present but /cdp quiet; waiting before reload');
    } else {
      log(`[hosted] page watchdog: ${action} launch URL (page never dialed /cdp)`);
    }
  } catch (err) {
    log(`[hosted] page watchdog: ensure failed: ${errText(err)}`);
  }
}

async function watchdogReload(
  options: HostedPageWatchdogOptions,
  log: (msg: string) => void,
  cdpOpMs: number
): Promise<void> {
  const reload = options.reload ?? restartLeader;
  try {
    const result = await withCdpOpTimeout(
      reload(options.cdp, options.pageUrlPrefix),
      cdpOpMs,
      'page watchdog reload'
    );
    const ok = typeof result === 'object' && result !== null && 'ok' in result && result.ok;
    if (ok) {
      log('[hosted] page watchdog: reloaded SLICC tab after stuck boot');
      return;
    }
    const code =
      typeof result === 'object' && result && 'code' in result ? String(result.code) : 'unknown';
    log(`[hosted] page watchdog: reload skipped (${code})`);
  } catch (err) {
    log(`[hosted] page watchdog: reload failed: ${errText(err)}`);
  }
}

export async function runHostedPageWatchdog(
  options: HostedPageWatchdogOptions
): Promise<HostedPageWatchdogOutcome> {
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const stuckMs = options.stuckMs ?? DEFAULT_STUCK_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const cdpOpMs = options.cdpOpMs ?? DEFAULT_CDP_OP_MS;
  const log = options.log ?? ((msg) => console.log(msg));
  const started = now();

  let ensured = false;
  let reloaded = false;

  while (true) {
    if (options.isAlive()) return 'alive';

    const elapsed = now() - started;
    if (!ensured && elapsed >= graceMs) {
      ensured = true;
      await watchdogEnsure(options, log, cdpOpMs);
    } else if (ensured && !reloaded && elapsed >= graceMs + stuckMs) {
      reloaded = true;
      await watchdogReload(options, log, cdpOpMs);
    } else if (reloaded && elapsed >= graceMs + stuckMs * 2) {
      log('[hosted] page watchdog: gave up; start-leader join poll still owns the deadline');
      return 'gave-up';
    }

    await sleep(pollMs);
  }
}
