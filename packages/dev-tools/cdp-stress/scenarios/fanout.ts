/**
 * Scenario 5 — fan-out stress (the #2411 incident shape).
 * D drivers each own 2 tabs and loop: goto → snapshot → screenshot → title
 * check. Everything funnels through the single global tab lock. Reports lock
 * wait, per-op latency, wrong-tab results, and error kinds.
 *
 * `poison: true` adds one driver that navigates to a URL that never loads: its
 * `navigate()` holds the global lock until the load-event timeout. `wallMs`
 * includes that driver; `driversWallMs` stops when the last REAL driver
 * finishes, which is what "unpoisoned drivers unaffected" is measured on.
 *
 * Post-fix expectation: per-tab locking, so cumulative lock wait collapses and
 * the poisoned run's `driversWallMs` matches the clean run's.
 */
import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack, errKind, type Summary, summarize } from '../stack.js';

export interface FanoutOptions {
  drivers?: number;
  iterations?: number;
  poison?: boolean;
  screenshot?: boolean;
}

export interface FanoutResult {
  drivers: number;
  iterations: number;
  poison: boolean;
  /** Wall clock for every task, including the poison driver's hung goto. */
  wallMs: number;
  /** Wall clock until the last non-poison driver finished. */
  driversWallMs: number;
  ops: number;
  wrongTabResults: number;
  errors: Record<string, number>;
  lock: {
    queueDepth: number;
    /** All queued time: `tabWaitMs + bridgeWaitMs` (or the whole wait on a bridge without the split). */
    totalWaitMs: number;
    /** Waiting for THIS tab's own lock — a sibling driving the same tab. */
    tabWaitMs?: number;
    /** Waiting for the bridge-wide lock — another tab's round trip in flight. */
    bridgeWaitMs?: number;
    acquisitions: number;
    /** Per-goto delta of the per-tab wait (falls back to total on a bridge without the split). */
    waitPerGoto: Summary;
  };
  latencyMs: { goto: Summary; snapshot: Summary; screenshot: Summary; title: Summary };
  sessionsMinted: number;
  inboundEvents: number;
  maxInboundBurst: { per100ms: number; per1s: number };
  topInboundEvents: Array<[string, number]>;
}

const ITEMS_PER_PAGE = 80;
const TABS_PER_DRIVER = 2;

export async function run(opts: FanoutOptions = {}): Promise<FanoutResult> {
  const drivers = opts.drivers ?? 8;
  const iterations = opts.iterations ?? Number(process.env['HARNESS_ITER'] ?? 6);
  const chrome = await launchChrome();
  const site = await startSite();
  try {
    const st = await buildStack(chrome.wsUrl);
    const b = st.browser;
    const lat: Record<string, number[]> = {
      goto: [],
      snapshot: [],
      screenshot: [],
      title: [],
      lockWait: [],
    };
    const errors = new Map<string, number>();
    let wrongTab = 0;
    let ops = 0;

    /** Charge the lock wait accrued while `fn` ran to the goto histogram. */
    // Per-tab lock wait (a sibling driving the SAME tab). Bridge-wide waits
    // are reported separately in `lock.bridgeWaitMs`: with an ambient session
    // cursor, CDP round trips still take turns on the bridge, while page
    // loads and waits overlap across tabs.
    const tabWait = (): number => {
      const stats = b.getTabLockStats();
      return stats.tabWaitMs ?? stats.totalWaitMs;
    };
    const lockWaitSample = async <T>(fn: () => Promise<T>): Promise<T> => {
      const before = tabWait();
      try {
        return await fn();
      } finally {
        lat['lockWait']?.push(tabWait() - before);
      }
    };
    const rec = async (kind: string, fn: () => Promise<unknown>): Promise<unknown> => {
      const t0 = Date.now();
      ops += 1;
      try {
        return await fn();
      } catch (e) {
        errors.set(errKind(e), (errors.get(errKind(e)) ?? 0) + 1);
        return undefined;
      } finally {
        lat[kind]?.push(Date.now() - t0);
      }
    };

    const driver = async (d: number) => {
      const tabs: string[] = [];
      for (let i = 0; i < TABS_PER_DRIVER; i++) tabs.push(await b.createPage('about:blank'));
      for (let k = 0; k < iterations; k++) {
        for (const [ti, tab] of tabs.entries()) {
          const name = `d${d}-t${ti}-i${k}`;
          await rec('goto', () =>
            lockWaitSample(() =>
              b.withTab(tab, () => b.navigate(`${site.url}/page/${name}?items=${ITEMS_PER_PAGE}`))
            )
          );
          await rec('snapshot', () => b.withTab(tab, () => b.getAccessibilityTree()));
          if (opts.screenshot !== false) {
            await rec('screenshot', () =>
              b.withTab(tab, () => b.screenshot({ foregroundFallback: false }))
            );
          }
          const got = await rec('title', () => b.withTab(tab, () => b.evaluate('document.title')));
          if (got !== undefined && got !== name) wrongTab += 1;
        }
      }
    };
    const poisonDriver = async () => {
      const tab = await b.createPage('about:blank');
      await rec('goto', () => b.withTab(tab, () => b.navigate(`${site.url}/hang`)));
    };

    const wall0 = Date.now();
    const driverTasks = Array.from({ length: drivers }, (_, d) => driver(d));
    const allTasks = opts.poison ? [...driverTasks, poisonDriver()] : driverTasks;
    await Promise.all(driverTasks);
    const driversWallMs = Date.now() - wall0;
    await Promise.all(allTasks);
    const wallMs = Date.now() - wall0;

    const stats = b.getTabLockStats();
    const result: FanoutResult = {
      drivers,
      iterations,
      poison: Boolean(opts.poison),
      wallMs,
      driversWallMs,
      ops,
      wrongTabResults: wrongTab,
      errors: Object.fromEntries(errors),
      lock: { ...stats, waitPerGoto: summarize(lat['lockWait'] ?? []) },
      latencyMs: {
        goto: summarize(lat['goto'] ?? []),
        snapshot: summarize(lat['snapshot'] ?? []),
        screenshot: summarize(lat['screenshot'] ?? []),
        title: summarize(lat['title'] ?? []),
      },
      sessionsMinted: st.sessions.length,
      inboundEvents: st.counters.eventsIn,
      maxInboundBurst: { per100ms: st.maxBurst(100), per1s: st.maxBurst(1000) },
      topInboundEvents: [...st.counters.eventsByMethod.entries()]
        .sort((a, b2) => b2[1] - a[1])
        .slice(0, 5),
    };
    st.stop();
    return result;
  } finally {
    site.close();
    chrome.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const drivers = Number(process.argv[2] ?? 8);
  const result = await run({ drivers, poison: process.argv.includes('--poison') });
  console.log(JSON.stringify(result, null, 2));
}
