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

async function bootLeader(page: Page): Promise<void> {
  await seedLocalLlmProvider(page, { modelId: 'fake-dipper' });
  await seedSkipSwReload(page);
  await gotoLeader(page);
  await waitForSW(page);
  await page.waitForSelector('slicc-input-card');
  await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
    timeout: 20_000,
  });
}

const EARLY_LEAD = 'Here it is.';

async function probeEarlyDip(page: Page, token?: string) {
  return page.evaluate(
    ({ tag, lead }) => {
      const bubble = Array.from(
        document.querySelectorAll('slicc-chat-thread slicc-agent-message')
      ).find((el) => el.querySelector('.body')?.textContent?.startsWith(lead));
      const iframes = Array.from(
        bubble?.querySelectorAll<HTMLIFrameElement>('.msg__dip iframe') ?? []
      );
      const iframe = iframes[0] as (HTMLIFrameElement & { __probe?: string }) | undefined;
      const win = iframe?.contentWindow as (Window & { __probe?: string }) | null | undefined;
      if (tag && iframe && win && !iframe.__probe) {
        iframe.__probe = tag;
        win.__probe = tag;
      }
      return {
        streaming: bubble?.hasAttribute('streaming') ?? false,
        iframes: iframes.length,
        pending: bubble?.querySelectorAll('.msg__dip-pending').length ?? 0,
        elementProbe: iframe?.__probe ?? null,
        windowProbe: win?.__probe ?? null,
        card: win?.document.getElementById('early-card')?.textContent ?? null,
      };
    },
    { tag: token, lead: EARLY_LEAD }
  );
}

test.describe('dip streamed after a tool call', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
    await loadFakeLlmFixture(readFixture('split-dip-stream'));
  });

  test.afterEach(async () => {
    await loadFakeLlmFixture(readFixture('reference-scenario'));
  });

  test('a frame parked by a background tab does not move the dip into the previous bubble', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await installRafPark(page);
    await bootLeader(page);
    const before = (await agentBubbles(page)).length;

    await page.evaluate(() => {
      window.__rafPark!.parked = true;
    });
    await submitUserMessage(page, 'check the thread');

    await waitForFakeLlmHold();
    await expect.poll(async () => (await agentBubbles(page)).length).toBe(before + 2);

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

  test('a dip mounts once its closing fence arrives and survives the rest of the stream', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await bootLeader(page);

    await submitUserMessage(page, 'pour a dip early');

    await waitForFakeLlmHold();
    await expect
      .poll(async () => (await probeEarlyDip(page, 'early')).iframes, { timeout: 15_000 })
      .toBe(1);
    const early = await probeEarlyDip(page);
    expect(early.streaming).toBe(true);
    expect(early.pending).toBe(0);
    expect(early.elementProbe).toBe('early');
    await expect.poll(async () => (await probeEarlyDip(page)).card).toBe('EARLY CARD');

    await releaseFakeLlmHold();
    await expect(page.locator('slicc-chat-thread')).toContainText('Still typing after the dip.', {
      timeout: 30_000,
    });
    await waitForTurnComplete(page);

    const settled = await probeEarlyDip(page);
    expect(settled).toMatchObject({
      streaming: false,
      iframes: 1,
      pending: 0,
      elementProbe: 'early',
      windowProbe: 'early',
      card: 'EARLY CARD',
    });
  });
});
