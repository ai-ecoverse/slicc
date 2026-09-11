---
name: transcript-export
description: |
  Use when the user asks to export, save, or download a transcript or session
  history; or (with Memory v2 on) to search or re-read past /sessions archives.
  Covers active-session export, archived (frozen) session export, ZIP bundle
  layout, redaction guarantees, `session export` syntax, and the Memory v2
  `session search` / `session read` bounded search-then-read protocol.
allowed-tools: bash, read_file
---

# Transcript Export

The `session export` command packages the current (or a named archived)
session into a signed, redacted ZIP bundle and writes it to the VFS.

## Syntax

```bash
# Export the active session (default output path):
session export

# Export to a specific VFS path:
session export --output /workspace/my-session.zip

# Export a frozen (archived) session by its ID:
session export --id <frozen-session-id>

# Export a frozen session to a custom path:
session export --id <session-id> --output /workspace/archive.zip
```

The **default output path** is `/workspace/slicc-transcript-<session-id>.zip`.

## Memory v2 — search then read (feature flag)

When the `memory-v2` flag is **on** (Settings → Experimental, or a central
override), `session` also exposes keyword search over `/sessions` archives
and every scoop session snapshot (`/scoops/<folder>/sessions/<jid>/`), so a
dropped scoop's transcript is still findable. Prefer this over `rg` / `cat`
on archives: legacy markdown embeds the whole session JSON on one line, so
grep counts and line dumps are misleading.

```bash
# Bounded keyword search (title weighted above body; original content above
# compaction summaries and prior search echoes):
session search "OpTel budget" [--limit 8]

# Read a bounded page for a hit id from search output:
session read sess/<sessionId>/msg/<messageId> [--from N --count M]
```

Protocol:

1. `session search <query>` returns short excerpts with stable `id=…` lines.
2. `session read <id>` returns a hard-capped page and reports what remains.
3. Stay under ~20 KB total across a few calls — never dump a whole archive.

With Memory v2 on, new archives write prose-only markdown plus a `.jsonl`
sidecar (one pi-ai-shaped message per line). Legacy embedded
`<!-- slicc:session-data -->` archives remain searchable.

## What the bundle contains

The ZIP always contains exactly one file: `transcript.json`. Its top-level
structure follows `TranscriptDocumentV1` (schema version 1):

```
slicc-transcript-<id>.zip
└── transcript.json     # full schema-validated v1 document
└── attachments/        # only if the session has binary attachments
    └── <sha256>.<ext>  # original bytes, unchanged
```

### Cone and scoop conversations

`transcript.json` contains every conversation in the session:

- `conversations[].kind == "cone"` — the main agent thread.
- `conversations[].kind == "scoop"` — parallel sub-agent threads.

Each conversation contains all messages in sequence order.

### Redaction guarantees

The export is **always redacted** before the ZIP is written. Two detectors run:

| Detector             | What it catches                                | Output in transcript.json            |
| -------------------- | ---------------------------------------------- | ------------------------------------ |
| `known-secret`       | Secrets from the session secret store          | `⟦REDACTED:known-secret:<id>⟧`       |
| `credential-pattern` | Bare API keys, bearer tokens, PEM private keys | `⟦REDACTED:credential-pattern:<id>⟧` |

Redacted values are listed in `privacy.redactions[]`. `privacy.redactionCounts`
gives per-category counts. A `privacy.reasoningExcluded: true` field confirms
that no reasoning/thinking content was included.

### Binary attachments

Text attachments (MIME type `text/*`) are redacted inline. Binary attachments
(images, PDFs, etc.) are copied **unchanged** into `attachments/` and their
`handling` field reads `"binary-unchanged"`.

> **Warning:** unchanged binary files may contain sensitive data (screenshots
> of credentials, PDFs with embedded API keys). Review binary attachments
> before sharing the ZIP.

## Session states

| State             | Behaviour                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Active**        | Exported from the live agent history. May be partial if the agent loop is mid-turn.                               |
| **Newly frozen**  | Exported from the snapshot captured by "Save & start new". Always complete.                                       |
| **Legacy frozen** | Exported from the Markdown archive at `/sessions/<slug>.md`. Partial by construction (no agent-history snapshot). |

## Error codes

| Code                    | Meaning                                                                        |
| ----------------------- | ------------------------------------------------------------------------------ |
| `permission-denied`     | User denied a follower export request (Cherry / follower flow).                |
| `redaction-unavailable` | The redactor could not initialize; export aborted.                             |
| `session-not-found`     | The requested frozen session ID does not exist.                                |
| `transfer-aborted`      | Export was cancelled mid-stream (abort signal or disconnect).                  |
| `transfer-corrupt`      | The ZIP bytes do not match the completion receipt checksum.                    |
| `schema-invalid`        | The transcript document failed v1 schema validation.                           |
| `attachment-unreadable` | A text attachment could not be decoded or redacted; export aborted for safety. |

## Finding frozen session IDs

```bash
cat /sessions/index.json
```

The index is a JSON array of frozen session objects, each with an `id` field.
Use that `id` as the `--id` argument.

## Examples

```bash
# Export the active session:
session export --output /workspace/today-session.zip

# Export a specific archived session:
session export --id 2026-07-22T12-00-00-planning --output /workspace/planning.zip

# Confirm the export succeeded:
ls -la /workspace/*.zip
```

## Notes

- The export command uses the **registered TranscriptExportService**. If the
  service is not yet ready (e.g. the cone is still bootstrapping), the command
  returns `session export: session-not-found`.
- The local UI export ("Export transcript" in the avatar menu) produces the
  same ZIP and triggers a browser download instead of writing to VFS.
- Followers (tray, Cherry) must request an export from the leader; the leader
  shows a one-time approval dialog before streaming the ZIP. On a cloud
  (hosted-leader) session the leader is headless, so it delegates that prompt to
  the requesting follower — the approval appears on the user's own device.
