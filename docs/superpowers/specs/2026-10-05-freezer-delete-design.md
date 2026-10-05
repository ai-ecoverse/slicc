# Delete frozen sessions from the Freezer rail — design

Date: 2026-10-05 · Branch: `feat/freezer-delete` · Status: approved, pre-plan

## Problem

Once a chat is frozen (New chat / New chat, fast / Drop cone), the Freezer rail
offers no way to remove it. `<slicc-freezer-card>` only fires
`freezer-card-select` (thaw read-only). "Erase" in `<slicc-freezer-new>` only
discards the _live_ chat before it is archived; nothing deletes an existing
archive. No open or closed issue/PR covers this (checked 2026-10-05; nearest
are #2272 and #1795, neither mentions deletion).

## Scope

- In: the desktop / extension WC Freezer rail on the leader.
- Out (possible follow-ups): TS follower rail, iOS Past Sessions sheet, a
  `session rm` shell verb, soft-delete/undo, bulk delete, memory purge.
- Followers read the leader's `/sessions/index.json` over remote VFS, so a
  deleted row disappears from their lists on next load with no protocol work.

## Decisions

| Question           | Decision                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Trigger            | Trash icon on hover/focus of an expanded card → confirm dialog                                                |
| Extracted memories | Kept. Memories carry no per-session provenance; the dialog says they are kept                                 |
| Live rows          | Not deletable ("in progress" = the open chat; New chat → Discard covers it)                                   |
| Pending rows       | Deletable; the enrichment race is closed (below)                                                              |
| Where delete runs  | Page realm, inside `serializeIndexWrite` (Web Locks `slicc:sessions-index`, origin-wide across page + kernel) |
| Hard vs soft       | Hard delete (confirm-first was chosen over undo)                                                              |

## What a frozen session owns

| Artifact                 | Path                                    |
| ------------------------ | --------------------------------------- |
| Index row                | `/sessions/index.json`                  |
| Markdown archive         | `/sessions/<filename>`                  |
| Memory v2 JSONL sidecar  | `/sessions/<base>.jsonl`                |
| Curator receipt          | `/sessions/.curated/<filename>`         |
| Complete snapshot bundle | `/sessions/data/<sessionId>/`           |
| Keyword search index     | `/sessions/.search-index.json` (shared) |

## Section 1 — Data layer

**New module `ui/frozen-session-delete.ts`** (webapp; keeps the 1,688-line
`ui/session-freezer.ts` from growing):

```ts
export type DeleteFrozenSessionResult = 'deleted' | 'not-found' | 'live';
export function deleteFrozenSession(
  vfs: WritableVfsClient,
  key: { sessionId?: string; filename: string }
): Promise<DeleteFrozenSessionResult>;
```

Inside ONE `serializeIndexWrite` transaction (must not call any other locked
helper — Web Locks are not reentrant):

1. Re-read the index with `readSessionsIndexForWrite`. Match by `sessionId`
   when the key has one (stable across enrichment renames), else by
   `filename`. No match → `'not-found'`. Match with `live: true` → `'live'`,
   nothing touched.
2. Write the index without the row (`writeSessionsIndexUnlocked`) FIRST —
   same order as `discardLiveSnapshot`: a crash mid-delete leaves orphan
   files, never a row pointing at nothing.
3. Remove, using the matched row's CURRENT filename: the archive, the JSONL
   sidecar (`removeSessionJsonl`), the curator receipt (`curatorReceiptPath`),
   and the snapshot bundle (`removeSnapshot`). ENOENT is fine; other errors
   are logged and the remaining steps still run (the row is already gone).
4. `invalidateSessionSearchIndex` so deleted bodies are not recoverable from
   the shared keyword index; then best-effort `vfs.flush()`.

Heavy modules (`session-jsonl`, `session-search-index`, `snapshot-store`,
`agentic-memory`) are dynamic-imported, matching `discardLiveSnapshot`.

**`transcript/snapshot-store.ts`**: export `removeSnapshot(vfs, sessionId)`, a
thin wrapper over the existing private `removeDir` for
`/sessions/data/<sessionId>`. Reject a `sessionId` containing `/` or `..`
before building the path.

**Enrichment race fix (`replaceIndexEntry` in `ui/session-freezer.ts`)**.
Today `enrichPendingSession` writes the renamed archive + sidecar, then calls
`replaceIndexEntry`, which PREPENDS the replacement when the old row is
missing — so a delete landing between the write and the index swap would
resurrect the session. New rule, evaluated inside the same lock:

- Old row missing AND old archive (`/sessions/<oldFilename>`) missing ⇒ the
  session was deleted: remove the just-written new archive + new sidecar,
  write nothing, return `'deleted'`.
- `enrichPendingSession` treats `'deleted'` like its other bail-outs:
  returns `null`, logs at info, skips its stale-file cleanup.
- Old row missing but old archive present (index lost/rebuilt) keeps today's
  prepend behavior.

Other index writers were checked and are safe with a missing row:
`advanceCuratedThrough` and `markSnapshotUnavailable` no-op;
`snapshotLiveSession` only writes `live` rows, which are not deletable.

## Section 2 — UI

**`<slicc-freezer-card>`** (webcomponents `src/freezer/slicc-freezer-card.ts`):

- New boolean attribute `deletable` (reflected property), added to
  `observedAttributes`.
- When `deletable` AND `expanded`: a trailing `<button type="button">` with
  `iconEl('trash-2')`, `part="delete"`, `aria-label="Delete “<title>”"`,
  `title="Delete"`. Visible on row `:hover` / `:focus-within` (opacity),
  keyboard-focusable. Hidden in the collapsed (icon-only) rail.
- Click (and Enter/Space via the native button): `stopPropagation()` so the
  row does not thaw, then fire `freezer-card-delete` (composed + bubbling,
  `detail: { slug }`).
- Built with `h()` / `iconEl()` (no `innerHTML`); styles in the existing
  light-DOM document stylesheet, token-only (`--txt-3`, `--ink`, `--ghost`,
  `--rose`).

**`ui/wc/wc-freezer.ts`**: `frozenCard(entry, opts?: { deletable?: boolean })`
sets `deletable` unless `entry.live`; `renderFreezerCards(freezer, entries,
opts?)` passes it through. Default off, so any other host that renders cards
never shows a trash button with no handler.

**`ui/wc/wc-live-freezer.ts`**:

- `renderFreezerCards(refs.freezer, entries, { deletable: true })`.
- Listen for `freezer-card-delete`; resolve the entry from `frozenEntries` by
  `filename === slug`.
- Open a `<slicc-dialog>` via the existing `buildConeDialog` (exported from
  `ui/wc/wc-cone-actions.ts` together with the button styles): heading
  **"Delete frozen chat?"**, body **"“<title>” and its transcript will be
  permanently deleted. Memories already learned from it are kept."**, buttons
  **Cancel** / **Delete** (`BTN_DANGER`). Title rendered via `textContent`.
- On Delete: disable the button, `await deleteFrozenSession(writer,
{ sessionId, filename })`, close the dialog, `refreshFreezer()`.
- If the deleted session is the one being viewed (`currentFrozenSessionId`
  matches `sessionId ?? filename`), clear it and select the archive's cone via
  `rootForConeFolder(getUnits(), entry.cone)` — same fallback as a failed
  thaw.
- Errors: `log.error`, close the dialog, `refreshFreezer()` (the rail shows
  ground truth). `'live'` / `'not-found'` just refresh.
- One delete in flight per slug; a second event for the same slug while its
  dialog/delete is pending is ignored.

## Section 3 — Testing and docs

Tests (mirrored under `packages/*/tests/`):

- webapp `tests/ui/frozen-session-delete.test.ts` — real `VirtualFS`
  (`fake-indexeddb/auto`, unique `dbName`): removes every artifact; refuses
  `live`; finds by `sessionId` after a rename; `not-found`; tolerates missing
  files; leaves sibling rows and their files intact; search index invalidated.
- webapp `tests/ui/session-freezer.test.ts` — enrichment race: delete a
  `pending-*` row between the archive write and `replaceIndexEntry` → no row
  resurrected, new archive + sidecar removed; existing prepend-when-index-lost
  behavior still covered.
- webapp `tests/ui/wc/wc-live-freezer-delete.test.ts` (jsdom, harness like
  `wc-live-freezer-erase.test.ts`): event → dialog; Cancel → no call; Delete →
  helper called with `{ sessionId, filename }` + refresh; deleting the viewed
  session selects its cone; failure leaves the card and logs.
- webcomponents `tests/freezer/slicc-freezer-card.test.ts` (browser): button
  only with `deletable` + `expanded`; click fires `freezer-card-delete` and
  NOT `freezer-card-select`; keyboard reachable; aria-label carries the title.
- Stories: add a `deletable` variant to `slicc-freezer-card.stories.ts`.

Docs:

- `README.md` Cone bullet: frozen chats can be deleted from the rail (trash
  icon, confirm); extracted memories are kept.
- `docs/work-unit.md` Freezer bullets (~line 597): delete semantics, lock,
  enrichment-race rule.
- `docs/webcomponents-details.md`: `deletable` attribute +
  `freezer-card-delete` event on the card contract.

Verification: full `verifying-before-push` pass — `lint`, `typecheck`,
`test`, `test:coverage` (webapp + webcomponents floors), both builds,
touched-file debt gate.

## Housekeeping

Planning artifacts do not ship to `main` (see `6a82b8c9c`). This spec and the
implementation plan live on the feature branch only and are dropped before
the PR is opened.
