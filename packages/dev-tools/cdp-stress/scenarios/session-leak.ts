/**
 * Scenario 1 — session accumulation.
 * Every `withTab` switch mints a fresh `Target.attachToTarget` session and the
 * previous one is never detached. Each leaked session keeps `Page.enable` (+
 * `Runtime.enable`) on, so Chrome fans every page/runtime event out once per
 * leaked session over the single /cdp socket.
 *
 * Post-fix expectation: sessions minted == tabs, `Target.detachFromTarget` is
 * sent when a tab closes, and the event cost of one navigation stays flat
 * across rounds instead of growing with every tab switch.
 */
import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack } from '../stack.js';

export interface SessionLeakResult {
  navigationWatcher: boolean;
  tabs: number;
  rounds: number;
  sessionsMinted: number;
  distinctSessions: number;
  attachToTargetSends: number;
  detachFromTargetSends: number;
  detachesAfterClose: number;
  eventsPerNavFirst: number;
  eventsPerNavLast: number;
  eventsPerNavSeries: number[];
  sessionsSeries: number[];
  topInboundEvents: Array<[string, number]>;
}

export interface SessionLeakOptions {
  tabs?: number;
  rounds?: number;
  navigationWatcher?: boolean;
}

export async function run(opts: SessionLeakOptions = {}): Promise<SessionLeakResult> {
  const tabs = opts.tabs ?? 4;
  const rounds = opts.rounds ?? 25;
  const chrome = await launchChrome();
  const site = await startSite();
  try {
    const st = await buildStack(chrome.wsUrl, { navigationWatcher: opts.navigationWatcher });
    const ids: string[] = [];
    for (let i = 0; i < tabs; i++) ids.push(await st.browser.createPage(`${site.url}/page/t${i}`));
    await new Promise((r) => setTimeout(r, 500));

    const eventsPerNav: number[] = [];
    const sessionsPerNav: number[] = [];
    for (let r = 0; r < rounds; r++) {
      for (let t = 0; t < tabs; t++) {
        await st.browser.withTab(ids[t] as string, () => st.browser.evaluate('document.title'));
      }
      // Probe: navigate tab 0 and count inbound events caused by that one nav.
      const before = st.counters.eventsIn;
      await st.browser.withTab(ids[0] as string, () =>
        st.browser.navigate(`${site.url}/page/probe-${r}`)
      );
      await new Promise((res) => setTimeout(res, 150));
      eventsPerNav.push(st.counters.eventsIn - before);
      sessionsPerNav.push(st.sessions.length);
    }
    // Closing a tab must release its session: post-fix, `closePage` detaches.
    const detachesBeforeClose = st.counters.byMethod.get('Target.detachFromTarget') ?? 0;
    await st.browser.closePage(ids[tabs - 1] as string);
    await new Promise((r) => setTimeout(r, 200));
    const detaches = st.counters.byMethod.get('Target.detachFromTarget') ?? 0;
    const result: SessionLeakResult = {
      navigationWatcher: Boolean(opts.navigationWatcher),
      tabs,
      rounds,
      sessionsMinted: st.sessions.length,
      distinctSessions: new Set(st.sessions).size,
      attachToTargetSends: st.counters.byMethod.get('Target.attachToTarget') ?? 0,
      detachFromTargetSends: detaches,
      detachesAfterClose: detaches - detachesBeforeClose,
      eventsPerNavFirst: eventsPerNav[0] ?? 0,
      eventsPerNavLast: eventsPerNav[eventsPerNav.length - 1] ?? 0,
      eventsPerNavSeries: eventsPerNav,
      sessionsSeries: sessionsPerNav,
      topInboundEvents: [...st.counters.eventsByMethod.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6),
    };
    st.stop();
    return result;
  } finally {
    site.close();
    chrome.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await run({
    navigationWatcher: process.argv.includes('--watcher'),
    rounds: Number(process.env['HARNESS_ROUNDS'] ?? 25),
  });
  console.log(JSON.stringify(result, null, 2));
}
