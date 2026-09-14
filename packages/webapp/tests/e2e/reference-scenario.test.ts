import {
  closeCdpPageTargets,
  FAKE_LLM_BASE_URL,
  readCdpPageState,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const REFERENCE_MODEL = 'fake-coder-reference';

const PAGE_A_TITLE = 'FAKE LLM REFERENCE TARGET';
const PAGE_B_TITLE = 'FAKE LLM COMPARE ALPHA';
const PAGE_C_TITLE = 'FAKE LLM COMPARE BETA';

const PAGE_A_HTML = `<!DOCTYPE html><title>${PAGE_A_TITLE}</title><h1>Page A</h1>`;
const PAGE_B_HTML = `<!DOCTYPE html><title>${PAGE_B_TITLE}</title><h1>Page B</h1>`;
const PAGE_C_HTML = `<!DOCTYPE html><title>${PAGE_C_TITLE}</title><h1>Page C</h1>`;
const PAGE_A_URL = `data:text/html,${PAGE_A_HTML}`;
const PAGE_B_URL = `data:text/html,${PAGE_B_HTML}`;
const PAGE_C_URL = `data:text/html,${PAGE_C_HTML}`;

const ALL_TITLES_SORTED = [PAGE_A_TITLE, PAGE_B_TITLE, PAGE_C_TITLE].slice().sort();
const PHASE2_TITLES_SORTED = [PAGE_B_TITLE, PAGE_C_TITLE].slice().sort();

test.describe('fake-llm reference scenario', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
    await closeCdpPageTargets({
      filter: (target) =>
        target.type === 'page' &&
        (target.url === PAGE_A_URL || target.url === PAGE_B_URL || target.url === PAGE_C_URL),
    });
  });

  test('multi-phase scripted tool calls drive multiple CDP navigations', async ({ page }) => {
    expect(FAKE_LLM_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    await seedLocalLlmProvider(page, { modelId: REFERENCE_MODEL });
    await seedSkipSwReload(page);

    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    await submitUserMessage(page, 'open the reference page');
    await waitForTurnComplete(page);

    await expect(page.locator('slicc-chat-thread')).toContainText(
      'Opening the reference data: URL'
    );
    await expect(page.locator('slicc-chat-thread')).toContainText('Done. Page A is open.');

    await expect
      .poll(
        async () => {
          const targets = await readCdpPageState({
            filter: (t) => t.type === 'page' && t.url === PAGE_A_URL,
          });
          return { count: targets.length, titles: targets.map((t) => t.title) };
        },
        { timeout: 15_000 }
      )
      .toMatchObject({ count: 1, titles: [PAGE_A_TITLE] });

    await submitUserMessage(page, 'open the comparison pages');
    await waitForTurnComplete(page);

    await expect(page.locator('slicc-chat-thread')).toContainText('Done. Pages B and C are open.');

    await expect
      .poll(
        async () => {
          const targets = await readCdpPageState({
            filter: (t) => t.type === 'page' && (t.url === PAGE_B_URL || t.url === PAGE_C_URL),
          });
          return {
            count: targets.length,
            titles: targets.map((t) => t.title).sort(),
          };
        },
        { timeout: 15_000 }
      )
      .toMatchObject({ count: 2, titles: PHASE2_TITLES_SORTED });

    await submitUserMessage(page, 'give me a summary');
    await expect(page.locator('slicc-chat-thread')).toContainText(
      'Summary: opened three CDP targets',
      { timeout: 20_000 }
    );

    await page.waitForFunction(
      () => {
        const frame = document.querySelector('.wcui-frame');
        return frame !== null && !frame.hasAttribute('data-processing');
      },
      undefined,
      { timeout: 20_000 }
    );

    await expect
      .poll(
        async () => {
          const targets = await readCdpPageState({
            filter: (t) =>
              t.type === 'page' &&
              (t.url === PAGE_A_URL || t.url === PAGE_B_URL || t.url === PAGE_C_URL),
          });
          return {
            count: targets.length,
            titles: targets.map((t) => t.title).sort(),
          };
        },
        { timeout: 15_000 }
      )
      .toMatchObject({ count: 3, titles: ALL_TITLES_SORTED });
  });
});
