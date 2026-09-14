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

const CDP_TIMEOUT_MS = 8000;
const NO_TIMEOUT_MS = 5000;

const MAX_TAB_WAIT_P95_MS = 250;
const MAX_TAB_WAIT_TOTAL_MS = 2000;

const MAX_BRIDGE_WAIT_TOTAL_MS = 5000;

const MIN_TARGET_LOAD_MS = 2500;

const ABORT_SETTLE_BUDGET_MS = 3000;

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

    expect(r.sessionsMinted).toBe(SESSION_LEAK_TABS);

    expect(r.detachesAfterClose).toBeGreaterThanOrEqual(1);

    expect(r.eventsPerNavLast).toBeLessThanOrEqual(Math.ceil(r.eventsPerNavFirst * 1.5));
  });

  it("own-tab: SLICC's own tab costs no WebSocket events and still yields its handoff", {
    timeout: 180_000,
  }, async () => {
    const r = await runOwnTab();

    expect(r.guarded.webSocketFrameEvents).toBe(0);

    expect(r.unguarded.webSocketFrameEvents).toBeGreaterThan(0);

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
    const r = await runStaleProxy();
    for (const policy of ['swift', 'node', 'legacy-swift'] as const) {
      const p = r[policy];
      expect(p, `${policy} policy ran`).toBeDefined();
      if (!p) continue;
      expect(p.before.ok, `${policy}: baseline command works`).toBe(true);

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

    const budget = Math.max(clean.driversWallMs * 1.1, clean.driversWallMs + 500);
    expect(poisoned.driversWallMs).toBeLessThanOrEqual(budget);
    expect(poisoned.wrongTabResults).toBe(0);
  });

  it('abandoned: giving up on a goto frees the lock and rejects nothing', {
    timeout: 600_000,
  }, async () => {
    const r = await runAbandoned();
    for (const v of [r.orphaned, r.signal, r.signalUnresponsive]) {
      expect(v.victimCommandWaitedMs, `${v.variant}: victim tab`).toBeLessThan(1000);
      expect(v.unhandledRejections, `${v.variant}: unhandled`).toEqual([]);
    }

    expect(r.signal.abandonedGotoFinalOutcome).toBe('aborted');
    expect(r.signal.abandonedGotoSettledMs).toBeLessThan(ABORT_SETTLE_BUDGET_MS);
    expect(r.signal.followUpOnHungTabMs).toBeLessThan(ABORT_SETTLE_BUDGET_MS);
    expect(r.signal.followUpOnHungTabOk).toBe(true);

    expect(r.orphaned.abandonedGotoSettledMs).toBeGreaterThan(ABORT_SETTLE_BUDGET_MS);

    expect(r.signalUnresponsive.stuckIn).toBe('page-navigate-round-trip');
    expect(r.cdpTimeoutMs).toBe(CDP_TIMEOUT_MS);
    expect(r.signalUnresponsive.abandonedGotoSettledMs).toBeLessThan(CDP_TIMEOUT_MS * 2);
  });
});
