# Stateless Tab Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate shared mutable tab state in the playwright command by making every command take an explicit `--tab <targetId>`, add a CDP attachment mutex for concurrent safety, and ensure agent-created tabs join the slicc tab group.

**Architecture:** Remove `currentTarget` and `ensureTarget()` from `PlaywrightState`. Add `--tab` parameter parsing as a shared utility used by all 36 tab-operating commands. Add `withTab()` mutex to `BrowserAPI`. Change teleport to per-tab watchers. Update agent system prompt.

**Tech Stack:** TypeScript, CDP protocol, Chrome Extension APIs, Vitest

**Spec:** `docs/superpowers/specs/2026-03-24-stateless-tab-handling-design.md`

---

### Task 1: Add `withTab()` mutex to BrowserAPI

**Files:**
- Modify: `packages/webapp/src/cdp/browser-api.ts`
- Modify: `packages/webapp/src/cdp/browser-api.test.ts`

This is the foundational change — all other tasks depend on it.

- [ ] **Step 1: Write failing tests for withTab mutex**

Add to `packages/webapp/src/cdp/browser-api.test.ts`:

```typescript
describe('withTab mutex', () => {
  it('serializes concurrent withTab calls', async () => {
    const order: string[] = [];
    const browser = new BrowserAPI(/* mock transport */);
    // Mock attachToPage to track call order
    vi.spyOn(browser, 'attachToPage').mockImplementation(async (id) => {
      order.push(`attach-${id}`);
      return `session-${id}`;
    });

    const p1 = browser.withTab('tab-A', async () => {
      order.push('op-A-start');
      await new Promise(r => setTimeout(r, 50));
      order.push('op-A-end');
      return 'result-A';
    });
    const p2 = browser.withTab('tab-B', async () => {
      order.push('op-B-start');
      order.push('op-B-end');
      return 'result-B';
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('result-A');
    expect(r2).toBe('result-B');
    // A must complete entirely before B starts
    expect(order).toEqual([
      'attach-tab-A', 'op-A-start', 'op-A-end',
      'attach-tab-B', 'op-B-start', 'op-B-end',
    ]);
  });

  it('releases mutex even if operation throws', async () => {
    const browser = new BrowserAPI(/* mock transport */);
    vi.spyOn(browser, 'attachToPage').mockResolvedValue('session');

    await expect(browser.withTab('tab-A', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // Second call should proceed (mutex released)
    const result = await browser.withTab('tab-B', async () => 'ok');
    expect(result).toBe('ok');
  });
});
```

Note: The test setup needs to handle BrowserAPI constructor requirements. Read the existing test file to understand the mock pattern (BrowserAPI may need a mock transport or the tests may need to use a different approach). Adapt accordingly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/webapp/src/cdp/browser-api.test.ts`
Expected: Fail — `withTab` method doesn't exist yet.

- [ ] **Step 3: Implement withTab mutex**

In `packages/webapp/src/cdp/browser-api.ts`, add to the `BrowserAPI` class:

```typescript
  private _tabLock: Promise<void> = Promise.resolve();

  /**
   * Execute an operation on a specific tab with exclusive access.
   * Serializes all tab operations — only one tab can be attached at a time.
   * Handles local and remote (tray) targets transparently.
   */
  async withTab<T>(targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
    let release: () => void;
    const next = new Promise<void>(r => { release = r; });
    const prev = this._tabLock;
    this._tabLock = next;
    await prev;
    try {
      const sessionId = await this.attachToPage(targetId);
      return await fn(sessionId);
    } finally {
      release!();
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/webapp/src/cdp/browser-api.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/cdp/browser-api.ts packages/webapp/src/cdp/browser-api.test.ts
git commit -m "feat(cdp): add withTab() mutex for serialized tab operations

Ensures concurrent scoops can't interleave CDP attachments.
The attach → operate cycle is atomic per withTab call.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Add `--tab` parsing utility and remove `currentTarget` / `ensureTarget`

**Files:**
- Modify: `packages/webapp/src/shell/supplemental-commands/playwright-command.ts`

This task adds the `--tab` parsing, removes `currentTarget` from `PlaywrightState`, removes `ensureTarget()`, and removes `tab-select`. No command handlers are updated yet — that's Task 3.

- [ ] **Step 1: Add `requireTab()` helper function**

Add a new function near `ensureTarget()`:

```typescript
/**
 * Parse and validate the --tab parameter. Returns the targetId or throws.
 * Used by all tab-operating commands instead of ensureTarget().
 */
async function requireTab(
  browser: BrowserAPI,
  state: PlaywrightState,
  flags: Record<string, string>,
): Promise<string> {
  const tabId = flags['tab'];
  if (!tabId) {
    return { error: 'Error: --tab <targetId> is required. Run \'playwright-cli tab-list\' to get tab IDs.\n' };
  }
  // Verify the tab exists
  const pages = await getActionablePages(browser, state);
  const found = pages.find(p => p.targetId === tabId);
  if (!found) {
    return { error: `Error: Tab ${tabId} not found. Run 'playwright-cli tab-list' to see available tabs.\n` };
  }
  return { targetId: tabId };
}
```

Return type is `{ targetId: string } | { error: string }` to allow callers to return error results cleanly.

- [ ] **Step 2: Remove `currentTarget` from PlaywrightState**

Change the interface:
```typescript
interface PlaywrightState {
  // currentTarget: string | null;  ← REMOVED
  snapshots: Map<string, TabSnapshot>;
  appTabId: string | null;
  harRecorder: HarRecorder | null;
  sessionDirsCreated: boolean;
  teleportWatchers: Map<string, TeleportWatcher>;  // Changed from single watcher
}
```

Update the state initialization (search for where `PlaywrightState` objects are created) to remove `currentTarget` and change `teleportWatcher` to `teleportWatchers: new Map()`.

- [ ] **Step 3: Remove `ensureTarget()` function**

Delete the entire `ensureTarget()` function (lines ~484-507). Also remove `tab-select` case from the switch (lines ~2266-2288).

- [ ] **Step 4: Update `tab-list` to show active marker from Chrome**

In the `tab-list` case, replace the `isCurrent` logic (which checks `state.currentTarget`) with Chrome's active tab state. The `pages` from `getActionablePages()` already have an `active` field from CDP. Use that:

```typescript
case 'tab-list': {
  const pages = await getActionablePages(browser, state);
  if (pages.length === 0) {
    result = { stdout: 'No browser tabs found.\n', stderr: '', exitCode: 0 };
    break;
  }
  let output = '';
  for (const p of pages) {
    const marker = p.active ? ' (active)' : '';
    output += `[${p.targetId}] ${p.url} "${p.title}"${marker}\n`;
  }
  result = { stdout: output, stderr: '', exitCode: 0 };
  break;
}
```

- [ ] **Step 5: Update `tab-new` / `open` to return targetId**

In the `tab-new`/`open` case, ensure the output includes the new tab's targetId clearly:

```
Opened <url> in new tab [targetId: <id>]
```

The agent needs to parse this to capture the targetId.

- [ ] **Step 6: Verify build compiles**

Run: `npx vitest run packages/webapp/src/shell/supplemental-commands/playwright-command.test.ts`

This will have compilation errors if any code still references `currentTarget` or `ensureTarget()`. That's expected — Task 3 will fix the command handlers. For now, focus on removing the state and adding the utility. The build might not compile yet.

- [ ] **Step 7: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/playwright-command.ts
git commit -m "refactor: remove currentTarget/ensureTarget, add requireTab utility

Removes implicit tab state from PlaywrightState. Adds requireTab()
that validates --tab parameter against available tabs. Updates
tab-list to show Chrome's active tab. Updates tab-new to return
targetId.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Migrate all 36 command handlers to use `--tab` + `withTab()`

**Files:**
- Modify: `packages/webapp/src/shell/supplemental-commands/playwright-command.ts`

This is the bulk of the work — updating every `ensureTarget()` call to use `requireTab()` + `browser.withTab()`. The pattern is mechanical for each command:

**Before:**
```typescript
case 'screenshot': {
  const targetId = await ensureTarget(browser, state);
  if (!targetId) { result = noTabError(); break; }
  await browser.attachToPage(targetId);
  const data = await browser.screenshot();
  // ... handle result
}
```

**After:**
```typescript
case 'screenshot': {
  const tab = await requireTab(browser, state, flags);
  if ('error' in tab) { result = { stdout: '', stderr: tab.error, exitCode: 1 }; break; }
  const data = await browser.withTab(tab.targetId, async () => {
    return await browser.screenshot();
  });
  // ... handle result
}
```

- [ ] **Step 1: Migrate navigation commands** (`goto`/`navigate`, `go-back`, `go-forward`, `reload`)

- [ ] **Step 2: Migrate inspection commands** (`screenshot`, `snapshot`, `eval`, `eval-file`)

- [ ] **Step 3: Migrate interaction commands** (`click`, `dblclick`, `hover`, `type`, `fill`, `select`, `check`, `uncheck`, `press`, `drag`, `resize`)

- [ ] **Step 4: Migrate dialog commands** (`dialog-accept`, `dialog-dismiss`)

- [ ] **Step 5: Migrate cookie commands** (`cookie-list`, `cookie-get`, `cookie-set`, `cookie-delete`, `cookie-clear`)

- [ ] **Step 6: Migrate storage commands** (`localstorage-*`, `sessionstorage-*` — 10 commands)

- [ ] **Step 7: Migrate `tab-close`** — require `--tab`, remove index-based fallback

- [ ] **Step 8: Migrate `teleport`** — require `--tab`, use `state.teleportWatchers` Map

- [ ] **Step 9: Update `checkTeleportBlock` for per-tab scoping**

Change `checkTeleportBlock(state)` to `checkTeleportBlock(state, targetId)` — only block if the target tab has an active teleport watcher.

- [ ] **Step 10: Verify the build compiles and all references to `currentTarget` / `ensureTarget` are gone**

Run:
```bash
grep -n 'currentTarget\|ensureTarget' packages/webapp/src/shell/supplemental-commands/playwright-command.ts
```
Expected: No matches.

Run:
```bash
npm run typecheck
```
Expected: Pass.

- [ ] **Step 11: Run tests**

Run: `npx vitest run packages/webapp/src/shell/supplemental-commands/playwright-command.test.ts`

Many existing tests will fail because they use the old implicit-tab pattern. That's expected — Task 4 fixes the tests.

- [ ] **Step 12: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/playwright-command.ts
git commit -m "refactor: migrate all 36 playwright commands to explicit --tab

Every command that operates on a tab now requires --tab <targetId>
and uses browser.withTab() for serialized CDP access. Removes all
index-based tab selection and implicit current tab usage.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Update tests for new `--tab` interface

**Files:**
- Modify: `packages/webapp/src/shell/supplemental-commands/playwright-command.test.ts`
- Modify: `packages/webapp/src/cdp/browser-api.test.ts` (if mutex tests need adjustment)

- [ ] **Step 1: Read the existing test file** to understand the mock pattern

- [ ] **Step 2: Update all existing tests** to pass `--tab <targetId>` in the args

For each test that calls a playwright subcommand, add `--tab` to the args. The mock BrowserAPI's `listPages` should return predictable targetIds that tests can reference.

- [ ] **Step 3: Add tests for missing --tab error**

```typescript
it('returns error when --tab is missing', async () => {
  const result = await runPlaywright(['screenshot']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('--tab');
});
```

- [ ] **Step 4: Add tests for invalid tab ID error**

```typescript
it('returns error for invalid tab ID', async () => {
  const result = await runPlaywright(['screenshot', '--tab', 'nonexistent']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('not found');
});
```

- [ ] **Step 5: Add test for tab-list format** (targetIds, active marker)

- [ ] **Step 6: Add test for tab-new returning targetId**

- [ ] **Step 7: Run all tests**

Run: `npx vitest run`
Expected: All pass.

- [ ] **Step 8: Commit**

```bash
git add packages/webapp/src/shell/supplemental-commands/playwright-command.test.ts packages/webapp/src/cdp/browser-api.test.ts
git commit -m "test: update playwright tests for explicit --tab interface

All tests now pass --tab <targetId>. Adds tests for missing --tab
error, invalid tab ID error, tab-list format, and tab-new output.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add tab grouping for agent-created tabs

**Files:**
- Modify: `packages/webapp/src/cdp/browser-api.ts`
- Modify: `packages/webapp/src/shell/supplemental-commands/playwright-command.ts`

- [ ] **Step 1: Add `groupNewTab()` to BrowserAPI**

```typescript
/**
 * Add a newly created tab to the slicc tab group (extension mode only).
 * Resolves targetId → tabId via chrome.tabs, then calls addToSliccGroup.
 * Best-effort — never throws.
 */
async groupNewTab(targetId: string): Promise<void> {
  // Only in extension mode
  if (typeof chrome === 'undefined' || !chrome?.runtime?.id) return;
  try {
    // Find the Chrome tab matching this CDP target
    const tabs = await chrome.tabs.query({});
    // Match by target — we need to find the tab that was just created
    // CDP targetId maps to a chrome.debugger target, not directly to tabId
    // Use the debugger API to find the match
    const targets = await chrome.debugger.getTargets();
    const match = targets.find(t => t.id === targetId);
    if (match?.tabId) {
      const { addToSliccGroup } = await import('../extension/tab-group.js');
      await addToSliccGroup(match.tabId);
    }
  } catch {
    // Best-effort — don't block tab creation
  }
}
```

Note: The exact mechanism to resolve targetId → tabId may differ. Read the existing `debugger-client.ts` to see how it resolves tab IDs. Adapt the approach.

- [ ] **Step 2: Call `groupNewTab()` after `tab-new` / `open`**

In the `tab-new`/`open` handler, after `browser.createPage(url)`:

```typescript
const newTargetId = await browser.createPage(url);
await browser.groupNewTab(newTargetId);
```

- [ ] **Step 3: Run build gates**

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/cdp/browser-api.ts packages/webapp/src/shell/supplemental-commands/playwright-command.ts
git commit -m "feat: add agent-created tabs to slicc tab group

New tabs created via playwright-cli tab-new/open now join the
slicc tab group in extension mode. Resolves targetId to tabId
and calls addToSliccGroup(). Best-effort, never blocks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Update agent system prompt and skills

**Files:**
- Modify: `packages/vfs-root/shared/CLAUDE.md`
- Modify: Any skills in `packages/vfs-root/workspace/skills/` that use playwright commands

- [ ] **Step 1: Search for all playwright-cli references in agent docs and skills**

```bash
grep -rn 'playwright-cli\|playwright ' packages/vfs-root/shared/CLAUDE.md packages/vfs-root/workspace/skills/
```

- [ ] **Step 2: Update CLAUDE.md**

Update all playwright command examples to use `--tab <targetId>`. Show the new workflow:
1. `tab-list` to find tabs (shows targetIds + active marker)
2. `tab-new <url>` returns targetId
3. All operations use `--tab <id>`

- [ ] **Step 3: Update any skills that use playwright commands**

Each skill that calls `playwright-cli` needs `--tab` added to its commands.

- [ ] **Step 4: Run all build gates**

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

- [ ] **Step 5: Commit**

```bash
git add packages/vfs-root/
git commit -m "docs: update agent prompt and skills for --tab interface

All playwright-cli examples now use explicit --tab <targetId>.
Shows tab-list → capture ID → use ID workflow.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Final verification and documentation

**Files:**
- Modify: `CLAUDE.md` (project root)
- Modify: `docs/architecture.md`

- [ ] **Step 1: Run all build gates**

```bash
npm run typecheck && npm run test && npm run build && npm run build:extension
```

- [ ] **Step 2: Verify no references to old patterns remain**

```bash
grep -rn 'currentTarget\|ensureTarget\|tab-select' packages/webapp/src/shell/supplemental-commands/playwright-command.ts
```

Expected: No matches.

- [ ] **Step 3: Update CLAUDE.md**

Add note about stateless tab handling in the CDP section.

- [ ] **Step 4: Update docs/architecture.md**

Update the BrowserAPI description to mention `withTab()` mutex.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/architecture.md
git commit -m "docs: document stateless tab handling and withTab mutex

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
