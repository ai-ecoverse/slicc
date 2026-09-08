/**
 * Scenario 6 — abandoned command keeps the lock (background_after / exit 124).
 * The bash tool gives up on a command after `background_after`, but the JS
 * promise behind it keeps running and keeps the global tab lock. A single
 * `goto` to a page that never loads blocks EVERY other driver for the full
 * `Page.loadEventFired` timeout, even though its caller moved on in 2s.
 *
 * Post-fix expectation: the victim's command on an unrelated tab completes
 * immediately, and the abandoned load wait produces no unhandled rejection.
 */
import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack, errKind, resetUnhandled, unhandled } from '../stack.js';

/** How long the caller waits before giving up, mirroring `background_after`. */
const CALLER_GIVE_UP_MS = 2000;

export interface AbandonedResult {
  unhandledRejections: string[];
  callerGaveUp: string;
  victimCommandWaitedMs: number;
  victimResult: unknown;
  abandonedGotoFinalOutcome: unknown;
  lock: { queueDepth: number; totalWaitMs: number; acquisitions: number };
}

export async function run(): Promise<AbandonedResult> {
  resetUnhandled();
  const chrome = await launchChrome();
  const site = await startSite();
  try {
    const st = await buildStack(chrome.wsUrl);
    const b = st.browser;
    const hung = await b.createPage('about:blank');
    const victim = await b.createPage(`${site.url}/page/victim`);
    await new Promise((r) => setTimeout(r, 300));
    // Driver A: goto /hang, caller abandons after 2s (like background_after).
    const gotoPromise = b
      .withTab(hung, (page) => page.navigate(`${site.url}/hang`))
      .catch((e: unknown) => errKind(e));
    const callerGaveUp = await Promise.race([
      gotoPromise,
      new Promise<string>((r) =>
        setTimeout(() => r('caller-abandoned-after-2s'), CALLER_GIVE_UP_MS)
      ),
    ]);
    // Driver B: a trivial command on another tab, right after A's caller gave up.
    const t0 = Date.now();
    let victimResult: unknown;
    try {
      victimResult = await b.withTab(victim, (page) => page.evaluate('document.title'));
    } catch (e) {
      victimResult = errKind(e);
    }
    const victimCommandWaitedMs = Date.now() - t0;
    const abandonedGotoFinalOutcome = await gotoPromise;
    // Give a late rejection from the abandoned load wait a chance to surface.
    await new Promise((r) => setTimeout(r, 250));
    const result: AbandonedResult = {
      unhandledRejections: unhandled(),
      callerGaveUp: String(callerGaveUp),
      victimCommandWaitedMs,
      victimResult,
      abandonedGotoFinalOutcome,
      lock: b.getTabLockStats(),
    };
    st.stop();
    return result;
  } finally {
    site.close();
    chrome.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await run(), null, 2));
}
