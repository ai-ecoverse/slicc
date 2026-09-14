import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack } from '../stack.js';

export interface SessionLeakResult {
  navigationWatcher: boolean;

  leaderTab: boolean;

  skipOwnTab: boolean;

  webSocketFrameEvents: number;
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

  leaderTab?: boolean;

  skipOwnTab?: boolean;
}

export async function run(opts: SessionLeakOptions = {}): Promise<SessionLeakResult> {
  const tabs = opts.tabs ?? 4;
  const rounds = opts.rounds ?? 25;
  const chrome = await launchChrome();
  const site = await startSite();
  try {
    const leaderUrl = `${site.url}/leader`;
    const st = await buildStack(chrome.wsUrl, {
      navigationWatcher: opts.navigationWatcher,
      ...(opts.skipOwnTab ? { ownTabUrl: leaderUrl } : {}),
    });

    if (opts.leaderTab) {
      await st.transport.send('Target.createTarget', { url: leaderUrl });
      await new Promise((r) => setTimeout(r, 500));
    }
    const ids: string[] = [];
    for (let i = 0; i < tabs; i++) ids.push(await st.browser.createPage(`${site.url}/page/t${i}`));
    await new Promise((r) => setTimeout(r, 500));

    const eventsPerNav: number[] = [];
    const sessionsPerNav: number[] = [];
    for (let r = 0; r < rounds; r++) {
      for (let t = 0; t < tabs; t++) {
        await st.browser.withTab(ids[t] as string, (page) => page.evaluate('document.title'));
      }

      const before = st.counters.eventsIn;
      await st.browser.withTab(ids[0] as string, (page) =>
        page.navigate(`${site.url}/page/probe-${r}`)
      );
      await new Promise((res) => setTimeout(res, 150));
      eventsPerNav.push(st.counters.eventsIn - before);
      sessionsPerNav.push(st.sessions.length);
    }

    const detachesBeforeClose = st.counters.byMethod.get('Target.detachFromTarget') ?? 0;
    await st.browser.closePage(ids[tabs - 1] as string);
    await new Promise((r) => setTimeout(r, 200));
    const detaches = st.counters.byMethod.get('Target.detachFromTarget') ?? 0;
    const wsFrames =
      (st.counters.eventsByMethod.get('Network.webSocketFrameSent') ?? 0) +
      (st.counters.eventsByMethod.get('Network.webSocketFrameReceived') ?? 0);
    const result: SessionLeakResult = {
      navigationWatcher: Boolean(opts.navigationWatcher),
      leaderTab: Boolean(opts.leaderTab),
      skipOwnTab: Boolean(opts.skipOwnTab),
      webSocketFrameEvents: wsFrames,
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
    leaderTab: process.argv.includes('--leader-tab'),
    skipOwnTab: process.argv.includes('--skip-own-tab'),
    rounds: Number(process.env['HARNESS_ROUNDS'] ?? 25),
  });
  console.log(JSON.stringify(result, null, 2));
}
