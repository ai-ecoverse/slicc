import type { Page } from '@playwright/test';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  loadFakeLlmFixture,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

const RASTERIZE_MODEL = 'fake-rasterizer';

function readFixture(name: string): unknown {
  const dir = fileURLToPath(new URL('./fake-llm/fixtures/', import.meta.url));
  return JSON.parse(fs.readFileSync(`${dir}${name}.json`, 'utf8'));
}

const PAGE_WIDTH_PT = 200;
const PAGE_HEIGHT_PT = 100;

const DEFAULT_DPI_SIZE = { width: 417, height: 209 };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function readVfsFile(reader: Page, vfsPath: string): Promise<Buffer> {
  const result = await reader.evaluate(async (path: string) => {
    const response = await fetch(`/preview${path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, bytes: Array.from(bytes) };
  }, vfsPath);
  expect(result.status, `${vfsPath} was not served from the VFS`).toBe(200);
  return Buffer.from(result.bytes);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8), 'not a PNG').toEqual(PNG_SIGNATURE);
  expect(bytes.subarray(12, 16).toString('latin1'), 'first chunk is not IHDR').toBe('IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  expect(bytes.readUInt16BE(0), 'not a JPEG (missing SOI)').toBe(0xffd8);
  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];

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
    await resetFakeLlm();

    await loadFakeLlmFixture(readFixture('pdf-rasterize'));
  });

  test.afterEach(async () => {
    await loadFakeLlmFixture(readFixture('reference-scenario'));
  });

  test('pdftoppm writes real, decodable images from a real PDF', async ({ page, context }) => {
    test.setTimeout(180_000);

    await seedLocalLlmProvider(page, { modelId: RASTERIZE_MODEL });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    await submitUserMessage(page, 'seed and rasterize at 72 dpi');
    await expect(page.locator('slicc-chat-thread')).toContainText(
      'Wrote page-1.png and page-2.png',
      { timeout: 90_000 }
    );
    await waitForTurnComplete(page);

    const reader = await context.newPage();

    await reader.goto('/preview/workspace/pdftest/sw-anchor.html');

    const pageOne = await readVfsFile(reader, '/workspace/pdftest/page-1.png');

    expect(pngDimensions(pageOne)).toEqual({ width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT });

    const pageTwo = await readVfsFile(reader, '/workspace/pdftest/page-2.png');
    expect(pngDimensions(pageTwo)).toEqual({ width: PAGE_WIDTH_PT, height: PAGE_HEIGHT_PT });

    expect(pageOne.equals(pageTwo)).toBe(false);

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

    await submitUserMessage(page, 'rasterize as jpeg');
    await expect(page.locator('slicc-chat-thread')).toContainText('Wrote cover.jpg from page 2', {
      timeout: 90_000,
    });
    await waitForTurnComplete(page);

    const jpeg = await readVfsFile(reader, '/workspace/pdftest/cover.jpg');

    expect(jpegDimensions(jpeg)).toEqual(DEFAULT_DPI_SIZE);
  });
});
