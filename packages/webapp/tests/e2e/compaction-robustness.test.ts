/**
 * Compaction robustness scenarios (#1985 / #1986 / #1987) against the
 * fake-LLM framework — the REAL agent loop, kernel worker, session store,
 * and compaction transformer; only the assistant turns are scripted.
 *
 * The seeded `local-llm` models carry a 32K-token context window, so two
 * scripted ~60K-char story turns (~15K estimator tokens each) push the
 * history past the compaction threshold (window − reserve) and the third
 * user prompt triggers a real pre-call compaction:
 *
 *  - success fixture: the summary + memory calls are scripted → the
 *    transcript shows the compacting notice and the follow-up answer.
 *  - fallback fixture: the summary call is deliberately UNSCRIPTED — the
 *    fake server 400s it (`fixture_overflow`) — and compaction must degrade
 *    to the naive drop with a visible notice while the turn still completes.
 *  - persistence fixture: a tool turn whose post-tool completion call is
 *    unscripted → the turn errors; the checkpointed session must survive a
 *    reload with the turn's completed messages intact.
 */

import { readFileSync } from 'node:fs';
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

/** Streaming two ~60K-char turns takes longer than the 20s default fall. */
const STORY_TURN = { timeoutMs: 90_000 } as const;

test.describe('compaction robustness', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test.afterEach(async () => {
    // Restore the boot default so later serial tests (workers: 1) that rely on
    // the reference scenario see the fixture they expect.
    await loadFakeLlmFixture(fixture('reference-scenario'));
  });

  async function bootLeader(page: import('@playwright/test').Page): Promise<void> {
    await seedLocalLlmProvider(page, { modelId: 'fake-coder-compaction' });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    // The cone bootstrap renders the welcome as its first turn; CI machines
    // take well over the 5s default expect timeout to get there.
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });
  }

  /** Two big story turns put the history over the compaction threshold. */
  async function fillHistoryPastThreshold(page: import('@playwright/test').Page): Promise<void> {
    await submitUserMessage(page, 'tell me the epic story part one');
    await waitForTurnComplete(page, STORY_TURN);
    await expect(page.locator('slicc-chat-thread')).toContainText('STORY-PART-one');
    await submitUserMessage(page, 'tell me the epic story part two');
    await waitForTurnComplete(page, STORY_TURN);
    await expect(page.locator('slicc-chat-thread')).toContainText('STORY-PART-two');
  }

  test('pre-call compaction runs visibly and the turn continues (#1986 pipeline)', async ({
    page,
  }) => {
    // Boot + two ~60K-char streamed story turns + a real compaction pass
    // exceed the suite's default 30s per-test budget on CI machines.
    test.setTimeout(240_000);
    await loadFakeLlmFixture(fixture('compaction-success'));
    await bootLeader(page);
    await fillHistoryPastThreshold(page);

    await submitUserMessage(page, 'so, what did we learn from all this?');
    await waitForTurnComplete(page, STORY_TURN);

    const thread = page.locator('slicc-chat-thread');
    // The compaction is no longer invisible: the transcript carries a marker
    // row for the round. One row per round, settled in place — the opening
    // state does not leave a second row behind (#2843).
    const marker = thread.locator('slicc-compaction-marker');
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute('trigger', 'threshold');
    await expect(marker).toHaveAttribute('state', 'summarized');
    // …and the turn completed against the compacted context.
    await expect(thread).toContainText('COMPACTION-DONE-ANSWER');
    // The clean path never shows the degraded state.
    await expect(thread.locator('slicc-compaction-marker[state="fallback"]')).toHaveCount(0);
    // The marker is NOT an assistant bubble: the model's voice does not carry
    // bookkeeping, and the reply must not bleed into the row.
    await expect(
      page.locator('slicc-agent-message', { hasText: 'compacting history' })
    ).toHaveCount(0);
  });

  test('summary-call failure degrades to naive drop; the turn still completes (#1985)', async ({
    page,
  }) => {
    // Same long-flow headroom as the success scenario above.
    test.setTimeout(240_000);
    await loadFakeLlmFixture(fixture('compaction-fallback'));
    await bootLeader(page);
    await fillHistoryPastThreshold(page);

    await submitUserMessage(page, 'and the moral is what, exactly?');
    await waitForTurnComplete(page, STORY_TURN);

    const thread = page.locator('slicc-chat-thread');
    // The degradation is visible instead of a silent turn death…
    const marker = thread.locator('slicc-compaction-marker');
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute('state', 'fallback');
    // …and the user's actual question still got its answer.
    await expect(thread).toContainText('FALLBACK-DONE-ANSWER');
    // The degradation is a marker row, not an assistant bubble.
    await expect(
      page.locator('slicc-agent-message', { hasText: 'older messages truncated' })
    ).toHaveCount(0);
  });

  test('an errored turn keeps its completed messages across a reload (#1987)', async ({ page }) => {
    // Two boots (initial + reload) plus the agent's retry loop need more
    // than the suite's default 30s on CI machines.
    test.setTimeout(120_000);
    await loadFakeLlmFixture(fixture('compaction-persistence'));
    await bootLeader(page);

    await submitUserMessage(page, 'create the marker file please');
    // The post-tool completion call has no scripted turn → the fake server
    // 400s it and the turn ends in an error after the retry loop.
    await waitForTurnComplete(page, { timeoutMs: 60_000 });
    await expect(page.locator('slicc-chat-thread')).toContainText('PERSIST-TOOL-TURN');

    // Reload the leader: the session store must replay the turn's completed
    // messages — before #1987 an abnormal turn end could leave them only in
    // page memory.
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('PERSIST-TOOL-TURN', {
      timeout: 30_000,
    });
  });
});
