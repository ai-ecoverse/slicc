import { launchChrome } from '../chrome.js';
import { startProxy } from '../proxy.js';
import { startSite } from '../site.js';
import { buildStack, type Timed, timed } from '../stack.js';

export interface StaleWorkerHopResult {
  before: Timed<unknown>;
  statesAfterKill: { pageClient: string; workerProxy: string };
  whilePageDown: Timed<unknown>;
  statesAfterPageReconnect: { pageClient: string; workerProxy: string };
  afterPageReconnect: Timed<unknown>;
  afterPageReconnect2: Timed<unknown>;
  onNewTab: Timed<unknown>;
  backOnOld: Timed<unknown>;
}

export async function run(): Promise<StaleWorkerHopResult> {
  const chrome = await launchChrome();
  const site = await startSite();
  try {
    const proxy = await startProxy(chrome.wsUrl, 'node');
    const st = await buildStack(proxy.url);
    const tab = await st.browser.createPage(`${site.url}/page/one`);
    await new Promise((r) => setTimeout(r, 300));
    const title = () => st.browser.withTab(tab, (page) => page.evaluate('document.title'));
    const before = await timed(title);
    proxy.killClient();
    await new Promise((r) => setTimeout(r, 200));
    const statesAfterKill = { pageClient: st.pageClient.state, workerProxy: st.transport.state };
    const whilePageDown = await timed(title);
    await st.reconnectPage();
    const statesAfterPageReconnect = {
      pageClient: st.pageClient.state,
      workerProxy: st.transport.state,
    };
    const afterPageReconnect = await timed(title);
    const afterPageReconnect2 = await timed(title);
    const newTab = await st.browser.createPage(`${site.url}/page/fresh`);
    await new Promise((r) => setTimeout(r, 300));
    const onNewTab = await timed(() =>
      st.browser.withTab(newTab, (page) => page.evaluate('document.title'))
    );
    const backOnOld = await timed(title);
    st.stop();
    proxy.close();
    return {
      before,
      statesAfterKill,
      whilePageDown,
      statesAfterPageReconnect,
      afterPageReconnect,
      afterPageReconnect2,
      onNewTab,
      backOnOld,
    };
  } finally {
    site.close();
    chrome.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await run(), null, 2));
}
