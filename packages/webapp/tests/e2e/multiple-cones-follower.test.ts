// packages/webapp/tests/e2e/multiple-cones-follower.test.ts
/**
 * Two-instance multiple-cones E2E (#2313, part of #1666): a leader with the
 * fake LLM and a follower joined through a REAL tray hub — the harness's own
 * `wrangler dev` of `packages/cloudflare-worker`, Durable Objects and all.
 * Nothing about the tray is stubbed; the only fake in the picture is the model
 * provider.
 *
 * What the follower is here to prove:
 *   - the cone tabs and their ORDER mirror the leader (`orderForSwitcher` on
 *     one side, `toFollowerSwitcherScoops` on the other — two independent
 *     implementations of the same rule, which is exactly why it needs a test);
 *   - a follower changes the model of the cone IT is looking at, while the
 *     leader sits in another cone, and only that cone moves (#2310);
 *   - a scoop is a read-only transcript on BOTH sides (#2312).
 *
 * See `two-instance-helpers.ts` for the topology and
 * `.agents/skills/cdp-smoke-test/tier3-multi-harness.md` for what this kind of
 * follower can and cannot do (no local CDP surface: never teleport-eligible).
 */

import { expect, test } from '@playwright/test';
import followerFixture from './fake-llm/fixtures/multiple-cones-follower.json' with {
  type: 'json',
};
import { resetFakeLlm } from './fake-llm-helpers.js';
import type { BrowserDiagnostics } from './two-instance-helpers.js';
import {
  activeTabLabel,
  bootMultiConeLeader,
  CONE_MODEL,
  CONE_MODEL_ALT,
  chat,
  composerIsUsable,
  createCone,
  expectReply,
  followerSelectModel,
  joinAsFollower,
  leaderJoinUrl,
  modelPill,
  PRIMARY_CONE_LABEL,
  selectTab,
  switcherLabels,
  TWO_INSTANCE_TEST_TIMEOUT_MS,
  watchBrowserDiagnostics,
} from './two-instance-helpers.js';

/**
 * Whether the read-only scoop view (#2312) has landed. Flip to `true` in the
 * PR that implements it — the spec below is already written against it.
 */
const READ_ONLY_SCOOP_VIEW = false;

test.describe('multiple cones — leader + follower', () => {
  // One retry, against the config's CI-wide `retries: 2`. Two runtimes and a
  // real tray make this the most expensive spec in the suite, and its ceiling
  // is 10 minutes — three attempts at that would be half the `e2e` job's whole
  // budget, starving the specs after it. A second attempt still absorbs a
  // genuine blip; a third only pays for the same failure twice more, and the
  // failure is now diagnostic (bounded steps + `expectReply` + captured console)
  // rather than a silent timeout, so re-rolling it buys nothing.
  test.describe.configure({ retries: 1 });

  /**
   * Diagnostics for the CURRENT test, dumped by the afterEach below.
   *
   * `diagnostics.annotate(err)` only fires for a thrown error; a Playwright
   * TEST TIMEOUT aborts the body instead, so the catch never runs and the
   * console tail — the only record of what the two runtimes were doing — is
   * lost. `afterEach` still runs after a timeout, which makes it the one place
   * that reports on the failure mode this spec actually suffers in CI.
   */
  let current: BrowserDiagnostics | null = null;

  test.beforeEach(async () => {
    current = null;
    await resetFakeLlm();
  });

  // Playwright REQUIRES the fixtures parameter to be a destructuring pattern
  // ("First argument must use the object destructuring pattern") and this hook
  // needs no fixture, so the empty pattern is the only shape that works.
  // biome-ignore lint/correctness/noEmptyPattern: see above
  test.afterEach(({}, testInfo) => {
    if (testInfo.status === 'passed' || testInfo.status === 'skipped') return;
    const tail = current?.entries.slice(-40).join('\n');
    console.log(
      `--- browser diagnostics for "${testInfo.title}" (${testInfo.status}) ---\n${
        tail || '(nothing captured)'
      }`
    );
  });

  test('follower mirrors the cone strip and drives one cone’s model', async ({ page, browser }) => {
    test.setTimeout(TWO_INSTANCE_TEST_TIMEOUT_MS);
    const diagnostics = watchBrowserDiagnostics(page, 'leader');
    current = diagnostics;
    await bootMultiConeLeader(page, { fixture: followerFixture, tray: true });

    await createCone(page, { name: 'reviewer', brief: 'review the docs' });
    await expectReply(page, 'Reviewer cone online.');

    const follower = await joinAsFollower(browser, await leaderJoinUrl(page));
    watchBrowserDiagnostics(follower.page, 'follower', diagnostics);
    try {
      // ── The strip mirrors, order and all ────────────────────────────
      // Two cones, no scoop: the mirror is what this spec is for, and every
      // extra agent turn is leader work a two-runtime spec pays for twice.
      // "The selected cone's scoops come next" is asserted leader-side in
      // `multiple-cones.test.ts`, where it costs one runtime.
      const leaderStrip = await switcherLabels(page);
      expect(leaderStrip).toEqual([PRIMARY_CONE_LABEL, 'reviewer']);
      await expect
        .poll(() => switcherLabels(follower.page), { timeout: 60_000 })
        .toEqual(leaderStrip);

      // ── Per-cone model (#2310) ──────────────────────────────────────
      // The leader sits in cone A; the follower is looking at cone B and
      // changes B's model. Only B moves.
      await selectTab(page, PRIMARY_CONE_LABEL);
      await expect.poll(() => activeTabLabel(page), { timeout: 30_000 }).toBe(PRIMARY_CONE_LABEL);
      await expect.poll(() => modelPill(page), { timeout: 30_000 }).toBe(CONE_MODEL);

      await selectTab(follower.page, 'reviewer');
      await expect.poll(() => activeTabLabel(follower.page), { timeout: 30_000 }).toBe('reviewer');
      await followerSelectModel(follower.page, CONE_MODEL_ALT);

      // Cone A — where the leader is standing — is untouched. Polling for a
      // change that must NOT happen would pass instantly, so wait for the
      // follower's pick to be visible on cone B first, then re-read A.
      await selectTab(page, 'reviewer');
      await expect.poll(() => modelPill(page), { timeout: 60_000 }).toBe(CONE_MODEL_ALT);
      await selectTab(page, PRIMARY_CONE_LABEL);
      await expect.poll(() => modelPill(page), { timeout: 30_000 }).toBe(CONE_MODEL);
    } catch (err) {
      throw diagnostics.annotate(err);
    } finally {
      await follower.close();
    }
  });

  /**
   * #2312 (read-only scoop view) is not implemented yet: `wc-live.ts` still
   * enables the composer for whatever unit is selected, scoop included, and
   * the follower mirrors that. The spec is written against the decided
   * behaviour and marked `fixme` so it FAILS the day someone flips it on
   * without meaning to, and turns green — by deleting one line — the day the
   * feature lands. Flip `READ_ONLY_SCOOP_VIEW` when #2312 merges.
   */
  test('a scoop is a read-only transcript on both sides', async ({ page, browser }) => {
    test.fixme(!READ_ONLY_SCOOP_VIEW, 'awaiting #2312 — read-only scoop view');
    test.setTimeout(TWO_INSTANCE_TEST_TIMEOUT_MS);
    const diagnostics = watchBrowserDiagnostics(page, 'leader');
    current = diagnostics;
    await bootMultiConeLeader(page, { fixture: followerFixture, tray: true });

    await createCone(page, { name: 'reviewer', brief: 'review the docs' });
    await expectReply(page, 'Reviewer cone online.');
    await chat(page, 'spawn a helper scoop', 'Helper scoop is ready.');

    const follower = await joinAsFollower(browser, await leaderJoinUrl(page));
    watchBrowserDiagnostics(follower.page, 'follower', diagnostics);
    try {
      // A scoop is a transcript, not a conversation: no composer to type into.
      await selectTab(page, 'helper');
      await expect.poll(() => activeTabLabel(page), { timeout: 30_000 }).toBe('helper');
      expect(await composerIsUsable(page)).toBe(false);

      await selectTab(follower.page, 'helper');
      await expect.poll(() => activeTabLabel(follower.page), { timeout: 60_000 }).toBe('helper');
      expect(await composerIsUsable(follower.page)).toBe(false);

      // …and the cone it belongs to still has one.
      await selectTab(page, 'reviewer');
      await expect.poll(() => activeTabLabel(page), { timeout: 30_000 }).toBe('reviewer');
      expect(await composerIsUsable(page)).toBe(true);
    } catch (err) {
      throw diagnostics.annotate(err);
    } finally {
      await follower.close();
    }
  });
});
