/**
 * Compact-on-idle end to end (#2843) against the fake-LLM framework — the
 * REAL idle timer, gates, adoption check, compaction transformer and marker
 * row; only the assistant turns are scripted.
 *
 * The feature ships at 30 minutes and 200k tokens, which no test can wait for.
 * Rather than reach past the production path with a mock, the scenario seeds
 * the two `localStorage` knobs `readIdleCompactionSettings` reads live
 * (`slicc_idle_compaction_minutes`, `slicc_idle_compaction_min_tokens`) so the
 * SAME `setTimeout` the shipped feature arms fires in about a second against a
 * context floor of nothing. That is the reason those keys are readable at all.
 *
 * What it is here to catch is the bug the feature shipped with: the notice used
 * to be a FAKE assistant turn, whose `message_start` put the composer in its
 * busy state with nothing to ever clear it — no `content_done` fall, no
 * `turn_end`, and no status change, because an idle round never leaves `ready`.
 * Every later send then parked in the queued stack while the agent answered it
 * anyway, so bubbles surfaced dozens of rows after their own replies. The
 * assertions below are that bug's regression net: a marker row appears, the
 * composer never goes busy for it, and a send that follows lands immediately.
 */

import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  loadFakeLlmFixture,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fake-llm/fixtures/${name}.json`, import.meta.url), 'utf8'));

/** Streaming the ~60K-char story turn takes longer than the 20s default fall. */
const STORY_TURN = { timeoutMs: 90_000 } as const;

/**
 * 0.1 minutes = 6s. Long enough that the conversation has fully settled before
 * the round starts — a round that opens while the turn's tail is still landing
 * sees the thread move under it and is (correctly) discarded, which retracts
 * its own row — and short enough to observe inside a Playwright budget.
 */
const IDLE_MINUTES = '0.1';
/** No floor: the whole point is exercising the timer, not the size gate. */
const IDLE_MIN_TOKENS = '0';

/** The marker row must appear within a few idle windows plus a summary call. */
const MARKER_TIMEOUT = { timeout: 60_000 } as const;

test.describe('compact-on-idle', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test.afterEach(async () => {
    // Restore the boot default so later serial tests (workers: 1) that rely on
    // the reference scenario see the fixture they expect.
    await loadFakeLlmFixture(fixture('reference-scenario'));
  });

  /**
   * Boot a leader with `compact-on-idle` on and the idle window turned down to
   * seconds. Both knobs go in through the same `localStorage` the production
   * reader consults, so nothing about the code under test is stubbed.
   */
  async function bootIdleLeader(page: Page): Promise<void> {
    await seedLocalLlmProvider(page, { modelId: 'fake-coder-compaction' });
    await page.addInitScript(
      (seed: { minutes: string; minTokens: string }) => {
        try {
          // Flag values are STRINGS on this key (`sanitizeValues` drops
          // anything else), so a boolean here would silently leave the
          // experiment off and the scenario would pass by never running.
          localStorage.setItem('slicc_feature_flags', JSON.stringify({ 'compact-on-idle': 'on' }));
          localStorage.setItem('slicc_idle_compaction_minutes', seed.minutes);
          localStorage.setItem('slicc_idle_compaction_min_tokens', seed.minTokens);
        } catch {
          /* localStorage may be unavailable for opaque origins */
        }
      },
      { minutes: IDLE_MINUTES, minTokens: IDLE_MIN_TOKENS }
    );
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });
  }

  /**
   * TWO big story turns, so the round has something worth summarizing. One is
   * not enough: at ~15K estimator tokens the whole history fits inside
   * `keepRecentTokens` (20K), the cut point finds nothing to summarize, the
   * compactor hands its input straight back, and the round is correctly
   * reported `no-progress` — which retracts its own row. The scenario would
   * then fail without the feature being broken at all.
   */
  async function tellTheStory(page: Page): Promise<void> {
    await submitUserMessage(page, 'tell me the epic story part one');
    await waitForTurnComplete(page, STORY_TURN);
    await expect(page.locator('slicc-chat-thread')).toContainText('STORY-PART-one');
    await submitUserMessage(page, 'tell me the epic story part two');
    await waitForTurnComplete(page, STORY_TURN);
    await expect(page.locator('slicc-chat-thread')).toContainText('STORY-PART-two');
  }

  test('an idle round marks the thread and settles the row in place', async ({ page }) => {
    // Boot + a ~60K-char streamed turn + a real compaction round exceed the
    // suite's default per-test budget on CI machines.
    test.setTimeout(240_000);
    await loadFakeLlmFixture(fixture('compaction-idle'));
    await bootIdleLeader(page);
    await tellTheStory(page);

    // Nobody prompted this: the timer armed when the turn settled into `ready`.
    // Unscoped: a row lives behind the thread's shadow boundary, so neither a
    // CSS descendant nor a locator chained off the thread reaches it.
    const marker = page.locator('slicc-compaction-marker');
    await expect(marker).toHaveCount(1, MARKER_TIMEOUT);
    // Worded as an idle round, and the transcript snapshot is reachable.
    await expect(marker).toHaveAttribute('trigger', 'idle', MARKER_TIMEOUT);
    await expect(marker).toHaveAttribute('state', 'summarized', MARKER_TIMEOUT);
    await expect(marker).toHaveAttribute('transcript', /^\/sessions\/live-cone-.*\.md$/);
    // One row for the whole round — the opening state does not leave a second
    // row behind, and the terminal state does not append one.
    await expect(marker).toHaveCount(1);
    // Not the model's voice: a compaction is bookkeeping.
    await expect(
      page.locator('slicc-agent-message', { hasText: 'Compacted while idle' })
    ).toHaveCount(0);
    // The row really is a thread row, not something floating elsewhere in the
    // shell — worth pinning, since the locator above deliberately is not scoped.
    expect(await marker.evaluate((el) => el.closest('slicc-chat-thread') !== null)).toBe(true);
  });

  test('the composer never goes busy and a following send is not parked', async ({ page }) => {
    test.setTimeout(240_000);
    await loadFakeLlmFixture(fixture('compaction-idle'));
    await bootIdleLeader(page);
    await tellTheStory(page);

    const frame = page.locator('.wcui-frame');
    // The story turn is over, so the shell is idle before the round starts.
    await expect(frame).not.toHaveAttribute('data-processing', /.*/);

    const marker = page.locator('slicc-compaction-marker');
    await expect(marker).toHaveCount(1, MARKER_TIMEOUT);
    await expect(marker).toHaveAttribute('state', 'summarized', MARKER_TIMEOUT);

    // THE regression: the round is over and nothing put the shell back into
    // its busy state. Before #2843 this attribute was set by the notice's fake
    // `message_start` and stayed set for the rest of the session.
    await expect(frame).not.toHaveAttribute('data-processing', /.*/);

    const bubbles = page.locator('slicc-user-message');
    const before = await bubbles.count();
    await submitUserMessage(page, 'are you still there?');

    // The bubble is in the thread NOW rather than parked in the queued stack
    // waiting for a rising edge that would never come.
    await expect(bubbles).toHaveCount(before + 1, { timeout: 10_000 });
    // …and the queued stack is holding nothing back. The stack's own `count`
    // property is the queue length, so this reads the queue rather than
    // guessing from CSS. (The reflected ATTRIBUTE is absent until something is
    // queued for the first time, so asserting on it would pass for the wrong
    // reason.)
    expect(
      await page
        .locator('slicc-queued-stack')
        .evaluate((el) => (el as HTMLElement & { count: number }).count)
    ).toBe(0);
    // And the send really reached the agent.
    await waitForTurnComplete(page, { timeoutMs: 60_000 });
    await expect(page.locator('slicc-chat-thread')).toContainText('IDLE-FOLLOWUP-ANSWER');
  });
});
