/**
 * Scenario 2 — cross-tab load-event bleed.
 * `BrowserAPI.navigate()` awaits `client.once('Page.loadEventFired')` with NO
 * sessionId filter. Any other attached session (leaked or live) whose page
 * fires `load` resolves the wait early, so `goto` returns before the target
 * tab has loaded and the next snapshot/screenshot sees the OLD page.
 *
 * Post-fix expectation: the wait is session-scoped, so `goto` returns only
 * after the target tab's own load — ~3s here — with `readyState: complete`.
 */
import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack } from '../stack.js';

/** The target page's slow <img> delays its own `load` by this much. */
const SLOW_ASSET_MS = 3000;

export interface LoadBleedMeasurement {
  label: string;
  elapsedMs: number;
  error: string | null;
  loadEventsDuringGoto: number;
  reloaderHits: number;
  observedAfterGoto: { title: string; readyState: string; href: string };
}

export interface LoadBleedResult {
  control: LoadBleedMeasurement;
  bleed: LoadBleedMeasurement;
  reproduced: boolean;
}

export async function run(): Promise<LoadBleedResult> {
  const chrome = await launchChrome();
  const site = await startSite();
  try {
    const st = await buildStack(chrome.wsUrl);
    const measure = async (label: string, withNoise: boolean): Promise<LoadBleedMeasurement> => {
      const a = await st.browser.createPage(`${site.url}/page/start`);
      await new Promise((r) => setTimeout(r, 300));
      if (withNoise) {
        const b = await st.browser.createPage(`${site.url}/reloader?every=300`);
        await new Promise((r) => setTimeout(r, 300));
        // A sibling driver touched tab B once — leaks a Page-enabled session.
        await st.browser.withTab(b, (page) => page.evaluate('1'));
      }
      const loadsBefore = st.counters.eventsByMethod.get('Page.loadEventFired') ?? 0;
      const t0 = Date.now();
      let err: string | null = null;
      try {
        await st.browser.withTab(a, (page) =>
          page.navigate(`${site.url}/page/slow?subdelay=${SLOW_ASSET_MS}`)
        );
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      const elapsedMs = Date.now() - t0;
      const seen = await st.browser.withTab(a, (page) =>
        page.evaluate(
          'JSON.stringify({title: document.title, readyState: document.readyState, href: location.href})'
        )
      );
      return {
        label,
        elapsedMs,
        error: err,
        loadEventsDuringGoto:
          (st.counters.eventsByMethod.get('Page.loadEventFired') ?? 0) - loadsBefore,
        reloaderHits: site.hits.get('/reloader') ?? 0,
        observedAfterGoto: JSON.parse(String(seen)),
      };
    };
    const control = await measure('control (no sibling activity)', false);
    const bleed = await measure('sibling tab reloading every 300ms', true);
    st.stop();
    return {
      control,
      bleed,
      reproduced: bleed.elapsedMs < 2500 && bleed.observedAfterGoto.readyState !== 'complete',
    };
  } finally {
    site.close();
    chrome.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await run(), null, 2));
}
