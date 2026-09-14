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

const BASH_OUTPUT_MAX_BYTES = 40 * 1024;

function readFixture(name: string): unknown {
  const dir = fileURLToPath(new URL('./fake-llm/fixtures/', import.meta.url));
  return JSON.parse(fs.readFileSync(`${dir}${name}.json`, 'utf8'));
}

async function toolImageSources(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('slicc-chat-thread img.wcmsg-tool-image'))
      .concat(
        Array.from(document.querySelectorAll('slicc-chat-thread'))
          .flatMap((host) => Array.from(host.shadowRoot?.querySelectorAll('img') ?? []))
          .filter((img) => img.className.includes('wcmsg-tool-image'))
      )
      .map((img) => (img as HTMLImageElement).src)
  );
}

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
    await loadFakeLlmFixture(readFixture('reference-scenario'));
  });

  test('an oversized inline image survives the bash cap, renders, and does not flood the model', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await seedLocalLlmProvider(page, { modelId: VIEWER_MODEL });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    await submitUserMessage(page, 'make a noisy image');
    await expect(page.locator('slicc-chat-thread')).toContainText('Wrote noise.png', {
      timeout: 90_000,
    });
    await waitForTurnComplete(page);

    await submitUserMessage(page, 'show me the image');
    await expect(page.locator('slicc-chat-thread')).toContainText('I can see the noise image', {
      timeout: 90_000,
    });
    await waitForTurnComplete(page);

    const sources = await toolImageSources(page);
    expect(sources.length, 'no inline tool-result image rendered').toBeGreaterThan(0);
    const src = sources[sources.length - 1];
    expect(src.startsWith('data:image/')).toBe(true);

    expect(src.length, 'image is too small to exercise the 40KB cap').toBeGreaterThan(
      BASH_OUTPUT_MAX_BYTES
    );

    const rendered = await page.evaluate((dataUrl: string) => {
      const img = Array.from(
        document.querySelectorAll('slicc-chat-thread img.wcmsg-tool-image')
      ).find((el) => (el as HTMLImageElement).src === dataUrl) as HTMLImageElement | undefined;
      return img ? { width: img.naturalWidth, height: img.naturalHeight } : null;
    }, src);

    expect(rendered).toEqual({ width: 512, height: 512 });

    const toolTexts = toolResultTexts(await readFakeLlmRequests());
    const viewResult = toolTexts.find((t) => t.includes('/workspace/viewtest/noise.png'));
    expect(viewResult, 'the open --view tool result never reached the provider').toBeTruthy();

    expect(viewResult).toMatch(/noise\.png \(512x512 → \d+x\d+, \d+ KB, image\/\w+\)/);

    expect(viewResult).not.toMatch(/[A-Za-z0-9+/]{2000,}/);
    expect(viewResult!.length).toBeLessThan(BASH_OUTPUT_MAX_BYTES);
  });
});
