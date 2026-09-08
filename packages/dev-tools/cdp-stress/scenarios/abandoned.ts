/**
 * Scenario 6 — abandoned command keeps the lock (background_after / exit 124).
 * The bash tool gives up on a command after `background_after`, but the JS
 * promise behind it keeps running and keeps the tab lock. A single `goto` to a
 * page that never loads blocks every later command on that tab for the full
 * `Page.loadEventFired` timeout, even though its caller moved on in 2s.
 *
 * Per-tab locking already contains the damage to the hung tab: the victim's
 * command on an unrelated tab completes immediately and the abandoned load
 * wait produces no unhandled rejection. This scenario measures what
 * COOPERATIVE CANCELLATION buys on top — getting the hung tab itself back — by
 * giving up in two ways:
 *
 * - `orphaned` — the caller just stops awaiting, which is all
 *   `background_after` could do before cooperative cancellation existed. The
 *   `goto` runs out its full 30 s load bound and the tab stays locked.
 * - `signal` — the caller aborts the `AbortSignal` it passed to `withTab`, the
 *   way `playwright-cli` now threads the bash tool's abort. The load wait
 *   rejects at once and the tab is usable again in milliseconds.
 *
 * A third run pins the documented LIMIT. Against `/hang`, which never answers
 * at all, the command is parked inside the `Page.navigate` round trip itself —
 * CDP has no cancel verb, so aborting cannot shorten it and the tab comes back
 * only when that request settles (its per-command CDP timeout). Cancellation
 * stops the NEXT step, never the one already on the wire.
 */
import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack, errKind, harnessCdpTimeoutMs, resetUnhandled, unhandled } from '../stack.js';

/** How long the caller waits before giving up, mirroring `background_after`. */
const CALLER_GIVE_UP_MS = 2000;

/** Longer than any run: the asset the hung page waits on never arrives. */
const NEVER_ARRIVES_MS = 600_000;

export type AbandonedVariant = 'orphaned' | 'signal' | 'signal-unresponsive';

export interface AbandonedVariantResult {
  variant: AbandonedVariant;
  /** Where the command is parked when the caller gives up. */
  stuckIn: 'load-event-wait' | 'page-navigate-round-trip';
  unhandledRejections: string[];
  callerGaveUp: string;
  victimCommandWaitedMs: number;
  victimResult: unknown;
  abandonedGotoFinalOutcome: unknown;
  /**
   * Milliseconds from "the caller gave up" to the abandoned `goto` promise
   * actually settling — how long the tab stayed locked for a command nobody
   * was reading. This is the number cooperative cancellation moves.
   */
  abandonedGotoSettledMs: number;
  /** Tab-lock stats for the hung tab once everything settled. */
  lock: { queueDepth: number; totalWaitMs: number; acquisitions: number };
  /**
   * A follow-up command on the ABANDONED tab, and how long it queued.
   *
   * `ok: false` on the unresponsive run is Chrome, not the bridge: that tab's
   * renderer is still parked on a request that never answers, so a probe on it
   * times out however promptly the lock came back.
   */
  followUpOnHungTabMs: number;
  followUpOnHungTabOk: boolean;
}

export interface AbandonedResult {
  /** Per-command CDP timeout in force, which bounds the unresponsive run. */
  cdpTimeoutMs: number | undefined;
  orphaned: AbandonedVariantResult;
  signal: AbandonedVariantResult;
  signalUnresponsive: AbandonedVariantResult;
}

async function runVariant(variant: AbandonedVariant): Promise<AbandonedVariantResult> {
  resetUnhandled();
  const chrome = await launchChrome();
  const site = await startSite();
  const unresponsive = variant === 'signal-unresponsive';
  const signalled = variant !== 'orphaned';
  try {
    const st = await buildStack(chrome.wsUrl);
    const b = st.browser;
    const hung = await b.createPage('about:blank');
    const victim = await b.createPage(`${site.url}/page/victim`);
    await new Promise((r) => setTimeout(r, 300));

    // Driver A: a goto that never finishes, whose caller gives up after 2s.
    // `/hang` never answers (stuck in Page.navigate); the subdelay page
    // commits at once but never fires `load` (stuck in the load wait).
    const url = unresponsive
      ? `${site.url}/hang`
      : `${site.url}/page/hung?subdelay=${NEVER_ARRIVES_MS}`;
    const controller = new AbortController();
    // Stamped where the promise actually settles, not where it is awaited: the
    // follow-up drivers below are awaited first, and on the unresponsive run
    // one of them blocks for its own CDP timeout.
    let gotoSettledAt = 0;
    const gotoPromise = b
      .withTab(
        hung,
        (page) => page.navigate(url),
        signalled ? { signal: controller.signal } : undefined
      )
      .catch((e: unknown) => errKind(e))
      .then((outcome) => {
        gotoSettledAt = Date.now();
        return outcome;
      });
    const callerGaveUp = await Promise.race([
      gotoPromise,
      new Promise<string>((r) =>
        setTimeout(() => r('caller-abandoned-after-2s'), CALLER_GIVE_UP_MS)
      ),
    ]);
    const gaveUpAt = Date.now();
    // The abort IS the giving up — same moment the orphaning caller walks away.
    if (signalled) controller.abort();

    // Driver B: a trivial command on ANOTHER tab (the per-tab locking property).
    const t0 = Date.now();
    let victimResult: unknown;
    try {
      victimResult = await b.withTab(victim, (page) => page.evaluate('document.title'));
    } catch (e) {
      victimResult = errKind(e);
    }
    const victimCommandWaitedMs = Date.now() - t0;

    // Driver C: a command on the ABANDONED tab — what the released lock buys.
    const t1 = Date.now();
    let followUpOnHungTabOk = true;
    try {
      await b.withTab(hung, (page) => page.evaluate('1 + 1'));
    } catch {
      followUpOnHungTabOk = false;
    }
    const followUpOnHungTabMs = Date.now() - t1;

    const abandonedGotoFinalOutcome = await gotoPromise;
    const abandonedGotoSettledMs = gotoSettledAt - gaveUpAt;
    // Give a late rejection from the abandoned load wait a chance to surface.
    await new Promise((r) => setTimeout(r, 250));
    const result: AbandonedVariantResult = {
      variant,
      stuckIn: unresponsive ? 'page-navigate-round-trip' : 'load-event-wait',
      unhandledRejections: unhandled(),
      callerGaveUp: String(callerGaveUp),
      victimCommandWaitedMs,
      victimResult,
      abandonedGotoFinalOutcome,
      abandonedGotoSettledMs,
      lock: b.getTabLockStats(hung),
      followUpOnHungTabMs,
      followUpOnHungTabOk,
    };
    st.stop();
    return result;
  } finally {
    site.close();
    chrome.kill();
  }
}

export async function run(): Promise<AbandonedResult> {
  // Sequential, each on its own Chrome: the runs differ only in how the caller
  // gives up, so they must not share a bridge whose lock one of them is
  // deliberately holding.
  const orphaned = await runVariant('orphaned');
  const signal = await runVariant('signal');
  const signalUnresponsive = await runVariant('signal-unresponsive');
  return { cdpTimeoutMs: harnessCdpTimeoutMs(), orphaned, signal, signalUnresponsive };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await run(), null, 2));
}
