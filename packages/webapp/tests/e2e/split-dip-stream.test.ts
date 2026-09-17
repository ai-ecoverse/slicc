// packages/webapp/tests/e2e/split-dip-stream.test.ts
/**
 * A dip must stay inside the bubble of the message that streamed it.
 *
 * Live cone, 2026-09-17: an assistant message (text + `bash`) was followed,
 * after the tool call, by a message holding a ```shtml dip. The thread showed
 * the first bubble ending in "stuck:It's reasoning…" plus half the dip, and
 * the second bubble starting mid-table with a literal ``` fence. The stored
 * conversation was intact; only the live render was wrong.
 *
 * Cause: the chat controller batches deltas behind `requestAnimationFrame`,
 * and the frame callback captured the id of the message that scheduled it. A
 * background tab parks rAF, so message 1's frame was still queued when
 * message 2 streamed; when the tab woke, that frame flushed message 2's
 * buffer into message 1.
 *
 * This scenario parks rAF (the tab going to the background), runs the tool
 * turn, holds the second stream two chunks in (inside the ```shtml fence), and
 * then wakes the frames, as the tab does when the user looks at it again.
 */

import type { Page } from '@playwright/test';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  loadFakeLlmFixture,
  releaseFakeLlmHold,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForFakeLlmHold,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

declare global {
  interface Window {
    __rafPark?: { parked: boolean; wake(): number };
  }
}

function readFixture(name: string): unknown {
  const dir = fileURLToPath(new URL('./fake-llm/fixtures/', import.meta.url));
  return JSON.parse(fs.readFileSync(`${dir}${name}.json`, 'utf8'));
}

/** Queue rAF callbacks while `parked`, the way a background tab does. */
async function installRafPark(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const queue = new Map<number, FrameRequestCallback>();
    let nextId = -1;
    const park = {
      parked: false,
      wake(): number {
        park.parked = false;
        const due = [...queue.values()];
        queue.clear();
        for (const cb of due) cb(performance.now());
        return due.length;
      },
    };
    window.__rafPark = park;
    window.requestAnimationFrame = (cb) => {
      if (!park.parked) return request(cb);
      const id = nextId--;
      queue.set(id, cb);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (!queue.delete(id)) cancel(id);
    };
  });
}

interface Bubble {
  text: string;
  dips: number;
}

async function agentBubbles(page: Page): Promise<Bubble[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('slicc-chat-thread slicc-agent-message')).map((el) => ({
      text: el.querySelector('.body')?.textContent ?? '',
      dips: el.querySelectorAll('.msg__dip').length,
    }))
  );
}

test.describe('dip streamed after a tool call', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
    await loadFakeLlmFixture(readFixture('split-dip-stream'));
  });

  test.afterEach(async () => {
    // Fixture swaps outlive `/__reset`; restore the boot default.
    await loadFakeLlmFixture(readFixture('reference-scenario'));
  });

  test('a frame parked by a background tab does not move the dip into the previous bubble', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await installRafPark(page);
    await seedLocalLlmProvider(page, { modelId: 'fake-dipper' });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });
    const before = (await agentBubbles(page)).length;

    await page.evaluate(() => {
      window.__rafPark!.parked = true;
    });
    await submitUserMessage(page, 'check the thread');

    // Message 2 has started streaming: its bubble exists, and the fake LLM is
    // holding the rest of it inside the ```shtml fence.
    await waitForFakeLlmHold();
    await expect.poll(async () => (await agentBubbles(page)).length).toBe(before + 2);

    // The user comes back to the tab.
    const woken = await page.evaluate(() => window.__rafPark!.wake());
    expect(woken, 'no frame was parked — the scenario did not run').toBeGreaterThan(0);

    await releaseFakeLlmHold();
    await expect(page.locator('slicc-chat-thread')).toContainText('Tail after the dip.', {
      timeout: 30_000,
    });
    await waitForTurnComplete(page);

    const [first, second] = (await agentBubbles(page)).slice(before);
    expect(first.text).toContain('Confirming it is not stuck:');
    expect(first.text).not.toContain('Launched.');
    expect(first.dips).toBe(0);
    expect(second.text).toContain('Launched.');
    expect(second.text).toContain('Tail after the dip.');
    expect(second.text).not.toContain('```');
    expect(second.dips).toBe(1);
  });
});
