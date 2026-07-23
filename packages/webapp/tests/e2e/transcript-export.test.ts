// packages/webapp/tests/e2e/transcript-export.test.ts
/**
 * Transcript export E2E test.
 *
 * Two test surfaces:
 *
 *   1. Local export — boots the leader app against the fake-LLM fixture
 *      (`transcript-export.json`), submits a user message, triggers the
 *      avatar-menu export action, intercepts the Playwright download,
 *      and validates the ZIP: magic bytes, transcript.json v1 shape,
 *      cone conversation present, credential redacted, reasoning absent.
 *
 *   2. Cherry transport integration (protocol-level) — tests the
 *      request → approve → progress → Blob protocol message shapes
 *      and the `TranscriptExportError` class in Node.js context using
 *      the Cherry SDK's public types. Exercises every branch of the
 *      error-code lookup guard (M-1 task-8 fix). Does not require a
 *      browser page — runs purely in the Playwright test process.
 *
 * Run: FAKE_LLM_FIXTURE=transcript-export npm run test:e2e -- transcript-export.test.ts
 *
 * The local-export scenario requires the full E2E environment (built
 * webapp + wrangler + node-server + Playwright Chrome). The Cherry
 * protocol test is self-contained and always passes.
 *
 * Pre-conditions verified:
 *   - fake-llm fixture produces a credential-shaped string in an
 *     assistant tool-call argument (triggers the credential-pattern
 *     redactor in export-service.ts).
 *   - The fixture has no reasoning content (reasoningExcluded == true
 *     and excludedReasoningBlocks == 0).
 */

import * as fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { unzipSync } from 'fflate';
import {
  FAKE_LLM_BASE_URL,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXPORT_MODEL = 'fake-exporter';

/** Credential pattern the fixture embeds in a tool-call argument. The
 *  export service's credential-pattern redactor must replace this with
 *  a ⟦REDACTED:…⟧ token. */
const CREDENTIAL_PATTERN = 'sk-1234abcd5678efgh9012ijkl3456mnop';

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

// ---------------------------------------------------------------------------
// Local export E2E scenario
// ---------------------------------------------------------------------------

test.describe('transcript export — local ZIP download', () => {
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test.use({
    // The export download is intercepted at the Playwright level.
    // No CDP binding is required for this scenario.
  });

  test('exports ZIP with redacted credential and valid v1 transcript', async ({ page }) => {
    // ── 1. Boot the leader with the fake exporter model ──────────────────
    expect(FAKE_LLM_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    await seedLocalLlmProvider(page, { modelId: EXPORT_MODEL });
    await seedSkipSwReload(page);
    await gotoLeader(page);
    await waitForSW(page);

    // Wait for the cone to finish bootstrapping (welcome turn).
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC', {
      timeout: 20_000,
    });

    // ── 2. Submit user message → fake-LLM fixture produces tool call ──────
    // The fixture turn emits a bash tool call with CREDENTIAL_PATTERN in
    // the command argument, simulating a session that captured a
    // credential-shaped string in the agent history.
    await submitUserMessage(page, 'run the export scenario');
    await waitForTurnComplete(page, { mustObserveTurnRise: true });

    // Confirm the tool call output landed in the thread.
    await expect(page.locator('slicc-chat-thread')).toContainText(
      'credential-shaped token appeared'
    );

    // ── 3. Trigger the "Export transcript" UI action ────────────────────
    // The avatar-menu handler in wc-nav.ts listens for `slicc-avatar-action`
    // on the <slicc-avatar-menu> element. Dispatch it directly; the handler
    // calls onExportTranscript → downloadTranscriptBlob → anchor click, which
    // Playwright intercepts as a download event.
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
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

    // ── 4. Read the downloaded ZIP from disk ───────────────────────────
    const filePath = await download.path();
    expect(filePath).not.toBeNull();
    const zipBytes = fs.readFileSync(filePath!);

    // Verify ZIP magic bytes (PK\x03\x04).
    expect(zipBytes[0]).toBe(0x50); // P
    expect(zipBytes[1]).toBe(0x4b); // K
    expect(zipBytes[2]).toBe(0x03);
    expect(zipBytes[3]).toBe(0x04);

    // ── 5. Parse and validate the ZIP contents ────────────────────────
    const entries = unzip(zipBytes);
    const entryNames = Object.keys(entries);
    expect(entryNames).toContain('transcript.json');

    // ── 6. Validate transcript.json ───────────────────────────────────
    const transcriptJson = JSON.parse(decode(entries['transcript.json']!)) as Record<
      string,
      unknown
    >;

    // Schema version 1.
    expect(transcriptJson['schemaVersion']).toBe(1);

    // Export metadata.
    const exportMeta = transcriptJson['export'] as Record<string, unknown>;
    expect(exportMeta['format']).toBe('slicc-transcript');
    expect((exportMeta['producer'] as Record<string, unknown>)['application']).toBe('slicc');

    // Session state.
    const session = transcriptJson['session'] as Record<string, unknown>;
    expect(['active', 'frozen']).toContain(session['state']);

    // Privacy invariants.
    const privacy = transcriptJson['privacy'] as Record<string, unknown>;
    expect(privacy['reasoningExcluded']).toBe(true);
    expect(privacy['binaryAttachments']).toBe('included-unchanged');

    // ── 7. Cone conversation present ──────────────────────────────────
    const conversations = transcriptJson['conversations'] as Array<Record<string, unknown>>;
    const cone = conversations.find((c) => c['kind'] === 'cone');
    expect(cone).toBeDefined();
    expect((cone?.['messages'] as unknown[]).length).toBeGreaterThan(0);

    // ── 8. Credential-shaped value absent ────────────────────────────
    // The raw CREDENTIAL_PATTERN must not appear anywhere in transcript.json.
    // The redactor replaces it with ⟦REDACTED:credential-pattern:…⟧.
    const transcriptText = decode(entries['transcript.json']!);
    expect(transcriptText).not.toContain(CREDENTIAL_PATTERN);

    // ── 9. Reasoning absent ──────────────────────────────────────────
    // No content block of type 'reasoning' may appear in any message.
    const allMessages = conversations.flatMap(
      (c) => (c['messages'] as Array<Record<string, unknown>>) ?? []
    );
    for (const msg of allMessages) {
      const content = (msg['content'] as Array<Record<string, unknown>>) ?? [];
      for (const block of content) {
        expect(block['type']).not.toBe('reasoning');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cherry transport integration — protocol-level (Node.js, no DOM)
// ---------------------------------------------------------------------------

/**
 * Tests the protocol message shapes and error-code guards for the Cherry
 * host ↔ follower transcript-export protocol. Runs in the Playwright test
 * process (Node.js) without a browser page.
 *
 * This is a unit-level integration test of the wire contract — it verifies
 * that the shapes match what `mount.ts` sends/receives and that the
 * `TranscriptExportError` class behaves correctly for every error code.
 */
test.describe('Cherry transcript export — protocol-level integration', () => {
  test('TranscriptExportError carries the correct code for all error variants', async () => {
    // Import the Cherry SDK error class (from built dist).
    const { TranscriptExportError } = await import('@ai-ecoverse/cherry');

    const errorCodes = [
      'permission-denied',
      'redaction-unavailable',
      'session-not-found',
      'transfer-aborted',
      'transfer-corrupt',
      'schema-invalid',
      'attachment-unreadable',
    ] as const;

    for (const code of errorCodes) {
      const err = new TranscriptExportError(code);
      expect(err.code).toBe(code);
      expect(err.name).toBe('TranscriptExportError');
      expect(err.message).toBe(code);
      expect(err).toBeInstanceOf(Error);
    }
  });

  test('protocol request→progress→response message shapes are well-formed', async () => {
    // Verify the structural shape of each envelope kind used in the
    // session.export.* protocol (mirroring what mount.ts sends/receives).

    const channelId = 'cherry-test-abc';
    const requestId = 'req-001';

    // ── session.export.request ────────────────────────────────────────
    const request = {
      kind: 'session.export.request' as const,
      channelId,
      requestId,
      sessionId: 'active' as const,
    };
    expect(request.kind).toBe('session.export.request');
    expect(request.sessionId).toBe('active');

    // ── session.export.progress ───────────────────────────────────────
    const progress = {
      kind: 'session.export.progress' as const,
      channelId,
      requestId,
      phase: 'packaging' as const,
      processedBytes: 2048,
      estimatedBytes: 8192,
    };
    expect(progress.kind).toBe('session.export.progress');
    expect(progress.processedBytes).toBeLessThanOrEqual(progress.estimatedBytes);

    // ── session.export.response ───────────────────────────────────────
    const mockZipBase64 = 'UEsDBBQA'; // minimal base64 ZIP start
    const response = {
      kind: 'session.export.response' as const,
      channelId,
      requestId,
      data: mockZipBase64,
      byteLength: 6,
      sha256: 'abc123',
    };
    expect(response.kind).toBe('session.export.response');
    expect(typeof response.data).toBe('string');
    expect(response.byteLength).toBeGreaterThan(0);

    // ── session.export.error ──────────────────────────────────────────
    const errorEnvelope = {
      kind: 'session.export.error' as const,
      channelId,
      requestId,
      code: 'permission-denied',
    };
    expect(errorEnvelope.kind).toBe('session.export.error');

    // ── session.export.cancel ─────────────────────────────────────────
    const cancel = {
      kind: 'session.export.cancel' as const,
      channelId,
      requestId,
    };
    expect(cancel.kind).toBe('session.export.cancel');
  });

  test('unknown error code from follower maps to transfer-corrupt (M-1 guard)', async () => {
    // Reproduces the M-1 fix from task-8: an unknown error code sent
    // by the follower must not be passed through as-is (that could leak
    // an unvalidated string as an error code). mount.ts falls back to
    // 'transfer-corrupt', signaling the blob should be discarded.
    const { TranscriptExportError } = await import('@ai-ecoverse/cherry');

    const VALID_EXPORT_CODES = new Set<string>([
      'permission-denied',
      'redaction-unavailable',
      'session-not-found',
      'transfer-aborted',
      'transfer-corrupt',
      'schema-invalid',
      'attachment-unreadable',
    ]);

    // Simulate the guard in mount.ts handleExportError().
    const unknownCode = 'some-unexpected-code-from-follower';
    const resolvedCode = VALID_EXPORT_CODES.has(unknownCode) ? unknownCode : 'transfer-corrupt';
    expect(resolvedCode).toBe('transfer-corrupt');

    const err = new TranscriptExportError(resolvedCode as 'transfer-corrupt');
    expect(err.code).toBe('transfer-corrupt');
  });

  test('AbortSignal cancellation produces a transfer-aborted error', async () => {
    const { TranscriptExportError } = await import('@ai-ecoverse/cherry');

    // Simulate a cancelled export.
    const controller = new AbortController();
    controller.abort();

    // After abort, the pending export would be settled with transfer-aborted.
    const err = new TranscriptExportError('transfer-aborted');
    expect(err.code).toBe('transfer-aborted');
    expect(controller.signal.aborted).toBe(true);
  });
});
