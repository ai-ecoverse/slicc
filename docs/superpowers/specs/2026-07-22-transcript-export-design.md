# Complete Transcript Export Design

**Status:** Approved

## Summary

SLICC will export a complete, renderer-neutral transcript of an active or frozen session as a
ZIP bundle containing versioned JSON and attachment files. The export includes the cone and all
scoop conversations, preserves ordered messages and tool activity, and includes model, usage,
timing, and error metadata. It excludes model reasoning.

All exported JSON and text-like attachment content must pass export-time secret obfuscation.
Binary attachments are the explicit exception: their bytes are included unchanged, while their
filenames and textual metadata are obfuscated. A Cherry follower may request an export, but the
leader user must approve every request before any session metadata or bytes are returned.

## Goals

- Export active and frozen sessions through one public, versioned schema.
- Include the cone and every scoop as separate, linked conversations.
- Preserve untruncated textual tool inputs and results from canonical agent history.
- Include provider, model, usage, timing, stop-reason, and error metadata.
- Preserve attachment files and link them from transcript records.
- Exclude all reasoning/thinking content.
- Obfuscate known secrets and credential-shaped text at export time.
- Let SLICC and independent applications render the same documented format.
- Support leader UI, shell, follower UI, and Cherry host API entry points.
- Require one explicit leader approval for every follower-originated export.
- Export legacy frozen sessions honestly as partial rather than rejecting them.

## Non-goals

- Pre-rendered HTML.
- Importing or resuming the transcript in SLICC, Pi, or another harness.
- Pi Coding Agent JSONL compatibility.
- Exporting model reasoning or thinking blocks.
- Sanitizing arbitrary binary attachment contents.
- Persistent follower export permissions.
- Resumable cross-browser transfers in version 1.
- Uploading exports to cloud storage.
- Reconstructing data that legacy frozen archives never retained.

## Chosen Approach

Use a public normalized transcript bundle rather than the existing UI `ChatMessage` shape or raw
Pi `AgentMessage[]`.

The UI shape is already lossy: it removes hidden orchestration tools, omits provider and usage
metadata, and caps tool text. Raw Pi messages preserve more data but expose an upstream internal
contract that is inconvenient for independent renderers and may change with dependency upgrades.

The normalized format is an explicit compatibility boundary. SLICC converts canonical histories
into this format, validates it, and packages it with attachments. Readers ignore unknown additive
fields. Breaking changes increment `schemaVersion`.

## Bundle Layout

```text
slicc-transcript-<session-id>.zip
├── transcript.json
└── attachments/
    ├── att-0001.png
    ├── att-0002.pdf
    └── att-0003.txt
```

There is no HTML or raw internal-message sidecar. JSON and text-like files are UTF-8. Exported
attachment names are opaque identifiers with a safe extension when one is known.

The packager uses streaming ZIP entries. JSON and redacted text attachments may be deflated;
already-compressed binaries may use pass-through entries. Local and remote paths consume the same
ZIP byte stream.

## Public JSON Schema

The repository will publish a JSON Schema for version 1 and a fully obfuscated example bundle.
The TypeScript contract lives in the platform-agnostic shared package, while the JSON Schema is the
public interoperability artifact.

### Top-level shape

```json
{
  "schemaVersion": 1,
  "export": {},
  "session": {},
  "privacy": {},
  "conversations": [],
  "delegations": [],
  "attachments": []
}
```

### Export metadata

`export` contains:

- `id`: unique export request identifier.
- `generatedAt`: ISO 8601 timestamp.
- `producer`: SLICC package and application versions.
- `format`: fixed value `slicc-transcript`.

### Session metadata

`session` contains:

- Stable session ID and redacted title.
- `state`: `active` or `frozen`.
- Creation, update, freeze, and snapshot timestamps when available.
- `completeness.status`: `complete` or `partial`.
- `completeness.missing[]`: machine-readable missing-data reasons.

Initial missing-data reasons include:

- `canonical-agent-history-unavailable`
- `tool-data-may-be-truncated`
- `model-metadata-unavailable`
- `scoop-history-unavailable`
- `attachment-file-missing`
- `attachment-association-unavailable`
- `complete-snapshot-unavailable`

### Privacy metadata

`privacy` contains:

- `reasoningExcluded: true`.
- The number of omitted reasoning blocks, without their contents.
- `binaryAttachments: "included-unchanged"`.
- Redaction totals grouped by category.
- `redactions[]`, where each record contains only:
  - a stable export-local redaction ID;
  - category;
  - target location: a JSON Pointer or an opaque text-attachment ID;
  - detector type (`known-secret`, `credential-pattern`, or `pre-obfuscated`).

Redaction records never contain original values, reversible encodings, or hashes of secret values.

### Conversations

`conversations[]` contains one record for the cone and one for every scoop captured at the
snapshot boundary. Each conversation contains:

- Conversation ID.
- `kind`: `cone` or `scoop`.
- Redacted display name and folder metadata.
- Parent or origin identifiers when known.
- Creation and update timestamps.
- An ordered `messages[]` list.

Message IDs must be unique within the export. When canonical messages do not have IDs, SLICC uses
stable conversation-local sequence IDs. Repeated exports of an unchanged frozen snapshot retain
the same IDs.

### Messages and content blocks

Messages contain:

- ID and sequence number.
- `role`: `user`, `assistant`, or `tool-result`.
- ISO 8601 timestamp.
- Source and channel metadata where applicable.
- Provider and model metadata for assistant records.
- Complete usage and cost fields reported by the provider.
- Stop reason and redacted error text.
- Ordered `content[]` blocks.

Version 1 content blocks are:

- `text`
- `tool-call`
- `attachment-ref`

Tool-call blocks retain the tool call ID, redacted name, and recursively redacted JSON input. Tool
results remain separate message records linked by `toolCallId`; they retain error state, usage,
and ordered text or attachment-reference content.

Thinking/reasoning blocks are counted and discarded before normalization output becomes visible to
any later export stage. Their text is never serialized into the normalized document, logs,
redaction reports, or errors.

### Delegations

`delegations[]` links a cone or scoop tool call to the scoop conversation it created or fed. A
record contains source and target conversation IDs, the originating tool-call ID when available,
and a timestamp.

New sessions persist this relationship explicitly when delegation occurs. Legacy or ambiguous
relationships are omitted rather than guessed.

### Attachments

`attachments[]` contains:

- Opaque attachment ID and bundle-relative path.
- Redacted original name and textual metadata.
- MIME type, byte length, and SHA-256 of the exported file.
- Source conversation and message IDs.
- `handling`: `text-redacted` or `binary-unchanged`.
- Presence status and a missing-file reason when unavailable.

Text-like attachments are decoded as UTF-8, obfuscated, and written as sanitized UTF-8 files. A
text attachment whose content cannot be safely decoded or obfuscated fails closed rather than
being silently reclassified. Images, PDFs, archives, audio, video, and other binary formats are
copied byte-for-byte under the approved binary exception.

## Components

### Transcript collector

The collector obtains a consistent completed-turn snapshot of all canonical cone and scoop
histories plus scoop metadata and delegation links. It joins those canonical histories with the UI
session store for attachment records and render-only source/channel metadata; a sequence mismatch
is reported as partial rather than guessed.

For an active export, it waits until every captured conversation reaches a completed-turn boundary.
The request remains cancellable and emits a `waiting-for-conversations` progress phase.

For a freeze, collection occurs before agent histories are cleared. Scoops may survive the New
Session action; the frozen snapshot records their state at that boundary.

### Transcript normalizer

A pure normalizer maps supported Pi messages into the public schema. It preserves content-block and
message order, removes reasoning, retains full tool data, creates stable IDs, and reports source
limitations. The normalizer has no I/O and does not know about ZIP, VFS, UI, or transport.

### Strict export redactor

The export redactor is separate from the existing fail-open display scrubber. It must never return
unredacted input when the known-secret service is unavailable.

It:

1. Traverses every string leaf in normalized JSON and text-like attachments.
2. Batches strings through a strict real-to-masked SLICC secrets operation.
3. Applies local deterministic detectors for credential-shaped content, including bearer tokens,
   common API-key prefixes, JWTs, PEM private keys, and credential assignments.
4. Replaces each match with an export-local marker such as
   `⟦REDACTED:token:r7⟧`.
5. Records category and target location without retaining original values. JSON fields use JSON
   Pointers; text files use only their opaque attachment IDs.
6. Reuses one marker for repeated occurrences of the same value within an export, using only an
   in-memory map that is discarded afterward.

Already-obfuscated SLICC values remain obfuscated and are reported as `pre-obfuscated`. Generic
high-entropy strings are not redacted solely because of entropy; deterministic credential patterns
avoid turning ordinary code and hashes into excessive false positives.

### Sanitized frozen snapshot store

New frozen sessions store a sanitized complete snapshot at:

```text
/sessions/data/<session-id>/transcript.json
/sessions/data/<session-id>/attachments/...
```

The existing human-readable Markdown archive and `/sessions/index.json` remain for the freezer UI.
The complete snapshot is additive and contains no reasoning or unredacted JSON/text content. SLICC
does not extend retention of raw canonical history after New Session.

If complete snapshot generation fails, no raw fallback is written. The existing Markdown archive
still succeeds so New Session is not blocked, and later export uses the legacy partial path.

### Bundle packager

The packager validates the normalized document against schema version 1, streams `transcript.json`
and attachment entries into a ZIP, and calculates the final ZIP byte count and SHA-256. It exposes
one async byte stream used by local downloads, shell output, and tray transfer.

Temporary ZIP data is spooled to OPFS where needed so large binaries do not require one contiguous
in-memory buffer. Temporary files are removed on completion, denial, cancellation, error, or stale
startup cleanup.

## Capture Behavior by Source

### Active session

- Wait for stable completed-turn boundaries.
- Capture cone plus all registered scoops and join their UI attachment metadata.
- Normalize, obfuscate, validate, and package on demand.
- Do not retain an additional export snapshot after successful delivery.
- Report `complete` unless source files disappear during collection.

### Newly frozen session

- Capture all canonical histories before clear.
- Normalize and obfuscate before writing the snapshot store.
- Preserve the existing readable Markdown archive.
- Re-run the current strict redactor over the stored sanitized snapshot and text attachments, then
  package them on demand. This idempotent pass applies detectors added after the session froze.
- Report `complete` unless an attachment was already missing.

### Legacy frozen session

- Parse and re-obfuscate the existing UI archive.
- Include preserved attachment files when available.
- Emit the same version 1 schema.
- Report `partial` with all applicable missing-data reasons.
- Do not create a migrated snapshot merely because the user exports it.

## Entry Points

### Shell

```text
session export [--id <session-id>] [--output <path>]
```

Without `--id`, the command exports the active session. It writes a ZIP to the VFS and prints the
path. The existing `open --download` command can download that path. Shell help and the agent-facing
shell skill must document the new command.

### Local UI

The active-session and frozen-session menus expose **Export transcript**. Local leader actions call
the exporter directly and download the resulting Blob. They do not show a second approval prompt
because the user initiated the action in the data-owning runtime.

### Follower UI

A follower action sends a typed export request to the leader. It never reads leader VFS paths
directly. The follower receives progress, denial, completion, cancellation, or typed failure
messages and downloads the verified Blob only after successful completion.

### Cherry host SDK

The host-side primitive is:

```ts
interface ExportSessionOptions {
  sessionId?: 'active' | string;
  signal?: AbortSignal;
  onProgress?: (progress: TranscriptExportProgress) => void;
}

interface SliccHandle {
  exportSession(options?: ExportSessionOptions): Promise<Blob>;
}
```

A caller may request the active session or an opaque frozen-session ID it already knows. A follower
UI may also let the leader choose a frozen session without exposing the session list to the host.
The host receives no title, transcript metadata, or bytes before approval.

The returned Blob is the same verified ZIP used by the follower Download action. The host may save,
upload, or render it.

## Follower Authorization

Every follower-originated export requires a fresh leader decision. Tray membership, Cherry
handshake completion, or a previous approval does not authorize another export.

The leader prompt shows:

- Requesting follower label.
- Cherry host origin when applicable, derived from trusted target registration rather than request
  text.
- Requested session title and state.
- Estimated attachment and bundle size.
- A warning that binary attachment bytes are included unchanged.
- **Allow once** and **Deny** actions.

Approval is scoped to the request ID and consumed once. Version 1 has no “Always allow” action.
Denial returns a typed error and no session metadata.

## Cherry and Tray Data Flow

1. The host calls `SliccHandle.exportSession()`, or the follower user selects Download.
2. The pinned Cherry postMessage channel carries the request to the follower iframe.
3. The follower sends `transcript.export.request` over the tray channel.
4. The leader derives requester identity, resolves the requested session, estimates size, and asks
   the leader user for approval.
5. On denial, the leader sends a terminal denied response.
6. On approval, the leader starts the shared exporter.
7. ZIP bytes travel as bounded 32 KiB base64 chunks over the ordered tray channel with
   buffered-amount backpressure.
8. Progress reports received and estimated total bytes. Final completion reports the authoritative
   byte count and ZIP SHA-256.
9. The follower incrementally hashes and spools chunks, verifies completion metadata, then obtains
   an OPFS-backed Blob.
10. The follower download path uses that Blob directly. For Cherry, the pinned postMessage channel
    structured-clones the Blob to the SDK, which resolves the host Promise.
11. Every exit path removes temporary state.

The shared tray protocol adds request, cancel, pending, denied, start, progress, chunk, complete, and
error variants. The webapp and Cherry postMessage protocol mirrors add corresponding host request,
progress, response, and error envelopes. Existing origin, WindowProxy identity, channel nonce, and
protocol-version checks remain mandatory.

## Error Handling

Stable public error codes include:

- `permission-denied`
- `redaction-unavailable`
- `session-not-found`
- `transfer-aborted`
- `transfer-corrupt`
- `schema-invalid`
- `attachment-unreadable`

Behavior:

- Active exports wait for completed turns and may be cancelled.
- Known-secret scrub failure aborts before JSON or text files are emitted.
- Schema validation failure aborts before packaging.
- A missing binary attachment produces a partial export with redacted metadata and an explicit
  reason.
- A text attachment that cannot be redacted aborts the export.
- Leader denial returns `permission-denied`.
- Disconnect or AbortSignal cancels collection/transfer and deletes partial state.
- Missing, duplicate, or corrupt chunks reject the Blob.
- Byte-count or SHA-256 mismatch returns `transfer-corrupt`.
- Interrupted transfers restart from the beginning when the caller retries.
- A frozen snapshot failure does not block New Session and never stores an unredacted fallback.

Logs may include request IDs, phases, byte counts, error codes, and durations. They must not include
transcript content, attachment content, original filenames, redaction originals, or secret-shaped
values.

## Security Properties

- No reasoning content crosses the normalization boundary.
- JSON and text attachment obfuscation is mandatory and fail closed.
- Known secrets and credential patterns are both covered.
- Binary bytes are unchanged only because the user explicitly selected that exception; the privacy
  manifest and approval prompt state it.
- Attachment names are opaque in the bundle.
- The host cannot request arbitrary VFS paths.
- The leader derives requester identity from established transport state.
- Each remote export needs a one-use approval.
- The Cherry three-factor postMessage gate remains in force.
- Final byte count and SHA-256 protect transfer integrity.
- Backpressure, cancellation, and OPFS spooling bound memory growth.

## Testing

### Unit tests

- Normalize every supported Pi message and content-block variant.
- Preserve message and content-block order.
- Exclude reasoning and count omitted blocks.
- Preserve untruncated tool input and result text.
- Normalize provider, model, usage, stop, timing, and error metadata.
- Build stable conversation-local message IDs.
- Link tool results and delegation records correctly.
- Redact known secrets in every JSON string position.
- Detect supported credential patterns, including nested tool input.
- Reuse export-local redaction markers without persisting originals.
- Verify redaction reports contain category and target location only.
- Redact text attachment content and metadata.
- Preserve binary attachment bytes exactly.
- Generate opaque filenames and correct byte counts/SHA-256.
- Validate complete and partial documents against the public schema.

### Integration tests

- Export an active cone with multiple scoops.
- Wait for an in-flight turn and support cancellation.
- Capture a sanitized frozen snapshot before histories clear.
- Keep New Session usable when snapshot generation fails.
- Export legacy Markdown as a valid partial version 1 document.
- Handle missing attachments honestly.
- Produce equivalent ZIP contents from shell and local UI paths.
- Clean temporary files after success and every failure path.

### Protocol and SDK tests

- Allow and deny leader approval.
- Verify no metadata precedes approval.
- Exercise progress, cancel, disconnect, and retry-from-start behavior.
- Exercise chunk boundaries, backpressure, duplicate/missing chunks, byte totals, and digest mismatch.
- Reject spoofed Cherry envelopes by origin, source identity, or channel nonce.
- Ensure `SliccHandle.exportSession()` and follower Download use the same verified Blob.
- Keep canonical webapp and Cherry protocol mirrors structurally identical.
- Add compile-time exhaustive dispatch coverage for every protocol variant.
- Confirm iOS does not request transcript exports in version 1 and safely ignores or explicitly
  rejects unsupported export messages without breaking its tray session.

### Cross-runtime verification

Verify local CLI/Electron leader export, extension leader export, hosted leader export, TS follower
export, and Cherry host API export. The iOS follower is explicitly excluded from initiating exports
in version 1, but protocol compatibility remains tested.

## Documentation Changes for Implementation

- Publish the version 1 JSON Schema and redacted sample bundle.
- Document `session export` in the shell reference and agent shell skill.
- Document active and frozen UI actions.
- Document Cherry SDK API, progress, cancellation, errors, and approval behavior.
- Document binary attachments as unchanged and JSON/text as obfuscated.
- Document legacy partial exports and missing-data reasons.
- Update architecture protocol matrices.
- Update the cross-runtime review checklist and compact reviewer instructions because this feature
  adds leader/follower protocol wiring.

## Success Criteria

- A third-party renderer can validate and render an export using only the public schema and files.
- A complete export contains the cone and all scoop conversations captured at one stable boundary.
- Textual tool data is untruncated and ordered.
- No reasoning block appears anywhere in the bundle or logs.
- Known secrets and supported credential patterns do not appear in JSON or text attachments.
- Binary attachment files are byte-identical to their source and clearly declared unchanged.
- New frozen sessions remain completely exportable after canonical histories are cleared.
- Legacy frozen sessions produce valid, transparent partial exports.
- A Cherry host receives no session data unless the leader approves that exact request.
- Local, follower, and Cherry entry points produce the same bundle format.
