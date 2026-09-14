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
      const title = () => st.browser.withTab(tab, (page) => page.evaluate('document.title'));
      const before = await timed(title);
      proxy.dropChromeLeg();
      await new Promise((r) => setTimeout(r, SETTLE_AFTER_DROP_MS));
      const pageClientState = st.pageClient.state;
      const workerTransportState = st.transport.state;
      const afterDrop = await timed(title);
      const afterDrop2 = await timed(title);

      const otherTab = await timed(() =>
        st.browser.withTab(other, (page) => page.evaluate('document.title'))
      );
      const backAgain = await timed(title);

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
