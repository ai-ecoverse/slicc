/**
 * Reload recovery against the fake-LLM framework — the REAL kernel worker,
 * turn journal, canonical conversation store and lick pipeline; only the
 * assistant turns are scripted.
 *
 *  - A reload while the MODEL REQUEST is in flight (the fake server parks the
 *    stream mid-answer): after the reload the kernel repeats the request from
 *    the restored history, and the answer lands without the user resending.
 *  - A reload while a TOOL CALL is in flight (`sleep 300`): the call is NOT
 *    re-run — it gets an "interrupted" error result, and the cone receives a
 *    `session-reload` lick (`tool-call-interrupted`) and answers it.
 */

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

/** Two boots plus a streamed turn on each side of the reload. */
const RELOAD_TEST_TIMEOUT_MS = 180_000;

interface JournalRow {
  jid: string;
  tools: Array<{ toolName: string }>;
}

/**
 * The in-flight journal, read from the page realm (same origin as the kernel
 * worker, so the same IndexedDB). Never creates the database: opening it
 * before the worker would pin a store-less v1 and break the worker's writes.
 */
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

/** Text of the latest `user` message in one recorded request. */
function latestUserText(request: RecordedRequest): string {
  for (let i = request.length - 1; i >= 0; i--) {
    if (request[i].role === 'user') return JSON.stringify(request[i].content);
  }
  return '';
}

/** Let a stream the test parked finish, if one is still parked. */
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
    // Restore the boot default so later serial tests (workers: 1) that rely on
    // the reference scenario see the fixture they expect.
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
    // The answer is mid-stream and parked: the request is provably in flight.
    await waitForFakeLlmHold();
    await expect
      .poll(async () => (await readJournal(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    await reloadLeader(page);

    const thread = page.locator('slicc-chat-thread');
    await expect(thread).toContainText('RELOAD-RESUMED-ANSWER', { timeout: 60_000 });
    // The half-streamed answer died with the page; only the repeat survives.
    await expect(thread).not.toContainText('RELOAD-PARTIAL-CHUNK');
    // The user did not resend: one user bubble for the prompt.
    await expect(page.locator('slicc-user-message', { hasText: 'RELOAD-LLM-PROMPT' })).toHaveCount(
      1
    );

    // On the wire: the same request went out twice, and the repeat carries the
    // prompt exactly once (a continue, not a re-prompt).
    const promptRequests = (await readFakeLlmRequests()).filter((r) =>
      latestUserText(r).includes('RELOAD-LLM-PROMPT')
    );
    expect(promptRequests).toHaveLength(2);
    const repeat = promptRequests[1];
    expect(
      repeat.filter((m) => m.role === 'user' && JSON.stringify(m.content).includes('RELOAD-LLM'))
    ).toHaveLength(1);
    expect(repeat.at(-1)?.role).toBe('user');

    // The resumed turn settled, so nothing is left to recover on the next boot.
    await expect.poll(async () => readJournal(page), { timeout: 15_000 }).toEqual([]);
  });

  test('a tool call cut off by a reload is reported, never re-run', async ({ page }) => {
    test.setTimeout(RELOAD_TEST_TIMEOUT_MS);
    await bootLeader(page);

    await submitUserMessage(page, 'RELOAD-TOOL-PROMPT run the slow command');
    // `sleep 300` is running: the journal names the in-flight bash call.
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
    // The cone got the `tool-call-interrupted` lick and answered it.
    await expect(thread).toContainText('RELOAD-TOOL-ACKNOWLEDGED', { timeout: 60_000 });

    const requests = await readFakeLlmRequests();
    // The tool's model request was NOT repeated — that would re-issue the call.
    expect(requests.filter((r) => latestUserText(r).includes('RELOAD-TOOL-PROMPT'))).toHaveLength(
      1
    );
    const lickTurn = requests.find((r) => latestUserText(r).includes('tool-call-interrupted'));
    expect(lickTurn).toBeDefined();
    const wire = JSON.stringify(lickTurn);
    // The lick names the lost call…
    expect(latestUserText(lickTurn!)).toContain('sleep 300');
    // …the history answers it with an "interrupted" result, not a real one…
    expect(wire).toContain('Interrupted: the page reloaded while this tool call was running');
    // …and the command never finished: no tool result ever carried its output.
    const toolResults = requests.flatMap((r) => r.filter((m) => m.role === 'tool'));
    expect(JSON.stringify(toolResults)).not.toContain('SLOW-TOOL-FINISHED');
  });
});
