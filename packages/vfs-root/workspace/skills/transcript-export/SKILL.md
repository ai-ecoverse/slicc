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

`session export` → signed, redacted ZIP on VFS.

## Syntax

```bash
session export
session export --output /workspace/my-session.zip
session export --id <frozen-session-id>
session export --id <session-id> --output /workspace/archive.zip
```

Default: `/workspace/slicc-transcript-<session-id>.zip`.

## Memory v2 — search then read

Flag on (Settings → Experimental): keyword search over `/sessions` + `/scoops/<folder>/sessions/<jid>/`. Prefer over `rg`/`cat` (legacy archives embed JSON on one line).

```bash
session search "OpTel budget" [--limit 8]
session read sess/<sessionId>/msg/<messageId> [--from N --count M]
```

1. `search` → excerpts + stable `id=…`
2. `read` → capped page + remainder hint
3. Stay under ~20 KB total — never dump whole archive

New archives: prose markdown + `.jsonl` sidecar. Legacy `<!-- slicc:session-data -->` still searchable.

## Bundle

```
slicc-transcript-<id>.zip
├── transcript.json          # TranscriptDocumentV1
└── attachments/             # if binary attachments exist
    └── <sha256>.<ext>
```

`conversations[].kind`: `"cone"` (main) or `"scoop"` (sub-agents).

### Redaction (always)

| Detector             | Catches                      | Marker                               |
| -------------------- | ---------------------------- | ------------------------------------ |
| `known-secret`       | Session secret store         | `⟦REDACTED:known-secret:<id>⟧`       |
| `credential-pattern` | API keys, bearer tokens, PEM | `⟦REDACTED:credential-pattern:<id>⟧` |

`privacy.redactions[]`, `redactionCounts`, `reasoningExcluded: true`. Text `text/*` redacted inline; binary copied unchanged (`handling: "binary-unchanged"`) — review before sharing.

## Session states

| State         | Source                          |
| ------------- | ------------------------------- |
| Active        | Live history (may be mid-turn)  |
| Newly frozen  | "Save & start new" snapshot     |
| Legacy frozen | `/sessions/<slug>.md` (partial) |

## Errors

`permission-denied`, `redaction-unavailable`, `session-not-found`, `transfer-aborted`, `transfer-corrupt`, `schema-invalid`, `attachment-unreadable`.

## Frozen IDs

```bash
cat /sessions/index.json   # use each object's `id` with --id
```

## Notes

- Service not ready → `session export: session-not-found`.
- UI "Export transcript" (avatar menu) → same ZIP, browser download.
- Followers (tray, Cherry) request export from leader; one-time approval dialog. Cloud (headless) leader delegates the prompt to the requesting follower device.
