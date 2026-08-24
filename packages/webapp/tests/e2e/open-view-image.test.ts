// packages/webapp/tests/e2e/open-view-image.test.ts
/**
 * `open --view` image round-trip E2E (#2217).
 *
 * The unit suites prove each seam in isolation: `bash-tool` keeps a marker out
 * of the 40KB cap, `image-markers` classifies it, `tool-adapter` turns it into
 * an image content block, `wc-message-view` renders it. None of them proves the
 * chain holds end to end on a *real* oversized image, which is exactly how
 * #2217 escaped — every piece worked, and the byte cap in the middle destroyed
 * the marker before the pieces downstream ever saw it.
 *
 * So this scenario runs the real thing in a real browser:
 *
 *   1. The agent generates a 512x512 deterministic-noise PNG in the VFS
 *      (noise, because a flat image re-encodes to a few KB and would never
 *      cross the cap this test exists to cross).
 *   2. The agent runs `open --view --size medium` on it. The resulting marker
 *      is well over 40KB, so a cap that measured it as text would slice it.
 *   3. The chat row is asserted to render a real, decoded `<img>` — the inline
 *      preview from #1819, which #2217 silently took away.
 *   4. The request the agent then put on the wire is asserted to carry the
 *      header line and NOT a wall of base64 — the model-facing half of #2217.
 *
 * On (4): pi-ai only serializes image blocks for a model whose metadata
 * advertises image input, and `local-llm` deliberately declares `input:
 * ['text']` for every model (`providers/built-in/local-llm.ts`) because most
 * local runtimes are text-only. So the fake provider cannot receive an
 * `image_url` part, and asserting one here would only be asserting a fixture.
 * What this scenario *can* pin — and what the issue was actually about — is
 * that the tool result reaching the provider is a readable header line instead
 * of the 100-270KB base64 flood that used to evict it.
 */

import type { Page } from '@playwright/test';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  loadFakeLlmFixture,
  readFakeLlmRequests,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const VIEWER_MODEL = 'fake-viewer';

/** The bash tool's text cap. The marker must be comfortably past it. */
const BASH_OUTPUT_MAX_BYTES = 40 * 1024;

function readFixture(name: string): unknown {
  const dir = fileURLToPath(new URL('./fake-llm/fixtures/', import.meta.url));
  return JSON.parse(fs.readFileSync(`${dir}${name}.json`, 'utf8'));
}

/** `src` of every inline tool-result image currently in the transcript. */
async function toolImageSources(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('slicc-chat-thread img.wcmsg-tool-image'))
      .concat(
        // The row may live inside a shadow root depending on the chat surface.
        Array.from(document.querySelectorAll('slicc-chat-thread'))
          .flatMap((host) => Array.from(host.shadowRoot?.querySelectorAll('img') ?? []))
          .filter((img) => img.className.includes('wcmsg-tool-image'))
      )
      .map((img) => (img as HTMLImageElement).src)
  );
}

/** Text of every `role: 'tool'` message across all recorded requests. */
function toolResultTexts(requests: Array<Array<{ role: string; content?: unknown }>>): string[] {
  return requests
    .flat()
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
}

test.describe('open --view image round-trip', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
    await loadFakeLlmFixture(readFixture('open-view-image'));
  });

  test.afterEach(async () => {
    // Fixture swaps outlive `/__reset` and the suite runs serially on one
    // worker — restore the boot default for whatever runs next.
    await loadFakeLlmFixture(readFixture('reference-scenario'));
  });

  test('an oversized inline image survives the bash cap, renders, and does not flood the model', async ({
    page,
  }) => {
    // Cold kernel boot + a 512x512 canvas encode + a resize pass run well past
    // the suite's 30s default.
    test.setTimeout(180_000);

    await seedLocalLlmProvider(page, { modelId: VIEWER_MODEL });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    // ── Phase 1: a real, high-entropy PNG in the VFS ─────────────────
    await submitUserMessage(page, 'make a noisy image');
    await expect(page.locator('slicc-chat-thread')).toContainText('Wrote noise.png', {
      timeout: 90_000,
    });
    await waitForTurnComplete(page);

    // ── Phase 2: view it ─────────────────────────────────────────────
    await submitUserMessage(page, 'show me the image');
    await expect(page.locator('slicc-chat-thread')).toContainText('I can see the noise image', {
      timeout: 90_000,
    });
    await waitForTurnComplete(page);

    // The inline preview is back: a decoded image, not the marker's text.
    const sources = await toolImageSources(page);
    expect(sources.length, 'no inline tool-result image rendered').toBeGreaterThan(0);
    const src = sources[sources.length - 1];
    expect(src.startsWith('data:image/')).toBe(true);
    // Past the cap — otherwise this test would pass even with the bug.
    expect(src.length, 'image is too small to exercise the 40KB cap').toBeGreaterThan(
      BASH_OUTPUT_MAX_BYTES
    );

    const rendered = await page.evaluate((dataUrl: string) => {
      const img = Array.from(
        document.querySelectorAll('slicc-chat-thread img.wcmsg-tool-image')
      ).find((el) => (el as HTMLImageElement).src === dataUrl) as HTMLImageElement | undefined;
      return img ? { width: img.naturalWidth, height: img.naturalHeight } : null;
    }, src);
    // Chrome decoded the bytes; a sliced marker would give 0x0 or no element.
    expect(rendered).toEqual({ width: 512, height: 512 });

    // ── The model-facing half ────────────────────────────────────────
    const toolTexts = toolResultTexts(await readFakeLlmRequests());
    const viewResult = toolTexts.find((t) => t.includes('/workspace/viewtest/noise.png'));
    expect(viewResult, 'the open --view tool result never reached the provider').toBeTruthy();
    // The header line survives — under the bug the cap kept the base64 tail
    // and dropped exactly this line.
    expect(viewResult).toMatch(/noise\.png \(512x512 → \d+x\d+, \d+ KB, image\/\w+\)/);
    // …and no base64 flood came with it.
    expect(viewResult).not.toMatch(/[A-Za-z0-9+/]{2000,}/);
    expect(viewResult!.length).toBeLessThan(BASH_OUTPUT_MAX_BYTES);
  });
});
