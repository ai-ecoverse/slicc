// packages/webapp/tests/e2e/reference-scenario.test.ts
/**
 * Reference Fake-LLM E2E scenario.
 *
 * Closes the three risks the Task 2 verifier flagged on the harness:
 *
 *   1. `localStorage` → kernel-worker shim sync — proven by seeding
 *      the `local-llm` provider via {@link seedLocalLlmProvider} BEFORE
 *      `page.goto('/')` and then submitting user messages that only
 *      reach the fake server if the worker's shim picked the seed up.
 *      Per-phase chat-transcript assertions are positive — they only
 *      fire when the agent's scripted turns actually streamed back
 *      from the fake server and ran.
 *
 *   2. `waitForTurnComplete` masking failures — guarded by the
 *      chat-transcript + CDP-state assertions interleaved between
 *      phases: each depends on the prior scripted turn actually
 *      completing, so a silent "turn never started" failure mode
 *      surfaces as a timeout, not a false green.
 *
 *   3. CDP port matches the harness default — Playwright launches
 *      Chrome with `--remote-debugging-port=9222` for this file,
 *      `node-server --serve-only --cdp-port=9222` (from
 *      `playwright.config.ts`) proxies to the same port, and
 *      {@link readCdpPageState} probes it by default. The per-phase
 *      assertions call the helper without a `cdpEndpoint` override.
 *
 * The elaborated 3-phase shape additionally exercises the fake-LLM
 * harness's multi-turn sequencing (cursor + matcher ordering, see
 * `./fake-llm/types.ts`), a single turn emitting two `bash` tool
 * calls under small content + tool-arg chunk sizes (SSE delta
 * reassembly), the object-form regex matcher
 * (`{ pattern, flags }`), and multi-target CDP enumeration at 9222.
 */

import { expect, test } from '@playwright/test';
import {
  FAKE_LLM_BASE_URL,
  readCdpPageState,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { seedSkipSwReload, waitForSW } from './helpers.js';

const REFERENCE_MODEL = 'fake-coder-reference';

// Distinct titles so multi-tab CDP filters at 9222 are unambiguous.
const PAGE_A_TITLE = 'FAKE LLM REFERENCE TARGET';
const PAGE_B_TITLE = 'FAKE LLM COMPARE ALPHA';
const PAGE_C_TITLE = 'FAKE LLM COMPARE BETA';

// `data:` URLs keep the CDP-driven tabs self-contained: no service-worker
// claim, no VFS seed dance. Each URL carries its deterministic HTML, so
// the agent's `playwright-cli tab-new …` is enough to make Chrome
// report a target whose URL and title both come straight from the
// scripted bash command — exactly the read-back signal we want.
const PAGE_A_HTML = `<!DOCTYPE html><title>${PAGE_A_TITLE}</title><h1>Page A</h1>`;
const PAGE_B_HTML = `<!DOCTYPE html><title>${PAGE_B_TITLE}</title><h1>Page B</h1>`;
const PAGE_C_HTML = `<!DOCTYPE html><title>${PAGE_C_TITLE}</title><h1>Page C</h1>`;
const PAGE_A_URL = `data:text/html,${PAGE_A_HTML}`;
const PAGE_B_URL = `data:text/html,${PAGE_B_HTML}`;
const PAGE_C_URL = `data:text/html,${PAGE_C_HTML}`;

const ALL_TITLES_SORTED = [PAGE_A_TITLE, PAGE_B_TITLE, PAGE_C_TITLE].slice().sort();
const PHASE2_TITLES_SORTED = [PAGE_B_TITLE, PAGE_C_TITLE].slice().sort();

// Bind 9222 on the Playwright-launched Chrome so:
//   - the `node-server --serve-only` CDP proxy (`--cdp-port=9222`)
//     connects to a real Chrome
//   - the agent's `playwright-cli tab-new` opens a CDP-driven tab there
//   - {@link readCdpPageState} sees the same target at its default port
// Project-level `workers: 1` in `playwright.config.ts` already
// serializes every CDP-binding scenario (preview-serve.test.ts also
// claims 9222), so no per-file `mode: 'serial'` is needed here.
test.use({
  launchOptions: { args: ['--remote-debugging-port=9222'] },
});

test.describe('fake-llm reference scenario', () => {
  test('multi-phase scripted tool calls drive multiple CDP navigations', async ({ page }) => {
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

    // ── Phase 1: single tool call → Page A ───────────────────────────
    // Fixture turn[0] (matched) + turn[1] (cursor follow-up) deliver
    // the scripted text and a `playwright-cli tab-new` for Page A.
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

    // ── Phase 2: two tool calls in one turn → Pages B + C ────────────
    // Fixture turn[2] (matched, small `contentChunkSize` +
    // `toolArgumentsChunkSize`) emits two `bash` tool calls back to
    // back; the agent runs both, then turn[3] (cursor) closes the
    // phase.
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

    // ── Phase 3: regex-matcher → text-only summary turn ──────────────
    // Fixture turn[4] uses the object-form regex matcher
    // (`{ pattern: 'summar(y|ize)', flags: 'i' }`) and returns text
    // only (no tool call) — proves both the regex path and a
    // text-only terminal turn.
    await submitUserMessage(page, 'give me a summary');
    await waitForTurnComplete(page);

    await expect(page.locator('slicc-chat-thread')).toContainText(
      'Summary: opened three CDP targets'
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
