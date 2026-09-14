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

const STORY_TURN = { timeoutMs: 90_000 } as const;

test.describe('compaction robustness', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test.afterEach(async () => {
    await loadFakeLlmFixture(fixture('reference-scenario'));
  });

  async function bootLeader(page: import('@playwright/test').Page): Promise<void> {
    await seedLocalLlmProvider(page, { modelId: 'fake-coder-compaction' });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');

    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });
  }

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
    test.setTimeout(240_000);
    await loadFakeLlmFixture(fixture('compaction-success'));
    await bootLeader(page);
    await fillHistoryPastThreshold(page);

    await submitUserMessage(page, 'so, what did we learn from all this?');
    await waitForTurnComplete(page, STORY_TURN);

    const thread = page.locator('slicc-chat-thread');

    const marker = thread.locator('slicc-compaction-marker');
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute('trigger', 'threshold');
    await expect(marker).toHaveAttribute('state', 'summarized');

    await expect(thread).toContainText('COMPACTION-DONE-ANSWER');

    await expect(thread.locator('slicc-compaction-marker[state="fallback"]')).toHaveCount(0);

    await expect(
      page.locator('slicc-agent-message', { hasText: 'compacting history' })
    ).toHaveCount(0);

    for (const pass of [1, 2]) {
      await gotoLeader(page);
      await waitForSW(page);
      await page.waitForSelector('slicc-input-card');
      const replayed = page.locator('slicc-chat-thread slicc-compaction-marker');
      await expect(replayed, `seam survived reload ${pass}`).toHaveCount(1, { timeout: 30_000 });
      await expect(replayed).toHaveAttribute('state', 'summarized');
      await expect(replayed).toHaveAttribute('trigger', 'threshold');
    }
  });

  test('summary-call failure degrades to naive drop; the turn still completes (#1985)', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await loadFakeLlmFixture(fixture('compaction-fallback'));
    await bootLeader(page);
    await fillHistoryPastThreshold(page);

    await submitUserMessage(page, 'and the moral is what, exactly?');
    await waitForTurnComplete(page, STORY_TURN);

    const thread = page.locator('slicc-chat-thread');

    const marker = thread.locator('slicc-compaction-marker');
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute('state', 'fallback');

    await expect(thread).toContainText('FALLBACK-DONE-ANSWER');

    await expect(
      page.locator('slicc-agent-message', { hasText: 'older messages truncated' })
    ).toHaveCount(0);
  });

  test('an errored turn keeps its completed messages across a reload (#1987)', async ({ page }) => {
    test.setTimeout(120_000);
    await loadFakeLlmFixture(fixture('compaction-persistence'));
    await bootLeader(page);

    await submitUserMessage(page, 'create the marker file please');

    await waitForTurnComplete(page, { timeoutMs: 60_000 });
    await expect(page.locator('slicc-chat-thread')).toContainText('PERSIST-TOOL-TURN');

    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('PERSIST-TOOL-TURN', {
      timeout: 30_000,
    });
  });
});
