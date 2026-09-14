import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import {
  FAKE_LLM_BASE_URL,
  loadFakeLlmFixture,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
} from './fake-llm-helpers.js';
import { expect, test } from './fixtures.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

function readFixture(name: string): unknown {
  const dir = fileURLToPath(new URL('./fake-llm/fixtures/', import.meta.url));
  return JSON.parse(fs.readFileSync(`${dir}${name}.json`, 'utf8'));
}

const EXPORT_MODEL = 'fake-exporter';

const CREDENTIAL_PATTERN = 'sk-proj-1234abcd5678efgh9012ijkl3456mnop';

const BINARY_FIXTURE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function seedBinaryAttachment(
  page: import('@playwright/test').Page,
  b64: string
): Promise<void> {
  await page.evaluate(
    async (args: { b64: string }) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('browser-coding-agent', 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('sessions', 'readwrite');
          const store = tx.objectStore('sessions');
          const getReq = store.get('session-cone');
          getReq.onsuccess = () => {
            const session = getReq.result as
              | { id: string; messages: Array<{ role: string; attachments?: unknown[] }> }
              | undefined;
            if (!session?.messages?.length) {
              resolve();
              return;
            }
            const firstUserMsg = session.messages.find((m) => m.role === 'user');
            if (!firstUserMsg) {
              resolve();
              return;
            }
            if (!firstUserMsg.attachments) firstUserMsg.attachments = [];
            firstUserMsg.attachments.push({
              id: 'e2e-binary-fixture',
              name: 'fixture.bin',
              mimeType: 'application/octet-stream',
              size: 8,
              kind: 'file',
              data: args.b64,
            });
            const putReq = store.put(session);
            putReq.onsuccess = () => resolve();
            putReq.onerror = () => reject(putReq.error);
          };
          getReq.onerror = () => reject(getReq.error);
        };
        req.onerror = () => reject(req.error);
      });
    },
    { b64 }
  );
}

test.describe('transcript export — local ZIP download', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();

    await loadFakeLlmFixture(readFixture('transcript-export'));
  });

  test.afterEach(async () => {
    await loadFakeLlmFixture(readFixture('reference-scenario'));
  });

  test('exports ZIP: cone + scoop conversations, binary unchanged, credential redacted', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    expect(FAKE_LLM_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    await seedLocalLlmProvider(page, { modelId: EXPORT_MODEL });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    await submitUserMessage(page, 'run the export scenario');

    await expect(page.locator('slicc-chat-thread')).toContainText(
      'credential-shaped token appeared',
      { timeout: 30_000 }
    );
    await page.waitForFunction(
      () => {
        const frame = document.querySelector('.wcui-frame');
        return frame !== null && !frame.hasAttribute('data-processing');
      },
      undefined,
      { timeout: 30_000 }
    );

    const binaryB64 = Buffer.from(BINARY_FIXTURE_BYTES).toString('base64');
    await seedBinaryAttachment(page, binaryB64);

    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.evaluate(() => {
      const menu = document.querySelector('slicc-avatar-menu');
      if (!menu) throw new Error('slicc-avatar-menu not found in DOM');
      menu.dispatchEvent(
        new CustomEvent('slicc-avatar-action', {
          detail: { id: 'export-transcript' },
          bubbles: true,
          composed: true,
        })
      );
    });

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    const filePath = await download.path();
    expect(filePath).not.toBeNull();
    const zipBytes = fs.readFileSync(filePath!);

    expect(zipBytes[0]).toBe(0x50);
    expect(zipBytes[1]).toBe(0x4b);
    expect(zipBytes[2]).toBe(0x03);
    expect(zipBytes[3]).toBe(0x04);

    const entries = unzip(zipBytes);
    const entryNames = Object.keys(entries);
    expect(entryNames).toContain('transcript.json');

    const transcriptJson = JSON.parse(decode(entries['transcript.json']!)) as Record<
      string,
      unknown
    >;

    expect(transcriptJson['schemaVersion']).toBe(1);

    const exportMeta = transcriptJson['export'] as Record<string, unknown>;
    expect(exportMeta['format']).toBe('slicc-transcript');
    expect((exportMeta['producer'] as Record<string, unknown>)['application']).toBe('slicc');

    const session = transcriptJson['session'] as Record<string, unknown>;
    expect(['active', 'frozen']).toContain(session['state']);

    const privacy = transcriptJson['privacy'] as Record<string, unknown>;
    expect(privacy['reasoningExcluded']).toBe(true);
    expect(privacy['binaryAttachments']).toBe('included-unchanged');

    const conversations = transcriptJson['conversations'] as Array<Record<string, unknown>>;
    const cone = conversations.find((c) => c['kind'] === 'cone');
    expect(cone).toBeDefined();
    expect((cone!['messages'] as unknown[]).length).toBeGreaterThan(0);

    const scoop = conversations.find((c) => c['kind'] === 'scoop');
    expect(scoop).toBeDefined();
    expect((scoop!['messages'] as unknown[]).length).toBeGreaterThan(0);

    const transcriptText = decode(entries['transcript.json']!);
    expect(transcriptText).not.toContain(CREDENTIAL_PATTERN);

    const allMessages = conversations.flatMap(
      (c) => (c['messages'] as Array<Record<string, unknown>>) ?? []
    );
    for (const msg of allMessages) {
      const content = (msg['content'] as Array<Record<string, unknown>>) ?? [];
      for (const block of content) {
        expect(block['type']).not.toBe('reasoning');
      }
    }

    const attachmentEntries = entryNames.filter((n) => n.startsWith('attachments/'));
    expect(attachmentEntries.length).toBeGreaterThanOrEqual(1);
    const attachmentBytes = entries[attachmentEntries[0]!]!;
    expect(Array.from(attachmentBytes)).toEqual(Array.from(BINARY_FIXTURE_BYTES));
  });
});
