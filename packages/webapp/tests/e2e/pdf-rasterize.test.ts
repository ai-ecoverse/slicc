// packages/webapp/tests/e2e/pdf-rasterize.test.ts
/**
 * Real PDF rasterization E2E.
 *
 * The unit suites for `pdftoppm` / `pdf-raster` mock pdf.js and stub
 * `OffscreenCanvas`, so they prove the argument handling and the streaming
 * contract but say nothing about whether rasterization actually *works*. This
 * scenario closes exactly that gap:
 *
 *   1. pdf.js accepts our `OffscreenCanvas`-backed `CanvasFactory` in the
 *      kernel worker, where the shell really runs. A mocked canvas cannot
 *      show this; pdf.js reaches for canvas APIs the fake never implements.
 *   2. The bytes that land in the VFS are real, decodable images at the
 *      expected pixel dimensions — read back through the preview SW rather
 *      than trusted from a `writeFile` spy.
 *   3. `-r`, `-f`/`-l`, `-singlefile` and `-jpeg` affect the actual output,
 *      not just the options object.
 *
 * `convert`'s PDF-input path is deliberately NOT covered here. `convert`
 * requires `@imagemagick/magick-wasm` to be installed into the VFS
 * (`ipk add @imagemagick/magick-wasm@<version>`) and has no network fallback
 * by design, so it cannot run against a fresh E2E VFS at all — a plain
 * `convert a.png a.jpg` fails here too. That path stays unit-tested in
 * `convert-pdf-input.test.ts`.
 *
 * The fixture PDF is two 200x100pt pages, each with a filled rectangle and a
 * Helvetica label. Its expected raster sizes below were taken from real
 * poppler `pdftoppm` output on the same file, so the assertions are pinned to
 * the tool this command imitates rather than to our own implementation.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  loadFakeLlmFixture,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const RASTERIZE_MODEL = 'fake-rasterizer';

function readFixture(name: string): unknown {
  const dir = fileURLToPath(new URL('./fake-llm/fixtures/', import.meta.url));
  return JSON.parse(fs.readFileSync(`${dir}${name}.json`, 'utf8'));
}

/** The fixture PDF's MediaBox is 200x100pt, so 72 DPI renders 1:1. */
const PAGE_WIDTH_PT = 200;
const PAGE_HEIGHT_PT = 100;

/**
 * Size of a fixture page rendered at pdftoppm's *default* resolution (150
 * DPI, i.e. no `-r`). Verified against real poppler on the same PDF, which
 * emits exactly 417x209 — so this pins our rounding to the tool's, not just
 * to our own arithmetic.
 */
const DEFAULT_DPI_SIZE = { width: 417, height: 209 };

/** PNG magic: \x89PNG\r\n\x1a\n */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read a file the agent wrote back out of the *real* VFS.
 *
 * Two details make this a genuine read rather than a staged one:
 *
 *   - It runs on a second page. The preview SW resolves `preview-vfs-read`
 *     over a BroadcastChannel answered by the live app page, so navigating
 *     the app page into `/preview/` would kill the very responder the read
 *     depends on and every fetch would hit the 5s responder timeout.
 *   - The seed responder installed by `seedSkipSwReload` returns early for
 *     paths it was never given, and this test seeds nothing. So these bytes
 *     came from the VFS, written by `pdftoppm` itself.
 *
 * The reader navigates into `/preview/` scope once so the SW controls it and
 * intercepts sub-fetches; binary bodies then come back through `fetch`
 * without tripping Chrome's download handling on unknown extensions.
 */
async function readVfsFile(reader: Page, vfsPath: string): Promise<Buffer> {
  const result = await reader.evaluate(async (path: string) => {
    const response = await fetch(`/preview${path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, bytes: Array.from(bytes) };
  }, vfsPath);
  expect(result.status, `${vfsPath} was not served from the VFS`).toBe(200);
  return Buffer.from(result.bytes);
}

/** Decode a PNG's IHDR dimensions. Width and height are big-endian u32 at 16. */
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8), 'not a PNG').toEqual(PNG_SIGNATURE);
  expect(bytes.subarray(12, 16).toString('latin1'), 'first chunk is not IHDR').toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Decode a JPEG's SOFn frame dimensions. Walks the marker segments rather
 * than assuming a fixed offset, since the encoder's segment order is not ours
 * to control.
 */
function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.readUInt16BE(0), 'not a JPEG (missing SOI)').toBe(0xffd8);
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0-SOF3 / SOF5-SOF7 / SOF9-SOF11 / SOF13-SOF15 carry the frame size.
    // Exclude DHT (c4), JPG (c8) and DAC (cc), which share the c0-cf range.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new Error('no SOF marker found in JPEG');
}

test.describe('pdf rasterization', () => {
  test.beforeEach(async () => {
    // The fake LLM is a long-lived webServer with a per-process turn cursor;
    // rewind it so a Playwright retry does not resume mid-fixture.
    await resetFakeLlm();
    // CI boots the shared default (reference-scenario) fixture, so swap the
    // rasterization turns in at runtime rather than relying on the
    // FAKE_LLM_FIXTURE env override a local run can pass.
    await loadFakeLlmFixture(readFixture('pdf-rasterize'));
  });

  test.afterEach(async () => {
    // Fixture swaps outlive `/__reset`, and the suite runs serially on one
    // worker — restore the boot default so later tests see what they expect.
    await loadFakeLlmFixture(readFixture('reference-scenario'));
  });

  test('pdftoppm writes real, decodable images from a real PDF', async ({ page, context }) => {
    // Boot, pdf.js module load, and three rasterization passes in a cold
    // kernel worker run well past the suite's 30s default.
    test.setTimeout(180_000);

    await seedLocalLlmProvider(page, { modelId: RASTERIZE_MODEL });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);

    // The composer renders before the kernel worker finishes the cone
    // bootstrap; the welcome message proves the cone exists and is selected.
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    // ── Phase 1: two pages at 72 DPI ─────────────────────────────────
    await submitUserMessage(page, 'seed and rasterize at 72 dpi');
    await expect(page.locator('slicc-chat-thread')).toContainText(
      'Wrote page-1.png and page-2.png',
      { timeout: 90_000 }
    );
    await waitForTurnComplete(page);

    // A dedicated reader page inside `/preview/` scope, opened only now that
    // the directory exists. The app page above stays on the leader origin so
    // it can keep answering the SW's `preview-vfs-read` broadcasts.
    const reader = await context.newPage();
    // A path that does not exist: the 404 still puts the client under the
    // SW's control, without Chrome treating the body as a download.
    await reader.goto('/preview/workspace/pdftest/sw-anchor.html');

    const pageOne = await readVfsFile(reader, '/workspace/pdftest/page-1.png');
    // 200x100pt at 72 DPI is 1:1 — byte-for-byte the size real poppler emits.
    expect(pngDimensions(pageOne)).toEqual({ width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT });

    const pageTwo = await readVfsFile(reader, '/workspace/pdftest/page-2.png');
    expect(pngDimensions(pageTwo)).toEqual({ width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT });

    // The two pages carry different artwork (red vs blue rectangle, different
    // labels), so identical bytes would mean page selection silently rendered
    // the same page twice — the exact bug a size-only assertion misses.
    expect(pageOne.equals(pageTwo)).toBe(false);

    // ── Phase 2: -r doubles the raster, -singlefile drops the suffix ──
    await submitUserMessage(page, 'rasterize at 144 dpi');
    await expect(page.locator('slicc-chat-thread')).toContainText('Wrote hi.png at 144 DPI', {
      timeout: 90_000,
    });
    await waitForTurnComplete(page);

    const highDpi = await readVfsFile(reader, '/workspace/pdftest/hi.png');
    expect(pngDimensions(highDpi)).toEqual({
      width: PAGE_WIDTH_PT * 2,
      height: PAGE_HEIGHT_PT * 2,
    });

    // ── Phase 3: -jpeg emits a real JPEG at the default 150 DPI ──────
    await submitUserMessage(page, 'rasterize as jpeg');
    await expect(page.locator('slicc-chat-thread')).toContainText('Wrote cover.jpg from page 2', {
      timeout: 90_000,
    });
    await waitForTurnComplete(page);

    const jpeg = await readVfsFile(reader, '/workspace/pdftest/cover.jpg');
    // No -r here, so this also pins the 150 DPI poppler default.
    expect(jpegDimensions(jpeg)).toEqual(DEFAULT_DPI_SIZE);
  });
});
