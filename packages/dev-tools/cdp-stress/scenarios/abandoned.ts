import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack, errKind, harnessCdpTimeoutMs, resetUnhandled, unhandled } from '../stack.js';

const CALLER_GIVE_UP_MS = 2000;

const NEVER_ARRIVES_MS = 600_000;

export type AbandonedVariant = 'orphaned' | 'signal' | 'signal-unresponsive';

export interface AbandonedVariantResult {
  variant: AbandonedVariant;

  stuckIn: 'load-event-wait' | 'page-navigate-round-trip';
  unhandledRejections: string[];
  callerGaveUp: string;
  victimCommandWaitedMs: number;
  victimResult: unknown;
  abandonedGotoFinalOutcome: unknown;

  abandonedGotoSettledMs: number;

  lock: { queueDepth: number; totalWaitMs: number; acquisitions: number };

  followUpOnHungTabMs: number;
  followUpOnHungTabOk: boolean;
}

export interface AbandonedResult {
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

    const url = unresponsive
      ? `${site.url}/hang`
      : `${site.url}/page/hung?subdelay=${NEVER_ARRIVES_MS}`;
    const controller = new AbortController();

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

    if (signalled) controller.abort();

    const t0 = Date.now();
    let victimResult: unknown;
    try {
      victimResult = await b.withTab(victim, (page) => page.evaluate('document.title'));
    } catch (e) {
      victimResult = errKind(e);
    }
    const victimCommandWaitedMs = Date.now() - t0;

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
  const orphaned = await runVariant('orphaned');
  const signal = await runVariant('signal');
  const signalUnresponsive = await runVariant('signal-unresponsive');
  return { cdpTimeoutMs: harnessCdpTimeoutMs(), orphaned, signal, signalUnresponsive };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await run(), null, 2));
}
