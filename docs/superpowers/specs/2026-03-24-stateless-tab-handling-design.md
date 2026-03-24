# Stateless Tab Handling

**Date:** 2026-03-24
**Status:** Approved

## Problem

The playwright command maintains a shared `currentTarget` (active tab) across all scoops. When multiple scoops use browser automation concurrently, they stomp on each other:

1. **Shared `currentTarget`** — Scoop A sets the active tab, scoop B sees the same value. Tab selection is a global race.
2. **Single CDP attachment** — `BrowserAPI.attachToPage()` detaches the previous target. If scoop A is mid-screenshot and scoop B navigates, A's operation runs on the wrong tab or fails.
3. **Index-based tab references** — Indices shift when tabs are added/removed concurrently. `tab-close 2` might close the wrong tab.
4. **Shared snapshot cache** — DOM element refs (e5, e12) are keyed by targetId but accessed via implicit "current tab". Two scoops on the same tab corrupt each other's element references.
5. **Teleport blocks everyone** — One scoop's auth teleport blocks ALL scoops' playwright commands.

## Design

### Core Principle: No Implicit State

Every playwright command that operates on a tab takes an explicit `--tab <targetId>` parameter. There is no mutable "current tab" variable. The agent must always specify which tab it's operating on.

### Tab ID Format

Use CDP `targetId` directly — already unique, stable, and what `BrowserAPI` uses internally. No mapping layer needed.

### Command Categories

**38 commands require `--tab <targetId>`** (all that currently call `ensureTarget()`):

**Navigation:** `goto`/`navigate`, `go-back`, `go-forward`, `reload`

**Inspection:** `screenshot`, `snapshot`, `eval`, `eval-file`

**Interaction:** `click`, `dblclick`, `hover`, `type`, `fill`, `select`, `check`, `uncheck`, `press`, `drag`, `scroll`, `resize`

**Wait:** `wait-for`

**Dialogs:** `dialog-accept`, `dialog-dismiss`

**Cookies:** `cookie-list`, `cookie-get`, `cookie-set`, `cookie-delete`, `cookie-clear`

**Storage:** `localstorage-list`, `localstorage-get`, `localstorage-set`, `localstorage-delete`, `localstorage-clear`, `sessionstorage-list`, `sessionstorage-get`, `sessionstorage-set`, `sessionstorage-delete`, `sessionstorage-clear`

**Teleport:** `teleport` (scoped to a tab)

**Tab close:** `tab-close`

**6 commands do NOT require `--tab`:**

| Command | Reason |
|---------|--------|
| `tab-list` | Lists all tabs — reads from Chrome, no tab context needed |
| `tab-new` / `open` | Creates a new tab, **returns the new targetId** |
| `tab-select` | Removed (no implicit current tab to select) |
| `record` | Creates recording — tab-agnostic |
| `stop-recording` | Stops recording — tab-agnostic |

### `tab-list` Output

`tab-list` queries Chrome for all tabs and marks the **browser-active tab** (the one Chrome has in the foreground). This is read-only observable state from CDP, not our mutable `currentTarget`:

```
[E9A3F...] https://example.com "Example Page" (active)
[B7C2D...] https://docs.google.com "Google Docs"
[F1D8A...] https://github.com "GitHub"
```

The `(active)` marker tells the agent which tab the user is currently looking at. This comes from Chrome's `Target.getTargets()` response, not from `PlaywrightState`.

### `tab-new` Return Value

`tab-new` (and `open`) return the new tab's targetId so the agent can capture it:

```
$ playwright-cli tab-new https://example.com
Opened https://example.com in new tab [targetId: E9A3F...]
```

### Error Handling

**Invalid/closed tab ID:** If `--tab <id>` points to a tab that no longer exists, the command returns a clear error:
```
Error: Tab <id> not found. Run 'playwright-cli tab-list' to see available tabs.
```

**Missing `--tab`:** If a command requires `--tab` but it's not provided:
```
Error: --tab <targetId> is required. Run 'playwright-cli tab-list' to get tab IDs.
```

**Old syntax used:** Index-based or implicit-tab commands produce a helpful migration message:
```
Error: Implicit tab selection removed. Use: playwright-cli screenshot --tab <targetId>
```

### What Gets Removed

- `PlaywrightState.currentTarget` — eliminated
- `ensureTarget()` function — eliminated
- Index-based tab selection (`tab-close 2`, `tab-switch 1`) — eliminated
- `tab-select` command — eliminated (no current tab to select)

### What Stays

- `PlaywrightState.snapshots` — still keyed by targetId, accessed via explicit `--tab`
- `BrowserAPI.attachToPage()` — still needed internally, called by `withTab()` mutex
- HAR recorder — can be scoped per tab ID

## CDP Attachment Mutex

### Problem

`BrowserAPI` has a single CDP session. `attachToPage()` detaches the previous target before attaching to a new one. If two scoops fire commands concurrently, one can detach the other's target mid-operation.

Additionally, `attachToPage()` handles remote targets (tray federation) by swapping the underlying `client` transport. The module-level `remoteTargetInfo` and `sessionId` are global mutable state.

### Solution

Add a `withTab(targetId, fn)` method that serializes all tab operations:

```typescript
class BrowserAPI {
  private _lock: Promise<void> = Promise.resolve();

  async withTab<T>(targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
    let release: () => void;
    const next = new Promise<void>(r => { release = r; });
    const prev = this._lock;
    this._lock = next;
    await prev;
    try {
      const sessionId = await this.attachToPage(targetId);
      return await fn(sessionId);
    } finally {
      release!();
    }
  }
}
```

The mutex protects the **entire** attach → operate → (implicit detach on next attach) cycle. This covers:
- Local target attachment (normal tabs)
- Remote target attachment (tray federation — transport swaps)
- Session ID and remote target info state

Each playwright command uses `browser.withTab(targetId, async (session) => { ... })` instead of manually calling `attachToPage()`.

### Concurrency Tests

Mutex tests live in `src/cdp/browser-api.test.ts`:
- Two concurrent `withTab()` calls with different targetIds serialize correctly
- The second call waits for the first to complete before attaching
- If the first call throws, the second still proceeds (mutex releases in `finally`)

## Teleport Handling

### Current Problem

`checkTeleportBlock()` is called for ALL playwright commands. If any teleport watcher is active, ALL commands are blocked for up to 300 seconds — even commands targeting unrelated tabs.

### Solution

Teleport watchers are scoped to a tab ID:

- `playwright-cli teleport --tab <id> --start <regex> --return <regex>`
- `PlaywrightState.teleportWatcher` becomes `PlaywrightState.teleportWatchers: Map<string, TeleportWatcher>`
- `checkTeleportBlock()` only blocks commands whose `--tab` matches an active teleport's tab
- Commands targeting other tabs proceed normally

### Edge Cases

- **Tab closed while teleport active:** Teleport watcher is cleaned up (disarmed) when the target tab is detected as closed. The `tab-close --tab <id>` command disarms any watcher on that tab before closing.
- **Multiple concurrent teleports:** Supported — each on a different tab. Two teleports on the same tab: second replaces first (existing behavior).

## Snapshot Element Refs

### Current Problem

Element refs (e5, e12) are generated per-snapshot and are **not stable across snapshots**. Different accessibility tree traversals produce different numbering. If scoop A snapshots a tab and gets e5 = "Submit button", then scoop B snapshots the same tab, e5 might now be "Cancel button".

### Solution

Element refs are scoped to the `--tab` + snapshot combination:

- `snapshot --tab ABC` caches snapshot for tab `ABC`
- `click --tab ABC e5` looks up snapshot for `ABC`, resolves `e5`
- Two scoops snapshotting **different tabs**: no conflict (different cache entries)
- Two scoops snapshotting the **same tab**: last write wins for the snapshot cache. Each scoop should take a fresh snapshot before interacting — this is already the expected pattern (snapshot → read refs → click). The refs are valid only until the next snapshot of that tab.

No change to snapshot caching mechanism needed — explicit `--tab` naturally scopes the lookup.

## Changes

### File: `src/shell/supplemental-commands/playwright-command.ts`

- Remove `currentTarget` from `PlaywrightState`
- Remove `ensureTarget()` function
- Remove `tab-select` command
- Add `--tab <targetId>` parsing to all 38 tab-operating subcommands
- Each command calls `browser.withTab(targetId, ...)` instead of `ensureTarget()` + `attachToPage()`
- Update `tab-list` to show `(active)` from Chrome's active tab, not `currentTarget`
- Update `tab-new` / `open` to return the new tab's targetId in output
- Remove all index-based tab selection
- Update `tab-close` to require `--tab <id>`
- Change `teleportWatcher` to `teleportWatchers: Map<string, TeleportWatcher>`
- Update `checkTeleportBlock()` to check only the target tab's watcher
- Add error messages for missing `--tab` and invalid tab IDs

### File: `src/cdp/browser-api.ts`

- Add `withTab(targetId, fn)` promise-based mutex method
- Keep `attachToPage()` as internal (called by `withTab()`)
- Add `withTab` tests in `src/cdp/browser-api.test.ts`

### File: `src/defaults/shared/CLAUDE.md`

Update agent instructions for the new tab handling pattern:

**Before:**
```
playwright-cli tab-new https://example.com
playwright-cli screenshot
playwright-cli snapshot
playwright-cli click e5
```

**After:**
```
playwright-cli tab-new https://example.com
# Output: Opened in new tab [targetId: E9A3F...]

playwright-cli screenshot --tab E9A3F
playwright-cli snapshot --tab E9A3F
playwright-cli click --tab E9A3F e5
```

Key instructions:
- Always capture the targetId from `tab-new` or `tab-list`
- Every command that operates on a tab requires `--tab <targetId>`
- Use `tab-list` to find the active tab (marked `(active)`)
- Element refs (e5, e12) are valid until the next snapshot of that tab

### File: `src/shell/supplemental-commands/playwright-command.test.ts`

- Update all existing tests to use `--tab <targetId>` syntax
- Remove tests for index-based selection and implicit current tab
- Add tests for: missing `--tab` error, invalid tab ID error, `tab-new` returns targetId
- Add tests for teleport scoped to tab (only blocks same-tab commands)

### File: `src/cdp/browser-api.test.ts`

- Add tests for `withTab()` mutex serialization
- Test concurrent calls serialize correctly
- Test error in first call doesn't block second

### Files: Agent skills in `src/defaults/workspace/skills/`

- Update any skills that use playwright commands to use `--tab` syntax
- Search for `playwright-cli` in all skill files and update

## Testing

- Unit tests for `--tab` parameter parsing (all 38 commands)
- Unit tests for `withTab()` mutex (concurrent serialization, error handling)
- Unit tests for `tab-new` returning targetId
- Unit tests for `tab-list` format (targetIds, active marker from Chrome)
- Unit tests for teleport per-tab scoping
- Unit tests for error messages (missing --tab, invalid tab ID, old syntax)
- Build gates: `npm run typecheck && npm run test && npm run build && npm run build:extension`

## Migration

This is a **breaking change** to the playwright command interface.

**What breaks:**
- All agent workflows using implicit current tab (the primary pattern today)
- All skills using `playwright-cli` without `--tab`
- Index-based tab operations (`tab-close 2`)
- `tab-select` command (removed)

**Migration path:**
- Update `src/defaults/shared/CLAUDE.md` (agent system prompt)
- Update all skills in `src/defaults/workspace/skills/`
- Old syntax produces helpful error messages pointing to the new syntax
- No deprecation period — clean break

## Tab Grouping for Agent-Created Tabs

### Current Gap

`BrowserAPI.createPage()` creates tabs via CDP `Target.createTarget`. In extension mode, this bypasses Chrome's tab grouping hooks — agent-created tabs are NOT added to the "slicc" tab group. Tab grouping currently only works when:
- The debugger client opens a tab (`src/cdp/debugger-client.ts:250`)
- The service worker opens a tab (`src/extension/service-worker.ts:417`)

Both use `addToSliccGroup(tabId)` from `src/extension/tab-group.ts`. But the playwright command path (`tab-new` / `open` → `BrowserAPI.createPage()`) does not.

### Fix

After `createPage()` returns a CDP `targetId`, resolve it to a Chrome `tabId` and call `addToSliccGroup(tabId)` in extension mode. This requires:

1. **Resolve targetId → tabId:** Use CDP `Target.getTargetInfo` or query `chrome.tabs` by URL/title to find the matching Chrome tab ID.
2. **Call `addToSliccGroup(tabId)`** — best-effort, same pattern as debugger-client.
3. **Extension-only:** In CLI mode there's no tab grouping API (no `chrome.tabs`). The grouping call is guarded by extension detection.

### Implementation Options

**Option A (recommended):** Add a `groupNewTab(targetId)` method to `BrowserAPI` that's a no-op in CLI mode and resolves + groups in extension mode. Called by the playwright command after `createPage()`.

**Option B:** Have `createPage()` itself handle grouping internally. Cleaner API but mixes concerns (CDP creation + Chrome extension grouping).

### Files

- Modify: `src/cdp/browser-api.ts` — add `groupNewTab()` or post-create hook
- Modify: `src/shell/supplemental-commands/playwright-command.ts` — call grouping after `tab-new` / `open`
- Use: `src/extension/tab-group.ts` — existing `addToSliccGroup()` (no changes needed)

## Out of Scope

- Per-scoop tab visibility/ACLs (all scoops can see all tabs)
- Tab ownership tracking (any scoop can close any tab)
- Multiple simultaneous CDP sessions (still one session, serialized via mutex)
- HAR recording refactor (follows the same explicit tab pattern)
