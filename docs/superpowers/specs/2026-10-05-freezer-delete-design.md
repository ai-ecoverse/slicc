# Delete frozen sessions from the Freezer rail — design

Date: 2026-10-05 · Branch: `feat/freezer-delete` · Status: revised after
adversarial review, pending user review

## Problem

Once a chat is frozen (New chat / New chat, fast / Drop cone), the Freezer rail
offers no way to remove it. `<slicc-freezer-card>` only fires
`freezer-card-select` (thaw read-only). "Erase" in `<slicc-freezer-new>` only
discards the _live_ chat before it is archived; nothing deletes an existing
archive. No open or closed issue/PR covers this (checked 2026-10-05; nearest
are #2272 and #1795, neither mentions deletion).

## Scope

- In: the desktop / extension WC Freezer rail on the leader, plus the
  index-writer and identity hardening that deletion depends on.
- Out (possible follow-ups): iOS Past Sessions delete, a `session rm` shell
  verb, soft-delete/undo, bulk delete, memory purge.
- Followers: the TS follower shell does NOT render frozen cards (only the
  leader's `wc-live-freezer.ts` calls `renderFreezerCards`); the iOS follower
  reads the leader's `/sessions/index.json` over remote VFS and reloads it each
  time its Past Sessions sheet opens. See Known limitations.

## Decisions

| Question           | Decision                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Trigger            | Trash icon on hover/focus of an expanded card → confirm dialog                           |
| Extracted memories | Kept. Memories carry no per-session provenance; the dialog says so                       |
| Live rows          | Not deletable ("in progress" = the open chat; New chat → Discard covers it)              |
| Pending rows       | Deletable; every background writer is made delete-safe (Section 1)                       |
| Where delete runs  | Page realm, inside `serializeIndexWrite` (Web Lock `slicc:sessions-index`, origin-wide)  |
| Order              | Files first, index row LAST — an interrupted delete leaves a visible, retryable card     |
| Identity           | Card slug = archive `filename` is the primary key; `sessionId` only when unique          |
| Hard vs soft       | Hard delete (confirm-first was chosen over undo)                                         |
| Hardening depth    | Full: fix every resurrection / orphan path found in review (user-approved over "narrow") |

## What a frozen session owns

`key` below = the row's `sessionId` when trusted (see 1a), else the archive
filename without `.md` — the same fallback `curateFrozenSessionMemories` uses.

| Artifact                      | Path                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| Index row                     | `/sessions/index.json`                                                                     |
| Markdown archive              | `/sessions/<filename>`                                                                     |
| Memory v2 JSONL sidecar       | `/sessions/<base>.jsonl` (`sidecarPathForArchive`)                                         |
| Persisted `/tmp` attachments  | `/sessions/attachments/<attachmentsKey>/` (initial filename base, recorded in frontmatter) |
| Complete snapshot bundle      | `/sessions/data/<sessionId>/` and staging `/sessions/data/.tmp-<id>`                       |
| Live-curation delta archives  | `/sessions/.live-deltas/<key>-<from>-<to>.md`                                              |
| Curator receipts              | `/sessions/.curated/<archive-or-delta basename>`                                           |
| Curator per-pass state        | `/sessions/.curation/<archive-or-delta base>/`                                             |
| Keyword search index (shared) | `/sessions/.search-index.json` (holds up to 4 KB body per doc)                             |

Not owned: scoop compaction snapshots under `/scoops/<folder>/sessions/<jid>/`
(per-scoop, not freezer-managed — same rule as `discardLiveSnapshot`); memory
files.

## Section 1 — Data layer

### 1a. Identity

- **Archive frontmatter fix (pre-existing bug, tightly coupled).**
  `freezeConeSession` writes the per-freeze UUID into the index row but
  `id: session.id` (the per-cone chat key `session-<folder>`) into the archive;
  `entryFromArchive` then promotes that `id` into `sessionId`, so after a
  corrupt-index rebuild every chat of a cone shares one `sessionId`. Fix: add a
  `sessionId:` frontmatter field written from the row's UUID
  (`FrozenSessionArchive.sessionId?`, `formatArchiveAsMarkdown`,
  `parseFrozenArchive`), preserved through enrichment rewrites and
  live-snapshot finalization. Rebuild prefers `sessionId:`; falls back to `id:`
  only when it is not a chat key (`/^session-/`); otherwise no `sessionId`.
  `id:` keeps its current meaning. Tracked as #3807; this branch fixes it.
- **Trusted sessionId**: a row's `sessionId` is used for path derivation or
  matching only if it is not a per-cone chat key (`session-…`) and no other
  row in the same index read shares it.
- **Delete key**: `{ filename, sessionId? }` from the card. Match by
  `filename`; only when that is a DRAFT name (`pending-` / `live-` — the only
  names enrichment renames) and absent, match the unique row with the
  trusted `sessionId`; else `'not-found'`. A stale card for a canonical name
  can never resolve to a different chat.

### 1b. Path safety

Index rows are unvalidated casts, and the VFS resolves `..`. Before ANY
filesystem call:

- `isSafeArchiveFilename(name)`: non-empty basename, ends in `.md`, no `/`,
  `\`, NUL, not `.`/`..`.
- `isSafeSessionKey(key)`: `/^[A-Za-z0-9._-]+$/` and not `.`/`..`.
- Attachment dirs are never inferred from message paths (a user can attach
  any VFS file, including another session's attachment). The freeze records
  its own dir as `attachmentsKey:` frontmatter (the initial filename base);
  delete removes only that dir and `/sessions/attachments/<current base>`,
  each validated with `isSafeSessionKey`.

An unsafe row returns `'unsafe'` and touches nothing.

### 1c. `deleteFrozenSession` (new `ui/frozen-session-delete.ts`)

```ts
export type DeleteFrozenSessionResult =
  | { status: 'deleted' }
  | { status: 'not-found' | 'live' | 'unsafe' }
  | { status: 'failed'; errors: string[] }; // row kept → retryable
export function deleteFrozenSession(
  vfs: WritableVfsClient,
  key: { filename: string; sessionId?: string }
): Promise<DeleteFrozenSessionResult>;
```

Inside ONE `serializeIndexWrite` callback (non-reentrant: use only
`*Unlocked` primitives inside):

1. `readSessionsIndexForWrite`; resolve the row (1a). Refuse `live`; validate
   (1b).
2. `removeFrozenSessionArtifacts(vfs, row, { trustedKey })` (shared helper,
   also used by 1e/1f) removes, tolerating ONLY `ENOENT`, collecting every
   other error and continuing: snapshot bundle + staging dir; sidecar;
   the attachment dirs the archive owns (`attachmentsKey:` + current base);
   live-delta archives matching `^<key>-\d+-\d+\.md$` plus each delta's
   receipt and curation dir; the archive's receipt and curation dir; then —
   only if nothing so far failed — the sidecar and the archive itself. The
   archive is the only record of a pre-rename attachment dir, so it must
   survive any failure for a retry to rediscover what is left.
3. Strict search-index invalidation (1g).
4. Only if no errors: write the index without the row (LAST), invalidate
   the search index once more (lenient — a rebuild that read the bodies
   before the delete may have written them back), then best-effort
   `vfs.flush()` → `'deleted'`. Otherwise keep the row →
   `'failed'` with the errors. Every step tolerates already-removed files, so
   a retry converges.

Why files-first: a crash or error leaves the row (the card is still there;
delete again) rather than orphan archives that a later corrupt-index rebuild
would resurrect. No tombstone needed. (`discardLiveSnapshot` is row-first
because it races the live snapshot writer; non-live rows have no such writer
once 1d–1f land.)

### 1d. Every index writer becomes delete-safe

| Writer                                                                                                            | Today                                                            | Change                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `enrichFreezerIcons` (`wc-freezer.ts`)                                                                            | Re-reads then rewrites the WHOLE index OUTSIDE the lock          | Picks icons outside; write inside `serializeIndexWrite`: re-read, set `icon` only on rows still present |
| Corrupt-index rebuild (`wc-live-freezer.ts` refresh)                                                              | Scans archives + writes outside the lock                         | Inside the lock: re-check state is still `corrupt`, scan, write                                         |
| `mergeFoldedCostIntoFrozen`                                                                                       | Unlocked read, then create-or-replace `upsertSessionsIndexEntry` | Single locked update-if-present by `filename`; never creates a row                                      |
| `replaceIndexEntry` (enrichment)                                                                                  | Prepends the replacement when the old row is missing             | See rules below                                                                                         |
| `clearPendingMarkers`, `recordPendingAttempt`, `stampMemory*`, `markSnapshotUnavailable`, `advanceCuratedThrough` | Locked, update-if-present                                        | Unchanged (verified no-op on a missing row)                                                             |

`replaceIndexEntry(old, replacement)` → `'replaced' | 'superseded' | 'deleted' | 'prepended'`, evaluated inside the lock:

1. Old row present → replace as today → `'replaced'`.
2. Old row missing, a row with the replacement's `filename` exists → it is
   the canonical row (#718): replace it in place → `'replaced'`.
3. Old row missing, the ONE row with the replacement's trusted `sessionId`
   (never a chat key) has another filename → a rival enrichment won: write
   nothing, delete nothing that row references → `'superseded'`.
4. Old row missing, old archive missing, no row as in 2–3 → deleted while
   enriching: remove the just-written new archive + sidecar (only if no row
   references them) → `'deleted'`.
5. Old row missing, old archive present → keep today's prepend (index lost or
   rebuilt) → `'prepended'`.

`commitEnrichedArchive` returns `null` on `'superseded'` / `'deleted'` and
skips its own stale-file cleanup (the winner or the delete owns it), so
`enrichPendingSession` keeps its `FrozenSessionIndexEntry | null` signature.
Callers that must know whether the session still exists ask the index (1e).

### 1e. Background pipeline stops on a deleted session

- `new-session.ts` agentic background pass and legacy timer race: a locked
  presence check (`findIndexedFrozenRow(vfs, key)`) runs right before the
  curator spawn and before `onSessionSettled`. Only `absent` (a well-formed
  index without the row) skips work — a missing or corrupt index is
  `unknown` and proceeds as today. `absent` skips
  `curateFrozenSessionMemories` and `onSessionSettled` (no billable curator,
  no gelatiere notification for a deleted archive). A row renamed by another
  enrichment is followed to its current filename.
- `processPendingSessions` (boot catch-up) only calls `enrichPendingSession`
  and never spawns the curator; the 1d `replaceIndexEntry` rules cover it.
- A curator already running when the delete lands: after it resolves, the
  caller re-checks presence; if `absent`, it runs `removeCuratorByproducts`
  for the receipt / curation state / deltas the curator produced (never the
  archive itself — the delete already swept it).

### 1f. Complete-snapshot capture

- `snapshot-store.ts`: export `removeSnapshot(vfs, sessionId)` — validates the
  key, removes `/sessions/data/<id>/` and `/sessions/data/.tmp-<id>`,
  tolerating ONLY `ENOENT` (the existing private `removeDir` swallows
  everything and is not reused as-is).
- `TranscriptExportService.captureFrozen`: in a `finally` after
  `snapshotStore.write` (so it also runs when a concurrent delete broke the
  publish), call — NOT awaited, so New chat's 5 s snapshot deadline never
  waits on the lock — the optional `snapshotStore.discardIfUnindexed(sessionId)`, wired to
  `discardSnapshotIfUnindexed` in both the page (`wc-live.ts`) and worker
  (`orchestrator.ts`) registrations. Inside `serializeIndexWrite` it removes
  the bundle only when a well-formed index has no row with that
  `sessionId` (missing/corrupt index → keep). The lock orders this after any
  in-flight delete, so publish-after-delete cannot leave an orphan bundle.
- Export after delete needs no change: files-first means the snapshot is gone
  before the row, so `buildFrozenSnapshot` misses it and the legacy fallback
  finds no row.

### 1g. Search index

- `invalidateSessionSearchIndex(vfs, { strict: true })` tolerates only
  `ENOENT`; other errors throw (deletion reports `'failed'`, row kept). The
  default stays lenient so `discardLiveSnapshot` is unchanged.
- `rebuildSessionSearchIndex` / `ensureSessionSearchIndex`: recompute the
  located-entries fingerprint immediately before `writeFile`; if it changed
  during the build, skip the write (`written: false`) and serve the
  in-memory index just built. Narrows the "rebuild started before delete
  writes stale bodies" window; the existing fingerprint check forces a
  rebuild on the next search for anything that slips through.

## Section 2 — UI

**`<slicc-freezer-card>`** (webcomponents `src/freezer/slicc-freezer-card.ts`):

- New boolean attribute `deletable` (reflected property, observed). The trash
  button is created/removed with `deletable`; `expanded` needs no observation.
- Button: `<button type="button">` + `iconEl('trash-2')`, `part="delete"`,
  `aria-label="Delete “<title>”"` (kept in sync with `title`), `title="Delete"`.
- CSS: `slicc-freezer-card:not([expanded]) .slicc-fzcard__delete { display:
none }` — removes it from layout AND tab order in the icon-only rail.
  Expanded: `opacity: 0` → `1` on `:hover` / `:focus-within`. Token-only.
- Click: `stopPropagation()` (the host's bubbling click → thaw never fires),
  then `freezer-card-delete` (composed + bubbling, `detail: { slug }`).
  Built with `h()` / `iconEl()`; no `innerHTML`.

**`ui/wc/wc-freezer.ts`**: `frozenCard(entry, { deletable })` sets
`deletable` unless `entry.live`; `renderFreezerCards(freezer, entries, opts)`
passes it through. Default off.

**`ui/wc/wc-live-freezer.ts`** + new **`ui/wc/wc-freezer-delete.ts`**
(`wireFreezerRail` is at 145 of Biome's 150 counted lines, so the delete flow
lives in its own module and the refresh/icon helpers move to module scope):

- `renderFreezerCards(refs.freezer, entries, { deletable: true })`.
- On `freezer-card-delete`: resolve the entry by `filename === slug`; ignore
  live rows, unknown slugs, and a slug whose dialog/delete is already open.
- Dialog via `buildConeDialog` + button styles exported from
  `wc-cone-actions.ts`: heading "Delete frozen chat?", body "“<title>” and its
  transcript will be deleted. Memories already learned from it
  are kept." (title via `textContent`), Cancel / Delete (`BTN_DANGER`).
- Delete: disable both buttons, `await deleteFrozenSession(writer,
{ filename, sessionId })`.
  - `'deleted'`: if it is the viewed session (`currentFrozenSessionId` ===
    `sessionId ?? filename`): `getController()?.loadMessages([])` FIRST
    (selecting a cone loads its snapshot asynchronously and keeps the old
    thread on failure), clear `currentFrozenSessionId`, then select
    `rootForConeFolder(getUnits(), entry.cone)` (with no root — impossible,
    the last cone cannot be dropped — only the thread is cleared). Close
    dialog, `refreshFreezer()`.
  - `'failed'` or a thrown error: keep the dialog open, show an inline error line ("Couldn't
    delete everything — try again."), re-enable Delete, `log.error` the
    errors.
  - `'live' | 'not-found' | 'unsafe'`: close, `log.warn`, `refreshFreezer()`.
- Focus: on close, if focus fell back to `<body>` (the opener was detached by
  a refresh that re-rendered the cards while the dialog was open), focus the
  re-rendered card's delete button for the same slug.

## Section 3 — Testing and docs

Tests (mirrored under `packages/*/tests/`; real `VirtualFS` +
`fake-indexeddb/auto` with unique `dbName` unless noted):

- webapp `tests/ui/frozen-session-delete.test.ts`: removes every artifact in
  the inventory (incl. attachments under the pre-rename key, deltas +
  receipts + curation dirs, snapshot + `.tmp-`); row removed last; `live`,
  `not-found`, `unsafe` (`../shared/x.md`, absolute, backslash, NUL) touch
  nothing; filename match, then unique-sessionId fallback after a rename;
  duplicate `sessionId` rows → no sessionId-derived deletion; injected
  non-ENOENT failure → `'failed'`, row kept, retry converges; sibling rows and
  files intact.
- webapp `tests/transcript/frozen-archive-*.test.ts` + `tests/ui/wc/wc-freezer.test.ts`:
  `sessionId:` frontmatter round-trip; rebuild prefers it; legacy `id:
session-cone` yields no `sessionId`.
- webapp `tests/ui/session-freezer.test.ts`: `replaceIndexEntry` four outcomes;
  two concurrent enrichers (same and different titles) never delete the
  winner; enrichment vs delete → no resurrection, new files removed.
- webapp `tests/ui/new-session.test.ts`: deleted outcome / missing row skips
  curator spawn and `onSessionSettled`; delete during a running curator →
  post-run artifacts cleaned.
- webapp writer-race tests (deterministic interleaving via deferred promises):
  `enrichFreezerIcons`, corrupt rebuild, `mergeFoldedCostIntoFrozen` each vs
  delete → no resurrection.
- webapp `tests/transcript/snapshot-store.test.ts` + export-service:
  `removeSnapshot` strictness + staging dir; capture publishing after a delete
  removes its bundle.
- webapp `tests/transcript/session-search-index.test.ts`: strict invalidation;
  rebuild skips the write when the fingerprint changed mid-rebuild.
- webapp `tests/ui/wc/wc-live-freezer-delete.test.ts` (jsdom): event → dialog;
  Cancel → no call; Delete → helper called + refresh; viewed session →
  thread cleared before cone selection (snapshot promise never resolves);
  `'failed'` keeps dialog with error; refresh-while-open → focus restored to
  the re-rendered card.
- webcomponents `tests/freezer/slicc-freezer-card.test.ts` (browser): button
  only with `deletable`; hidden + not tabbable when collapsed (mount
  collapsed → expand → collapse while focused); click fires
  `freezer-card-delete` and NOT `freezer-card-select`; aria-label tracks
  `title`.
- Stories: `deletable` variant in `slicc-freezer-card.stories.ts`.

Docs:

- `README.md` Cone bullet: frozen chats can be deleted from the rail (trash
  icon, confirm); extracted memories are kept.
- `docs/work-unit.md` Freezer bullets: delete semantics (files-first, row
  last, retryable), writer rules, `sessionId:` frontmatter.
- `docs/webcomponents-details.md`: `deletable` + `freezer-card-delete` on the
  card contract.
- `packages/webapp/CLAUDE.md` never-rules: one line — every
  `/sessions/index.json` write goes through `serializeIndexWrite` and updates
  only rows still present (only a freeze creates rows).

Verification: full `verifying-before-push` pass — `lint`, `typecheck`,
`test`, `test:coverage` (webapp + webcomponents floors), both builds,
touched-file debt gate.

## Known limitations

- The agentic curator's persisted session transcript
  (`/sessions/agent-memory-curator[-<folder>]-<ts>.md`) can contain the
  archive text and is not removed by delete (hence the dialog says "deleted",
  not "permanently deleted"). Follow-up: record the curator transcript path
  in the per-pass curation state so the sweep can remove it.

- Archives frozen before `attachmentsKey:` existed and later renamed by
  enrichment leave their pre-rename `/sessions/attachments/pending-…/` dir
  on disk when deleted (ownership cannot be proven, so it is never guessed).

- Rows whose index was rebuilt before #3807 lost their per-freeze UUID; their
  `/sessions/data/<uuid>/` bundle cannot be found by delete and stays on disk.

- iOS follower: an archive already open stays visible (in memory) until
  dismissed; the list refreshes next time the Past Sessions sheet opens.
- A stale `pending-*` archive left by an EARLIER failed enrichment cleanup is
  not tracked by any row and is not removed; a later corrupt-index rebuild
  could surface it (pre-existing behavior for such aliases).
- A search-index rebuild that read archives just before the delete and writes
  just after can hold deleted excerpts until the next `session search`
  rebuilds on the fingerprint mismatch (window narrowed by 1g).

## Housekeeping

This spec and the implementation plan ship with the branch; a cleanup worker
removes planning artifacts from `main` afterwards (as in `6a82b8c9c`).
