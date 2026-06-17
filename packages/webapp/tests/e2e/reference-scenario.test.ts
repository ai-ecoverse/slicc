// packages/webapp/tests/e2e/reference-scenario.test.ts
/**
 * Reference Fake-LLM E2E scenario.
 *
 * Closes the three risks the Task 2 verifier flagged on the harness:
 *
 *   1. `localStorage` → kernel-worker shim sync — proven by seeding
 *      the `local-llm` provider via {@link seedLocalLlmProvider} BEFORE
 *      `page.goto('/')` and then submitting a user message that only
 *      reaches the fake server if the worker's shim picked the seed
 *      up. The chat-transcript assertion below is positive — it only
 *      fires when the agent's scripted turn actually streamed back
 *      from the fake server and ran.
 *
 *   2. `waitForTurnComplete` masking failures — guarded by the
 *      chat-transcript + CDP-state assertions: both depend on the
 *      scripted turn actually completing, so a silent "turn never
 *      started" failure mode surfaces as a timeout, not a false green.
 *
 *   3. CDP port matches the harness default — Playwright launches
 *      Chrome with `--remote-debugging-port=9222` for this file,
 *      `node-server --serve-only --cdp-port=9222` (from
 *      `playwright.config.ts`) proxies to the same port, and
 *      {@link readCdpPageState} probes it by default. The final
 *      assertion calls the helper without a `cdpEndpoint` override;
 *      it returning the scripted target proves the wiring end to end.
 */

import { expect, test } from '@playwright/test';
import {
  FAKE_LLM_BASE_URL,
  readCdpPageState,
  runUserInputFixture,
  seedLocalLlmProvider,
} from './fake-llm-helpers.js';
import { seedSkipSwReload, waitForSW } from './helpers.js';

const REFERENCE_MODEL = 'fake-coder-reference';
const TARGET_TITLE = 'FAKE LLM REFERENCE TARGET';
// `data:` URL keeps the CDP-driven tab self-contained: no service-worker
// claim, no VFS seed dance. The URL itself carries the deterministic
// HTML, so the agent's `playwright-cli tab-new …` is enough to make
// Chrome report a target whose URL and title both come straight from
// the scripted bash command — exactly the read-back signal we want.
const TARGET_HTML = `<!DOCTYPE html><title>${TARGET_TITLE}</title><h1>Agent landed here</h1>`;
const TARGET_DATA_URL = `data:text/html,${TARGET_HTML}`;

// Bind 9222 on the Playwright-launched Chrome so:
//   - the `node-server --serve-only` CDP proxy (`--cdp-port=9222`)
//     connects to a real Chrome
//   - the agent's `playwright-cli tab-new` opens a CDP-driven tab there
//   - {@link readCdpPageState} sees the same target at its default port
// Sequential mode keeps the port singular within this file.
test.use({
  launchOptions: { args: ['--remote-debugging-port=9222'] },
});
test.describe.configure({ mode: 'serial' });

test.describe('fake-llm reference scenario', () => {
  test('scripted tool call drives a real CDP navigation', async ({ page }) => {
    // Sanity: fake server is the one the harness expects.
    expect(FAKE_LLM_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    // Seed BEFORE goto so the seed lands in the page's localStorage
    // before boot and is forwarded to the kernel-worker shim.
    await seedLocalLlmProvider(page, { modelId: REFERENCE_MODEL });
    await seedSkipSwReload(page);
    await page.goto('/');
    await waitForSW(page);

    // The composer renders before the kernel-worker finishes the cone
    // bootstrap. Submitting before then produces a "No scoop selected"
    // error card (the OffscreenClient agent handle bails when
    // `selectedScoopJid` is null). The bootstrapped cone renders a
    // welcome message into the thread as its first turn — wait for
    // that to confirm the cone is created AND selected.
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });
    await runUserInputFixture(page, ['open the reference page']);

    // ── (a) chat-transcript assertion: scripted assistant text rendered ──
    // Canonical positive proof that the fake LLM streamed back AND the
    // agent loop processed the turn — both required for the
    // localStorage → kernel-worker shim sync to be exercised.
    await expect(page.locator('slicc-chat-thread')).toContainText(
      'Opening the reference data: URL'
    );
    await expect(page.locator('slicc-chat-thread')).toContainText(
      'Done. The agent navigated to the reference page'
    );

    // ── (b) CDP/browser-state assertion via the harness helper ──────
    // After the scripted `bash playwright-cli tab-new …` ran, Chrome at
    // 9222 should report a `page` target whose URL is the data: URL
    // the agent navigated to AND whose title matches the embedded HTML.
    // Polls because the target registers a beat after the CDP
    // `Target.createTarget` resolves on the agent side.
    await expect
      .poll(
        async () => {
          const targets = await readCdpPageState({
            filter: (t) => t.type === 'page' && t.url.startsWith('data:text/html'),
          });
          return {
            count: targets.length,
            titles: targets.map((t) => t.title),
            urls: targets.map((t) => t.url),
          };
        },
        { timeout: 15_000 }
      )
      .toMatchObject({
        count: 1,
        titles: [TARGET_TITLE],
        urls: [TARGET_DATA_URL],
      });
  });
});
