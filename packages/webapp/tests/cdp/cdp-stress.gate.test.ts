/**
 * Live-browser gates for the CDP bridge stress harness
 * (`packages/dev-tools/cdp-stress/`).
 *
 * Each `it` turns one row of the harness's `DIAGNOSIS.md` § Validation table
 * into an assertion, at the thresholds stated there. The scenarios stay
 * runnable standalone for exploration — this file only pins the pass criteria.
 *
 * GATING. Like the `iframe integration` suite in
 * tests/shell/supplemental-commands/playwright-command.test.ts, this needs a
 * real Chrome, so it is opt-in. Unlike that suite it deliberately does NOT
 * enable itself on `CI`: on today's `main` these gates FAIL by design — they
 * describe the bridge's behaviour AFTER the per-tab session registry and
 * per-tab locking land (DIAGNOSIS.md § Phase 1/2). Once the fixes are in, flip
 * this on by adding `Boolean(process.env['CI'])` to `stressEnabled` below, the
 * same shape the iframe suite uses.
 *
 * Locally:  SLICC_TEST_CDP_STRESS=1 npx vitest run packages/webapp/tests/cdp/cdp-stress.gate.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { chromeBinary } from '../../../dev-tools/cdp-stress/chrome.js';
import { run as runAbandoned } from '../../../dev-tools/cdp-stress/scenarios/abandoned.js';
import { run as runFanout } from '../../../dev-tools/cdp-stress/scenarios/fanout.js';
import { run as runLoadBleed } from '../../../dev-tools/cdp-stress/scenarios/load-bleed.js';
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

/** Sliding-window bounds for the "cumulative lock wait ~ 0" gate. */
const MAX_LOCK_WAIT_P95_MS = 250;
const MAX_LOCK_WAIT_TOTAL_MS = 2000;

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

  it('load-bleed: goto waits for its own tab, not a sibling load event', {
    timeout: 180_000,
  }, async () => {
    const r = await runLoadBleed();
    expect(r.bleed.elapsedMs).toBeGreaterThanOrEqual(MIN_TARGET_LOAD_MS);
    expect(r.bleed.observedAfterGoto.readyState).toBe('complete');
    expect(r.reproduced).toBe(false);
  });

  it('stale-proxy: a Chrome-leg drop self-heals under both proxy policies', {
    timeout: 300_000,
  }, async () => {
    const r = await runStaleProxy();
    for (const policy of ['swift', 'node'] as const) {
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
    expect(eight.lock.waitPerGoto.p95).toBeLessThanOrEqual(MAX_LOCK_WAIT_P95_MS);
    expect(eight.lock.totalWaitMs).toBeLessThanOrEqual(MAX_LOCK_WAIT_TOTAL_MS);
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
