import followerFixture from './fake-llm/fixtures/multiple-cones-follower.json' with {
  type: 'json',
};
import { resetFakeLlm, submitUserMessage, waitForTurnComplete } from './fake-llm-helpers.js';
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

  test('rapid follower cone switching preserves the selected transcript', async ({
    page,
    browser,
  }) => {
    test.setTimeout(TWO_INSTANCE_TEST_TIMEOUT_MS);
    const diagnostics = watchBrowserDiagnostics(page, 'leader');
    current = diagnostics;
    const primaryReply = `PRIMARY-SNAPSHOT-${'p'.repeat(70_000)}`;
    const reviewerReply = `REVIEWER-SNAPSHOT-${'r'.repeat(70_000)}`;
    const fixture = {
      model: CONE_MODEL,
      models: [CONE_MODEL, CONE_MODEL_ALT],
      turns: [
        {
          whenUserMessageMatches: 'populate primary',
          content: primaryReply,
          contentChunkSize: 4096,
        },
        {
          whenUserMessageMatches: 'populate reviewer',
          content: reviewerReply,
          contentChunkSize: 4096,
        },
      ],
    };
    await bootMultiConeLeader(page, {
      fixture,
      tray: true,
    });
    await chat(page, 'populate primary', 'PRIMARY-SNAPSHOT-');
    await createCone(page, { name: 'reviewer', brief: 'populate reviewer' });
    await expectReply(page, 'REVIEWER-SNAPSHOT-');
    await waitForTurnComplete(page, { timeoutMs: 60_000, riseTimeoutMs: 1_000 });

    const follower = await joinAsFollower(browser, await leaderJoinUrl(page));
    watchBrowserDiagnostics(follower.page, 'follower', diagnostics);
    try {
      await follower.page.evaluate((primaryLabel) => {
        const labels = ['reviewer', primaryLabel, 'reviewer'];
        for (const label of labels) {
          const button = [
            ...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]'),
          ].find((candidate) => candidate.getAttribute('aria-label')?.startsWith(`${label}:`));
          if (!button) throw new Error(`cone tab not found: ${label}`);
          button.click();
        }
      }, PRIMARY_CONE_LABEL);
      await expect.poll(() => activeTabLabel(follower.page), { timeout: 60_000 }).toBe('reviewer');
      await expect(follower.page.locator('slicc-chat-thread')).toContainText('REVIEWER-SNAPSHOT-', {
        timeout: 60_000,
      });
      await expect(follower.page.locator('slicc-chat-thread')).not.toContainText(
        'PRIMARY-SNAPSHOT-',
        { timeout: 5_000 }
      );
    } catch (err) {
      throw diagnostics.annotate(err);
    } finally {
      await follower.close();
    }
  });

  test('follower stop interrupts a running turn on its selected cone', async ({
    page,
    browser,
  }) => {
    test.setTimeout(TWO_INSTANCE_TEST_TIMEOUT_MS);
    const diagnostics = watchBrowserDiagnostics(page, 'leader');
    current = diagnostics;
    const fixture = {
      model: CONE_MODEL,
      models: [CONE_MODEL, CONE_MODEL_ALT],
      turns: [
        { whenUserMessageMatches: 'review the docs', content: 'Reviewer cone online.' },
        {
          whenUserMessageMatches: 'start a long follower turn',
          tool_calls: [{ name: 'bash', arguments: { command: 'sleep 20' } }],
        },
        { content: 'This reply must not arrive after stop.' },
      ],
    };
    await bootMultiConeLeader(page, {
      fixture,
      tray: true,
    });
    await createCone(page, { name: 'reviewer', brief: 'review the docs' });
    await expectReply(page, 'Reviewer cone online.');
    await waitForTurnComplete(page, { timeoutMs: 60_000, riseTimeoutMs: 1_000 });

    const follower = await joinAsFollower(browser, await leaderJoinUrl(page));
    watchBrowserDiagnostics(follower.page, 'follower', diagnostics);
    try {
      await selectTab(follower.page, 'reviewer');
      await expect.poll(() => activeTabLabel(follower.page), { timeout: 60_000 }).toBe('reviewer');

      await selectTab(page, PRIMARY_CONE_LABEL);
      await submitUserMessage(follower.page, 'start a long follower turn');
      const frame = follower.page.locator('.wcui-frame');
      await expect(frame).toHaveAttribute('data-processing', '', { timeout: 30_000 });

      await follower.page.evaluate(() => {
        document
          .querySelector('slicc-input-card')
          ?.dispatchEvent(new CustomEvent('stop', { bubbles: true, composed: true }));
      });
      await expect(frame).not.toHaveAttribute('data-processing', /.*/, { timeout: 30_000 });
      await expect(follower.page.locator('slicc-chat-thread')).not.toContainText(
        'This reply must not arrive after stop.',
        { timeout: 5_000 }
      );
    } catch (err) {
      throw diagnostics.annotate(err);
    } finally {
      await follower.close();
    }
  });
});
