/**
 * Live-browser gates for the CDP bridge stress harness
 * (`packages/dev-tools/cdp-stress/`).
 *
 * Each `it` turns one row of the Validation table in the #2417 diagnosis
 * (https://github.com/ai-ecoverse/slicc/issues/2417#issuecomment-5567295502)
 * into an assertion, at the thresholds stated there. The scenarios stay
 * runnable standalone for exploration — this file only pins the pass criteria.
 *
 * GATING. Like the `iframe integration` suite in
 * tests/shell/supplemental-commands/playwright-command.test.ts, this needs a
 * real Chrome, so it is opt-in. Unlike that suite it deliberately does NOT
 * enable itself on `CI`: a fan-out run needs 17 live tabs and a compositor
 * that can actually produce frames, which a shared runner does not reliably
 * have. Run it locally when touching `cdp/`.
 *
 * Locally:  SLICC_TEST_CDP_STRESS=1 npx vitest run packages/webapp/tests/cdp/cdp-stress.gate.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeBinary } from '../../../dev-tools/cdp-stress/chrome.js';
import { run as runAbandoned } from '../../../dev-tools/cdp-stress/scenarios/abandoned.js';
import { run as runFanout } from '../../../dev-tools/cdp-stress/scenarios/fanout.js';
import { run as runLoadBleed } from '../../../dev-tools/cdp-stress/scenarios/load-bleed.js';
import { run as runOwnTab } from '../../../dev-tools/cdp-stress/scenarios/own-tab.js';
import { run as runSessionLeak } from '../../../dev-tools/cdp-stress/scenarios/session-leak.js';
import { run as runStaleProxy } from '../../../dev-tools/cdp-stress/scenarios/stale-proxy.js';

const stressEnabled = process.env['SLICC_TEST_CDP_STRESS'] === '1';
const describeStress = chromeBinary() && stressEnabled ? describe : describe.skip;

/**
 * Shortened per-command CDP timeout so the node-policy stale run finishes in
 * seconds. Production is 30s; anything at or above `NO_TIMEOUT_MS` in a
 * measured step means the command timed out rather than failed fast.
 */
const CDP_TIMEOUT_MS = 8000;
const NO_TIMEOUT_MS = 5000;

/**
 * Bounds for the "distinct tabs do not wait on each other" gate. These are
 * PER-TAB lock waits (a sibling driving the same tab).
 */
const MAX_TAB_WAIT_P95_MS = 250;
const MAX_TAB_WAIT_TOTAL_MS = 2000;

/**
 * Bound on BRIDGE-WIDE waiting summed across the whole fan-out.
 *
 * Session-explicit handlers left exactly one bridge-wide step in a command's
 * path — attaching, which moves the cursor and (for a tray target) swaps the
 * transport. That is two round trips the first time a tab is touched and a
 * synchronous cursor move afterwards, so this does NOT scale with fan-out.
 *
 * The margin is enormous, which is the point: measured on one machine, this
 * same 8-driver run accumulated **3,491,200 ms** of bridge-wide waiting when a
 * command body held the bridge end to end, and **2,066 ms** once it stopped.
 * The bound is set above the latter with room for a loaded machine rather than
 * anywhere near the former — a regression here is three orders of magnitude,
 * not a few percent.
 */
const MAX_BRIDGE_WAIT_TOTAL_MS = 5000;

/** `goto` must wait for the target tab's own load (the slow asset is 3s). */
const MIN_TARGET_LOAD_MS = 2500;

const SESSION_LEAK_TABS = 4;
const SESSION_LEAK_ROUNDS = 12;
const FANOUT_ITERATIONS = 4;

describeStress('cdp bridge stress gates', () => {
  beforeAll(() => {
    process.env['HARNESS_CDP_TIMEOUT_MS'] = String(CDP_TIMEOUT_MS);
  });

  it('session-leak: one session per tab, detach on close, flat event cost per navigation', {
    timeout: 240_000,
  }, async () => {
    const r = await runSessionLeak({ tabs: SESSION_LEAK_TABS, rounds: SESSION_LEAK_ROUNDS });
    // A tab switch must reuse the target's session instead of minting one.
    expect(r.sessionsMinted).toBe(SESSION_LEAK_TABS);
    // Closing a tab releases its session.
    expect(r.detachesAfterClose).toBeGreaterThanOrEqual(1);
    // No leaked Page-enabled sessions ⇒ one navigation costs the same in the
    // last round as in the first (allow 50% for renderer noise).
    expect(r.eventsPerNavLast).toBeLessThanOrEqual(Math.ceil(r.eventsPerNavFirst * 1.5));
  });

  it("own-tab: SLICC's own tab costs no WebSocket events and still yields its handoff", {
    timeout: 180_000,
  }, async () => {
    const r = await runOwnTab();
    // The whole point: no Network domain on the app tab ⇒ Chrome never reports
    // that tab's /cdp socket back at us (issue #2417 follow-up 3).
    expect(r.guarded.webSocketFrameEvents).toBe(0);
    // Control — the same run without `isOwnTab` does see them, so a zero above
    // means the guard worked and not that the stand-in tab went quiet.
    expect(r.unguarded.webSocketFrameEvents).toBeGreaterThan(0);
    // And the tab navigating itself out of the app URL is armed early enough
    // that the handoff Link on THAT response is still observed.
    expect(r.guarded.navigateVerbs).toEqual(['handoff']);
    expect(r.guarded.navigateInstructions).toEqual(['armed in time']);
  });

  it('load-bleed: goto waits for its own tab, not a sibling load event', {
    timeout: 180_000,
  }, async () => {
    const r = await runLoadBleed();
    expect(r.bleed.elapsedMs).toBeGreaterThanOrEqual(MIN_TARGET_LOAD_MS);
    expect(r.bleed.observedAfterGoto.readyState).toBe('complete');
    expect(r.reproduced).toBe(false);
  });

  it('stale-proxy: a Chrome-leg drop self-heals under the shipped and legacy proxies', {
    timeout: 300_000,
  }, async () => {
    // 'swift' / 'node' model the shipped proxies (reconnect + 4002 reset);
    // 'legacy-swift' models an older Sliccstart that reconnects silently, so
    // the bridge's own stale-session self-heal is what has to carry it.
    const r = await runStaleProxy();
    for (const policy of ['swift', 'node', 'legacy-swift'] as const) {
      const p = r[policy];
      expect(p, `${policy} policy ran`).toBeDefined();
      if (!p) continue;
      expect(p.before.ok, `${policy}: baseline command works`).toBe(true);
      // Either self-heal, or one clear error — never a full-timeout hang.
      expect(p.afterDrop.error, `${policy}: first command after drop`).not.toBe('timeout');
      expect(p.afterDrop.ms, `${policy}: first command after drop`).toBeLessThan(NO_TIMEOUT_MS);
      expect(p.afterDrop2.ok, `${policy}: retry after drop succeeds`).toBe(true);
      expect(p.afterDrop2.ms, `${policy}: retry after drop`).toBeLessThan(NO_TIMEOUT_MS);
    }
  });

  it('fanout 8: distinct tabs do not contend, and wall-clock scales with ops', {
    timeout: 600_000,
  }, async () => {
    const one = await runFanout({ drivers: 1, iterations: FANOUT_ITERATIONS });
    const eight = await runFanout({ drivers: 8, iterations: FANOUT_ITERATIONS });
    expect(eight.wrongTabResults).toBe(0);
    expect(eight.errors).toEqual({});
    expect(eight.lock.waitPerGoto.p95).toBeLessThanOrEqual(MAX_TAB_WAIT_P95_MS);
    expect(eight.lock.tabWaitMs ?? eight.lock.totalWaitMs).toBeLessThanOrEqual(
      MAX_TAB_WAIT_TOTAL_MS
    );
    // Distinct tabs no longer take turns on the bridge either: a command body
    // holds nothing bridge-wide, so only the attaches can queue here.
    expect(eight.lock.bridgeWaitMs ?? 0).toBeLessThanOrEqual(MAX_BRIDGE_WAIT_TOTAL_MS);
    const scaledBudget = 1.5 * one.driversWallMs * (eight.ops / one.ops);
    expect(eight.driversWallMs).toBeLessThanOrEqual(scaledBudget);
  });

  it('fanout --poison: a hung navigation only stalls its own tab', {
    timeout: 600_000,
  }, async () => {
    const clean = await runFanout({ drivers: 4, iterations: FANOUT_ITERATIONS });
    const poisoned = await runFanout({
      drivers: 4,
      iterations: FANOUT_ITERATIONS,
      poison: true,
    });
    // "within 10% of the no-poison run", with a small absolute floor so a
    // sub-second baseline does not make the bound pure jitter.
    const budget = Math.max(clean.driversWallMs * 1.1, clean.driversWallMs + 500);
    expect(poisoned.driversWallMs).toBeLessThanOrEqual(budget);
    expect(poisoned.wrongTabResults).toBe(0);
  });

  it('abandoned: giving up on a goto frees the lock and rejects nothing', {
    timeout: 240_000,
  }, async () => {
    const r = await runAbandoned();
    expect(r.victimCommandWaitedMs).toBeLessThan(1000);
    expect(r.unhandledRejections).toEqual([]);
  });
});
