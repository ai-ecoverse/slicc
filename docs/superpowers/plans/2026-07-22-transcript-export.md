# Complete Transcript Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export active or frozen cone-plus-scoop transcripts as an obfuscated, public JSON bundle with attachment files, including leader-approved Cherry delivery.

**Architecture:** A browser-safe transcript pipeline converts canonical Pi messages into a versioned public schema, removes reasoning, applies fail-closed export redaction, resolves attachments, and streams a ZIP. Active exports read the canonical `agent-sessions` IndexedDB; new frozen sessions persist the same sanitized snapshot before clear; legacy archives normalize to an explicitly partial document. Local UI, shell, tray followers, and the Cherry SDK all call the same export service.

**Tech Stack:** TypeScript 6, Vitest, IndexedDB, OPFS-backed VirtualFS, `fflate`, `js-sha256` incremental hashing, Web Crypto attachment hashing, WebRTC tray data channels, Cherry `postMessage`, Swift/Hummingbird parity for native secret scrubbing.

## Global Constraints

- Bundle contents are `transcript.json` plus `attachments/`; no pre-rendered HTML or raw Pi sidecar.
- Schema version starts at integer `1`; readers ignore unknown additive fields; breaking changes increment the version.
- Include the cone and every registered scoop as separate linked conversations.
- Include untruncated textual tool data plus model, usage, timing, stop, and error metadata.
- Exclude all reasoning/thinking content from snapshots, exports, redaction reports, errors, and logs.
- Export-time obfuscation is mandatory for all JSON and text-like attachment content.
- Obfuscation covers SLICC-known secrets plus deterministic credential patterns and fails closed.
- Binary attachment bytes are explicitly included unchanged; filenames and textual metadata are obfuscated.
- Every follower-originated request requires one leader **Allow once** decision; tray membership is insufficient.
- Legacy frozen sessions export under the same schema with `completeness.status: "partial"` and explicit reasons.
- Do not add dependencies; use existing `fflate`, `js-sha256`, Web Crypto, VFS, dialog, and protocol infrastructure.
- All code paths must work in standalone, extension leader, Electron, hosted leader, TS follower, and Cherry floats; iOS is protocol-compatible but cannot initiate version-1 exports.
- Keep functions at most 100 lines, cyclomatic complexity at most 8, and source lines at most 100 characters.

---

## File and Responsibility Map

### New public/shared files

- **packages/shared-ts/src/transcript-export.ts** — public schema types, constants, runtime validator, error codes, progress types.
- **packages/shared-ts/src/transcript-redaction.ts** — deterministic credential-pattern scanner and trusted-realm known-secret batch result types.
- **packages/shared-ts/tests/transcript-export.test.ts** — public contract and validator coverage.
- **packages/shared-ts/tests/transcript-redaction.test.ts** — pattern scanner coverage.
- **docs/schemas/slicc-transcript-v1.schema.json** — public JSON Schema.
- **docs/examples/transcript-v1/transcript.json** — fully obfuscated complete example.
- **docs/examples/transcript-v1/attachments/att-0001.txt** — redacted example attachment.

### New webapp transcript files

- **packages/webapp/src/transcript/normalize.ts** — pure Pi-message-to-public-schema conversion.
- **packages/webapp/src/transcript/redact.ts** — recursive JSON/text-file redaction orchestration.
- **packages/webapp/src/transcript/strict-secret-client.ts** — fail-closed float-specific known-secret batch RPC.
- **packages/webapp/src/transcript/attachments.ts** — attachment classification, opaque naming, redaction, hashing.
- **packages/webapp/src/transcript/snapshot-store.ts** — sanitized frozen snapshot read/write.
- **packages/webapp/src/transcript/collect.ts** — completed-turn cone/scoop collection.
- **packages/webapp/src/transcript/zip-stream.ts** — streaming ZIP and final digest.
- **packages/webapp/src/transcript/export-service.ts** — active/frozen/legacy orchestration.
- **packages/webapp/src/transcript/export-provider.ts** — shell/page registration seam for the shared service.
- **packages/webapp/src/ui/wc/wc-transcript-export.ts** — local download and leader approval dialog helpers.
- **packages/webapp/src/shell/supplemental-commands/session-command.ts** — `session export` CLI.

### New webapp tests

- **packages/webapp/tests/transcript/fixtures.ts**
- **packages/webapp/tests/transcript/normalize.test.ts**
- **packages/webapp/tests/transcript/redact.test.ts**
- **packages/webapp/tests/transcript/strict-secret-client.test.ts**
- **packages/webapp/tests/transcript/attachments.test.ts**
- **packages/webapp/tests/transcript/snapshot-store.test.ts**
- **packages/webapp/tests/transcript/collect.test.ts**
- **packages/webapp/tests/transcript/zip-stream.test.ts**
- **packages/webapp/tests/transcript/export-service.test.ts**
- **packages/webapp/tests/shell/supplemental-commands/session-command.test.ts**
- **packages/webapp/tests/ui/wc/wc-transcript-export.test.ts**
- **packages/webapp/tests/scoops/tray-transcript-export.test.ts**

### Existing files changed by integration

- `packages/shared-ts/src/index.ts`
- `packages/shared-ts/src/secrets-pipeline.ts`
- `packages/shared-ts/src/tray-sync-protocol.ts`
- `packages/webapp/src/core/session.ts`
- `packages/webapp/src/core/secrets-bridge-client.ts`
- `packages/webapp/src/scoops/types.ts`
- `packages/webapp/src/scoops/agent-bridge.ts`
- `packages/webapp/src/scoops/orchestrator.ts`
- `packages/webapp/src/scoops/tray-leader-sync.ts`
- `packages/webapp/src/scoops/tray-follower-sync.ts`
- `packages/webapp/src/scoops/tray-sync-protocol-corpus.ts`
- `packages/webapp/src/ui/session-freezer.ts`
- `packages/webapp/src/ui/new-session.ts`
- `packages/webapp/src/ui/wc/wc-live.ts`
- `packages/webapp/src/ui/wc/wc-nav.ts`
- `packages/webapp/src/ui/wc/wc-follower.ts`
- `packages/webapp/src/shell/supplemental-commands/index.ts`
- `packages/chrome-extension/src/service-worker.ts`
- `packages/node-server/src/routes/secrets.ts`
- `packages/swift-server/Sources/Keychain/SecretInjector.swift`
- `packages/swift-server/Sources/Server/APIRoutes.swift`
- `packages/cherry/src/index.ts`
- `packages/cherry/src/mount.ts`
- `packages/cherry/src/protocol.ts`
- `packages/webapp/src/cdp/cherry-host-protocol.ts`
- `packages/webapp/CLAUDE.md`
- `packages/cherry/CLAUDE.md`
- `docs/architecture.md`
- `docs/approvals.md`
- `docs/review-patterns.md`
- `.github/copilot-instructions.md`
- `docs/shell-reference.md`
- **packages/vfs-root/workspace/skills/transcript-export/SKILL.md**

---

### Task 1: Public Transcript Contract and JSON Schema

**Files:**
- Create: **packages/shared-ts/src/transcript-export.ts**
- Create: **packages/shared-ts/tests/transcript-export.test.ts**
- Create: **docs/schemas/slicc-transcript-v1.schema.json**
- Create: **docs/examples/transcript-v1/transcript.json**
- Create: **docs/examples/transcript-v1/attachments/att-0001.txt**
- Modify: `packages/shared-ts/src/index.ts`

**Interfaces:**
- Produces: `TranscriptDocumentV1`, `TranscriptConversation`, `TranscriptMessage`, `TranscriptContentBlock`, `TranscriptAttachment`, `TranscriptDelegation`, `TranscriptRedaction`, `TranscriptExportErrorCode`, `TranscriptExportProgress`, `validateTranscriptDocumentV1(value)`.
- Consumed by: every later task.

- [ ] **Step 1: Write validator and sample-contract tests**

```typescript
import { describe, expect, it } from 'vitest';
import {
  SLICC_TRANSCRIPT_FORMAT,
  TRANSCRIPT_SCHEMA_VERSION,
  validateTranscriptDocumentV1,
  type TranscriptDocumentV1,
} from '../src/transcript-export.js';

const completeDocument = (): TranscriptDocumentV1 => ({
  schemaVersion: 1,
  export: {
    id: 'export-1',
    generatedAt: '2026-07-22T12:00:00.000Z',
    producer: { application: 'slicc', version: '5.65.2' },
    format: 'slicc-transcript',
  },
  session: {
    id: 'session-1',
    title: 'Redacted example',
    state: 'active',
    completeness: { status: 'complete', missing: [] },
  },
  privacy: {
    reasoningExcluded: true,
    excludedReasoningBlocks: 1,
    binaryAttachments: 'included-unchanged',
    redactionCounts: { token: 1 },
    redactions: [
      {
        id: 'r1',
        category: 'token',
        detector: 'credential-pattern',
        target: { kind: 'json', pointer: '/conversations/0/messages/0/content/0/text' },
      },
    ],
  },
  conversations: [
    {
      id: 'cone',
      kind: 'cone',
      name: 'Sliccy',
      messages: [
        {
          id: 'cone-msg-000001',
          sequence: 1,
          role: 'user',
          timestamp: '2026-07-22T12:00:00.000Z',
          content: [{ type: 'text', text: 'Use ⟦REDACTED:token:r1⟧' }],
        },
      ],
    },
  ],
  delegations: [],
  attachments: [],
});

describe('TranscriptDocumentV1', () => {
  it('accepts the public complete document shape', () => {
    expect(TRANSCRIPT_SCHEMA_VERSION).toBe(1);
    expect(SLICC_TRANSCRIPT_FORMAT).toBe('slicc-transcript');
    expect(validateTranscriptDocumentV1(completeDocument())).toEqual({ ok: true });
  });

  it('rejects reasoning content and unsupported schema versions', () => {
    const bad = structuredClone(completeDocument()) as unknown as Record<string, unknown>;
    bad['schemaVersion'] = 2;
    expect(validateTranscriptDocumentV1(bad)).toEqual({
      ok: false,
      error: 'schemaVersion must equal 1',
    });
  });
});
```

- [ ] **Step 2: Run the test and confirm the contract is absent**

Run:

```bash
npm test -w @slicc/shared-ts -- transcript-export.test.ts
```

Expected: FAIL because `../src/transcript-export.js` does not exist.

- [ ] **Step 3: Implement the public TypeScript contract and strict runtime validator**

Create discriminated interfaces with these exact unions:

```typescript
export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const SLICC_TRANSCRIPT_FORMAT = 'slicc-transcript' as const;

export type TranscriptCompletenessReason =
  | 'canonical-agent-history-unavailable'
  | 'tool-data-may-be-truncated'
  | 'model-metadata-unavailable'
  | 'scoop-history-unavailable'
  | 'attachment-file-missing'
  | 'attachment-association-unavailable'
  | 'complete-snapshot-unavailable';

export type TranscriptExportErrorCode =
  | 'permission-denied'
  | 'redaction-unavailable'
  | 'session-not-found'
  | 'transfer-aborted'
  | 'transfer-corrupt'
  | 'schema-invalid'
  | 'attachment-unreadable';

export type TranscriptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'attachment-ref'; attachmentId: string };

export interface TranscriptMessage {
  id: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool-result';
  timestamp: string;
  content: TranscriptContentBlock[];
  toolCallId?: string;
  isError?: boolean;
  source?: string;
  channel?: string;
  model?: { provider: string; id: string; api?: string };
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
  stopReason?: string;
  error?: string;
}

export interface TranscriptConversation {
  id: string;
  kind: 'cone' | 'scoop';
  name: string;
  folder?: string;
  parentConversationId?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: TranscriptMessage[];
}

export interface TranscriptDelegation {
  sourceConversationId: string;
  targetConversationId: string;
  toolCallId?: string;
  timestamp?: string;
}

export interface TranscriptAttachment {
  id: string;
  path: string;
  originalName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  sourceConversationId: string;
  sourceMessageId: string;
  handling: 'text-redacted' | 'binary-unchanged';
  present: boolean;
  missingReason?: 'attachment-file-missing';
}

export interface TranscriptRedaction {
  id: string;
  category: string;
  detector: 'known-secret' | 'credential-pattern' | 'pre-obfuscated';
  target:
    | { kind: 'json'; pointer: string }
    | { kind: 'attachment'; attachmentId: string };
}

export interface TranscriptExportProgress {
  phase:
    | 'waiting-for-conversations'
    | 'collecting'
    | 'redacting'
    | 'packaging'
    | 'transferring'
    | 'complete';
  processedBytes?: number;
  estimatedBytes?: number;
}

export class TranscriptExportError extends Error {
  constructor(public readonly code: TranscriptExportErrorCode) {
    super(code);
    this.name = 'TranscriptExportError';
  }
}

export type TranscriptValidationResult = { ok: true } | { ok: false; error: string };

export interface TranscriptDocumentV1 {
  schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  export: {
    id: string;
    generatedAt: string;
    producer: { application: 'slicc'; version: string };
    format: typeof SLICC_TRANSCRIPT_FORMAT;
  };
  session: {
    id: string;
    title: string;
    state: 'active' | 'frozen';
    createdAt?: string;
    updatedAt?: string;
    frozenAt?: string;
    snapshotAt?: string;
    completeness: { status: 'complete' | 'partial'; missing: TranscriptCompletenessReason[] };
  };
  privacy: {
    reasoningExcluded: true;
    excludedReasoningBlocks: number;
    binaryAttachments: 'included-unchanged';
    redactionCounts: Record<string, number>;
    redactions: TranscriptRedaction[];
  };
  conversations: TranscriptConversation[];
  delegations: TranscriptDelegation[];
  attachments: TranscriptAttachment[];
}
```

Implement `validateTranscriptDocumentV1(value: unknown): TranscriptValidationResult` with focused
helpers for the top-level object, conversations, messages, content blocks, attachments, and
redactions. Check all required discriminators, arrays, scalar types, and the invariant
`reasoningExcluded === true`; never throw for untrusted input.

- [ ] **Step 4: Add the JSON Schema and example bundle directory**

The JSON Schema must set:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://www.sliccy.ai/schemas/transcript/v1.json",
  "title": "SLICC Transcript Bundle v1",
  "type": "object",
  "required": [
    "schemaVersion",
    "export",
    "session",
    "privacy",
    "conversations",
    "delegations",
    "attachments"
  ],
  "properties": {
    "schemaVersion": { "const": 1 }
  },
  "additionalProperties": true
}
```

Complete `$defs` for every TypeScript interface. Require known fields while leaving
`additionalProperties: true` so v1 readers can ignore additive fields. Make the example document
pass `validateTranscriptDocumentV1()` and contain only redacted text.

- [ ] **Step 5: Export the contract and run package checks**

Add to `packages/shared-ts/src/index.ts`:

```typescript
export * from './transcript-export.js';
```

Run:

```bash
npm test -w @slicc/shared-ts -- transcript-export.test.ts
npm run typecheck -w @slicc/shared-ts
npm run build -w @slicc/shared-ts
```

Expected: all commands PASS with zero warnings.

- [ ] **Step 6: Commit the public contract**

```bash
git add packages/shared-ts/src packages/shared-ts/tests docs/schemas docs/examples/transcript-v1
git commit -m "feat(shared-ts): define transcript export schema"
```

---

### Task 2: Pure Canonical Message Normalizer

**Files:**
- Create: **packages/webapp/src/transcript/normalize.ts**
- Create: **packages/webapp/tests/transcript/fixtures.ts**
- Create: **packages/webapp/tests/transcript/normalize.test.ts**

**Interfaces:**
- Consumes: `TranscriptDocumentV1` message/conversation types from Task 1 and Pi `AgentMessage[]`.
- Produces:

```typescript
export interface TranscriptConversationSource {
  id: string;
  kind: 'cone' | 'scoop';
  name: string;
  folder?: string;
  parentConversationId?: string;
  originToolCallId?: string;
  createdAt?: string;
  updatedAt?: string;
  messages: readonly AgentMessage[];
}

export interface NormalizedTranscript {
  conversations: TranscriptConversation[];
  delegations: TranscriptDelegation[];
  excludedReasoningBlocks: number;
}

export function normalizeConversations(
  sources: readonly TranscriptConversationSource[]
): NormalizedTranscript;
```

- [ ] **Step 1: Create typed transcript test fixtures**

Add `makeTranscriptDocument(overrides)` and `makeAgentMessages()` in
**packages/webapp/tests/transcript/fixtures.ts**. `makeTranscriptDocument` returns a complete valid
`TranscriptDocumentV1` and accepts `{ toolInput?: unknown; text?: string }`; it must call no
production normalizer or redactor.

- [ ] **Step 2: Write message-order, metadata, and reasoning-exclusion tests**

Use real Pi message shapes and assert the exact public output:

```typescript
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { normalizeConversations } from '../../src/transcript/normalize.js';

const messages: AgentMessage[] = [
  { role: 'user', content: 'inspect it', timestamp: 1 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'private chain' },
      { type: 'text', text: 'I will inspect it.' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'cat big.txt' } },
    ],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    usage: {
      input: 20,
      output: 5,
      cacheRead: 10,
      cacheWrite: 0,
      totalTokens: 35,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
    },
    stopReason: 'toolUse',
    timestamp: 2,
  },
  {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'x'.repeat(70_000) }],
    isError: false,
    timestamp: 3,
  },
];

it('preserves ordered public content and excludes reasoning', () => {
  const result = normalizeConversations([
    { id: 'cone', kind: 'cone', name: 'Sliccy', messages },
  ]);
  expect(result.excludedReasoningBlocks).toBe(1);
  expect(JSON.stringify(result)).not.toContain('private chain');
  expect(result.conversations[0].messages[1].content).toEqual([
    { type: 'text', text: 'I will inspect it.' },
    { type: 'tool-call', id: 'call-1', name: 'bash', input: { command: 'cat big.txt' } },
  ]);
  expect(result.conversations[0].messages[2].content[0]).toEqual({
    type: 'text',
    text: 'x'.repeat(70_000),
  });
});
```

Add cases for image blocks becoming attachment references, assistant errors, user block arrays,
empty text, provider usage, source/channel envelopes, and parent conversation delegation.

- [ ] **Step 3: Run the focused test and verify failure**

```bash
npx vitest run --project webapp packages/webapp/tests/transcript/normalize.test.ts
```

Expected: FAIL because `normalize.ts` does not exist.

- [ ] **Step 4: Implement small role-specific normalizers**

Use these boundaries so no function exceeds 100 lines:

```typescript
export function normalizeConversations(
  sources: readonly TranscriptConversationSource[]
): NormalizedTranscript {
  let excludedReasoningBlocks = 0;
  const conversations = sources.map((source) => {
    const messages = source.messages.flatMap((message, index) => {
      const normalized = normalizeMessage(message, source.id, index + 1);
      excludedReasoningBlocks += normalized.excludedReasoningBlocks;
      return normalized.message ? [normalized.message] : [];
    });
    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      ...(source.folder ? { folder: source.folder } : {}),
      ...(source.parentConversationId
        ? { parentConversationId: source.parentConversationId }
        : {}),
      messages,
    } satisfies TranscriptConversation;
  });
  return {
    conversations,
    delegations: buildDelegations(sources),
    excludedReasoningBlocks,
  };
}
```

Implement `normalizeUser`, `normalizeAssistant`, `normalizeToolResult`, `normalizeContent`, and
`buildDelegations` as focused helpers. Use IDs `${conversationId}-msg-${sequence.toString().padStart(6, '0')}`.
Never route canonical text through transcript caps or `agentMessagesToChatMessages()`.

- [ ] **Step 5: Run normalizer tests and webapp typecheck**

```bash
npx vitest run --project webapp packages/webapp/tests/transcript/normalize.test.ts
npm run typecheck -w @slicc/webapp
```

Expected: PASS with the 70,000-character tool result intact and no reasoning text.

- [ ] **Step 6: Commit the normalizer**

```bash
git add packages/webapp/src/transcript/normalize.ts packages/webapp/tests/transcript/normalize.test.ts
git commit -m "feat(webapp): normalize canonical transcript messages"
```

---

### Task 3: Credential Pattern Redactor and JSON Walker

**Files:**
- Create: **packages/shared-ts/src/transcript-redaction.ts**
- Create: **packages/shared-ts/tests/transcript-redaction.test.ts**
- Modify: `packages/shared-ts/src/index.ts`
- Create: **packages/webapp/src/transcript/redact.ts**
- Create: **packages/webapp/tests/transcript/redact.test.ts**

**Interfaces:**
- Produces:

```typescript
export interface KnownSecretBatchRedactor {
  redact(texts: readonly string[], signal?: AbortSignal): Promise<readonly string[]>;
}

export interface RedactedTranscriptResult {
  document: TranscriptDocumentV1;
  textAttachments: Map<string, string>;
}

export function redactTranscript(
  document: TranscriptDocumentV1,
  textAttachments: ReadonlyMap<string, string>,
  knownSecrets: KnownSecretBatchRedactor,
  signal?: AbortSignal
): Promise<RedactedTranscriptResult>;
```

- Consumed by: snapshot/export service.

- [ ] **Step 1: Write scanner and recursive walker tests**

```typescript
import { describe, expect, it, vi } from 'vitest';
import { redactCredentialPatterns } from '@slicc/shared-ts';
import { redactTranscript } from '../../src/transcript/redact.js';

it('redacts deterministic credential patterns without generic entropy matching', () => {
  const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature sha256=abcdef123456';
  const result = redactCredentialPatterns(input, 'r');
  expect(result.text).toContain('⟦REDACTED:jwt:r1⟧');
  expect(result.text).toContain('sha256=abcdef123456');
  expect(result.matches).toEqual([{ id: 'r1', category: 'jwt' }]);
});

it('walks nested JSON and text attachments with stable export-local markers', async () => {
  const knownSecrets = {
    redact: vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => text.replaceAll('known-real-secret', '⟦REDACTED:known-secret:k1⟧'))
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
```

Use a complete fixture builder returning `TranscriptDocumentV1`; do not cast malformed objects to
bypass type checks.

- [ ] **Step 2: Confirm both focused tests fail**

```bash
npm test -w @slicc/shared-ts -- transcript-redaction.test.ts
npx vitest run --project webapp packages/webapp/tests/transcript/redact.test.ts
```

Expected: FAIL because scanner and walker modules do not exist.

- [ ] **Step 3: Implement deterministic scanners in shared-ts**

Export:

```typescript
export type CredentialCategory =
  | 'api-key'
  | 'bearer-token'
  | 'jwt'
  | 'private-key'
  | 'password';

export interface PatternRedactionResult {
  text: string;
  matches: Array<{ id: string; category: CredentialCategory }>;
  nextId: number;
}

export function redactCredentialPatterns(
  input: string,
  idPrefix: string,
  firstId = 1
): PatternRedactionResult;
```

Use a table of named regular expressions for Bearer values, JWT triplets, PEM private-key blocks,
common API-key prefixes, and `password|passwd|token|secret|api_key` assignments. Apply matches in
source order and skip ranges already replaced by a higher-priority detector. Do not add an entropy
heuristic.

- [ ] **Step 4: Implement the immutable JSON walker**

`redactTranscript()` must:

1. Collect every string leaf and its RFC 6901 JSON Pointer.
2. Call `knownSecrets.redact()` in batches capped at 1 MiB of source text.
3. Throw `TranscriptExportError('redaction-unavailable')` on any batch failure, length mismatch, or
   abort.
4. Apply credential patterns after known-secret replacement.
5. Replace immutable object/array spines only where strings changed.
6. Redact text attachments and record `{ kind: 'attachment', attachmentId }` targets.
7. Populate redaction counts and records without originals or hashes.
8. Treat existing `⟦REDACTED:` markers as `pre-obfuscated` and preserve them.

- [ ] **Step 5: Run scanner, walker, and type checks**

```bash
npm test -w @slicc/shared-ts -- transcript-redaction.test.ts
npx vitest run --project webapp packages/webapp/tests/transcript/redact.test.ts
npm run typecheck -w @slicc/shared-ts
npm run typecheck -w @slicc/webapp
```

Expected: PASS with zero warnings.

- [ ] **Step 6: Commit local redaction logic**

```bash
git add packages/shared-ts/src packages/shared-ts/tests \
  packages/webapp/src/transcript/redact.ts packages/webapp/tests/transcript/redact.test.ts
git commit -m "feat: redact transcript credential patterns"
```

---

### Task 4: Fail-Closed Known-Secret Batch Redaction Across Floats

**Files:**
- Modify: `packages/shared-ts/src/secrets-pipeline.ts`
- Modify: `packages/shared-ts/tests/secrets-pipeline.test.ts`
- Create: **packages/webapp/src/transcript/strict-secret-client.ts**
- Create: **packages/webapp/tests/transcript/strict-secret-client.test.ts**
- Modify: `packages/node-server/src/routes/secrets.ts`
- Modify: `packages/node-server/tests/routes/secrets.test.ts`
- Modify: `packages/chrome-extension/src/service-worker.ts`
- Modify: `packages/chrome-extension/tests/service-worker-secrets-coverage.test.ts`
- Modify: `packages/chrome-extension/tests/service-worker-secrets-crud-port.test.ts`
- Modify: `packages/swift-server/Sources/Keychain/SecretInjector.swift`
- Modify: `packages/swift-server/Sources/Server/APIRoutes.swift`
- Modify: `packages/swift-server/Tests/SecretAPIRoutesTests.swift`

**Interfaces:**
- Consumes: `KnownSecretBatchRedactor` from Task 3.
- Produces: `getStrictKnownSecretRedactor(): KnownSecretBatchRedactor` and trusted-realm
  `redactForExport(texts)` methods/endpoints.

- [ ] **Step 1: Write trusted-pipeline batch tests**

Add a shared-ts test proving consistent markers and no real values:

```typescript
it('redacts known values across a batch with stable anonymous markers', async () => {
  const pipeline = new SecretsPipeline({
    sessionId: 'session-fixed',
    source: source([
      { name: 'API_TOKEN', value: 'real-token-value', domains: ['api.example.test'] },
    ]),
  });
  await pipeline.reload();
  const result = pipeline.redactForExport(['a real-token-value', 'b real-token-value']);
  expect(result).toEqual({
    texts: ['a ⟦REDACTED:known-secret:k1⟧', 'b ⟦REDACTED:known-secret:k1⟧'],
    redactionCount: 2,
  });
  expect(JSON.stringify(result)).not.toContain('real-token-value');
  expect(JSON.stringify(result)).not.toContain('API_TOKEN');
});
```

- [ ] **Step 2: Write endpoint and client fail-closed tests before implementation**

Cover these exact behaviors:

- Node `POST /api/secrets/redact-export` accepts `{ texts: string[] }`, returns transformed texts,
  returns 400 for malformed input, and returns 503 without echoing text when pipeline reload fails.
- Extension `secrets.redact-export` returns transformed texts and `{ error }` without original texts
  on failure.
- Swift endpoint mirrors Node status and response shape.
- Webapp client throws `redaction-unavailable` on non-2xx, bridge timeout, malformed response,
  `connect` topology, or array-length mismatch.

Run once and expect failures:

```bash
npm test -w @slicc/shared-ts -- secrets-pipeline.test.ts
npx vitest run --project webapp packages/webapp/tests/transcript/strict-secret-client.test.ts
npm test -w @slicc/node-server -- tests/routes/secrets.test.ts
npm test -w @slicc/chrome-extension -- \
  tests/service-worker-secrets-coverage.test.ts \
  tests/service-worker-secrets-crud-port.test.ts
swift test --package-path packages/swift-server --filter SecretAPIRoutesTests
```

Expected: new cases FAIL because the operation is absent.

- [ ] **Step 3: Add trusted-realm anonymous batch redaction**

Add to `SecretsPipeline`:

```typescript
redactForExport(texts: readonly string[]): { texts: string[]; redactionCount: number } {
  const markers = this.secretPairs.map((pair, index) => ({
    values: [pair.realValue, pair.maskedValue].filter(Boolean),
    marker: `⟦REDACTED:known-secret:k${index + 1}⟧`,
  }));
  let redactionCount = 0;
  return {
    texts: texts.map((input) => {
      let output = input;
      for (const { values, marker } of markers) {
        for (const value of values) {
          const occurrences = output.split(value).length - 1;
          redactionCount += occurrences;
          output = output.replaceAll(value, marker);
        }
      }
      return output;
    }),
    redactionCount,
  };
}
```

If the current class does not expose `secretPairs`, keep the pairs in a private field populated by
its existing reload/build path. Never expose the field or secret names through the return type.

- [ ] **Step 4: Add the Node, extension, and Swift strict operations**

Use the same request/response JSON shape everywhere:

```typescript
type RedactExportRequest = { texts: string[] };
type RedactExportResponse = { texts: string[]; redactionCount: number };
```

Node and Swift return 503 with `{ error: 'redaction-unavailable' }` on trusted-pipeline failure.
Extension returns `{ error: 'redaction-unavailable' }`. None of the failure responses include the
request texts.

- [ ] **Step 5: Implement the float-specific strict client**

```typescript
export function getStrictKnownSecretRedactor(): KnownSecretBatchRedactor {
  const topology = resolveSecretTopology();
  if (topology === 'connect') return rejectingRedactor();
  if (topology === 'extension-direct') return extensionMessageRedactor();
  if (topology === 'extension-delegate') return extensionBridgeRedactor();
  return nodeRestRedactor();
}
```

Each helper validates that `texts` is an array of exactly the requested length. Unlike
`getToolResultScrubber()`, every error throws `TranscriptExportError('redaction-unavailable')`.

- [ ] **Step 6: Run all focused cross-runtime tests**

Run the commands from Step 2 again.

Expected: all PASS; failure responses and thrown errors contain no input text.

- [ ] **Step 7: Commit the strict redaction boundary**

```bash
git add packages/shared-ts packages/webapp/src/transcript packages/webapp/tests/transcript \
  packages/node-server packages/chrome-extension packages/swift-server
git commit -m "feat: add fail-closed transcript secret redaction"
```

---

### Task 5: Active Collection, Attachments, and Frozen Snapshot Storage

**Files:**
- Modify: `packages/webapp/src/core/session.ts`
- Modify: `packages/webapp/src/scoops/types.ts`
- Modify: `packages/webapp/src/scoops/agent-bridge.ts`
- Create: **packages/webapp/src/transcript/collect.ts**
- Create: **packages/webapp/src/transcript/attachments.ts**
- Create: **packages/webapp/src/transcript/snapshot-store.ts**
- Create: **packages/webapp/tests/transcript/collect.test.ts**
- Create: **packages/webapp/tests/transcript/attachments.test.ts**
- Create: **packages/webapp/tests/transcript/snapshot-store.test.ts**
- Modify: `packages/webapp/src/ui/session-freezer.ts`
- Modify: `packages/webapp/src/ui/new-session.ts`
- Modify: `packages/webapp/tests/ui/session-freezer.test.ts`
- Modify: `packages/webapp/tests/ui/new-session.test.ts`

**Interfaces:**
- Consumes: normalizer and redactor from Tasks 2–4.
- Produces:

```typescript
export interface TranscriptCollectionDeps {
  listScoops(): readonly RegisteredScoop[];
  isProcessing(jid: string): boolean;
  getAgentMessages(jid: string): readonly AgentMessage[] | null;
  loadPersistedSessions(): Promise<readonly SessionData[]>;
  loadUiChatSessions(): Promise<readonly Session[]>;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface CollectedTranscriptInput {
  sources: TranscriptConversationSource[];
  chatMessagesByConversation: Map<string, readonly ChatMessage[]>;
}

export async function collectActiveTranscriptSources(
  deps: TranscriptCollectionDeps,
  signal?: AbortSignal
): Promise<CollectedTranscriptInput>;

export interface SanitizedTranscriptSnapshot {
  document: TranscriptDocumentV1;
  /** Keys are bundle-relative paths such as attachments/att-0001.png. */
  attachments: Map<string, Uint8Array>;
}
```

- [ ] **Step 1: Write active-boundary and persistence fallback tests**

Test that collection waits while any scoop is processing, returns cone plus all scoops, prefers live
agent messages, falls back to `SessionStore.loadAll()`, and rejects an aborted wait.

```typescript
it('waits for every scoop to reach a completed-turn boundary', async () => {
  const coneUiSession: Session = {
    id: 'session-cone',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const scoopUiSession: Session = {
    id: `session-${scoop.folder}`,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  let processing = true;
  const wait = vi.fn(async () => {
    processing = false;
  });
  const result = await collectActiveTranscriptSources({
    listScoops: () => [cone, scoop],
    isProcessing: () => processing,
    getAgentMessages: (jid) => (jid === cone.jid ? coneMessages : scoopMessages),
    loadPersistedSessions: async () => [],
    loadUiChatSessions: async () => [coneUiSession, scoopUiSession],
    wait,
  });
  expect(wait).toHaveBeenCalledOnce();
  expect(result.sources.map((source) => source.id)).toEqual([cone.jid, scoop.jid]);
  expect(result.chatMessagesByConversation.get(cone.jid)).toEqual(coneUiSession.messages);
});
```

- [ ] **Step 2: Write attachment and snapshot-store tests**

Cover inline image data, text files, binary files, duplicate source paths, missing files, opaque
names, exact binary bytes, sanitized text bytes, SHA-256, and snapshot round-trip at
`/sessions/data/<session-id>/`.

Run and expect failure:

```bash
npx vitest run --project webapp \
  packages/webapp/tests/transcript/collect.test.ts \
  packages/webapp/tests/transcript/attachments.test.ts \
  packages/webapp/tests/transcript/snapshot-store.test.ts
```

- [ ] **Step 3: Add atomic `SessionStore.loadAll()` and scoop origin metadata**

Implement `loadAll()` using one IndexedDB readonly transaction and `getAll()`. Extend
`RegisteredScoop` with optional persisted fields:

```typescript
parentJid?: string;
originToolCallId?: string;
```

Populate `parentJid` when agent-bridge or cone scoop creation knows the invoking scoop. Only set
`originToolCallId` where an actual tool-call ID is available; never infer it from timestamps or
names.

- [ ] **Step 4: Implement collection and attachment processing**

Collection polls processing state at 50 ms only while necessary and honors AbortSignal. It joins
canonical sessions (`agent-sessions`) with UI attachment metadata (`browser-coding-agent`) by scoop
JID. Attachment processing maps UI user messages to normalized user messages by role ordinal,
verifies timestamp/content when available, and marks the export partial with
`attachment-association-unavailable` rather than guessing when the sequences diverge.

Attachment processing uses these exact decisions:

```typescript
export function attachmentHandling(mimeType: string, name: string):
  | 'text-redacted'
  | 'binary-unchanged' {
  const textMime = mimeType.startsWith('text/') || mimeType === 'application/json';
  const textName = /\.(?:txt|md|json|csv|xml|ya?ml|js|mjs|cjs|ts|tsx|css|html)$/i.test(name);
  return textMime || textName ? 'text-redacted' : 'binary-unchanged';
}
```

Decode text strictly, call `redactTranscript()` for its content, and fail with
`attachment-unreadable` on decode/redaction failure. Copy binary bytes unchanged. Generate
`att-0001.ext` names and compute SHA-256 over exported bytes.

- [ ] **Step 5: Implement sanitized snapshot storage**

Write JSON first to a temporary directory, write attachments, flush, then atomically publish by
renaming or final-copying into `/sessions/data/<session-id>/`. Remove temporary data on failure.
Read validates the JSON document and attachment hashes.

Add `sessionId: string` to new freezer index/archive metadata. Generate it with
`crypto.randomUUID()` before quick filenames can be renamed by enrichment; retain it through title
and filename rewrites. Legacy entries without `sessionId` continue to use filename as their lookup
key.

- [ ] **Step 6: Add the non-blocking complete-snapshot freeze hook**

Extend `RunNewSessionFreezeOptions`:

```typescript
captureCompleteSnapshot?: (frozen: FrozenSession) => Promise<void>;
```

After the existing Markdown write succeeds and before the caller clears histories, await the hook.
Catch failures, log only the error code, update the index entry with
`completeSnapshotUnavailable: true`, and still return the frozen session. Never write a raw
fallback.

- [ ] **Step 7: Run collection, freezer, and type tests**

```bash
npx vitest run --project webapp \
  packages/webapp/tests/transcript/collect.test.ts \
  packages/webapp/tests/transcript/attachments.test.ts \
  packages/webapp/tests/transcript/snapshot-store.test.ts \
  packages/webapp/tests/ui/session-freezer.test.ts \
  packages/webapp/tests/ui/new-session.test.ts
npm run typecheck -w @slicc/webapp
```

Expected: PASS, including a regression test proving snapshot failure does not block New Session.

- [ ] **Step 8: Commit collection and frozen storage**

```bash
git add packages/webapp/src/core/session.ts packages/webapp/src/scoops \
  packages/webapp/src/transcript packages/webapp/src/ui/session-freezer.ts \
  packages/webapp/src/ui/new-session.ts packages/webapp/tests
git commit -m "feat(webapp): capture complete transcript snapshots"
```

---

### Task 6: Streaming ZIP Packager and Export Service

**Files:**
- Create: **packages/webapp/src/transcript/zip-stream.ts**
- Create: **packages/webapp/src/transcript/export-service.ts**
- Create: **packages/webapp/src/transcript/export-provider.ts**
- Create: **packages/webapp/tests/transcript/zip-stream.test.ts**
- Create: **packages/webapp/tests/transcript/export-service.test.ts**

**Interfaces:**
- Consumes: collector, redactor, attachment processor, snapshot store, and public validator.
- Produces:

```typescript
export type TranscriptSessionSelector =
  | { kind: 'active' }
  | { kind: 'frozen'; sessionId: string };

export interface TranscriptZipResult {
  filename: string;
  chunks: AsyncIterable<Uint8Array>;
  completion: Promise<{ byteLength: number; sha256: string }>;
}

export interface FrozenTranscriptMetadata {
  sessionId: string;
  title: string;
  frozenAt: string;
  createdAt: number;
  updatedAt: number;
}

export interface TranscriptExportService {
  export(
    selector: TranscriptSessionSelector,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: TranscriptExportProgress) => void;
    }
  ): Promise<TranscriptZipResult>;
  captureFrozen(metadata: FrozenTranscriptMetadata, signal?: AbortSignal): Promise<void>;
}
```

- [ ] **Step 1: Write deterministic ZIP and digest tests**

Use `fflate.unzipSync()` in tests to assert exact paths and JSON. Assert chunk concatenation byte
count and SHA-256, pass-through binary equality, cancellation, and stream error cleanup.

```typescript
import { strFromU8, unzipSync } from 'fflate';
import { sha256 } from 'js-sha256';
import { makeTranscriptDocument } from './fixtures.js';

it('streams transcript.json and attachments with a verified digest', async () => {
  const bytes = (values: number[]) => Uint8Array.from(values);
  const collectChunks = async (chunks: AsyncIterable<Uint8Array>) => {
    const parts: number[] = [];
    for await (const chunk of chunks) parts.push(...chunk);
    return Uint8Array.from(parts);
  };
  const document = makeTranscriptDocument();
  const result = createTranscriptZip(
    document,
    new Map([['attachments/att-0001.bin', bytes([0, 1, 2])]])
  );
  const archive = await collectChunks(result.chunks);
  const completion = await result.completion;
  expect(completion.byteLength).toBe(archive.length);
  expect(completion.sha256).toBe(sha256(archive));
  const files = unzipSync(archive);
  expect(JSON.parse(strFromU8(files['transcript.json']))).toEqual(document);
  expect(files['attachments/att-0001.bin']).toEqual(bytes([0, 1, 2]));
});
```

- [ ] **Step 2: Write active, new-frozen, and legacy service tests**

Inject collectors/stores as dependencies. Assert:

- Active path calls collect → normalize → redact → attachments → validate → ZIP.
- New frozen path reloads sanitized snapshot, reruns current redaction, validates, and packages.
- Legacy path calls `parseFrozenArchive()`, emits partial reasons, and includes available files.
- Redaction and schema failures emit no ZIP chunks.
- Progress phases are ordered.

Run and expect failure:

```bash
npx vitest run --project webapp \
  packages/webapp/tests/transcript/zip-stream.test.ts \
  packages/webapp/tests/transcript/export-service.test.ts
```

- [ ] **Step 3: Implement streaming ZIP with existing `fflate`**

Use `Zip`, `ZipDeflate`, and `ZipPassThrough`; do not use `zipSync` for production. Feed JSON and
text through deflate entries, binary through pass-through entries. Push callback chunks into an
async queue, update an incremental SHA-256 helper, and resolve `completion` only after the final ZIP
callback. Abort closes the queue with `transfer-aborted`.

- [ ] **Step 4: Implement the three export source paths**

Split `export()` into focused methods:

```typescript
async function buildActiveSnapshot(deps: ExportDeps, signal?: AbortSignal) {
  const collected = await collectActiveTranscriptSources(deps.collection, signal);
  const normalized = normalizeConversations(collected.sources);
  return sanitizeAndResolveAttachments(
    deps,
    normalized,
    collected.chatMessagesByConversation,
    signal
  );
}

async function buildFrozenSnapshot(deps: ExportDeps, sessionId: string, signal?: AbortSignal) {
  const stored = await deps.snapshotStore.read(sessionId);
  if (stored) return deps.reredactStoredSnapshot(stored, signal);
  return deps.buildLegacyPartial(sessionId, signal);
}
```

Validate with `validateTranscriptDocumentV1()` immediately before ZIP creation. Convert validation
failures to `schema-invalid` without logging the document.

- [ ] **Step 5: Implement the registration seam**

```typescript
let provider: TranscriptExportService | null = null;

export function registerTranscriptExportService(service: TranscriptExportService): () => void {
  provider = service;
  return () => {
    if (provider === service) provider = null;
  };
}

export function getTranscriptExportService(): TranscriptExportService {
  if (!provider) throw new TranscriptExportError('session-not-found');
  return provider;
}
```

Register the worker service from `Orchestrator.init()` and the page-side service during WC live boot.
Ensure teardown unregisters only its own instance.

- [ ] **Step 6: Run focused tests and diagnostics**

```bash
npx vitest run --project webapp \
  packages/webapp/tests/transcript/zip-stream.test.ts \
  packages/webapp/tests/transcript/export-service.test.ts
npm run typecheck -w @slicc/webapp
```

Expected: PASS with binary bytes identical and no synchronous ZIP production path.

- [ ] **Step 7: Commit the export service**

```bash
git add packages/webapp/src/transcript packages/webapp/tests/transcript \
  packages/webapp/src/scoops/orchestrator.ts
git commit -m "feat(webapp): stream transcript export bundles"
```

---

### Task 7: Shell Command, Freeze Hook, and Local UI Download

**Files:**
- Create: **packages/webapp/src/shell/supplemental-commands/session-command.ts**
- Create: **packages/webapp/tests/shell/supplemental-commands/session-command.test.ts**
- Modify: `packages/webapp/src/shell/supplemental-commands/index.ts`
- Create: **packages/webapp/src/ui/wc/wc-transcript-export.ts**
- Create: **packages/webapp/tests/ui/wc/wc-transcript-export.test.ts**
- Modify: `packages/webapp/src/ui/wc/wc-live.ts`
- Modify: `packages/webapp/src/ui/wc/wc-nav.ts`
- Modify: `packages/webapp/src/ui/new-session.ts`

**Interfaces:**
- Consumes: `getTranscriptExportService()` and `TranscriptZipResult`.
- Produces: `session export` and local **Export transcript** action.

- [ ] **Step 1: Write shell parsing and output tests**

```typescript
import { sha256 } from 'js-sha256';
import { vi } from 'vitest';
import { mockCommandContext } from '../helpers/mock-command-context.js';

it('exports the active session to the requested VFS path', async () => {
  const zipBytes = Uint8Array.from([1, 2, 3]);
  const writeFile = vi.fn(async () => undefined);
  const chunks = async function* () {
    yield zipBytes;
  };
  registerTranscriptExportService({
    export: vi.fn(async () => ({
      filename: 'bundle.zip',
      chunks: chunks(),
      completion: Promise.resolve({ byteLength: 3, sha256: sha256(zipBytes) }),
    })),
    captureFrozen: vi.fn(async () => undefined),
  });
  const result = await createSessionCommand().execute(
    ['export', '--output', '/workspace/session.zip'],
    mockCommandContext({ fs: { writeFile } })
  );
  expect(result).toEqual({
    stdout: 'exported /workspace/session.zip\n',
    stderr: '',
    exitCode: 0,
  });
  expect(writeFile).toHaveBeenCalledWith('/workspace/session.zip', zipBytes);
});
```

Add cases for `--id`, missing value, unknown subcommand, `redaction-unavailable`, cancellation, and
write failure.

- [ ] **Step 2: Write local Blob/download and freeze-hook tests**

Test `transcriptZipToBlob()` sets `application/zip`, verifies completion byte length/digest,
revokes the object URL, and does not download on corruption. Test the New Session callback invokes
`captureFrozen(metadata)` before clear with the immutable session ID and archive timestamps.

Run and expect failure:

```bash
npx vitest run --project webapp \
  packages/webapp/tests/shell/supplemental-commands/session-command.test.ts \
  packages/webapp/tests/ui/wc/wc-transcript-export.test.ts \
  packages/webapp/tests/ui/new-session.test.ts
```

- [ ] **Step 3: Implement and register `session export`**

Accepted syntax:

```text
session export [--id <frozen-session-id>] [--output <path>]
```

Default output is `/workspace/slicc-transcript-<session-id>.zip`. Stream chunks into an array of
`Uint8Array`, verify completion, then write once through `ctx.fs.writeFile`. Return stable error
messages prefixed `session export:` and exit 1 on failure.

Register `createSessionCommand()` in `supplemental-commands/index.ts`.

- [ ] **Step 4: Implement reusable local Blob/download helpers**

```typescript
export async function transcriptZipToBlob(result: TranscriptZipResult): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of result.chunks) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const completion = await result.completion;
  if (completion.byteLength !== byteLength) {
    throw new TranscriptExportError('transfer-corrupt');
  }
  return new Blob(chunks, { type: 'application/zip' });
}
```

`downloadTranscriptBlob()` creates an anchor, clicks, removes it, and revokes the object URL in a
`finally` block.

- [ ] **Step 5: Wire the local menu and frozen selection**

Add `{ id: 'export-transcript', label: 'Export transcript', icon: 'download' }` to `wc-nav.ts`.
Pass an `onExportTranscript` callback from `wc-live.ts` that selects active unless the thread is
showing a frozen session, calls the page-side service, shows progress, and downloads the verified
Blob. Disable duplicate clicks while one export is active.

- [ ] **Step 6: Wire complete snapshot capture into both save variants**

Pass `captureCompleteSnapshot` to `runNewSessionFreeze()` and
`runNewSessionFreezeQuick()`. The callback maps `FrozenSession.archive` and the new immutable
`sessionId` into `FrozenTranscriptMetadata`, then calls the page-side service's `captureFrozen()`.
Preserve current ordering: Markdown archive → complete sanitized snapshot attempt → `/tmp` reset →
cone clear.

- [ ] **Step 7: Run local surface tests**

```bash
npx vitest run --project webapp \
  packages/webapp/tests/shell/supplemental-commands/session-command.test.ts \
  packages/webapp/tests/ui/wc/wc-transcript-export.test.ts \
  packages/webapp/tests/ui/new-session.test.ts \
  packages/webapp/tests/ui/session-freezer.test.ts
npm run typecheck -w @slicc/webapp
```

- [ ] **Step 8: Commit local entry points**

```bash
git add packages/webapp/src/shell packages/webapp/src/ui packages/webapp/tests
git commit -m "feat(webapp): expose local transcript export"
```

---

### Task 8: Leader Approval and Tray Chunk Transfer

**Files:**
- Modify: `packages/shared-ts/src/tray-sync-protocol.ts`
- Modify: `packages/webapp/src/scoops/tray-sync-protocol-corpus.ts`
- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts`
- Modify: `packages/webapp/src/scoops/tray-follower-sync.ts`
- Modify: `packages/webapp/src/ui/wc/wc-tray.ts`
- Modify: `packages/webapp/src/ui/wc/wc-follower.ts`
- Modify: **packages/webapp/src/ui/wc/wc-transcript-export.ts**
- Create: **packages/webapp/tests/scoops/tray-transcript-export.test.ts**
- Modify: `packages/webapp/tests/scoops/tray-leader-sync.test.ts`
- Modify: `packages/webapp/tests/scoops/tray-follower-sync.test.ts`
- Modify: `packages/ios-app/SliccFollower/Models/SyncProtocol.swift`
- Modify: `packages/ios-app/SliccFollower/Tests/SliccFollowerTests/SyncProtocolTests.swift`

**Interfaces:**
- Consumes: transcript export service and Blob helper.
- Produces: tray request/approval/progress/chunk/cancel/complete protocol.

- [ ] **Step 1: Add failing protocol corpus and transfer tests**

Add exact message families:

```typescript
export type TranscriptExportSelector =
  | { kind: 'active' }
  | { kind: 'frozen'; sessionId: string };

// Follower → leader
{ type: 'transcript.export.request'; requestId: string; selector: TranscriptExportSelector }
{ type: 'transcript.export.cancel'; requestId: string }

// Leader → follower
{ type: 'transcript.export.pending'; requestId: string }
{ type: 'transcript.export.denied'; requestId: string }
{ type: 'transcript.export.start'; requestId: string; filename: string; estimatedBytes?: number }
{ type: 'transcript.export.chunk'; requestId: string; index: number; data: string }
{ type: 'transcript.export.complete'; requestId: string; chunks: number; byteLength: number; sha256: string }
{ type: 'transcript.export.error'; requestId: string; code: TranscriptExportErrorCode }
```

Test allow, deny, no metadata before allow, cancellation, follower disconnect, duplicate/missing
chunks, digest mismatch, and buffered-amount backpressure.

Run and expect failure:

```bash
npx vitest run --project webapp \
  packages/webapp/tests/scoops/tray-transcript-export.test.ts \
  packages/webapp/tests/scoops/tray-leader-sync.test.ts \
  packages/webapp/tests/scoops/tray-follower-sync.test.ts
```

- [ ] **Step 2: Extend shared protocol unions and exhaustive dispatch**

Add the message variants, increment `TRAY_SYNC_PROTOCOL_VERSION`, update the golden corpus, and add
switch branches ending in the existing `unhandledProtocolMessage(message)` guard. Unsupported older
peers receive a protocol mismatch before any export request.

- [ ] **Step 3: Implement the leader one-use approval state machine**

Add to `LeaderSyncManagerOptions`:

```typescript
requestTranscriptExportApproval(request: {
  requestId: string;
  followerLabel: string;
  hostOrigin?: string;
  selector: TranscriptExportSelector;
  estimatedBytes?: number;
}): Promise<boolean>;
createTranscriptExport(
  selector: TranscriptExportSelector,
  signal: AbortSignal
): Promise<TranscriptZipResult>;
```

Derive follower label and Cherry origin from connected follower/target registry state. Do not trust
request payload identity. Send `pending`, await approval, and send `denied` without title, size, or
other transcript metadata when rejected. Keep one AbortController per approved request and remove it
on every exit.

- [ ] **Step 4: Implement bounded leader sending**

Base64-encode each ZIP chunk, splitting further so each data-channel message carries at most 32 KiB
of base64 text. Before each send, wait while `channel.bufferedAmount` exceeds 1 MiB and resume on
`bufferedamountlow` or a cancellable 25 ms poll for test doubles. Completion sends authoritative
chunk count, byte length, and SHA-256.

- [ ] **Step 5: Implement follower reassembly and Blob verification**

Track expected next index and reject duplicates or gaps immediately. Decode chunks incrementally,
update SHA-256, and spool bytes through an injectable sink. On completion, compare chunk count,
bytes, and digest before exposing a Blob. Cancel on disconnect or caller AbortSignal and delete the
sink.

- [ ] **Step 6: Add the leader approval dialog and follower UI action**

`openTranscriptExportApproval()` uses `<slicc-dialog>` and shows follower label, trusted host origin,
session selector, estimated bytes, and the unchanged-binary warning. It exposes only **Allow once**
and **Deny**. Escape/close resolves false.

Add **Export transcript** to the follower avatar menu. Its click requests active export, displays
progress, and downloads the verified Blob. Frozen requests use the selected frozen-session ID when
the follower has one; otherwise the leader chooses through the approval surface.

- [ ] **Step 7: Add explicit iOS compatibility**

Update Swift decoding to recognize export response variants as unsupported and ignore them safely.
Do not add an iOS request API or UI. Golden protocol tests must prove an export message does not
tear down the tray session.

- [ ] **Step 8: Run tray, shared, and iOS focused tests**

```bash
npm test -w @slicc/shared-ts -- tray-sync
npx vitest run --project webapp \
  packages/webapp/tests/scoops/tray-transcript-export.test.ts \
  packages/webapp/tests/scoops/tray-leader-sync.test.ts \
  packages/webapp/tests/scoops/tray-follower-sync.test.ts
swift test --package-path packages/ios-app --filter SyncProtocolTests
npm run typecheck -w @slicc/webapp
```

Expected: PASS; denial test proves no transcript metadata was sent.

- [ ] **Step 9: Commit tray export transport**

```bash
git add packages/shared-ts packages/webapp/src/scoops packages/webapp/src/ui/wc \
  packages/webapp/tests/scoops packages/ios-app
git commit -m "feat: transfer approved transcript exports to followers"
```

---

### Task 9: Cherry Host Export API and Mirrored Protocol

**Files:**
- Modify: `packages/cherry/src/index.ts`
- Modify: `packages/cherry/src/mount.ts`
- Modify: `packages/cherry/src/protocol.ts`
- Modify: `packages/webapp/src/cdp/cherry-host-protocol.ts`
- Modify: `packages/cherry/tests/mount.test.ts`
- Modify: `packages/cherry/examples/host.html`
- Modify: `packages/webapp/tests/cdp/cherry-host-protocol.test.ts`

**Interfaces:**
- Consumes: verified follower Blob and progress from Task 8.
- Produces:

```typescript
export interface ExportSessionOptions {
  sessionId?: 'active' | string;
  signal?: AbortSignal;
  onProgress?: (progress: TranscriptExportProgress) => void;
}

export interface SliccHandle {
  iframe: HTMLIFrameElement;
  emitHostEvent(name: string, detail?: unknown): void;
  exportSession(options?: ExportSessionOptions): Promise<Blob>;
  destroy(): void;
}
```

- [ ] **Step 1: Write host API success, denial, abort, and pinning tests**

```typescript
it('resolves exportSession with the follower-verified zip Blob', async () => {
  const posted: Array<{ kind?: string; requestId?: string }> = [];
  const seen: string[] = [];
  const handle = mountSliccImpl({
    container: document.createElement('div'),
    sliccOrigin: 'https://app.example',
    capabilities: { navigate: true, screenshot: 'none', openUrl: true },
    joinToken: 'https://app.example/join?t=X',
    __test_post: (envelope) => posted.push(envelope as never),
  });
  await handle.__test_receive({
    cherry: 1,
    channelId: 'ch-export',
    kind: 'handshake.hello',
  } as never);
  const pending = handle.exportSession({
    sessionId: 'active',
    onProgress: (progress) => seen.push(progress.phase),
  });
  const request = posted.find((envelope) => envelope.kind === 'session.export.request');
  await handle.__test_receive({
    cherry: 1,
    channelId: 'ch-export',
    kind: 'session.export.response',
    requestId: request?.requestId,
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }),
  } as never);
  await expect(pending).resolves.toBeInstanceOf(Blob);
  handle.destroy();
});
```

Add tests that untrusted origin/source/channel envelopes cannot resolve a Promise, denial maps to
`permission-denied`, AbortSignal posts cancel, `destroy()` rejects pending requests, progress routes
by request ID, and re-handshake rejects stale-channel responses.

- [ ] **Step 2: Run Cherry and webapp protocol tests and confirm failure**

```bash
npm test -w @ai-ecoverse/cherry -- mount.test.ts
npx vitest run --project webapp packages/webapp/tests/cdp/cherry-host-protocol.test.ts
```

Expected: FAIL because the API and envelopes are absent.

- [ ] **Step 3: Extend both Cherry protocol mirrors identically**

Add `session.export.request`, `session.export.cancel`, `session.export.progress`,
`session.export.response`, and `session.export.error` envelopes. Bump `CHERRY_PROTOCOL_VERSION`.
Keep `isCherryEnvelope`, version mismatch handling, and `acceptEnvelope` structurally identical in
both files. Blob is allowed only on `session.export.response`; all other payloads remain JSON-cloneable.

- [ ] **Step 4: Implement request lifecycle in `mountSliccImpl`**

Maintain:

```typescript
const pendingExports = new Map<string, {
  resolve: (blob: Blob) => void;
  reject: (error: TranscriptExportError) => void;
  onProgress?: (progress: TranscriptExportProgress) => void;
}>();
```

Require completed handshake before posting. Generate request IDs with `crypto.randomUUID()`. Attach
one abort listener per request and remove it on settlement. Reject all pending requests on destroy
or accepted re-handshake. Validate `blob.type === 'application/zip'` before resolving.

- [ ] **Step 5: Bridge follower tray results to Cherry envelopes**

The Cherry iframe sends progress and the verified Blob to `window.parent` through the existing
pinned postMessage helper. Host API and follower UI consume the same verified Blob; do not rebuild
or rehash it in the host SDK.

- [ ] **Step 6: Update the embed harness**

Add an **Export active transcript** button to `packages/cherry/examples/host.html`. It calls
`handle.exportSession()`, logs progress phases without content, and downloads the returned Blob.
The harness must not log transcript JSON or attachment bytes.

- [ ] **Step 7: Run Cherry tests and builds**

```bash
npm test -w @ai-ecoverse/cherry
npm run typecheck -w @ai-ecoverse/cherry
npm run build -w @ai-ecoverse/cherry
npx vitest run --project webapp packages/webapp/tests/cdp/cherry-host-protocol.test.ts
```

Expected: PASS with protocol mirror tests clean.

- [ ] **Step 8: Commit the Cherry API**

```bash
git add packages/cherry packages/webapp/src/cdp packages/webapp/tests/cdp
git commit -m "feat(cherry): request approved transcript exports"
```

---

### Task 10: Documentation, Security Regression, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `packages/webapp/CLAUDE.md`
- Modify: `packages/cherry/CLAUDE.md`
- Modify: `packages/shared-ts/CLAUDE.md`
- Modify: `packages/node-server/CLAUDE.md`
- Modify: `packages/chrome-extension/CLAUDE.md`
- Modify: `packages/swift-server/CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `docs/approvals.md`
- Modify: `docs/review-patterns.md`
- Modify: `.github/copilot-instructions.md`
- Modify: `docs/shell-reference.md`
- Create: **packages/vfs-root/workspace/skills/transcript-export/SKILL.md**
- Create: **docs/transcript-export.md**
- Create: **packages/webapp/tests/e2e/transcript-export.test.ts**
- Create: **packages/webapp/tests/e2e/fake-llm/fixtures/transcript-export.json**

**Interfaces:**
- Consumes: completed feature.
- Produces: public documentation, agent command knowledge, cross-runtime review guidance, final evidence.

- [ ] **Step 1: Write the fake-LLM end-to-end scenario**

The fixture must produce one user turn, one assistant tool call with a credential-shaped string, one
tool result, and one final assistant reply. The test exports locally and asserts:

- ZIP downloads.
- `transcript.json` validates as version 1.
- Cone and scoop conversations are present.
- Credential-shaped values are absent.
- Reasoning is absent.
- Binary fixture bytes are unchanged.

Also add a Cherry transport integration test using the host harness test seams: request → approve →
progress → Blob.

Run once before final wiring and expect the scenario to expose any missing integration:

```bash
FAKE_LLM_FIXTURE=transcript-export npm run test:e2e -- transcript-export.test.ts
```

- [ ] **Step 2: Write the authoritative public documentation**

**docs/transcript-export.md** must document:

- ZIP layout and schema URL.
- Active, newly frozen, and legacy behavior.
- Cone/scoop conversation model.
- Reasoning exclusion.
- Known-secret and credential-pattern obfuscation.
- Text-redacted versus binary-unchanged attachments.
- Shell, local UI, follower UI, and Cherry SDK usage.
- Per-request leader approval.
- Progress, cancellation, stable errors, and retry-from-start.
- A warning that unchanged binary files may contain sensitive information.

Link it from README and relevant package guides instead of duplicating details.

- [ ] **Step 3: Update agent and reviewer references**

Add `session export` exact syntax to `docs/shell-reference.md` and the bundled shell skill. Update
architecture protocol matrices, `docs/approvals.md`, `docs/review-patterns.md`, and the compact
Copilot instructions. Keep `.github/copilot-instructions.md` under 4,000 characters.

- [ ] **Step 4: Run focused package coverage gates**

```bash
npm run test:coverage:shared
npm run test:coverage:webapp
npm run test:coverage:cherry
```

Expected: all existing floors pass. Do not lower `coverage-thresholds.json`.

- [ ] **Step 5: Run lint first, then typecheck and tests**

```bash
npm run lint
npm run typecheck
npm test
```

Expected: zero errors and zero warnings.

- [ ] **Step 6: Run builds and native tests**

```bash
npm run build -w @slicc/shared-ts
npm run build -w @slicc/webapp
npm run build -w @ai-ecoverse/cherry
npm run build -w @slicc/chrome-extension
swift test --package-path packages/swift-server
swift test --package-path packages/ios-app
```

Expected: all commands PASS.

- [ ] **Step 7: Run the transcript E2E and manual Cherry smoke check**

```bash
FAKE_LLM_FIXTURE=transcript-export npm run test:e2e -- transcript-export.test.ts
```

Then run the Cherry host harness and verify:

1. Host requests export.
2. Leader sees follower label, host origin, size estimate, and binary warning.
3. Deny returns `permission-denied` and no Blob.
4. A second request requires a new prompt.
5. Allow streams progress and returns a ZIP Blob.
6. JSON validates and binary bytes match.
7. Disconnect during transfer cancels and leaves no temporary file.

- [ ] **Step 8: Run diagnostics and review the final diff**

```bash
git diff --check
git status --short
```

Run LSP diagnostics on all changed TypeScript, Swift, and JSON files. Run `lens_diagnostics` with
`mode=all`; resolve every finding. Re-read the diff for unneeded abstractions, transcript content in
logs, fail-open redaction, raw filenames, missing cleanup, and protocol mirror drift.

- [ ] **Step 9: Commit documentation and verification changes**

```bash
git add README.md packages docs .github/copilot-instructions.md
git commit -m "docs: document complete transcript exports"
```

---

## Final Review Checkpoints

After Task 4, request a security-focused review of the strict redaction boundary before building
snapshot persistence on top of it.

After Task 8, request a protocol-focused review covering authorization, requester identity,
backpressure, cancellation, and follower parity.

After Task 9, request an SDK-focused review covering Cherry protocol pinning and Promise cleanup.

Before merge, run the repository's full pre-push/PR pass from `docs/verification.md` and the
`requesting-code-review` skill. Do not merge or push directly to `main`.
