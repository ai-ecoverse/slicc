import {
  redactCredentialPatterns,
  type TranscriptDocumentV1,
  TranscriptExportError,
  validateTranscriptDocumentV1,
} from '@slicc/shared-ts';
import { describe, expect, it, vi } from 'vitest';
import { redactTranscript } from '../../src/transcript/redact.js';
import { makeTranscriptDocument } from './fixtures.js';

describe('redactTranscript', () => {
  it('walks nested JSON and text attachments with stable export-local markers', async () => {
    const knownSecrets = {
      redact: vi.fn(async (texts: readonly string[]) =>
        texts.map((t) => t.replaceAll('known-real-secret', '⟦REDACTED:known-secret:k1⟧'))
      ),
    };
    const document = makeTranscriptDocument({
      toolInput: { token: 'known-real-secret', apiKey: 'sk-live-1234567890' },
    });
    const result = await redactTranscript(
      document,
      new Map([['att-1', 'password=hunter2']]),
      knownSecrets
    );
    expect(JSON.stringify(result.document)).not.toContain('known-real-secret');
    expect(JSON.stringify(result.document)).not.toContain('sk-live-1234567890');
    expect(result.textAttachments.get('att-1')).toContain('⟦REDACTED:password:');
    expect(result.document.privacy.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: { kind: 'attachment', attachmentId: 'att-1' } }),
      ])
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
    await expect(redactTranscript(doc, new Map(), knownSecrets, ctrl.signal)).rejects.toMatchObject(
      { code: 'redaction-unavailable' }
    );
  });

  it('treats existing ⟦REDACTED: markers as pre-obfuscated', async () => {
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument({ text: '⟦REDACTED:jwt:old-1⟧ preserved' });
    const result = await redactTranscript(doc, new Map(), knownSecrets);
    expect(JSON.stringify(result.document)).toContain('⟦REDACTED:jwt:old-1⟧');
    expect(result.document.privacy.redactions.some((r) => r.detector === 'pre-obfuscated')).toBe(
      true
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

  it('deduplicates repeated pre-obfuscated markers for the same target', async () => {
    // Same marker appearing twice in one string → one record, not two.
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument({
      text: '⟦REDACTED:jwt:old-1⟧ and ⟦REDACTED:jwt:old-1⟧',
    });
    const result = await redactTranscript(doc, new Map(), knownSecrets);
    const preObs = result.document.privacy.redactions.filter(
      (r) => r.detector === 'pre-obfuscated'
    );
    expect(preObs).toHaveLength(1);
    expect(result.document.privacy.redactionCounts['jwt']).toBe(1);
  });

  it('classifies same-id marker as known-secret when occurrence count grows', async () => {
    // Original has ⟦REDACTED:known-secret:k1⟧ (pre-obfuscated). knownSecrets
    // replaces another occurrence of the same secret with the same marker text.
    // Multiset comparison detects the count increase and classifies it known-secret.
    const knownSecrets = {
      redact: vi.fn(async (texts: readonly string[]) =>
        texts.map((t) => t.replaceAll('real-secret', '⟦REDACTED:known-secret:k1⟧'))
      ),
    };
    const doc = makeTranscriptDocument({ text: '⟦REDACTED:known-secret:k1⟧ real-secret' });
    const result = await redactTranscript(doc, new Map(), knownSecrets);
    const preObs = result.document.privacy.redactions.filter(
      (r) => r.detector === 'pre-obfuscated'
    );
    const ks = result.document.privacy.redactions.filter((r) => r.detector === 'known-secret');
    expect(preObs).toHaveLength(1);
    expect(ks.some((r) => r.id === 'k1' && r.category === 'known-secret')).toBe(true);
  });

  it('does not send privacy metadata strings to knownSecrets', async () => {
    // Privacy subtree is skipped during leaf collection. To make this test
    // falsifiable: inject a sentinel string as a string-leaf value inside
    // privacy.redactions[0].id. Without the docWithoutPrivacy optimization,
    // collectLeaves would walk the privacy subtree and send the sentinel to
    // knownSecrets. Removing the optimization causes this test to fail.
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const sentinel = 'PRIVACY-SENTINEL-DO-NOT-REDACT-9f3a';
    const doc = makeTranscriptDocument({ text: 'hello' });
    const docWithPrivacyData: typeof doc = {
      ...doc,
      privacy: {
        ...doc.privacy,
        redactions: [
          {
            id: sentinel,
            category: 'jwt',
            detector: 'pre-obfuscated',
            target: { kind: 'json', pointer: '/conversations/0' },
          },
        ],
      },
    };
    await redactTranscript(docWithPrivacyData, new Map(), knownSecrets);
    const allTexts = knownSecrets.redact.mock.calls.flat(2) as string[];
    // sentinel is a string leaf in privacy.redactions[0].id — it reaches
    // knownSecrets only if the privacy subtree is walked. Must stay absent.
    expect(allTexts).not.toContain(sentinel);
  });
});

// ---------------------------------------------------------------------------
// Bearer-token case-insensitive detection (wave 2, item 5)
// ---------------------------------------------------------------------------

describe('redactCredentialPatterns — bearer-token case-insensitive', () => {
  it('redacts title-case Bearer token', () => {
    const { text, matches } = redactCredentialPatterns('Auth: Bearer abc123XYZ', 'r', 1);
    expect(text).not.toContain('abc123XYZ');
    expect(matches.some((m) => m.category === 'bearer-token')).toBe(true);
  });

  it('redacts lowercase bearer token', () => {
    const { text, matches } = redactCredentialPatterns('bearer abc123XYZ', 'r', 1);
    expect(text).not.toContain('abc123XYZ');
    expect(matches.some((m) => m.category === 'bearer-token')).toBe(true);
  });

  it('redacts uppercase BEARER token', () => {
    const { text, matches } = redactCredentialPatterns('BEARER abc123XYZ', 'r', 1);
    expect(text).not.toContain('abc123XYZ');
    expect(matches.some((m) => m.category === 'bearer-token')).toBe(true);
  });

  it('redacts mixed-case bEaReR token', () => {
    const { text, matches } = redactCredentialPatterns('bEaReR myToken.abc', 'r', 1);
    expect(text).not.toContain('myToken.abc');
    expect(matches.some((m) => m.category === 'bearer-token')).toBe(true);
  });

  it('redacts bearer token inside a larger string', () => {
    const { text } = redactCredentialPatterns(
      'Authorization: BEARER tok_abc123 and other data',
      'r',
      1
    );
    expect(text).not.toContain('tok_abc123');
    expect(text).toContain('other data');
  });

  it('redacts bearer token in redactTranscript end-to-end', async () => {
    const knownSecrets = { redact: vi.fn(async (ts: readonly string[]) => [...ts]) };
    const doc = makeTranscriptDocument({ text: 'BEARER secret-token-xyz' });
    const result = await redactTranscript(doc, new Map(), knownSecrets);
    expect(JSON.stringify(result.document)).not.toContain('secret-token-xyz');
    expect(result.document.privacy.redactions.some((r) => r.category === 'bearer-token')).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: redacted output must still satisfy the schema (#2845)
// ---------------------------------------------------------------------------

/**
 * A known-secret redactor that behaves exactly like the real one
 * (`SecretsPipeline.redactForExport`): plain `replaceAll` of the secret's
 * value, with no regard for where in the document that value happens to occur.
 *
 * A stored secret shorter than `MIN_MASKABLE_SECRET_LENGTH` is deliberately
 * still substituted on the export path, so `value` can legitimately be one
 * character — which is what turned a developer's transcript export into a bare
 * `schema-invalid` (#2845). CI never saw it because CI's secret store is empty.
 */
function substringRedactor(value: string): {
  redact: (texts: readonly string[]) => Promise<string[]>;
} {
  return {
    redact: async (texts: readonly string[]) =>
      texts.map((t) => t.replaceAll(value, '⟦REDACTED:known-secret:k1⟧')),
  };
}

/** Fixture document extended with the constrained fields the base one omits. */
function documentWithAttachment(text: string): TranscriptDocumentV1 {
  const doc = makeTranscriptDocument({ text });
  return {
    ...doc,
    attachments: [
      {
        id: 'att-bin-1',
        path: 'attachments/att-bin-1.bin',
        originalName: 'fixture.bin',
        mimeType: 'application/octet-stream',
        byteLength: 8,
        sha256: '0'.repeat(64),
        sourceConversationId: 'cone',
        sourceMessageId: 'cone-msg-000001',
        handling: 'binary-unchanged',
        present: true,
      },
    ],
  };
}

describe('redactTranscript schema stability (#2845)', () => {
  it('leaves session.state intact when a one-character secret occurs inside it', async () => {
    // 'v' occurs in "active" — the exact failure seen locally, where the
    // redactor rewrote session.state to 'acti⟦REDACTED:…⟧e'.
    const doc = makeTranscriptDocument({ text: 'no match here' });
    const result = await redactTranscript(doc, new Map(), substringRedactor('v'));
    expect(result.document.session.state).toBe('active');
    expect(validateTranscriptDocumentV1(result.document)).toEqual({ ok: true });
  });

  it('keeps enums, ids, timestamps, paths and hashes valid against a degenerate secret', async () => {
    // '0' occurs in every ISO timestamp, in the SHA-256 hex, in the message ids
    // and in the attachment path — i.e. in every constrained field at once.
    const doc = documentWithAttachment('nothing to redact');
    const result = await redactTranscript(doc, new Map(), substringRedactor('0'));
    const validation = validateTranscriptDocumentV1(result.document);
    expect(validation).toEqual({ ok: true });

    const att = result.document.attachments[0]!;
    expect(att.sha256).toBe('0'.repeat(64));
    expect(att.path).toBe('attachments/att-bin-1.bin');
    const conv = result.document.conversations[0]!;
    expect(conv.kind).toBe('cone');
    expect(conv.messages[0]!.id).toBe('cone-msg-000001');
    expect(conv.messages[1]!.content[1]).toMatchObject({ type: 'tool-call', id: 'call-1' });
  });

  it('still redacts free-form message metadata (source, channel)', async () => {
    // `source`/`channel` are unconstrained and can hold a scoop name — the same
    // kind of content kept redactable as conversations[].name. Exempting them
    // would be fail-open, so they must not be in the structural set.
    const base = makeTranscriptDocument({ text: 'nothing' });
    const doc: TranscriptDocumentV1 = {
      ...base,
      conversations: [
        {
          ...base.conversations[0]!,
          messages: [
            { ...base.conversations[0]!.messages[0]!, source: 'vault-scoop', channel: 'vpn' },
            ...base.conversations[0]!.messages.slice(1),
          ],
        },
      ],
    };
    const result = await redactTranscript(doc, new Map(), substringRedactor('v'));
    const msg = result.document.conversations[0]!.messages[0]!;
    expect(msg.source).not.toContain('v');
    expect(msg.channel).not.toContain('v');
    expect(validateTranscriptDocumentV1(result.document)).toEqual({ ok: true });
  });

  it('still redacts every content-bearing field the same secret reaches', async () => {
    // Fail-closed is preserved: sparing the schema fields must not spare
    // titles, conversation names, message text, tool input or attachment names.
    const doc = documentWithAttachment('the vault token is vvv');
    const result = await redactTranscript(
      { ...doc, session: { ...doc.session, title: 'v-titled session' } },
      new Map([['att-bin-1', 'v-bearing attachment text']]),
      substringRedactor('v')
    );
    expect(result.document.session.title).not.toContain('v');
    expect(result.document.conversations[0]!.messages[1]!.content[0]).toEqual({
      type: 'text',
      text: 'the ⟦REDACTED:known-secret:k1⟧ault token is ⟦REDACTED:known-secret:k1⟧⟦REDACTED:known-secret:k1⟧⟦REDACTED:known-secret:k1⟧',
    });
    expect(result.textAttachments.get('att-bin-1')).not.toContain('v');
    expect(validateTranscriptDocumentV1(result.document)).toEqual({ ok: true });
  });
});
