# Migrate Page Sprinkle

A one-click migration trigger for the slicc extension. The user navigates to any webpage, clicks "Migrate This Page" in the sprinkle panel, and the full 4-phase EDS migration runs — with live progress feedback in the sprinkle.

## Context

Three existing systems combine:

1. **Sprinkles** — Interactive `.shtml` panels in the VFS that communicate with agents via `slicc.lick()` (sprinkle → cone) and `sprinkle send` (cone → sprinkle). Work in both CLI and extension modes.
2. **Migration skills** — `migrate-page`, `migrate-block`, `migrate-header`, `dismiss-overlays` — already bundled as default skills in `src/defaults/workspace/skills/`. Orchestrate a 4-phase flow: extraction → decomposition → block generation → assembly.
3. **Extension active tab detection** — `playwright-cli tab-list` returns `PageInfo` with an `active: true` field in extension mode, identifying the user's focused tab.

Today, migration is triggered by typing in chat: "Migrate https://example.com/ — use owner/repo". This sprinkle replaces that with a single button click.

## Approach

Zero new infrastructure. The sprinkle sends a bare lick event. The cone handles everything using existing primitives:

- Active tab URL via `playwright-cli tab-list` (already has `active` field)
- Repo config via `read_file` on a workspace-level JSON file
- Progress updates via `sprinkle send` (existing sprinkle bridge)
- Migration execution via the existing migrate-page skill

No new bridge APIs, no new message types, no new extension plumbing.

**Cone-direct handling:** The agent's system prompt (Rules 2 and 5 in `/shared/CLAUDE.md`) normally prohibits the cone from handling lick events or running `sprinkle send`. The migrate-page skill explicitly overrides this for migration — the cone is the natural orchestrator because it creates scoops in Phase 3 (scoops cannot create scoops). The "Sprinkle Trigger" section in `SKILL.md` includes a carve-out that authorizes the cone to handle the lick and send progress updates directly.

## Sprinkle UI

File: `/shared/sprinkles/migrate-page/migrate-page.shtml`
Source: `src/defaults/shared/sprinkles/migrate-page/migrate-page.shtml` (follows the same pattern as the welcome sprinkle — priority discovery root).

### Opening the sprinkle

The sprinkle appears in the [+] sprinkle picker alongside other available sprinkles. The user opens it once; after that, it stays in the open sprinkles list (`slicc-open-sprinkles` in localStorage) and persists across sessions.

### Four states

**Ready** — Default state. Shows the configured repo name (e.g., `adobe/aem-boilerplate`) as a small indicator, a prominent "Migrate This Page" button, and a hint that it targets the active browser tab.

**Migrating** — After clicking. The button area transforms into a phase tracker:

- Four phases: Extraction, Decomposition, Generating Blocks, Assembly
- Each phase shows: checkmark (done), spinner (running), or circle (pending)
- Running phase includes a sub-status line (e.g., "hero, cards (2/5)")
- A progress bar at the bottom
- Source URL displayed at the top

**Done** — Migration complete. Shows a checkmark, the migrated URL, a "Preview" button (opens the preview service worker URL), and a "New Migration" button that resets to Ready.

**Error** — Shown when any phase fails. Displays the error message from the cone and a "Try Again" button that resets to Ready.

### Sprinkle JavaScript

On load:

- `slicc.readFile("/shared/migrate-config.json")` → parse JSON → display repo name
- `slicc.getState()` → restore last known state (handles side panel close/reopen during migration)

On click:

- Set state to "migrating" locally (disables button, prevents double-trigger)
- `slicc.lick({action: "migrate-page"})`

On update (`slicc.on('update', callback)`):

- Receives progress payloads from the cone
- Updates phase tracker UI
- Persists state via `slicc.setState()` for side panel recovery

On load recovery:

- `slicc.getState()` returns the last state persisted by the update handler
- If the panel was closed mid-migration, `sprinkle send` calls during that window are silently dropped (fire-and-forget). The sprinkle also reads `/shared/migrate-config.json` which includes a `currentMigration` field written by the cone at each phase transition. This is the authoritative recovery source.

## Workspace Config

File: `/shared/migrate-config.json`

```json
{
  "repo": "adobe/aem-boilerplate",
  "currentMigration": null
}
```

During migration, the cone writes progress to `currentMigration`:

```json
{
  "repo": "adobe/aem-boilerplate",
  "currentMigration": {
    "url": "example.com/products",
    "phase": "blocks",
    "status": "running",
    "detail": "hero, cards (2/5)"
  }
}
```

Set to `null` on completion or error.

- Ships pre-populated with the default boilerplate repo
- Sprinkle reads on load to display repo indicator and recover migration state
- Cone reads on migration to get the repo for git clone + branch creation
- Cone writes `currentMigration` at each phase transition (authoritative progress source — survives panel close)
- Cone writes `repo` when the user requests a repo change in chat
- Bundled via `src/defaults/shared/migrate-config.json` → extracted to VFS on first run

## Data Flow

### Trigger

```
User clicks "Migrate This Page"
  → sprinkle calls slicc.lick({action: "migrate-page"})
  → lick event routed to cone as incoming message
      channel: "sprinkle", source: "sprinkle:migrate-page"
      body: {action: "migrate-page"}
```

### Cone handles lick

1. `playwright-cli tab-list` → find tab with `active: true` → extract URL
2. `read_file /shared/migrate-config.json` → get repo
3. `read_file /workspace/skills/migrate-page/SKILL.md` → load migration instructions
4. Start Phase 1 (extraction) of the existing 4-phase flow

### Progress updates (cone → sprinkle)

At each phase transition, the cone runs:

```bash
sprinkle send migrate-page '<json>'
```

Payload format:

```json
{"phase": "extraction", "status": "running"}
{"phase": "extraction", "status": "done"}
{"phase": "decomposition", "status": "done", "detail": "5 blocks"}
{"phase": "blocks", "status": "running", "detail": "hero, cards (2/5)"}
{"phase": "blocks", "status": "done"}
{"phase": "assembly", "status": "running"}
{"phase": "done", "url": "example.com/products", "previewUrl": "/preview/shared/..."}
{"phase": "error", "message": "Failed to clone repo"}
```

### Completion

Cone sends `{phase: "done", previewUrl: "..."}`. Sprinkle transitions to Done state with a Preview link.

## Changes Required

### New files

| File                                                            | Purpose                                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/defaults/shared/sprinkles/migrate-page/migrate-page.shtml` | The sprinkle (HTML + JS for 4 states: ready, migrating, done, error) |
| `src/defaults/shared/migrate-config.json`                       | Default workspace config with `adobe/aem-boilerplate`                |

### Modified files

| File                                                  | Change                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/defaults/workspace/skills/migrate-page/SKILL.md` | Add "Sprinkle Trigger" section: (1) carve-out overriding Rules 2/5 to authorize cone-direct lick handling and `sprinkle send`; (2) instructions to detect active tab, read config, start migration; (3) `sprinkle send` commands at each phase transition; (4) `write_file` to update `currentMigration` in config at each phase. |

### No changes needed

- No new bridge APIs — `slicc.lick()`, `slicc.readFile()`, `slicc.on('update')`, `slicc.getState()`/`slicc.setState()` already exist
- No new message types — sprinkle licks already route to the cone
- No extension plumbing — sprinkles already work in extension mode (sandbox iframe)
- No sprinkle manager changes — `.shtml` files are auto-discovered from VFS

## Edge Cases

| Scenario                                       | Behavior                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No active tab (user on `chrome://` or new tab) | Cone detects no HTTP URL from `playwright-cli tab-list`. Sends `{phase: "error", message: "No page to migrate — navigate to a webpage first"}`. Sprinkle shows error, resets to Ready.                                                                                                                                                                                                |
| Migration already running                      | Sprinkle tracks `migrating` state locally. Button disabled while in progress. Prevents double-trigger.                                                                                                                                                                                                                                                                                |
| Side panel closed mid-migration                | Migration continues in offscreen. `sprinkle send` calls during the closed window are silently dropped (fire-and-forget). On reopen, sprinkle reads `currentMigration` from `/shared/migrate-config.json` — this is the authoritative recovery source since the cone writes it at every phase transition. If `currentMigration` is `null`, migration finished or errored while closed. |
| Error mid-migration                            | Cone sends `{phase: "error", message: "..."}`. Sprinkle shows error with message and "Try Again" button.                                                                                                                                                                                                                                                                              |
| User wants different repo                      | Asks in chat. Cone updates `/shared/migrate-config.json`. On next sprinkle load, new repo is shown.                                                                                                                                                                                                                                                                                   |

## Testing

| Test                        | Approach                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Sprinkle state transitions  | Unit: feed mock progress payloads to the update handler, verify DOM transitions (ready → migrating → done, ready → error → ready) |
| Config read on load         | Unit: mock `slicc.readFile()` returning valid config / malformed JSON, verify repo indicator display                              |
| Lick event payload          | Integration: verify `slicc.lick({action: "migrate-page"})` produces the expected lick event shape at the cone                     |
| Progress display            | Unit: each progress payload renders the correct phase as done/running/pending with correct detail text                            |
| Extension sandbox rendering | Manual: load extension, open sprinkle, verify it renders in sandbox iframe with theme CSS                                         |

## Out of Scope (v1)

- Migration history / log of past migrations
- Batch migration (multiple pages)
- Sprinkle-level repo picker UI (cone handles in chat)
- Cancel button (migration can be aborted from chat)
