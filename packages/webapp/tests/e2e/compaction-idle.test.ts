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

const STORY_TURN = { timeoutMs: 90_000 } as const;

const IDLE_MINUTES = '0.1';

const IDLE_MIN_TOKENS = '0';

const MARKER_TIMEOUT = { timeout: 60_000 } as const;

test.describe('compact-on-idle', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test.afterEach(async () => {
    await loadFakeLlmFixture(fixture('reference-scenario'));
  });

  async function bootIdleLeader(page: Page): Promise<void> {
    await seedLocalLlmProvider(page, { modelId: 'fake-coder-compaction' });
    await page.addInitScript(
      (seed: { minutes: string; minTokens: string }) => {
        try {
          localStorage.setItem('slicc_feature_flags', JSON.stringify({ 'compact-on-idle': 'on' }));
          localStorage.setItem('slicc_idle_compaction_minutes', seed.minutes);
          localStorage.setItem('slicc_idle_compaction_min_tokens', seed.minTokens);
        } catch {}
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

  async function tellTheStory(page: Page): Promise<void> {
    await submitUserMessage(page, 'tell me the epic story part one');
    await waitForTurnComplete(page, STORY_TURN);
    await expect(page.locator('slicc-chat-thread')).toContainText('STORY-PART-one');
    await submitUserMessage(page, 'tell me the epic story part two');
    await waitForTurnComplete(page, STORY_TURN);
    await expect(page.locator('slicc-chat-thread')).toContainText('STORY-PART-two');
  }

  test('an idle round marks the thread and settles the row in place', async ({ page }) => {
    test.setTimeout(240_000);
    await loadFakeLlmFixture(fixture('compaction-idle'));
    await bootIdleLeader(page);
    await tellTheStory(page);

    const marker = page.locator('slicc-compaction-marker');
    await expect(marker).toHaveCount(1, MARKER_TIMEOUT);

    await expect(marker).toHaveAttribute('trigger', 'idle', MARKER_TIMEOUT);
    await expect(marker).toHaveAttribute('state', 'summarized', MARKER_TIMEOUT);
    await expect(marker).toHaveAttribute('transcript', /^\/sessions\/live-cone-.*\.md$/);

    await expect(marker).toHaveCount(1);

    await expect(
      page.locator('slicc-agent-message', { hasText: 'Compacted while idle' })
    ).toHaveCount(0);

    expect(await marker.evaluate((el) => el.closest('slicc-chat-thread') !== null)).toBe(true);
  });

  test('the composer never goes busy and a following send is not parked', async ({ page }) => {
    test.setTimeout(240_000);
    await loadFakeLlmFixture(fixture('compaction-idle'));
    await bootIdleLeader(page);
    await tellTheStory(page);

    const frame = page.locator('.wcui-frame');

    await expect(frame).not.toHaveAttribute('data-processing', /.*/);

    const marker = page.locator('slicc-compaction-marker');
    await expect(marker).toHaveCount(1, MARKER_TIMEOUT);
    await expect(marker).toHaveAttribute('state', 'summarized', MARKER_TIMEOUT);

    await expect(frame).not.toHaveAttribute('data-processing', /.*/);

    const bubbles = page.locator('slicc-user-message');
    const before = await bubbles.count();
    await submitUserMessage(page, 'are you still there?');

    await expect(bubbles).toHaveCount(before + 1, { timeout: 10_000 });

    expect(
      await page
        .locator('slicc-queued-stack')
        .evaluate((el) => (el as HTMLElement & { count: number }).count)
    ).toBe(0);

    await waitForTurnComplete(page, { timeoutMs: 60_000 });
    await expect(page.locator('slicc-chat-thread')).toContainText('IDLE-FOLLOWUP-ANSWER');
  });
});
