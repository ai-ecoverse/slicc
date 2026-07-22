import { describe, expect, it, vi } from 'vitest';
import { TranscriptExportError } from '@slicc/shared-ts';
import { redactTranscript } from '../../src/transcript/redact.js';
import { makeTranscriptDocument } from './fixtures.js';

describe('redactTranscript', () => {
  it('walks nested JSON and text attachments with stable export-local markers', async () => {
    const knownSecrets = {
      redact: vi.fn(async (texts: readonly string[]) =>
        texts.map((t) => t.replaceAll('known-real-secret', '⟦REDACTED:known-secret:k1⟧')),
      ),
    };
    const document = makeTranscriptDocument({
      toolInput: { token: 'known-real-secret', apiKey: 'sk-live-1234567890' },
    });
    const result = await redactTranscript(
      document,
      new Map([['att-1', 'password=hunter2']]),
      knownSecrets,
    );
    expect(JSON.stringify(result.document)).not.toContain('known-real-secret');
    expect(JSON.stringify(result.document)).not.toContain('sk-live-1234567890');
    expect(result.textAttachments.get('att-1')).toContain('⟦REDACTED:password:');
    expect(result.document.privacy.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: { kind: 'attachment', attachmentId: 'att-1' } }),
      ]),
    );
  });

  it('throws redaction-unavailable on batch failure', async () => {
    const knownSecrets = {
      redact: vi.fn(async () => {
        throw new Error('service down');
      }),
    };
    const doc = makeTranscriptDocument({ text: 'hello' });
    await expect(redactTranscript(doc, new Map(), knownSecrets)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable on length mismatch', async () => {
    const knownSecrets = {
      redact: vi.fn(async (texts: readonly string[]) => texts.slice(0, -1)),
    };
    const doc = makeTranscriptDocument({ text: 'hello' });
    await expect(redactTranscript(doc, new Map(), knownSecrets)).rejects.toMatchObject({
      code: 'redaction-unavailable',
    });
  });

  it('throws redaction-unavailable on abort', async () => {
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument({ text: 'hello' });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      redactTranscript(doc, new Map(), knownSecrets, ctrl.signal),
    ).rejects.toMatchObject({ code: 'redaction-unavailable' });
  });

  it('treats existing ⟦REDACTED: markers as pre-obfuscated', async () => {
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument({ text: '⟦REDACTED:jwt:old-1⟧ preserved' });
    const result = await redactTranscript(doc, new Map(), knownSecrets);
    expect(JSON.stringify(result.document)).toContain('⟦REDACTED:jwt:old-1⟧');
    expect(result.document.privacy.redactions.some((r) => r.detector === 'pre-obfuscated')).toBe(
      true,
    );
  });

  it('populates redactionCounts keyed by category', async () => {
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument({
      toolInput: { key: 'sk-live-abcdefghij' },
    });
    const result = await redactTranscript(doc, new Map(), knownSecrets);
    expect(result.document.privacy.redactionCounts['api-key']).toBeGreaterThanOrEqual(1);
  });

  it('returns empty textAttachments when none provided', async () => {
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument();
    const result = await redactTranscript(doc, new Map(), knownSecrets);
    expect(result.textAttachments.size).toBe(0);
  });

  it('validates output document with validateTranscriptDocumentV1', async () => {
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument({ toolInput: { key: 'sk-live-abcdefghij' } });
    const result = await redactTranscript(doc, new Map(), knownSecrets);
    const { validateTranscriptDocumentV1 } = await import('@slicc/shared-ts');
    expect(validateTranscriptDocumentV1(result.document)).toEqual({ ok: true });
  });

  it('knownSecrets redact is called with all string leaves', async () => {
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument({ text: 'inspect' });
    await redactTranscript(doc, new Map([['a', 'attached']]), knownSecrets);
    const allCalls = knownSecrets.redact.mock.calls.flat(2) as string[];
    expect(allCalls).toContain('inspect');
    expect(allCalls).toContain('attached');
  });

  it('does not expose TranscriptExportError as plain Error', async () => {
    const knownSecrets = {
      redact: vi.fn(async () => {
        throw new Error('oops');
      }),
    };
    const doc = makeTranscriptDocument();
    try {
      await redactTranscript(doc, new Map(), knownSecrets);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TranscriptExportError);
    }
  });
});
