/**
 * Scenario 3 — "the CDP connection has gone stale".
 * The proxy's Chrome leg closes (production logs: `messageTooLarge`, code nil).
 * Chrome discards every session on that connection. Neither proxy tells the
 * webapp; `BrowserAPI` keeps `sessionId`/`attachedTargetId`, short-circuits
 * "already attached", and every command on that tab fails from then on.
 *   node policy  → frames dropped, each command waits the full CDP timeout
 *   swift policy → Chrome reconnected, commands fail fast with session-not-found
 * Switching to ANOTHER tab and back (or opening a new tab) mints a fresh session
 * and "fixes" it — which is exactly the workaround agents discover.
 *
 * Post-fix expectation: the first command after the drop either self-heals or
 * fails once with a clear error and the retry succeeds — never a full-timeout
 * hang, under either proxy policy.
 */
import { launchChrome } from '../chrome.js';
import { type ProxyPolicy, startProxy } from '../proxy.js';
import { startSite } from '../site.js';
import { buildStack, type Timed, timed } from '../stack.js';

export interface StalePolicyResult {
  before: Timed<unknown>;
  transportStatesAfterDrop: { pageClient: string; workerProxy: string };
  afterDrop: Timed<unknown>;
  afterDrop2: Timed<unknown>;
  workaroundTouchOtherTab: Timed<unknown>;
  workaroundBackToOriginalTab: Timed<unknown>;
  afterPageReconnect: Timed<unknown>;
  proxyStats: { chromeOpens: number; droppedFrames: number; relayed: number };
  sessionsMinted: number;
}

export type StaleProxyResult = Partial<Record<ProxyPolicy, StalePolicyResult>>;

/** Swift reconnects its Chrome leg after ~1s; settle past that before probing. */
const SETTLE_AFTER_DROP_MS = 1500;

export async function run(opts: { policies?: ProxyPolicy[] } = {}): Promise<StaleProxyResult> {
  const policies = opts.policies ?? (['swift', 'node', 'legacy-swift'] as ProxyPolicy[]);
  const chrome = await launchChrome();
  const site = await startSite();
  const out: StaleProxyResult = {};
  try {
    for (const policy of policies) {
      const proxy = await startProxy(chrome.wsUrl, policy);
      const st = await buildStack(proxy.url);
      const tab = await st.browser.createPage(`${site.url}/page/one`);
      const other = await st.browser.createPage(`${site.url}/page/two`);
      await new Promise((r) => setTimeout(r, 300));
      const title = () => st.browser.withTab(tab, () => st.browser.evaluate('document.title'));
      const before = await timed(title);
      proxy.dropChromeLeg();
      await new Promise((r) => setTimeout(r, SETTLE_AFTER_DROP_MS));
      const pageClientState = st.pageClient.state;
      const workerTransportState = st.transport.state;
      const afterDrop = await timed(title);
      const afterDrop2 = await timed(title);
      // Workaround 1: touch another tab then come back (forces re-attach).
      const otherTab = await timed(() =>
        st.browser.withTab(other, () => st.browser.evaluate('document.title'))
      );
      const backAgain = await timed(title);
      // Workaround 2: the page-side BrowserAPI's refresh loop calls
      // ensureConnected() — does that help the worker-side session?
      await st.reconnectPage();
      const afterPageReconnect = await timed(title);
      out[policy] = {
        before,
        transportStatesAfterDrop: {
          pageClient: pageClientState,
          workerProxy: workerTransportState,
        },
        afterDrop,
        afterDrop2,
        workaroundTouchOtherTab: otherTab,
        workaroundBackToOriginalTab: backAgain,
        afterPageReconnect,
        proxyStats: { ...proxy.stats },
        sessionsMinted: st.sessions.length,
      };
      st.stop();
      proxy.close();
    }
    return out;
  } finally {
    site.close();
    chrome.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await run(), null, 2));
}
