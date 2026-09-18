import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  FAKE_LLM_BASE_URL,
  loadFakeLlmFixture,
  type RecordedRequest,
  readFakeLlmRequests,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForFakeLlmHold,
} from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fake-llm/fixtures/${name}.json`, import.meta.url), 'utf8'));

const RELOAD_TEST_TIMEOUT_MS = 180_000;

interface JournalRow {
  jid: string;
  tools: Array<{ toolName: string }>;
}

async function readJournal(page: Page): Promise<JournalRow[]> {
  return page.evaluate(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((db) => db.name === 'slicc-turn-journal')) return [];
    return new Promise<JournalRow[]>((resolve, reject) => {
      const req = indexedDB.open('slicc-turn-journal');
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('inflight')) {
          db.close();
          resolve([]);
          return;
        }
        const get = db.transaction('inflight', 'readonly').objectStore('inflight').getAll();
        get.onsuccess = () => {
          db.close();
          resolve(get.result as JournalRow[]);
        };
        get.onerror = () => reject(get.error);
      };
      req.onerror = () => reject(req.error);
    });
  });
}

function latestUserText(request: RecordedRequest): string {
  for (let i = request.length - 1; i >= 0; i--) {
    if (request[i].role === 'user') return JSON.stringify(request[i].content);
  }
  return '';
}

async function releaseHoldIfAny(): Promise<void> {
  const origin = FAKE_LLM_BASE_URL.replace(/\/v1\/?$/, '');
  await fetch(`${origin}/__release`, { method: 'POST' }).catch(() => undefined);
}

test.describe('reload recovery', () => {
  test.beforeEach(async ({ page }) => {
    await resetFakeLlm();
    await loadFakeLlmFixture(fixture('reload-recovery'));
    await seedLocalLlmProvider(page, { modelId: 'fake-coder-reload' });
    await seedSkipSwReload(page);
  });

  test.afterEach(async () => {
    await releaseHoldIfAny();

    await loadFakeLlmFixture(fixture('reference-scenario'));
  });

  async function bootLeader(page: Page): Promise<void> {
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });
  }

  async function reloadLeader(page: Page): Promise<void> {
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
  }

  test('a model request cut off by a reload is repeated after it', async ({ page }) => {
    test.setTimeout(RELOAD_TEST_TIMEOUT_MS);
    await bootLeader(page);

    await submitUserMessage(page, 'RELOAD-LLM-PROMPT please answer');

    await waitForFakeLlmHold();
    await expect
      .poll(async () => (await readJournal(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    await reloadLeader(page);

    const thread = page.locator('slicc-chat-thread');
    await expect(thread).toContainText('RELOAD-RESUMED-ANSWER', { timeout: 60_000 });

    await expect(thread).not.toContainText('RELOAD-PARTIAL-CHUNK');

    await expect(page.locator('slicc-user-message', { hasText: 'RELOAD-LLM-PROMPT' })).toHaveCount(
      1
    );

    const promptRequests = (await readFakeLlmRequests()).filter((r) =>
      latestUserText(r).includes('RELOAD-LLM-PROMPT')
    );
    expect(promptRequests).toHaveLength(2);
    const repeat = promptRequests[1];
    expect(
      repeat.filter((m) => m.role === 'user' && JSON.stringify(m.content).includes('RELOAD-LLM'))
    ).toHaveLength(1);
    expect(repeat.at(-1)?.role).toBe('user');

    await expect.poll(async () => readJournal(page), { timeout: 15_000 }).toEqual([]);
  });

  test('a tool call cut off by a reload is reported, never re-run', async ({ page }) => {
    test.setTimeout(RELOAD_TEST_TIMEOUT_MS);
    await bootLeader(page);

    await submitUserMessage(page, 'RELOAD-TOOL-PROMPT run the slow command');

    await expect
      .poll(
        async () => (await readJournal(page)).flatMap((row) => row.tools.map((t) => t.toolName)),
        {
          timeout: 30_000,
        }
      )
      .toEqual(['bash']);

    await reloadLeader(page);

    const thread = page.locator('slicc-chat-thread');

    await expect(thread).toContainText('RELOAD-TOOL-ACKNOWLEDGED', { timeout: 60_000 });

    const requests = await readFakeLlmRequests();

    expect(requests.filter((r) => latestUserText(r).includes('RELOAD-TOOL-PROMPT'))).toHaveLength(
      1
    );
    const lickTurn = requests.find((r) => latestUserText(r).includes('tool-call-interrupted'));
    expect(lickTurn).toBeDefined();
    const wire = JSON.stringify(lickTurn);

    expect(latestUserText(lickTurn!)).toContain('sleep 300');

    expect(wire).toContain('Interrupted: the page reloaded while this tool call was running');

    const toolResults = requests.flatMap((r) => r.filter((m) => m.role === 'tool'));
    expect(JSON.stringify(toolResults)).not.toContain('SLOW-TOOL-FINISHED');
  });
});
