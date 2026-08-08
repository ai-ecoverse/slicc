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
import { expect, test } from '@playwright/test';
import {
  loadFakeLlmFixture,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fake-llm/fixtures/${name}.json`, import.meta.url), 'utf8'));

/** Streaming two ~60K-char turns takes longer than the 20s default fall. */
const STORY_TURN = { timeoutMs: 90_000 } as const;

test.describe('compaction robustness', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  async function bootLeader(page: import('@playwright/test').Page): Promise<void> {
    await seedLocalLlmProvider(page, { modelId: 'fake-coder-compaction' });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC');
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
    await loadFakeLlmFixture(fixture('compaction-success'));
    await bootLeader(page);
    await fillHistoryPastThreshold(page);

    await submitUserMessage(page, 'so, what did we learn from all this?');
    await waitForTurnComplete(page, STORY_TURN);

    const thread = page.locator('slicc-chat-thread');
    // The compaction is no longer invisible: the transcript carries the notice…
    await expect(thread).toContainText('Context window almost exceeded — compacting history');
    // …and the turn completed against the compacted context.
    await expect(thread).toContainText('COMPACTION-DONE-ANSWER');
    // The clean path never shows the degradation notice.
    await expect(thread).not.toContainText('Compaction summarization failed');
  });

  test('summary-call failure degrades to naive drop; the turn still completes (#1985)', async ({
    page,
  }) => {
    await loadFakeLlmFixture(fixture('compaction-fallback'));
    await bootLeader(page);
    await fillHistoryPastThreshold(page);

    await submitUserMessage(page, 'and the moral is what, exactly?');
    await waitForTurnComplete(page, STORY_TURN);

    const thread = page.locator('slicc-chat-thread');
    // The degradation is visible instead of a silent turn death…
    await expect(thread).toContainText(
      'Compaction summarization failed — continuing with older messages truncated.'
    );
    // …and the user's actual question still got its answer.
    await expect(thread).toContainText('FALLBACK-DONE-ANSWER');
  });

  test('an errored turn keeps its completed messages across a reload (#1987)', async ({ page }) => {
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
