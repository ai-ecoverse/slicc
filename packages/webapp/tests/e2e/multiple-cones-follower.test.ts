import followerFixture from './fake-llm/fixtures/multiple-cones-follower.json' with {
  type: 'json',
};
import { resetFakeLlm } from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
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

test.describe('multiple cones — leader + follower', () => {
  test.describe.configure({ retries: 1 });

  let current: BrowserDiagnostics | null = null;

  test.beforeEach(async () => {
    current = null;
    await resetFakeLlm();
  });

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
      const leaderStrip = await switcherLabels(page);
      expect(leaderStrip).toEqual([PRIMARY_CONE_LABEL, 'reviewer']);
      await expect
        .poll(() => switcherLabels(follower.page), { timeout: 60_000 })
        .toEqual(leaderStrip);

      await selectTab(page, PRIMARY_CONE_LABEL);
      await expect.poll(() => activeTabLabel(page), { timeout: 30_000 }).toBe(PRIMARY_CONE_LABEL);
      await expect.poll(() => modelPill(page), { timeout: 30_000 }).toBe(CONE_MODEL);

      await selectTab(follower.page, 'reviewer');
      await expect.poll(() => activeTabLabel(follower.page), { timeout: 30_000 }).toBe('reviewer');
      await followerSelectModel(follower.page, CONE_MODEL_ALT);

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

  test('a scoop is a read-only transcript on both sides', async ({ page, browser }) => {
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
      await selectTab(page, 'helper');
      await expect.poll(() => activeTabLabel(page), { timeout: 30_000 }).toBe('helper');
      expect(await composerIsUsable(page)).toBe(false);

      await selectTab(follower.page, 'helper');
      await expect.poll(() => activeTabLabel(follower.page), { timeout: 60_000 }).toBe('helper');
      expect(await composerIsUsable(follower.page)).toBe(false);

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
