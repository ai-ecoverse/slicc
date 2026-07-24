# Transcript Export

SLICC can package any session — active or archived — into an integrity-verified, redacted ZIP
bundle called a **transcript bundle**. The bundle is portable, self-describing, and
schema-validated before it is written.

This document is the **single authoritative reference** for the bundle format, privacy
guarantees, supported access paths, and operational semantics. Other docs link here instead of
duplicating these details.

---

## ZIP layout

```
slicc-<date>-<title-slug>-<export-id-prefix>.zip
├── transcript.json        # v1 document (see schema below)
└── attachments/           # only when binary attachments exist
    └── att-NNNN.<ext>     # opaque sequential name, original bytes copied unchanged
```

The ZIP filename embeds the export date, a URL-safe title slug (up to 40 chars), and the first
8 hex characters of the export UUID so that repeated exports of the same session on the same
day produce distinct filenames. The bundle is SHA-256 – integrity-verified but not digitally
signed.

**`transcript.json`** is always present and follows the `TranscriptDocumentV1` schema at:
`packages/shared-ts/src/transcript-export.ts` — `schemaVersion: 1`.

The schema URL (`export.format == "slicc-transcript"`) is stable across SLICC versions.
Future breaking changes will bump `schemaVersion`.

---

## Schema — top-level fields

```jsonc
{
  "schemaVersion": 1,
  "export": {
    "id": "<uuid>",
    "generatedAt": "<ISO-8601>",
    "producer": { "application": "slicc", "version": "<semver>" },
    "format": "slicc-transcript"
  },
  "session": {
    "id": "<session-id>",
    "title": "<string>",
    "state": "active" | "frozen",
    "createdAt": "<ISO-8601>",
    "updatedAt": "<ISO-8601>",
    "frozenAt": "<ISO-8601>",          // present when state == "frozen"
    "snapshotAt": "<ISO-8601>",        // present for new-frozen sessions
    "completeness": {
      "status": "complete" | "partial",
      "missing": ["<reason>", ...]    // empty when status == "complete"
    }
  },
  "privacy": {
    "reasoningExcluded": true,         // always true — reasoning is never exported
    "excludedReasoningBlocks": 0,      // count of reasoning blocks stripped
    "binaryAttachments": "included-unchanged",
    "redactionCounts": { "<category>": <number> },
    "redactions": [
      {
        "id": "<uuid>",
        "category": "<category-name>",
        "detector": "known-secret" | "credential-pattern" | "pre-obfuscated",
        "target": { "kind": "json", "pointer": "<json-pointer>" }
               | { "kind": "attachment", "attachmentId": "<id>" }
      }
    ]
  },
  "conversations": [...],     // see Conversation model below
  "delegations": [...],       // cone → scoop delegation edges
  "attachments": [...]        // file attachment metadata
}
```

---

## Session states and export behavior

| Session state     | Source data                                                                                                                             | Completeness                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Active**        | Live agent history from IndexedDB (`agent-sessions` store). May be partial if the loop is mid-turn.                                     | Complete if the turn finished; partial otherwise (`tool-data-may-be-truncated`). |
| **Newly frozen**  | Snapshot written by "Save & start new" or "New chat — skip memory". The export re-redacts from the sanitized snapshot.                  | Always complete.                                                                 |
| **Legacy frozen** | Markdown archive at `/sessions/<slug>.md` (`slicc:session-data` comment block). No agent-history snapshot; reconstructed from UI state. | Always partial (`complete-snapshot-unavailable`).                                |

> The legacy path is present for backward compatibility with sessions saved before the v1 snapshot
> format. New sessions always produce new-frozen snapshots.

---

## Cone and scoop conversation model

Each entry in `conversations[]` represents one conversation thread:

```jsonc
{
  "id": "<conversation-id>",
  "kind": "cone" | "scoop",
  "name": "<display-name>",
  "folder": "<optional-folder>",
  "parentConversationId": "<parent-id>",   // present for scoops
  "createdAt": "<ISO-8601>",
  "updatedAt": "<ISO-8601>",
  "messages": [...]
}
```

- **`cone`** — the main agent thread. Always present. Exactly one per export.
- **`scoop`** — a parallel sub-agent thread. Zero or more per export.
  `parentConversationId` links the scoop back to the cone (or another scoop).

Delegation edges (which cone turn spawned which scoop) are in `delegations[]`:

```jsonc
{
  "sourceConversationId": "cone",
  "targetConversationId": "scoop-1",
  "toolCallId": "<tool-call-id>",
  "timestamp": "<ISO-8601>",
}
```

Each `message` follows this shape:

```jsonc
{
  "id": "<msg-id>",
  "sequence": 1,
  "role": "user" | "assistant" | "tool-result",
  "timestamp": "<ISO-8601>",
  "content": [
    { "type": "text", "text": "<string>" },
    { "type": "tool-call", "id": "<id>", "name": "<name>", "input": {...} },
    { "type": "attachment-ref", "attachmentId": "<att-id>" }
  ],
  "toolCallId": "<id>",                 // present on tool-result messages
  "model": { "provider": "<id>", "id": "<model-id>", "api": "<api>" },
  "usage": { "input": 0, "output": 0, ... },
  "stopReason": "end_turn" | "tool_use" | ...
}
```

---

## Privacy guarantees

### Reasoning exclusion

Reasoning / extended thinking content is **always excluded**. No `reasoning` content block
appears in any exported message. `privacy.reasoningExcluded` is always `true` and
`privacy.excludedReasoningBlocks` counts how many reasoning blocks were stripped.

### Secret and credential-pattern obfuscation

Two redaction detectors run unconditionally before the ZIP is written:

| Detector             | What it catches                                                                                    | Replacement token                    |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `known-secret`       | Secrets explicitly stored in the session secret store (via `secret set`).                          | `⟦REDACTED:known-secret:<id>⟧`       |
| `credential-pattern` | Bare API keys (e.g. `sk-…`, `gh_…`), bearer tokens (`Bearer <token>`), and PEM private-key blocks. | `⟦REDACTED:credential-pattern:<id>⟧` |
| `pre-obfuscated`     | Values already in `⟦MASKED:…⟧` form (produced by the secrets pipeline).                            | Passed through unchanged.            |

Redaction is **fail-closed**: if the redactor cannot initialize, the export aborts with
`redaction-unavailable` rather than emitting an unredacted bundle.

Each redaction entry in `privacy.redactions[]` records the detector, category, and JSON
Pointer to the redacted location. `privacy.redactionCounts` gives per-category totals.

### Binary attachments — unchanged and potentially sensitive

Text attachments (`text/*` MIME types) are redacted inline before export. Binary attachments
(images, PDFs, compiled binaries, databases, etc.) are copied **byte-for-byte unchanged** into
`attachments/`. Their `handling` field is `"binary-unchanged"`.

> **Warning:** Unchanged binary files may contain embedded credentials, screenshots of API
> keys, private certificates, or other sensitive data. **Review every binary attachment before
> sharing the transcript bundle with a third party.**

---

## Access paths

### Shell — `session export`

```bash
# Active session → /workspace/slicc-transcript-<id>.zip
session export

# Custom output path:
session export --output /workspace/my-session.zip

# Archived session by ID:
session export --id <frozen-session-id>
session export --id <frozen-session-id> --output /workspace/archive.zip
```

Full syntax: `session export [--id <id>] [--output <path>]`

The default output filename uses the real session ID resolved by the export service, so
different sessions never collide. See `docs/shell-reference.md` for the full session command
reference.

### Local UI — avatar menu

The **Export transcript** item in the avatar (account) menu produces the same ZIP and triggers
a browser download dialog instead of writing to VFS. The export button is disabled while a
download is already in-flight; a second click has no effect.

### Tray follower UI

A connected tray follower (browser window, Electron, iOS app) may request an export from the
**Export transcript** menu item in its avatar menu. The **leader** sees an approval dialog
showing the follower label, host origin, selector, and estimated size. Approval is one-time per
request — a second export always requires a new prompt.

After approval, the leader streams the ZIP to the follower over the WebRTC data channel. The
follower triggers a local download on receipt.

### Cherry SDK — `handle.exportSession()`

A Cherry-embedded follower (SDK host page) can call:

```typescript
import { mountSlicc, TranscriptExportError } from '@ai-ecoverse/cherry';

const handle = mountSlicc({ ... });

try {
  const blob: Blob = await handle.exportSession({
    sessionId: 'active',          // or a frozen session ID
    signal: controller.signal,    // optional AbortSignal
    onProgress(progress) {        // optional progress callback
      console.log(progress.phase, progress.processedBytes);
    },
  });
  // blob.type === 'application/zip'
} catch (err) {
  if (err instanceof TranscriptExportError) {
    console.error('export failed:', err.code);
    // 'permission-denied' | 'session-not-found' | 'transfer-aborted' | ...
  }
}
```

The host page receives a `Blob` (type `application/zip`) only after:

1. The follower sends `session.export.request` to the leader.
2. The leader's approval dialog is shown to the user (one-time, per request).
3. The user clicks **Allow once**.
4. The leader streams the ZIP over the tray data channel.
5. The follower verifies byte length and SHA-256, then resolves the Promise.

If the user clicks **Deny** (or closes the dialog), the Promise rejects with
`TranscriptExportError('permission-denied')`. If the session is disconnected
mid-stream, the Promise rejects with `TranscriptExportError('transfer-aborted')`.

#### Progress events

`onProgress` receives `TranscriptExportProgress`:

```typescript
interface TranscriptExportProgress {
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
```

#### Cancellation

Pass an `AbortSignal` to cancel the in-flight export. On abort:

1. The Cherry SDK posts `session.export.cancel` to the leader.
2. The leader's ZIP stream is aborted server-side.
3. The Promise rejects with `TranscriptExportError('transfer-aborted')`.

Cancelling after the ZIP has already been fully received is a no-op.

---

## Approval — one-time per request

Every follower and Cherry export requires explicit human approval by the leader's user. The
approval dialog shows:

- **Follower** label (display name from the tray).
- **Host origin** (Cherry only — the third-party page's origin).
- **Transcript** — "Active session" or "Archived session (ID)".
- **Est. size** — derived from the stored snapshot or a live estimate.
- **Warning** about binary attachments being sent unchanged.

Clicking **Allow once** starts the export immediately. Clicking **Deny** (or pressing Escape
or closing the dialog) returns `permission-denied`. A second export request — even in the same
session — always requires a new approval prompt.

---

## Progress, cancellation, errors, and retry

### Progress phases

```
waiting-for-conversations → collecting → redacting → packaging → transferring → complete
```

`processedBytes` and `estimatedBytes` are available from `packaging` onward.

### Cancellation

Any export can be cancelled via `AbortSignal`. On cancellation:

- The ZIP stream is stopped.
- Any temporary buffers are released.
- No partial ZIP file is written or sent.
- The export resolves with `transfer-aborted`.

### Stable error codes

| Code                    | Cause                                                                          | Retry?                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `permission-denied`     | User denied the approval dialog.                                               | Only after a new approval.                                                                                                       |
| `redaction-unavailable` | Redactor failed to initialize.                                                 | Not useful — log and report.                                                                                                     |
| `session-not-found`     | The export service is not registered, or the frozen session ID does not exist. | Wait for boot to complete, or check the session ID.                                                                              |
| `transfer-aborted`      | Cancelled or disconnected mid-stream.                                          | Retry from start — no partial resume.                                                                                            |
| `transfer-corrupt`      | Byte length or SHA-256 mismatch.                                               | Retry from start — the entire transfer must be re-run.                                                                           |
| `schema-invalid`        | The assembled transcript failed v1 validation.                                 | Report as a bug.                                                                                                                 |
| `attachment-unreadable` | A text attachment could not be decoded or redacted (fail-closed safety guard). | Do not retry — report as a bug. Binary or missing files do NOT throw this error; they complete as partial with `present: false`. |

### Retry semantics

All exports are **retry-from-start**. There is no incremental resume or partial transfer. If
the leader streams 99% of a ZIP before a disconnect, the follower must request a new export
after reconnection.

---

## Related documentation

- `docs/approvals.md` — full approval gate model, authority axis, and threat model.
- `docs/architecture.md` — tray sync matrix and Cherry protocol topology.
- `docs/shell-reference.md` — `session export` shell command reference.
- `packages/vfs-root/workspace/skills/transcript-export/SKILL.md` — agent-facing skill.
- `packages/shared-ts/src/transcript-export.ts` — TypeScript schema types and runtime validator.
- `packages/cherry/CLAUDE.md` — Cherry SDK wiring for transcript export.
- `packages/webapp/CLAUDE.md` — Frozen Sessions section for session state details.
