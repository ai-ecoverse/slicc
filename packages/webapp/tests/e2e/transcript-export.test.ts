// packages/webapp/tests/e2e/transcript-export.test.ts
/**
 * Transcript export E2E test.
 *
 * Boots the leader app against the fake-LLM fixture (`transcript-export.json`),
 * submits a user message, seeds a binary attachment into the UI session store,
 * triggers the avatar-menu export action, intercepts the Playwright download,
 * and validates the ZIP:
 *
 *   - ZIP magic bytes and document schema v1.
 *   - Cone conversation present with messages.
 *   - Scoop conversation present (spawned by the `scoop_scoop` fixture turn).
 *   - Credential-shaped value absent (replaced by the redactor).
 *   - Reasoning absent (no `type: 'reasoning'` content blocks).
 *   - Binary attachment present with exact byte identity.
 *
 * Cherry transport integration tests live in the correct package:
 *   packages/cherry/tests/mount.test.ts — exportSession describe block
 *   packages/webapp/tests/cdp/cherry-host-transport.test.ts — CherryHostTransport
 * Those tests use the real mountSliccImpl/testReceive seams and cover the
 * full protocol (request→progress→response, unknown code M-1 guard, abort,
 * concurrent exports, stale/untrusted envelopes) without any DOM environment.
 *
 * Run: FAKE_LLM_FIXTURE=transcript-export npm run test:e2e -- transcript-export.test.ts
 *
 * Requires the full E2E environment: built webapp (dist/ui) + wrangler dev +
 * node-server thin bridge + Playwright Chrome. The three `webServer` entries in
 * playwright.config.ts start them automatically; no manual steps are needed.
 *
 * Fixture notes:
 *   - The fake-LLM fixture produces a bash tool call with a credential-shaped
 *     string (triggers the credential-pattern redactor in export-service.ts)
 *     AND a `scoop_scoop` call (spawns a real scoop named "verifier").
 *   - The fixture has no reasoning content (reasoningExcluded == true, count 0).
 *   - A known 8-byte binary buffer is injected into the cone UI session in IDB
 *     before export; the export service includes it unchanged in attachments/.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import {
  FAKE_LLM_BASE_URL,
  loadFakeLlmFixture,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

/** Read a fixture JSON from the fake-llm fixtures directory. */
function readFixture(name: string): unknown {
  const dir = fileURLToPath(new URL('./fake-llm/fixtures/', import.meta.url));
  return JSON.parse(fs.readFileSync(`${dir}${name}.json`, 'utf8'));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPORT_MODEL = 'fake-exporter';

/** Credential pattern the fixture embeds in a bash tool-call argument. The
 *  export service's credential-pattern redactor must replace this with
 *  a ⟦REDACTED:…⟧ token. */
const CREDENTIAL_PATTERN = 'sk-proj-1234abcd5678efgh9012ijkl3456mnop';

/** Known binary bytes seeded into the cone session before export.
 *  PNG magic header — deterministic and easily identified in the ZIP.
 *  The export service copies binary attachments unchanged; the test
 *  verifies the ZIP bytes match exactly. */
const BINARY_FIXTURE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse ZIP bytes using fflate and return a map of filename → bytes. */
function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

/** Decode UTF-8 bytes to string. */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Inject a synthetic binary MessageAttachment onto the first user message in
 * the `session-cone` UI session (IndexedDB `browser-coding-agent` / `sessions`
 * store). The export service's Phase-2 attachment walk picks up `kind='file'`
 * attachments whose `data` field is set, copies the bytes unchanged into the
 * ZIP bundle, and records them in `transcript.json`'s `attachments[]` array.
 *
 * Must be called after `waitForTurnComplete` so the session-cone record exists.
 */
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
              // Session not yet written — resolve silently; attachment will be absent.
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

// ---------------------------------------------------------------------------
// Transcript export — local ZIP download
// ---------------------------------------------------------------------------

test.describe('transcript export — local ZIP download', () => {
  test.beforeEach(async () => {
    // resetFakeLlm() contacts the fake-LLM server started by the `webServer`
    // entry in playwright.config.ts. If the server is not running (i.e. the
    // Playwright webServer failed to start), this throws ECONNREFUSED and the
    // test fails with a clear diagnostic — not silently skipped.
    await resetFakeLlm();
    // The shared CI webServer boots the default reference-scenario fixture.
    // This test needs the transcript-export turns, so swap them in at runtime.
    await loadFakeLlmFixture(readFixture('transcript-export'));
  });

  test.afterEach(async () => {
    // Restore the boot default so later serial tests (workers: 1) that rely on
    // the reference scenario see the fixture they expect.
    await loadFakeLlmFixture(readFixture('reference-scenario'));
  });

  test('exports ZIP: cone + scoop conversations, binary unchanged, credential redacted', async ({
    page,
  }) => {
    // ── 1. Boot the leader with the fake exporter model ──────────────────
    expect(FAKE_LLM_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    await seedLocalLlmProvider(page, { modelId: EXPORT_MODEL });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);

    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    // ── 2. Submit user message ─────────────────────────────────────────────
    // The fixture turn emits:
    //   (a) a bash tool call with CREDENTIAL_PATTERN in the command argument
    //   (b) a scoop_scoop call that spawns a "verifier" scoop with prompt
    //       "verify-export-scoop"
    // The fake-LLM server serves the scoop's LLM call from a turn matched on
    // "verify-export-scoop". The fixture uses onOverflow:'repeat-last' so any
    // ordering between the scoop and cone continuation is safe.
    await submitUserMessage(page, 'run the export scenario');
    await waitForTurnComplete(page, { mustObserveTurnRise: true });

    await expect(page.locator('slicc-chat-thread')).toContainText(
      'credential-shaped token appeared'
    );

    // ── 3. Seed binary attachment into the cone UI session ─────────────────
    // Injected after the turn so session-cone is already written by the WC
    // shell's chat controller. The export service's Phase-2 attachment walk
    // reads kind='file' attachments with data set and copies bytes unchanged.
    const binaryB64 = Buffer.from(BINARY_FIXTURE_BYTES).toString('base64');
    await seedBinaryAttachment(page, binaryB64);

    // ── 4. Trigger the "Export transcript" UI action ───────────────────────
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

    // The export service waits for any in-flight scoop (collectActiveTranscriptSources
    // polls until isProcessing returns false for all scoops). Allow generous timeout.
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);

    // ── 5. Read the downloaded ZIP ────────────────────────────────────────
    const filePath = await download.path();
    expect(filePath).not.toBeNull();
    const zipBytes = fs.readFileSync(filePath!);

    // ZIP magic bytes (PK\x03\x04).
    expect(zipBytes[0]).toBe(0x50); // P
    expect(zipBytes[1]).toBe(0x4b); // K
    expect(zipBytes[2]).toBe(0x03);
    expect(zipBytes[3]).toBe(0x04);

    // ── 6. Parse ZIP entries ──────────────────────────────────────────────
    const entries = unzip(zipBytes);
    const entryNames = Object.keys(entries);
    expect(entryNames).toContain('transcript.json');

    // ── 7. Validate transcript.json ───────────────────────────────────────
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

    // ── 8. Cone conversation present ──────────────────────────────────────
    const conversations = transcriptJson['conversations'] as Array<Record<string, unknown>>;
    const cone = conversations.find((c) => c['kind'] === 'cone');
    expect(cone).toBeDefined();
    expect((cone!['messages'] as unknown[]).length).toBeGreaterThan(0);

    // ── 9. Scoop conversation present ─────────────────────────────────────
    // The fixture spawns a "verifier" scoop via scoop_scoop. The export
    // service (collectActiveTranscriptSources) waits until all scoops finish,
    // then includes each scoop conversation in conversations[] with kind:'scoop'.
    const scoop = conversations.find((c) => c['kind'] === 'scoop');
    expect(scoop).toBeDefined();
    expect((scoop!['messages'] as unknown[]).length).toBeGreaterThan(0);

    // ── 10. Credential-shaped value absent ────────────────────────────────
    // The raw CREDENTIAL_PATTERN must not appear in transcript.json.
    const transcriptText = decode(entries['transcript.json']!);
    expect(transcriptText).not.toContain(CREDENTIAL_PATTERN);

    // ── 11. Reasoning absent ─────────────────────────────────────────────
    const allMessages = conversations.flatMap(
      (c) => (c['messages'] as Array<Record<string, unknown>>) ?? []
    );
    for (const msg of allMessages) {
      const content = (msg['content'] as Array<Record<string, unknown>>) ?? [];
      for (const block of content) {
        expect(block['type']).not.toBe('reasoning');
      }
    }

    // ── 12. Binary attachment present with exact byte identity ────────────
    // The seedBinaryAttachment helper injected BINARY_FIXTURE_BYTES (base64
    // encoded) as a kind='file' MessageAttachment on the first user message.
    // The export service reads these bytes from the IDB attachment record and
    // copies them unchanged into attachments/. The test verifies the ZIP entry
    // contains exactly the bytes we seeded — no corruption, no re-encoding.
    const attachmentEntries = entryNames.filter((n) => n.startsWith('attachments/'));
    expect(attachmentEntries.length).toBeGreaterThanOrEqual(1);
    const attachmentBytes = entries[attachmentEntries[0]!]!;
    expect(Array.from(attachmentBytes)).toEqual(Array.from(BINARY_FIXTURE_BYTES));
  });
});
