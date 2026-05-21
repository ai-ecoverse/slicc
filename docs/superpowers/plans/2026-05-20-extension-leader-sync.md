# Extension-Leader Tray Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the Chrome extension's offscreen `workerBaseUrl` branch so an extension running as a tray leader actually broadcasts chat snapshots, agent events, scoops/sprinkles lists, federated CDP, and webhook events to its followers — making `addFollower` more than a no-op.

**Architecture:** Construct `LeaderSyncManager` in offscreen (where the orchestrator, lickManager, sharedFs, and browser API already live). Most callbacks resolve from offscreen-local state directly. A narrow panel↔offscreen bridge handles four fire-and-forget pushes (sprinkles snapshot, sprinkle update, user echo, active-scoop selection) plus lifecycle (`leader-mode-changed`) and one round-trip (`leader-tray-reset` RPC). Extract the wiring into `extension-leader-tray.ts` (mirror of `page-leader-tray.ts`) so it's testable without booting the kernel host.

**Tech Stack:** TypeScript + Vitest. Pre-existing modules: `OffscreenBridge`, `LeaderSyncManager`, `LeaderTrayPeerManager`, `LeaderTrayManager`, `SprinkleManager`, `OffscreenClient`, `ThrottledErrorTracker`.

**Spec:** [`docs/superpowers/specs/2026-05-20-extension-leader-sync-design.md`](../specs/2026-05-20-extension-leader-sync-design.md) (revision 5 — read it first; this plan assumes the spec is authoritative on every design decision).

**Revision 2 (2026-05-20):** First-review fixes applied. Verified each
review claim against current `main` HEAD before patching. Summary:

- **Task 2 rewritten** — `OffscreenClient.selectScoop()` doesn't exist;
  selection mutation lives at four sites in `mainExtension`
  (main.ts:657, 700, 723, 802). Plan now adds
  `OffscreenClient.setSelectedScoopJid(jid)` setter that fires
  listeners and routes all four mutations through it.
- **Task 4 narrowed** — drop the `case 'leader-active-scoop'` envelope
  handler from the bridge's panel message switch. The leader-sync hub
  adapter (Task 9) is the single inbound route; bridge holds the
  cache via the public setter only. Avoids dual listeners on
  `chrome.runtime.onMessage`.
- **Task 17 extended** — added `onFollowerCountChanged` callback that
  writes `slicc.leaderTrayFollowers` (parity with standalone
  main.ts:2465-2476). `host-command.ts:74-84` reads it as a fallback
  when the getter is null.
- **Task 11 test approach corrected** — `LeaderSyncManager.getMessages`
  is an option callback, not a public method. Tests now capture
  `syncOptions` via a factory test seam (`_onSyncOptions` callback)
  instead of calling non-existent `handle.sync.getMessages()`.
- **Task 11 import fix** — `ChannelMessage` lives in
  `webapp/src/scoops/types.ts:154`, not `messages.ts`.
- **Task 12 test reordered** — `vi.spyOn` now precedes the
  `options.onFollowerMessage(...)` invocation so the broadcast
  assertion actually catches the call.
- **Task 17 test fixed** — `handle.leader.start` is called once
  (the reset's start), not twice. The factory itself doesn't call
  start() on boot — Task 19's offscreen.ts caller does.
- **Task 18 test expanded** — teardown order now asserts the full
  sequence including `clearInterval`, `setConnectedFollowersGetter(null)`,
  `setTrayResetter(null)`, `removeListener`, `signalLeaderMode(false)`,
  `detach()`.
- **Task 20 clarified** — extension panel terminal runs in offscreen
  via `RemoteTerminalView` (main.ts:622-624, 869-879). Panel-side
  `setTrayResetter` would not bind the shell that processes
  `host reset`. Task 17's offscreen-side `setTrayResetter` is
  authoritative; Task 20 no longer wires `setTrayResetter` on the
  panel side. Import path corrected to `../shell/...`. Panel
  sender/subscriber pattern referenced from existing
  `followerSprinkleSender` at main.ts:1436.
- **Task 22 adds coverage gate** — `npm run test:coverage:chrome-extension`
  (CI enforces 55/55/60/45 floors per root CLAUDE.md).
- **Task 1 test helper** — uses existing `beforeEach` setup (the
  helper `makeSprinkleManager()` doesn't exist in the codebase).
- **Task 3 dedup** — `SprinkleSummaryEnvelope` already exists at
  `messages.ts:30` (non-exported). Plan now exports the existing one
  rather than defining a duplicate.

---

## Pre-flight

- [ ] **Step P1: Confirm branch and clean tree**

  ```bash
  git status && git branch --show-current
  ```

  Expected: branch `fix/extension-leader-sync-682`, clean tree, four spec commits already present.

- [ ] **Step P2: Run baseline tests to confirm green starting point**

  ```bash
  npm run typecheck && npm run test
  ```

  Expected: typecheck passes, ~3341 tests pass (+1 known-flaky failure in `remote-cache.test.ts:20` is unrelated; ignore).

---

### Task 1: Add `SprinkleManager.onChange` event hook

The leader's panel-side `installLeaderHooks` needs to push a sprinkle snapshot every time the available-or-opened set changes. `SprinkleManager` currently only exposes `setupWatcher` + `refresh()`; add a coalesced change-event so the panel hook is one-liner.

**Files:**

- Modify: `packages/webapp/src/ui/sprinkle-manager.ts`
- Test: `packages/webapp/tests/ui/sprinkle-manager.test.ts`

- [ ] **Step 1: Write the failing test**

  Existing tests use a `beforeEach` block (sprinkle-manager.test.ts:66-76)
  that constructs `mgr` from a `VirtualFS` instance. Add a nested
  `describe` block that reuses the same `mgr`:

  ```ts
  describe('SprinkleManager.onChange', () => {
    it('fires once after refresh() completes', async () => {
      const calls: number[] = [];
      const off = mgr.onChange(() => calls.push(Date.now()));
      await mgr.refresh();
      expect(calls.length).toBe(1);
      off();
    });

    it('fires once per open()/close() state change', async () => {
      await mgr.refresh(); // seed
      const calls: number[] = [];
      mgr.onChange(() => calls.push(Date.now()));
      await mgr.open('dash');
      expect(calls.length).toBe(1);
      mgr.close('dash');
      expect(calls.length).toBe(2);
    });

    it('returns an unsubscribe that stops firing', async () => {
      const calls: number[] = [];
      const off = mgr.onChange(() => calls.push(Date.now()));
      off();
      await mgr.refresh();
      expect(calls.length).toBe(0);
    });

    it('coalesces multiple refreshes within one microtask', async () => {
      const calls: number[] = [];
      mgr.onChange(() => calls.push(Date.now()));
      await Promise.all([mgr.refresh(), mgr.refresh(), mgr.refresh()]);
      expect(calls.length).toBe(1);
    });
  });
  ```

  The existing test file seeds `/shared/sprinkles/dash/dash.shtml`
  (sprinkle-manager.test.ts:98, 130) — that's why `open()` / `close()`
  use `'dash'`. If the seeded set ever changes, update accordingly.

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run packages/webapp/tests/ui/sprinkle-manager.test.ts -t "onChange"
  ```

  Expected: FAIL with `sm.onChange is not a function`.

- [ ] **Step 3: Implement `onChange`**

  In `packages/webapp/src/ui/sprinkle-manager.ts`, add to the class:

  ```ts
  private readonly changeListeners = new Set<() => void>();
  private changeNotifyScheduled = false;

  onChange(handler: () => void): () => void {
    this.changeListeners.add(handler);
    return () => this.changeListeners.delete(handler);
  }

  private notifyChange(): void {
    if (this.changeNotifyScheduled) return;
    this.changeNotifyScheduled = true;
    queueMicrotask(() => {
      this.changeNotifyScheduled = false;
      for (const fn of this.changeListeners) {
        try {
          fn();
        } catch (err) {
          log.warn('SprinkleManager.onChange handler threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });
  }
  ```

  Then call `this.notifyChange()` at the end of `refresh()` (after the existing successful refresh body) and inside `open()` / `close()` / `markActivated()` wherever state mutates.

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  npx vitest run packages/webapp/tests/ui/sprinkle-manager.test.ts -t "onChange"
  ```

  Expected: PASS (all four cases).

- [ ] **Step 5: Format + run full sprinkle-manager test suite**

  ```bash
  npx prettier --write packages/webapp/src/ui/sprinkle-manager.ts packages/webapp/tests/ui/sprinkle-manager.test.ts
  npx vitest run packages/webapp/tests/ui/sprinkle-manager.test.ts
  ```

  Expected: all sprinkle-manager tests pass (existing + new).

- [ ] **Step 6: Commit**

  ```bash
  git add packages/webapp/src/ui/sprinkle-manager.ts packages/webapp/tests/ui/sprinkle-manager.test.ts
  git commit -m "feat(webapp): SprinkleManager.onChange coalesced event hook

  Enables panel-side leader sync to push sprinkle snapshots once per
  refresh/open/close cycle. Multiple refreshes within a microtask
  fire onChange once. Prerequisite for #682 extension-leader sync.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 2: Add `OffscreenClient.setSelectedScoopJid` + `onScoopSelected` event hook

The leader's panel-side hook needs to forward scoop selection changes to
offscreen. **`OffscreenClient` has no `selectScoop` method** —
`selectedScoopJid` is a public field (offscreen-client.ts:94) mutated
directly by `mainExtension` at four sites (main.ts:657, 700, 723, 802) and
by the existing tests at offscreen-client.test.ts:57, 72, 92. This task
introduces a public setter that fires listeners and routes every existing
mutation through it.

> **Note on spec drift:** the spec at §6 still says
> `client.onScoopSelected` fires when `selectScoop` sets `selectedScoopJid`.
> That wording predates this verification step. Follow this task body, not
> the stale spec prose. (Spec open question #3 was about confirming the
> single mutation site; it turned out to be four.)

**Files:**

- Modify: `packages/webapp/src/ui/offscreen-client.ts`
- Modify: `packages/webapp/src/ui/main.ts` (four mutation sites in `mainExtension`)
- Modify: `packages/webapp/tests/ui/offscreen-client.test.ts` (existing — three direct mutations)
- Test: append a new `describe` block to the existing
  `packages/webapp/tests/ui/offscreen-client.test.ts` (file already exists,
  ~400 lines, uses `new OffscreenClient(callbacks)` — see Step 2).

- [ ] **Step 1: Locate all selectedScoopJid mutation sites**

  ```bash
  grep -n "client.selectedScoopJid\|\.selectedScoopJid = " packages/webapp/src/ui/main.ts
  ```

  Expected output anchors: **lines 657, 700, 723, 802 are the four
  `mainExtension` sites — refactor these.** Line 1763 is the standalone
  worker path (different boot, unrelated to extension-leader); **do NOT
  touch line 1763**. The standalone path doesn't go through the leader-mode
  hooks added in Task 20, so leaving it untouched is correct.

  Also run:

  ```bash
  grep -n "client.selectedScoopJid =\|\.selectedScoopJid = " packages/webapp/tests/ui/offscreen-client.test.ts
  ```

  Expected: three existing test sites (~lines 57, 72, 92) that write
  `client.selectedScoopJid = …` directly. These will break when Step 4
  makes the field getter-only; update them in Step 5 to use the new
  `setSelectedScoopJid` setter.

- [ ] **Step 2: Write the failing test**

  The file `packages/webapp/tests/ui/offscreen-client.test.ts` already
  exists. The existing setup uses `new OffscreenClient(callbacks)` — see
  the `beforeEach` block at the top of the file. **Append** a new
  `describe` block at the end of the file:

  ```ts
  describe('OffscreenClient.setSelectedScoopJid + onScoopSelected', () => {
    // Reuse the same callbacks stub the existing file uses — search for
    // the `beforeEach` near the top to copy the canonical shape.
    let localClient: OffscreenClient;
    beforeEach(() => {
      localClient = new OffscreenClient(callbacks);
    });

    it('setSelectedScoopJid updates the field and fires listeners', () => {
      const calls: string[] = [];
      localClient.onScoopSelected((jid) => calls.push(jid));
      localClient.setSelectedScoopJid('scoop-1');
      expect(localClient.selectedScoopJid).toBe('scoop-1');
      expect(calls).toEqual(['scoop-1']);
    });

    it('does not fire when the same jid is set twice', () => {
      localClient.setSelectedScoopJid('scoop-1');
      const calls: string[] = [];
      localClient.onScoopSelected((jid) => calls.push(jid));
      localClient.setSelectedScoopJid('scoop-1');
      expect(calls).toEqual([]);
    });

    it('returns an unsubscribe that stops firing', () => {
      const off = localClient.onScoopSelected(() => {
        throw new Error('should not fire after off()');
      });
      off();
      expect(() => localClient.setSelectedScoopJid('scoop-2')).not.toThrow();
    });

    it('handler throws are logged but do not break other listeners', () => {
      const calls: string[] = [];
      localClient.onScoopSelected(() => {
        throw new Error('first handler bad');
      });
      localClient.onScoopSelected((jid) => calls.push(jid));
      localClient.setSelectedScoopJid('scoop-3');
      expect(calls).toEqual(['scoop-3']);
    });
  });
  ```

- [ ] **Step 3: Run test to verify it fails**

  ```bash
  npx vitest run packages/webapp/tests/ui/offscreen-client.test.ts
  ```

  Expected: FAIL — `client.setSelectedScoopJid is not a function`.

- [ ] **Step 4: Implement the setter + event hook**

  In `packages/webapp/src/ui/offscreen-client.ts`, the field is already
  declared as `selectedScoopJid: string | null = null` (line 94). Make it
  private and expose the setter + listener:

  ```ts
  // Change the field declaration:
  private _selectedScoopJid: string | null = null;

  get selectedScoopJid(): string | null {
    return this._selectedScoopJid;
  }

  // Existing direct assignments inside this class continue to work via the
  // setter (declare it as a real setter, OR convert every internal
  // assignment to setSelectedScoopJid). Easiest: keep `_selectedScoopJid`
  // for internal writes that should NOT notify, and route external writes
  // through the setter below.

  private readonly scoopSelectedListeners = new Set<(jid: string) => void>();

  onScoopSelected(handler: (jid: string) => void): () => void {
    this.scoopSelectedListeners.add(handler);
    return () => this.scoopSelectedListeners.delete(handler);
  }

  setSelectedScoopJid(jid: string | null): void {
    if (this._selectedScoopJid === jid) return;
    this._selectedScoopJid = jid;
    if (jid === null) return; // listeners only care about non-null selections
    for (const fn of this.scoopSelectedListeners) {
      try {
        fn(jid);
      } catch (err) {
        // eslint-disable-next-line no-console -- logger may not be in scope here
        console.warn('[offscreen-client] onScoopSelected handler threw:', err);
      }
    }
  }
  ```

  **Important:** every internal read of `this.selectedScoopJid` in the file
  still works via the getter. Find every internal assignment to
  `this.selectedScoopJid` and decide whether it should notify or not
  (internal bookkeeping = use `_selectedScoopJid`; user-initiated = use
  `setSelectedScoopJid`). Search:

  ```bash
  grep -n "this.selectedScoopJid =\|this._selectedScoopJid =" packages/webapp/src/ui/offscreen-client.ts
  ```

  Convert each one. The current code has none — the field is mutated only
  externally — so this is purely additive.

- [ ] **Step 5: Refactor existing call sites**

  Three groups of edits:

  **a) `mainExtension` mutation sites (main.ts).** Replace each
  `client.selectedScoopJid = X` with `client.setSelectedScoopJid(X)`:
  - main.ts:657 — inside the local `selectScoop` function
  - main.ts:700 — `onReady` first-scoop init
  - main.ts:723 — cone-fallback init
  - main.ts:802 — switch-on-tab-click handler

  **Do NOT change main.ts:1763** — that's the standalone worker path; it
  doesn't go through extension-leader hooks and the field-write semantics
  are fine there.

  **b) Existing test mutations (offscreen-client.test.ts).** The existing
  test file mutates `client.selectedScoopJid` at ~lines 57, 72, 92.
  Replace each `client.selectedScoopJid = 'cone_123'` with
  `client.setSelectedScoopJid('cone_123')`. Without this, the
  getter-only field added in Step 4 will fail typecheck.

  **c) Verify**:

  ```bash
  grep -n "client.selectedScoopJid =" packages/webapp/src/ui/main.ts packages/webapp/tests/
  ```

  Expected: only line 1763 remains (the deliberately-untouched standalone
  worker path).

- [ ] **Step 6: Run test to verify it passes**

  ```bash
  npx vitest run packages/webapp/tests/ui/offscreen-client.test.ts
  ```

  Expected: PASS.

- [ ] **Step 7: Format + run webapp tests**

  ```bash
  npx prettier --write packages/webapp/src/ui/offscreen-client.ts packages/webapp/src/ui/main.ts packages/webapp/tests/ui/offscreen-client.test.ts
  npm run typecheck
  npx vitest run packages/webapp/tests/ui/
  ```

  Expected: typecheck clean (the `get`-only accessor on `selectedScoopJid`
  blocks external assignment — the typecheck catches any sites I missed in
  step 5). All webapp ui tests pass.

- [ ] **Step 8: Commit**

  ```bash
  git add packages/webapp/src/ui/offscreen-client.ts packages/webapp/src/ui/main.ts packages/webapp/tests/ui/offscreen-client.test.ts
  git commit -m "feat(webapp): OffscreenClient.setSelectedScoopJid + onScoopSelected (#682)

  selectedScoopJid was a public field mutated directly from mainExtension
  at four sites. Field is now backed by a getter; writes go through a
  public setter that fires listeners. All four mainExtension sites
  refactored. Required for #682 extension-leader's panel push of the
  active scoop to offscreen so LeaderSyncManager.getScoopJid() resolves
  to the panel-viewed scoop, not always the cone.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 3: Add new panel↔offscreen message types

All eight new message types are purely additive (no behavior change yet). Adding them first lets every subsequent task import them without forward references.

**Files:**

- Modify: `packages/chrome-extension/src/messages.ts`
- Test: `packages/chrome-extension/tests/messages.test.ts`

- [ ] **Step 1: Write the failing test**

  Add to `packages/chrome-extension/tests/messages.test.ts`:

  ```ts
  import type {
    LeaderSprinklesSnapshotMsg,
    LeaderSprinkleUpdateMsg,
    LeaderUserMessageEchoMsg,
    LeaderActiveScoopMsg,
    LeaderRequestLeaderModeStateMsg,
    LeaderTrayResetRequestMsg,
    LeaderModeChangedMsg,
    LeaderTrayResetResponseMsg,
    PanelToOffscreenMessage,
    OffscreenToPanelMessage,
  } from '../src/messages.js';

  describe('leader-sync message types', () => {
    it('every new panel→offscreen type is in the PanelToOffscreenMessage union', () => {
      const samples: PanelToOffscreenMessage[] = [
        { type: 'leader-sprinkles-snapshot', sprinkles: [] },
        { type: 'leader-sprinkle-update', sprinkleName: 'x', data: null },
        { type: 'leader-user-message-echo', text: 'hi', messageId: 'm1' },
        { type: 'leader-active-scoop', scoopJid: 'cone' },
        { type: 'leader-request-mode-state' },
        { type: 'leader-tray-reset', requestId: 'r1' },
      ];
      expect(samples.length).toBe(6);
    });

    it('every new offscreen→panel type is in the OffscreenToPanelMessage union', () => {
      const samples: OffscreenToPanelMessage[] = [
        { type: 'leader-mode-changed', active: true },
        {
          type: 'leader-tray-reset-response',
          requestId: 'r1',
          ok: true,
          status: {} as any, // shape comes from LeaderTrayRuntimeStatus
        },
      ];
      expect(samples.length).toBe(2);
    });

    it('sprinkles snapshot envelope is assignable to SprinkleSummary[]', () => {
      // From spec §3 compile-time invariant.
      const msg: LeaderSprinklesSnapshotMsg = {
        type: 'leader-sprinkles-snapshot',
        sprinkles: [{ name: 'a', title: 'A', path: '/a.shtml', open: false, autoOpen: false }],
      };
      // If the envelope type drifts from SprinkleSummary, this won't compile.
      const summaries: import('../../webapp/src/scoops/tray-sync-protocol.js').SprinkleSummary[] =
        msg.sprinkles;
      expect(summaries.length).toBe(1);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run packages/chrome-extension/tests/messages.test.ts -t "leader-sync"
  ```

  Expected: FAIL — missing exports.

- [ ] **Step 3: Add the types to `messages.ts`**

  Note: `SprinkleSummaryEnvelope` already exists at `messages.ts:30` as a
  non-exported `interface`. Convert that existing declaration to `export
interface SprinkleSummaryEnvelope` (so the leader bridge in Task 9 can
  import it). The existing `_AssertSprinkleSummaryEnvelopeMatches`
  assertion in `follower-sprinkle-bridge.ts:43` continues to guard the
  shape — no new assertion needed.

  Then append to `packages/chrome-extension/src/messages.ts`:

  ```ts
  import type { LeaderTrayRuntimeStatus } from '../../webapp/src/scoops/tray-leader.js';
  import type { MessageAttachment } from '../../webapp/src/core/attachments.js';

  export interface LeaderSprinklesSnapshotMsg {
    type: 'leader-sprinkles-snapshot';
    sprinkles: SprinkleSummaryEnvelope[];
  }

  export interface LeaderSprinkleUpdateMsg {
    type: 'leader-sprinkle-update';
    sprinkleName: string;
    data: unknown;
  }

  export interface LeaderUserMessageEchoMsg {
    type: 'leader-user-message-echo';
    text: string;
    messageId: string;
    attachments?: MessageAttachment[];
  }

  export interface LeaderActiveScoopMsg {
    type: 'leader-active-scoop';
    scoopJid: string;
  }

  export interface LeaderRequestLeaderModeStateMsg {
    type: 'leader-request-mode-state';
  }

  export interface LeaderTrayResetRequestMsg {
    type: 'leader-tray-reset';
    requestId: string;
  }

  export interface LeaderModeChangedMsg {
    type: 'leader-mode-changed';
    active: boolean;
  }

  export interface LeaderTrayResetResponseMsg {
    type: 'leader-tray-reset-response';
    requestId: string;
    ok: boolean;
    status?: LeaderTrayRuntimeStatus;
    error?: string;
  }
  ```

  Then extend the unions (find the existing `PanelToOffscreenMessage` and `OffscreenToPanelMessage` definitions and add the new members):

  ```ts
  export type PanelToOffscreenMessage =
    // … existing members …
    | LeaderSprinklesSnapshotMsg
    | LeaderSprinkleUpdateMsg
    | LeaderUserMessageEchoMsg
    | LeaderActiveScoopMsg
    | LeaderRequestLeaderModeStateMsg
    | LeaderTrayResetRequestMsg;

  export type OffscreenToPanelMessage =
    // … existing members …
    LeaderModeChangedMsg | LeaderTrayResetResponseMsg;
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  npx vitest run packages/chrome-extension/tests/messages.test.ts -t "leader-sync"
  npm run typecheck
  ```

  Expected: PASS + typecheck clean.

- [ ] **Step 5: Format + commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/messages.ts packages/chrome-extension/tests/messages.test.ts
  git add packages/chrome-extension/src/messages.ts packages/chrome-extension/tests/messages.test.ts
  git commit -m "feat(extension): leader-sync panel↔offscreen message types (#682)

  Eight new envelopes: four fire-and-forget panel→offscreen pushes
  (sprinkles snapshot, sprinkle update, user echo, active-scoop), one
  panel→offscreen state request, one offscreen→panel mode signal, and
  a round-trip leader-tray-reset RPC pair. Additive only; no logic
  changes here.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 4: Extend `OffscreenBridge` — active-scoop tracking

`OffscreenBridge` becomes the single source of truth for the panel's active scoop (replacing the always-cone behavior at `offscreen-bridge.ts:373`). Add a setter + getter only — the inbound `leader-active-scoop` envelope route lives on the leader-sync hub adapter (Task 9), not on the bridge's panel message switch. Single listener per envelope avoids dual handlers on `chrome.runtime.onMessage`.

**Files:**

- Modify: `packages/chrome-extension/src/offscreen-bridge.ts`
- Test: `packages/chrome-extension/tests/offscreen-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

  Add to `packages/chrome-extension/tests/offscreen-bridge.test.ts`:

  ```ts
  describe('OffscreenBridge active-scoop tracking', () => {
    it('defaults to null before any panel signal', () => {
      const bridge = new OffscreenBridge(/* … */);
      expect(bridge.getActiveScoopJid()).toBeNull();
    });

    it('setActiveScoopJid updates the cached value', () => {
      const bridge = new OffscreenBridge(/* … */);
      bridge.setActiveScoopJid('scoop-1');
      expect(bridge.getActiveScoopJid()).toBe('scoop-1');
    });

    it('null clears the cache', () => {
      const bridge = new OffscreenBridge(/* … */);
      bridge.setActiveScoopJid('scoop-1');
      bridge.setActiveScoopJid(null);
      expect(bridge.getActiveScoopJid()).toBeNull();
    });
  });
  ```

  Note: there is NO test for `leader-active-scoop` envelope handling here —
  the hub adapter (Task 9) is the single inbound route and writes through
  to this setter. Bridge only owns the cache via the public API.

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  npx vitest run packages/chrome-extension/tests/offscreen-bridge.test.ts -t "active-scoop"
  ```

  Expected: FAIL — `bridge.getActiveScoopJid is not a function`.

- [ ] **Step 3: Implement field + setter/getter**

  In `packages/chrome-extension/src/offscreen-bridge.ts`:

  ```ts
  // Add to class fields:
  private activeScoopJid: string | null = null;

  // Add public methods:
  setActiveScoopJid(jid: string | null): void {
    this.activeScoopJid = jid;
  }

  getActiveScoopJid(): string | null {
    return this.activeScoopJid;
  }
  ```

  Do **not** add a `case 'leader-active-scoop':` to the bridge's panel
  envelope switch — the hub adapter in Task 9 is the single inbound route
  for that envelope. Keeping the bridge's `setupMessageListener` ignorant
  of it avoids dual handlers on `chrome.runtime.onMessage`.

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  npx vitest run packages/chrome-extension/tests/offscreen-bridge.test.ts -t "active-scoop"
  ```

  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
  git add packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
  git commit -m "feat(extension): OffscreenBridge active-scoop tracking (#682)

  Single source of truth for the panel's currently-viewed scoop. The
  setter is written by the leader-sync hub adapter (Task 9) when a
  panel-pushed leader-active-scoop envelope arrives. Replaces the
  always-cone behavior in state-snapshot.activeScoopJid. Bridge holds
  only the cache; no envelope handler on the bridge's panel-message
  switch (single inbound route — see Task 9).

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 5: `OffscreenBridge.getMessagesForJid` wrapper

Public wrapper over `getBuffer(jid)` that casts to `ChatMessage[]` (same cast used at `offscreen-bridge.ts:671`). Used by `LeaderSyncManager`'s `getMessages` / `getMessagesForScoop` callbacks.

**Files:**

- Modify: `packages/chrome-extension/src/offscreen-bridge.ts`
- Test: `packages/chrome-extension/tests/offscreen-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  describe('OffscreenBridge.getMessagesForJid', () => {
    it('returns the buffered messages cast to ChatMessage[]', () => {
      const bridge = new OffscreenBridge(/* … */);
      // Seed via the @internal getBuffer (test only).
      const buf = (bridge as any).getBuffer('scoop-1') as Array<any>;
      buf.push({ id: 'm1', role: 'user', content: 'hi', timestamp: 1 });
      const msgs = bridge.getMessagesForJid('scoop-1');
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe('m1');
    });

    it('returns an empty array for an unknown jid', () => {
      const bridge = new OffscreenBridge(/* … */);
      expect(bridge.getMessagesForJid('nope')).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run + verify fail**

  ```bash
  npx vitest run packages/chrome-extension/tests/offscreen-bridge.test.ts -t "getMessagesForJid"
  ```

- [ ] **Step 3: Implement**

  ```ts
  getMessagesForJid(jid: string): ChatMessage[] {
    return this.getBuffer(jid) as unknown as ChatMessage[];
  }
  ```

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
  git add -u
  git commit -m "feat(extension): OffscreenBridge.getMessagesForJid public wrapper (#682)

  Casts BufferedChatMessage[] to ChatMessage[] (existing pattern from
  offscreen-bridge.ts:671) so the leader factory can read chat state
  without reaching for @internal helpers.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 6: `OffscreenBridge.routeSprinkleLick` refactor

Extract the existing `sprinkle-lick` envelope handler at `offscreen-bridge.ts:924-962` into a public method. The envelope handler calls it (no behavior change); the leader factory's `onSprinkleLick` callback also calls it.

**Files:**

- Modify: `packages/chrome-extension/src/offscreen-bridge.ts`
- Test: `packages/chrome-extension/tests/offscreen-bridge.test.ts`

- [ ] **Step 1: Write the failing test (characterizes existing behavior)**

  ```ts
  describe('OffscreenBridge.routeSprinkleLick', () => {
    it('handles a sprinkle lick targeted at a specific scoop', async () => {
      const orchestrator = makeMockOrchestrator([
        { jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' },
        { jid: 'scoop-2', name: 'helper', isCone: false, folder: 'helper' },
      ]);
      const bridge = new OffscreenBridge(/* … */);
      await bridge.bind(orchestrator as any);
      await bridge.routeSprinkleLick('welcome', { action: 'go' }, 'helper');
      expect(orchestrator.handleMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'scoop-2',
          channel: 'sprinkle',
          senderName: 'sprinkle:welcome',
        })
      );
    });

    it('falls back to the cone when no targetScoop is given', async () => {
      const orchestrator = makeMockOrchestrator([
        { jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' },
      ]);
      const bridge = new OffscreenBridge(/* … */);
      await bridge.bind(orchestrator as any);
      await bridge.routeSprinkleLick('welcome', { action: 'go' });
      expect(orchestrator.handleMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chatJid: 'cone-1' })
      );
    });
  });
  ```

- [ ] **Step 2: Run + verify fail**

  Expected: FAIL — `bridge.routeSprinkleLick is not a function`.

- [ ] **Step 3: Refactor**

  Move the body of the `case 'sprinkle-lick':` block (currently at lines 924-962 of `offscreen-bridge.ts`) into a new public method:

  ```ts
  async routeSprinkleLick(
    sprinkleName: string,
    body: unknown,
    targetScoop?: string
  ): Promise<void> {
    if (!this.orchestrator) return;
    const scoops = this.orchestrator.getScoops();
    let target = targetScoop
      ? scoops.find(
          (s) =>
            s.name === targetScoop ||
            s.folder === targetScoop ||
            s.folder === `${targetScoop}-scoop`
        )
      : undefined;
    if (!target) target = scoops.find((s) => s.isCone);
    if (!target) return;
    const msgId = `sprinkle-${sprinkleName}-${Date.now()}`;
    const content = `[Sprinkle Event: ${sprinkleName}]\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``;
    const channelMsg: ChannelMessage = {
      id: msgId,
      chatJid: target.jid,
      senderId: 'sprinkle',
      senderName: `sprinkle:${sprinkleName}`,
      content,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'sprinkle',
    };
    this.getBuffer(target.jid).push({
      id: msgId,
      role: 'user',
      content,
      timestamp: Date.now(),
      source: 'lick',
      channel: 'sprinkle',
    } as any);
    this.persistScoop(target.jid);
    await this.orchestrator.handleMessage(channelMsg);
  }
  ```

  Replace the envelope handler body with:

  ```ts
  case 'sprinkle-lick': {
    const lickMsg = msg as any;
    await this.routeSprinkleLick(lickMsg.sprinkleName, lickMsg.body, lickMsg.targetScoop);
    break;
  }
  ```

- [ ] **Step 4: Run all OffscreenBridge tests to verify both old and new behavior**

  ```bash
  npx vitest run packages/chrome-extension/tests/offscreen-bridge.test.ts
  ```

  Expected: existing sprinkle-lick envelope tests pass + new `routeSprinkleLick` tests pass.

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
  git add -u
  git commit -m "refactor(extension): extract OffscreenBridge.routeSprinkleLick (#682)

  Moves the body of the sprinkle-lick envelope handler into a public
  method. Envelope handler now delegates. Same behavior; preparatory
  refactor so the leader factory's onSprinkleLick callback can reuse
  the same routing without duplicating the channel-message construction.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 7: `OffscreenBridge.notifyPanelIncomingMessage` refactor

Extract the wire-envelope construction from the existing `onIncomingMessage` orchestrator callback at `offscreen-bridge.ts:319-331` into a public method. The leader factory's `onFollowerMessage` calls this explicitly because `'web'`-channel messages don't trigger `onIncomingMessage` (gated by `isExternalLickChannel` at `orchestrator.ts:1297`).

**Files:**

- Modify: `packages/chrome-extension/src/offscreen-bridge.ts`
- Test: `packages/chrome-extension/tests/offscreen-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  describe('OffscreenBridge.notifyPanelIncomingMessage', () => {
    it('emits an incoming-message envelope with the canonical wire shape', () => {
      const bridge = new OffscreenBridge(/* … */);
      const msg: ChannelMessage = {
        id: 'm-99',
        chatJid: 'scoop-1',
        senderId: 'user',
        senderName: 'User',
        content: 'hello from follower',
        timestamp: '2026-05-20T00:00:00.000Z',
        fromAssistant: false,
        channel: 'web',
      };
      sentMessages.length = 0;
      bridge.notifyPanelIncomingMessage('scoop-1', msg);
      const sent = sentMessages.find((m: any) => m?.payload?.type === 'incoming-message') as any;
      expect(sent).toBeDefined();
      expect(sent.payload.scoopJid).toBe('scoop-1');
      expect(sent.payload.message).toMatchObject({
        id: 'm-99',
        content: 'hello from follower',
        channel: 'web',
        fromAssistant: false,
      });
    });

    it('existing onIncomingMessage callback still emits via the same helper', () => {
      // Characterization test: the refactored onIncomingMessage callback
      // (which only fires for external lick channels) must produce the
      // same wire envelope as before the refactor.
      const bridge = new OffscreenBridge(/* … */);
      const callbacks = OffscreenBridge.createCallbacks(bridge);
      sentMessages.length = 0;
      callbacks.onIncomingMessage?.('cone-1', {
        id: 'wh-1',
        chatJid: 'cone-1',
        senderId: 'webhook',
        senderName: 'webhook:test',
        content: '[Webhook test]',
        timestamp: '2026-05-20T00:00:00.000Z',
        fromAssistant: false,
        channel: 'webhook',
      });
      const sent = sentMessages.find((m: any) => m?.payload?.type === 'incoming-message') as any;
      expect(sent.payload.message.channel).toBe('webhook');
    });
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Refactor**

  Add the helper:

  ```ts
  notifyPanelIncomingMessage(scoopJid: string, message: ChannelMessage): void {
    this.emit({
      type: 'incoming-message',
      scoopJid,
      message: {
        id: message.id,
        content: message.content,
        attachments: message.attachments,
        channel: message.channel,
        senderName: message.senderName,
        fromAssistant: message.fromAssistant,
        timestamp: message.timestamp,
      },
    } satisfies IncomingMessageMsg);
  }
  ```

  Refactor the existing `onIncomingMessage` orchestrator callback to call this helper (replace the inline `emit` block at lines 319-331):

  ```ts
  onIncomingMessage: (scoopJid, message) => {
    const chatMsg: BufferedChatMessage = {
      id: message.id,
      role: 'user',
      content:
        message.channel === 'delegation'
          ? `**[Instructions from sliccy]**\n\n${message.content}`
          : message.content,
      attachments: message.attachments,
      timestamp: new Date(message.timestamp).getTime(),
      source: message.channel === 'delegation' ? 'delegation' : undefined,
      channel: message.channel,
    };
    bridge.getBuffer(scoopJid).push(chatMsg);
    bridge.persistScoop(scoopJid);
    bridge.notifyPanelIncomingMessage(scoopJid, message);
  },
  ```

- [ ] **Step 4: Run + verify pass + existing tests still pass**

  ```bash
  npx vitest run packages/chrome-extension/tests/offscreen-bridge.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
  git add -u
  git commit -m "refactor(extension): extract OffscreenBridge.notifyPanelIncomingMessage (#682)

  Public helper that emits the canonical 'incoming-message' wire envelope
  shape. Needed because orchestrator.handleMessage only fires
  onIncomingMessage for EXTERNAL_LICK_CHANNELS (lick-formatting.ts:29-37)
  — 'web'-channel follower messages get no automatic panel echo. Leader
  factory calls this explicitly. Existing onIncomingMessage callback
  refactored to use the helper (no behavior change).

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 8: `OffscreenBridge.onAgentEvent` tap

Fan-out tap at the existing `bridge.emit(...)` callsite. When `msg.type === 'agent-event'`, translate the wire envelope into a `ui/types.ts AgentEvent` (mirroring `offscreen-client.ts:495-585`) and call every registered listener with `(scoopJid, event)`. The tap reuses the bridge's existing `currentMessageId` state.

**Files:**

- Modify: `packages/chrome-extension/src/offscreen-bridge.ts`
- Test: `packages/chrome-extension/tests/offscreen-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  describe('OffscreenBridge.onAgentEvent tap', () => {
    function captureEvents(bridge: OffscreenBridge) {
      const events: Array<{ scoopJid: string; event: any }> = [];
      const off = bridge.onAgentEvent((scoopJid, event) => events.push({ scoopJid, event }));
      return { events, off };
    }

    it('text_delta with no current messageId emits message_start + content_delta', () => {
      const bridge = new OffscreenBridge(/* … */);
      const callbacks = OffscreenBridge.createCallbacks(bridge);
      const { events } = captureEvents(bridge);
      callbacks.onResponse?.('scoop-1', 'hello', true);
      expect(events.map((e) => e.event.type)).toEqual(['message_start', 'content_delta']);
      expect(events[1].event.text).toBe('hello');
      expect(events.every((e) => e.scoopJid === 'scoop-1')).toBe(true);
    });

    it('subsequent text_delta with same messageId emits only content_delta', () => {
      const bridge = new OffscreenBridge(/* … */);
      const callbacks = OffscreenBridge.createCallbacks(bridge);
      callbacks.onResponse?.('scoop-1', 'hello', true);
      const { events } = captureEvents(bridge);
      callbacks.onResponse?.('scoop-1', ' world', true);
      expect(events).toHaveLength(1);
      expect(events[0].event.type).toBe('content_delta');
      expect(events[0].event.text).toBe(' world');
    });

    it('onResponseDone emits content_done', () => {
      const bridge = new OffscreenBridge(/* … */);
      const callbacks = OffscreenBridge.createCallbacks(bridge);
      callbacks.onResponse?.('scoop-1', 'hello', true);
      const { events } = captureEvents(bridge);
      callbacks.onResponseDone?.('scoop-1');
      expect(events).toHaveLength(1);
      expect(events[0].event.type).toBe('content_done');
    });

    it('onToolStart conditional message_start + tool_use_start', () => {
      const bridge = new OffscreenBridge(/* … */);
      const callbacks = OffscreenBridge.createCallbacks(bridge);
      const { events } = captureEvents(bridge);
      callbacks.onToolStart?.('scoop-1', 'bash', { command: 'ls' });
      expect(events.map((e) => e.event.type)).toEqual(['message_start', 'tool_use_start']);
      expect(events[1].event.toolName).toBe('bash');
    });

    it('onToolEnd emits tool_result only when messageId exists', () => {
      const bridge = new OffscreenBridge(/* … */);
      const callbacks = OffscreenBridge.createCallbacks(bridge);
      callbacks.onToolStart?.('scoop-1', 'bash', {});
      const { events } = captureEvents(bridge);
      callbacks.onToolEnd?.('scoop-1', 'bash', 'output', false);
      expect(events).toHaveLength(1);
      expect(events[0].event).toMatchObject({ type: 'tool_result', toolName: 'bash' });
    });

    it('unsubscribe stops further events', () => {
      const bridge = new OffscreenBridge(/* … */);
      const callbacks = OffscreenBridge.createCallbacks(bridge);
      const { events, off } = captureEvents(bridge);
      off();
      callbacks.onResponse?.('scoop-1', 'hello', true);
      expect(events).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  Add to `OffscreenBridge`:

  ```ts
  private readonly agentEventListeners = new Set<(scoopJid: string, event: AgentEvent) => void>();

  onAgentEvent(handler: (scoopJid: string, event: AgentEvent) => void): () => void {
    this.agentEventListeners.add(handler);
    return () => this.agentEventListeners.delete(handler);
  }

  /** @internal — called from emit() when type === 'agent-event' */
  private fanOutAgentEvent(msg: AgentEventMsg): void {
    const { scoopJid, eventType } = msg;
    const events: AgentEvent[] = [];
    const ensureMessageStart = (): string => {
      let msgId = this.currentMessageId.get(scoopJid);
      if (!msgId) {
        msgId = `scoop-${scoopJid}-${uid()}`;
        this.currentMessageId.set(scoopJid, msgId);
        events.push({ type: 'message_start', messageId: msgId });
      }
      return msgId;
    };

    switch (eventType) {
      case 'text_delta': {
        const messageId = ensureMessageStart();
        events.push({ type: 'content_delta', messageId, text: msg.text ?? '' });
        break;
      }
      case 'tool_start': {
        const messageId = ensureMessageStart();
        events.push({
          type: 'tool_use_start',
          messageId,
          toolName: msg.toolName ?? '',
          toolInput: msg.toolInput,
        });
        break;
      }
      case 'tool_end': {
        const messageId = this.currentMessageId.get(scoopJid);
        if (!messageId) return;
        events.push({
          type: 'tool_result',
          messageId,
          toolName: msg.toolName ?? '',
          result: msg.toolResult ?? '',
          isError: msg.isError,
        });
        break;
      }
      case 'tool_ui': {
        const messageId = ensureMessageStart();
        events.push({
          type: 'tool_ui',
          messageId,
          toolName: msg.toolName ?? '',
          requestId: msg.requestId ?? '',
          html: msg.html ?? '',
        });
        break;
      }
      case 'tool_ui_done': {
        const messageId = this.currentMessageId.get(scoopJid);
        if (!messageId) return;
        events.push({ type: 'tool_ui_done', messageId, requestId: msg.requestId ?? '' });
        break;
      }
      case 'response_done': {
        const messageId = this.currentMessageId.get(scoopJid);
        if (!messageId) return;
        events.push({ type: 'content_done', messageId });
        // NB: revision 4 of the spec left turn_end synthesis as an open
        // question. Do NOT synthesize turn_end here; verify with the
        // standalone wire diff (open question #1) before adding it.
        break;
      }
    }

    for (const event of events) {
      for (const fn of this.agentEventListeners) {
        try {
          fn(scoopJid, event);
        } catch (err) {
          log.warn('onAgentEvent listener threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
  ```

  Hook the fan-out into the existing `emit` method:

  ```ts
  private emit(msg: OffscreenToPanelMessage): void {
    // … existing chrome.runtime.sendMessage logic …
    if ((msg as any).type === 'agent-event') {
      this.fanOutAgentEvent(msg as AgentEventMsg);
    }
  }
  ```

  (Place the fan-out AFTER the existing send — listeners shouldn't gate panel delivery.)

- [ ] **Step 4: Run + verify pass**

  ```bash
  npx vitest run packages/chrome-extension/tests/offscreen-bridge.test.ts
  ```

  Expected: all six `onAgentEvent tap` cases pass + existing tests still pass.

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
  git add -u
  git commit -m "feat(extension): OffscreenBridge.onAgentEvent fan-out tap (#682)

  Mirrors offscreen-client.ts:495-585 (the wire → AgentEvent
  translation) so the leader factory can subscribe to a synchronized
  AgentEvent stream without re-implementing the message_start gating
  or currentMessageId tracking. turn_end synthesis intentionally
  deferred to the pre-merge wire diff (open question #1 in spec).

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 9: Create `leader-sync-bridge.ts` — proxy + adapter with the four pushes

Symmetrical halves modeled on `follower-sprinkle-bridge.ts`. Panel-side `PanelLeaderSyncProxy` exposes `pushSprinklesSnapshot`, `pushSprinkleUpdate`, `pushUserMessageEcho`, `pushActiveScoop`. Offscreen-side `connectOffscreenLeaderSyncBridge` caches the sprinkle snapshot, fans updates into `syncRef()?.broadcast*`, and routes active-scoop to `bridge.setActiveScoopJid`.

**Files:**

- Create: `packages/chrome-extension/src/leader-sync-bridge.ts`
- Test: `packages/chrome-extension/tests/leader-sync-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

  Create `packages/chrome-extension/tests/leader-sync-bridge.test.ts`:

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import {
    PanelLeaderSyncProxy,
    connectOffscreenLeaderSyncBridge,
    type OffscreenMessageHub,
    type ActiveScoopSink,
  } from '../src/leader-sync-bridge.js';
  import type { LeaderSyncManager } from '../../webapp/src/scoops/tray-leader-sync.js';

  function createBus() {
    type Envelope = { source: string; payload: unknown };
    const panelListeners = new Set<(e: Envelope) => void>();
    const offscreenListeners = new Set<(e: Envelope) => void>();
    return {
      panelSender: {
        send(envelope: Envelope): void {
          for (const l of offscreenListeners) l(envelope);
        },
      },
      panelSubscriber: {
        onMessage(handler: (e: Envelope) => void): () => void {
          panelListeners.add(handler);
          return () => panelListeners.delete(handler);
        },
      },
      offscreenHub: {
        sendToPanel(envelope: Envelope): void {
          for (const l of panelListeners) l(envelope);
        },
        onPanelMessage(handler: (e: Envelope) => void): () => void {
          offscreenListeners.add(handler);
          return () => offscreenListeners.delete(handler);
        },
      } satisfies OffscreenMessageHub,
    };
  }

  function makeMockSync() {
    return {
      broadcastSprinkleUpdate: vi.fn(),
      broadcastUserMessage: vi.fn(),
    } as unknown as LeaderSyncManager & {
      broadcastSprinkleUpdate: ReturnType<typeof vi.fn>;
      broadcastUserMessage: ReturnType<typeof vi.fn>;
    };
  }

  function makeMockBridge() {
    return {
      setActiveScoopJid: vi.fn(),
    } satisfies ActiveScoopSink;
  }

  describe('PanelLeaderSyncProxy → offscreen adapter', () => {
    it('sprinkles snapshot is cached and retrievable via getSprinkles', () => {
      const bus = createBus();
      const sync = makeMockSync();
      const bridge = makeMockBridge();
      const adapter = connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      proxy.pushSprinklesSnapshot([
        { name: 'welcome', title: 'W', path: '/w.shtml', open: true, autoOpen: false },
      ]);
      expect(adapter.getSprinkles()).toHaveLength(1);
      expect(adapter.resolveSprinklePath('welcome')).toBe('/w.shtml');
      expect(adapter.resolveSprinklePath('nope')).toBeNull();
    });

    it('sprinkle update fans to broadcastSprinkleUpdate', () => {
      const bus = createBus();
      const sync = makeMockSync();
      const bridge = makeMockBridge();
      connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      proxy.pushSprinkleUpdate('welcome', { x: 1 });
      expect(sync.broadcastSprinkleUpdate).toHaveBeenCalledWith('welcome', { x: 1 });
    });

    it('user message echo fans to broadcastUserMessage', () => {
      const bus = createBus();
      const sync = makeMockSync();
      const bridge = makeMockBridge();
      connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      proxy.pushUserMessageEcho('hi', 'm1', [{ name: 'a.png' }] as any);
      expect(sync.broadcastUserMessage).toHaveBeenCalledWith('hi', 'm1', [{ name: 'a.png' }]);
    });

    it('active-scoop write-through to bridge.setActiveScoopJid', () => {
      const bus = createBus();
      const sync = makeMockSync();
      const bridge = makeMockBridge();
      connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      proxy.pushActiveScoop('scoop-7');
      expect(bridge.setActiveScoopJid).toHaveBeenCalledWith('scoop-7');
    });

    it('detach() removes the hub listener — subsequent envelopes are no-ops', () => {
      const bus = createBus();
      const sync = makeMockSync();
      const bridge = makeMockBridge();
      const adapter = connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
      adapter.detach();
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      proxy.pushSprinkleUpdate('welcome', { x: 1 });
      expect(sync.broadcastSprinkleUpdate).not.toHaveBeenCalled();
    });

    it('syncRef returning null is tolerated (no throws)', () => {
      const bus = createBus();
      const bridge = makeMockBridge();
      connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => null, bridge);
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      expect(() => proxy.pushSprinkleUpdate('welcome', null)).not.toThrow();
    });
  });
  ```

- [ ] **Step 2: Run + verify fail**

  ```bash
  npx vitest run packages/chrome-extension/tests/leader-sync-bridge.test.ts
  ```

  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `leader-sync-bridge.ts` (proxy + adapter)**

  Create `packages/chrome-extension/src/leader-sync-bridge.ts`:

  ```ts
  /**
   * Panel ↔ offscreen bridge for extension-leader mode.
   *
   * Mirror of follower-sprinkle-bridge.ts but for the leader role:
   * panel pushes sprinkle snapshot / sprinkle updates / user-message
   * echo / active-scoop selection. Offscreen pushes leader-mode-changed
   * and leader-tray-reset-response.
   */

  import type {
    LeaderSprinklesSnapshotMsg,
    LeaderSprinkleUpdateMsg,
    LeaderUserMessageEchoMsg,
    LeaderActiveScoopMsg,
    LeaderRequestLeaderModeStateMsg,
    LeaderModeChangedMsg,
    SprinkleSummaryEnvelope,
  } from './messages.js';
  import type { LeaderSyncManager } from '../../webapp/src/scoops/tray-leader-sync.js';
  import type { MessageAttachment } from '../../webapp/src/core/attachments.js';

  export interface PanelMessageSender {
    send(envelope: { source: 'panel'; payload: unknown }): void;
  }

  export interface PanelMessageSubscriber {
    onMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
  }

  export interface OffscreenMessageHub {
    sendToPanel(envelope: { source: 'offscreen'; payload: unknown }): void;
    onPanelMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
  }

  /** Narrow surface the leader adapter needs on OffscreenBridge — kept slim
   *  so tests can pass a hand-built stub. */
  export interface ActiveScoopSink {
    setActiveScoopJid(jid: string | null): void;
  }

  function discriminateMsg<T extends { type: string }>(
    payload: unknown,
    type: T['type']
  ): T | null {
    if (!payload || typeof payload !== 'object') return null;
    if ((payload as { type?: unknown }).type !== type) return null;
    return payload as T;
  }

  // -----------------------------------------------------------------------------
  // Panel-side proxy
  // -----------------------------------------------------------------------------

  export class PanelLeaderSyncProxy {
    private disposed = false;
    private readonly unsubscribe: () => void;

    constructor(
      private readonly sender: PanelMessageSender,
      subscriber: PanelMessageSubscriber,
      private readonly listeners: {
        onLeaderModeChange?: (active: boolean) => void;
      }
    ) {
      this.unsubscribe = subscriber.onMessage((envelope) => {
        if (envelope.source !== 'offscreen') return;
        const mode = discriminateMsg<LeaderModeChangedMsg>(envelope.payload, 'leader-mode-changed');
        if (mode) {
          this.listeners.onLeaderModeChange?.(mode.active);
          return;
        }
      });
    }

    pushSprinklesSnapshot(sprinkles: SprinkleSummaryEnvelope[]): void {
      if (this.disposed) return;
      const payload: LeaderSprinklesSnapshotMsg = {
        type: 'leader-sprinkles-snapshot',
        sprinkles,
      };
      this.sender.send({ source: 'panel', payload });
    }

    pushSprinkleUpdate(sprinkleName: string, data: unknown): void {
      if (this.disposed) return;
      const payload: LeaderSprinkleUpdateMsg = {
        type: 'leader-sprinkle-update',
        sprinkleName,
        data,
      };
      this.sender.send({ source: 'panel', payload });
    }

    pushUserMessageEcho(text: string, messageId: string, attachments?: MessageAttachment[]): void {
      if (this.disposed) return;
      const payload: LeaderUserMessageEchoMsg = {
        type: 'leader-user-message-echo',
        text,
        messageId,
        attachments,
      };
      this.sender.send({ source: 'panel', payload });
    }

    pushActiveScoop(jid: string): void {
      if (this.disposed) return;
      const payload: LeaderActiveScoopMsg = { type: 'leader-active-scoop', scoopJid: jid };
      this.sender.send({ source: 'panel', payload });
    }

    requestModeState(): void {
      if (this.disposed) return;
      const payload: LeaderRequestLeaderModeStateMsg = { type: 'leader-request-mode-state' };
      this.sender.send({ source: 'panel', payload });
    }

    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.unsubscribe();
    }
  }

  // -----------------------------------------------------------------------------
  // Offscreen-side adapter
  // -----------------------------------------------------------------------------

  export interface OffscreenLeaderSyncBridgeHandle {
    getSprinkles(): SprinkleSummaryEnvelope[];
    resolveSprinklePath(name: string): string | null;
    signalLeaderMode(active: boolean): void;
    detach(): void;
  }

  export function connectOffscreenLeaderSyncBridge(
    hub: OffscreenMessageHub,
    syncRef: () => LeaderSyncManager | null,
    bridge: ActiveScoopSink
  ): OffscreenLeaderSyncBridgeHandle {
    let detached = false;
    let leaderModeActive = false;
    let cachedSprinkles: SprinkleSummaryEnvelope[] = [];

    const off = hub.onPanelMessage((envelope) => {
      if (detached || envelope.source !== 'panel') return;

      const snapshot = discriminateMsg<LeaderSprinklesSnapshotMsg>(
        envelope.payload,
        'leader-sprinkles-snapshot'
      );
      if (snapshot) {
        cachedSprinkles = snapshot.sprinkles.slice();
        return;
      }

      const update = discriminateMsg<LeaderSprinkleUpdateMsg>(
        envelope.payload,
        'leader-sprinkle-update'
      );
      if (update) {
        syncRef()?.broadcastSprinkleUpdate(update.sprinkleName, update.data);
        return;
      }

      const echo = discriminateMsg<LeaderUserMessageEchoMsg>(
        envelope.payload,
        'leader-user-message-echo'
      );
      if (echo) {
        syncRef()?.broadcastUserMessage(echo.text, echo.messageId, echo.attachments);
        return;
      }

      const active = discriminateMsg<LeaderActiveScoopMsg>(envelope.payload, 'leader-active-scoop');
      if (active) {
        bridge.setActiveScoopJid(active.scoopJid);
        return;
      }

      const req = discriminateMsg<LeaderRequestLeaderModeStateMsg>(
        envelope.payload,
        'leader-request-mode-state'
      );
      if (req) {
        const payload: LeaderModeChangedMsg = {
          type: 'leader-mode-changed',
          active: leaderModeActive,
        };
        hub.sendToPanel({ source: 'offscreen', payload });
      }
    });

    return {
      getSprinkles() {
        return cachedSprinkles;
      },
      resolveSprinklePath(name) {
        const found = cachedSprinkles.find((s) => s.name === name);
        return found ? found.path : null;
      },
      signalLeaderMode(active) {
        if (detached) return;
        leaderModeActive = active;
        const payload: LeaderModeChangedMsg = { type: 'leader-mode-changed', active };
        hub.sendToPanel({ source: 'offscreen', payload });
      },
      detach() {
        if (detached) return;
        detached = true;
        off();
      },
    };
  }
  ```

- [ ] **Step 4: Run + verify pass**

  ```bash
  npx vitest run packages/chrome-extension/tests/leader-sync-bridge.test.ts
  npm run typecheck
  ```

  Expected: all six cases pass + typecheck clean.

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/leader-sync-bridge.ts packages/chrome-extension/tests/leader-sync-bridge.test.ts
  git add packages/chrome-extension/src/leader-sync-bridge.ts packages/chrome-extension/tests/leader-sync-bridge.test.ts
  git commit -m "feat(extension): leader-sync panel ↔ offscreen bridge (#682)

  Symmetrical halves mirroring follower-sprinkle-bridge.ts. Panel side
  exposes pushSprinklesSnapshot / pushSprinkleUpdate /
  pushUserMessageEcho / pushActiveScoop / requestModeState. Offscreen
  adapter caches the sprinkle snapshot, fans updates into
  syncRef()?.broadcast*, and writes active-scoop through to
  OffscreenBridge.setActiveScoopJid (single cache owner).

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 10: Add `resetTray()` waiter map to `PanelLeaderSyncProxy`

Round-trip RPC for panel `host reset`. Pattern matches `PanelFollowerSprinkleProxy.fetchSprinkleContent` (follower-sprinkle-bridge.ts:112-218): mint a requestId, register `{resolve, reject, timer}`, send the RPC, resolve on the matching response.

**Files:**

- Modify: `packages/chrome-extension/src/leader-sync-bridge.ts`
- Test: `packages/chrome-extension/tests/leader-sync-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  describe('PanelLeaderSyncProxy.resetTray', () => {
    it('sends leader-tray-reset and resolves on matching response', async () => {
      const bus = createBus();
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      // Fake offscreen handler: echo a successful response with the request's id.
      bus.offscreenHub.onPanelMessage((env) => {
        const msg = env.payload as any;
        if (msg?.type !== 'leader-tray-reset') return;
        bus.offscreenHub.sendToPanel({
          source: 'offscreen',
          payload: {
            type: 'leader-tray-reset-response',
            requestId: msg.requestId,
            ok: true,
            status: { state: 'connected', session: null, error: null, reconnectAttempts: 0 } as any,
          },
        });
      });
      const status = await proxy.resetTray(1000);
      expect(status.state).toBe('connected');
    });

    it('rejects on ok: false with the error', async () => {
      const bus = createBus();
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      bus.offscreenHub.onPanelMessage((env) => {
        const msg = env.payload as any;
        if (msg?.type !== 'leader-tray-reset') return;
        bus.offscreenHub.sendToPanel({
          source: 'offscreen',
          payload: {
            type: 'leader-tray-reset-response',
            requestId: msg.requestId,
            ok: false,
            error: 'no active session',
          },
        });
      });
      await expect(proxy.resetTray(1000)).rejects.toThrow(/no active session/);
    });

    it('rejects on timeout', async () => {
      const bus = createBus();
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      // No offscreen handler — request hangs.
      await expect(proxy.resetTray(50)).rejects.toThrow(/timed out/i);
    });

    it('two concurrent resets resolve independently by requestId', async () => {
      const bus = createBus();
      const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
      const seen: string[] = [];
      bus.offscreenHub.onPanelMessage((env) => {
        const msg = env.payload as any;
        if (msg?.type !== 'leader-tray-reset') return;
        seen.push(msg.requestId);
        // Reply only to the second request first to verify out-of-order works.
        if (seen.length === 2) {
          bus.offscreenHub.sendToPanel({
            source: 'offscreen',
            payload: {
              type: 'leader-tray-reset-response',
              requestId: seen[1],
              ok: true,
              status: { state: 'second', session: null, error: null, reconnectAttempts: 0 } as any,
            },
          });
          bus.offscreenHub.sendToPanel({
            source: 'offscreen',
            payload: {
              type: 'leader-tray-reset-response',
              requestId: seen[0],
              ok: true,
              status: { state: 'first', session: null, error: null, reconnectAttempts: 0 } as any,
            },
          });
        }
      });
      const [a, b] = await Promise.all([proxy.resetTray(1000), proxy.resetTray(1000)]);
      expect(a.state).toBe('first');
      expect(b.state).toBe('second');
    });
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  Add to `PanelLeaderSyncProxy`:

  ```ts
  private readonly pendingResets = new Map<
    string,
    {
      resolve: (status: LeaderTrayRuntimeStatus) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextResetId = 1;
  ```

  Extend the constructor subscriber to also discriminate the response:

  ```ts
  this.unsubscribe = subscriber.onMessage((envelope) => {
    if (envelope.source !== 'offscreen') return;
    const mode = discriminateMsg<LeaderModeChangedMsg>(envelope.payload, 'leader-mode-changed');
    if (mode) {
      this.listeners.onLeaderModeChange?.(mode.active);
      return;
    }
    const resp = discriminateMsg<LeaderTrayResetResponseMsg>(
      envelope.payload,
      'leader-tray-reset-response'
    );
    if (resp) {
      const pending = this.pendingResets.get(resp.requestId);
      if (!pending) return;
      this.pendingResets.delete(resp.requestId);
      clearTimeout(pending.timer);
      if (resp.ok && resp.status) pending.resolve(resp.status);
      else pending.reject(new Error(resp.error ?? 'tray reset failed'));
      return;
    }
  });
  ```

  Add the public method:

  ```ts
  resetTray(timeoutMs = 30_000): Promise<LeaderTrayRuntimeStatus> {
    if (this.disposed) return Promise.reject(new Error('PanelLeaderSyncProxy disposed'));
    const requestId = `tray-reset-${Date.now()}-${this.nextResetId++}`;
    return new Promise<LeaderTrayRuntimeStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResets.delete(requestId);
        reject(new Error(`leader-tray-reset timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingResets.set(requestId, { resolve, reject, timer });
      const payload: LeaderTrayResetRequestMsg = { type: 'leader-tray-reset', requestId };
      this.sender.send({ source: 'panel', payload });
    });
  }
  ```

  Update `dispose()` to reject all pending:

  ```ts
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const entry of this.pendingResets.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('PanelLeaderSyncProxy disposed'));
    }
    this.pendingResets.clear();
  }
  ```

  Imports needed: `LeaderTrayResetRequestMsg`, `LeaderTrayResetResponseMsg`, `LeaderTrayRuntimeStatus`.

- [ ] **Step 4: Run + verify pass**

  ```bash
  npx vitest run packages/chrome-extension/tests/leader-sync-bridge.test.ts -t "resetTray"
  ```

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/leader-sync-bridge.ts packages/chrome-extension/tests/leader-sync-bridge.test.ts
  git add -u
  git commit -m "feat(extension): PanelLeaderSyncProxy.resetTray RPC (#682)

  Round-trip requestId-keyed waiter map (same pattern as
  PanelFollowerSprinkleProxy.fetchSprinkleContent). 30s default timeout
  to cover tray reconnect latency. dispose() rejects all pending.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 11: Create `extension-leader-tray.ts` skeleton with `LeaderSyncManager` + read-only callbacks

First slice of the factory. Constructs `LeaderSyncManager` with the data-source callbacks (`getMessages`, `getMessagesForScoop`, `getScoopJid`, `getScoops`, `getSprinkles`, `readSprinkleContent`) and exposes a handle for the rest of the wiring to attach to. Does NOT yet construct `LeaderTrayPeerManager` / `LeaderTrayManager` / intervals / event tap / teardown — those come in later tasks.

**Files:**

- Create: `packages/chrome-extension/src/extension-leader-tray.ts`
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  import { describe, it, expect, vi } from 'vitest';
  import { startExtensionLeaderTray } from '../src/extension-leader-tray.js';

  function makeMockBridge(opts: { coneJid?: string; messages?: Record<string, any[]> } = {}) {
    const messages = opts.messages ?? {};
    return {
      getConeJid: vi.fn(() => opts.coneJid ?? null),
      getActiveScoopJid: vi.fn(() => null),
      setActiveScoopJid: vi.fn(),
      getMessagesForJid: vi.fn((jid: string) => messages[jid] ?? []),
      routeSprinkleLick: vi.fn(),
      notifyPanelIncomingMessage: vi.fn(),
      onAgentEvent: vi.fn(() => () => {}),
      persistScoop: vi.fn(),
      getBuffer: vi.fn((jid: string) => messages[jid] ?? []),
    };
  }

  function makeMockOrchestrator(scoops: any[] = []) {
    return {
      getScoops: vi.fn(() => scoops),
      handleMessage: vi.fn().mockResolvedValue(undefined),
      handleWebhookEvent: vi.fn(),
      stopScoop: vi.fn(),
      createScoopTab: vi.fn(),
    };
  }

  function makeMockSharedFs(files: Record<string, string> = {}) {
    return {
      readFile: vi.fn(async (path: string) => {
        if (path in files) return files[path];
        throw new Error('not found');
      }),
    };
  }

  function makeStubBrowser() {
    return {
      listPages: vi.fn().mockResolvedValue([]),
      setTrayTargetProvider: vi.fn(),
      getTransport: vi.fn(() => undefined),
    } as any;
  }

  describe('startExtensionLeaderTray — read-only callbacks', () => {
    function startWithCapture(
      overrides: Partial<Parameters<typeof startExtensionLeaderTray>[0]> = {}
    ) {
      let capturedOptions!: LeaderSyncManagerOptions;
      const orchestrator =
        overrides.orchestrator ??
        makeMockOrchestrator([{ jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' }]);
      const bridge = overrides.bridge ?? makeMockBridge({ coneJid: 'cone-1' });
      const handle = startExtensionLeaderTray({
        workerBaseUrl: 'wss://test',
        bridge: bridge as any,
        orchestrator: orchestrator as any,
        sharedFs: overrides.sharedFs ?? (makeMockSharedFs() as any),
        browser: overrides.browser ?? makeStubBrowser(),
        log: console as any,
        leaderBridge:
          overrides.leaderBridge ??
          ({
            getSprinkles: () => [],
            resolveSprinklePath: () => null,
            signalLeaderMode: vi.fn(),
            detach: vi.fn(),
          } as any),
        _trayLeaderFactory: () =>
          ({
            start: vi.fn().mockResolvedValue({}),
            stop: vi.fn(),
            clearSession: vi.fn().mockResolvedValue(undefined),
            sendControlMessage: vi.fn(),
          }) as any,
        _peerManagerFactory: () =>
          ({
            stop: vi.fn(),
            getPeers: vi.fn(() => []),
            handleControlMessage: vi.fn().mockResolvedValue(undefined),
          }) as any,
        _onSyncOptions: (opts) => {
          capturedOptions = opts;
        },
        ...overrides,
      });
      return { handle, options: capturedOptions, orchestrator, bridge };
    }

    it('getMessages reads from bridge.getMessagesForJid(activeJid)', () => {
      const bridge = makeMockBridge({
        coneJid: 'cone-1',
        messages: { 'cone-1': [{ id: 'm1', role: 'user', content: 'hi' }] },
      });
      const { handle, options } = startWithCapture({ bridge: bridge as any });
      expect(options.getMessages()).toHaveLength(1);
      handle.stop();
    });

    it('getScoops projects orchestrator scoops to ScoopSummary shape', () => {
      const orchestrator = makeMockOrchestrator([
        {
          jid: 'c',
          name: 'cone',
          isCone: true,
          folder: 'cone',
          assistantLabel: 'sliccy',
          trigger: undefined,
        },
        {
          jid: 's',
          name: 'helper',
          isCone: false,
          folder: 'helper',
          assistantLabel: 'helper',
          trigger: undefined,
        },
      ]);
      const { handle, options } = startWithCapture({ orchestrator: orchestrator as any });
      expect(options.getScoops?.()).toEqual([
        {
          jid: 'c',
          name: 'cone',
          folder: 'cone',
          isCone: true,
          assistantLabel: 'sliccy',
          trigger: undefined,
        },
        {
          jid: 's',
          name: 'helper',
          folder: 'helper',
          isCone: false,
          assistantLabel: 'helper',
          trigger: undefined,
        },
      ]);
      handle.stop();
    });

    it('readSprinkleContent looks up path via leaderBridge.resolveSprinklePath then reads sharedFs', async () => {
      const leaderBridge = {
        getSprinkles: () => [
          { name: 'w', title: 'W', path: '/welcome.shtml', open: false, autoOpen: false },
        ],
        resolveSprinklePath: (name: string) => (name === 'w' ? '/welcome.shtml' : null),
        signalLeaderMode: vi.fn(),
        detach: vi.fn(),
      };
      const sharedFs = makeMockSharedFs({ '/welcome.shtml': '<p>hi</p>' });
      const { handle, options } = startWithCapture({
        leaderBridge: leaderBridge as any,
        sharedFs: sharedFs as any,
      });
      expect(await options.readSprinkleContent?.('w')).toBe('<p>hi</p>');
      expect(await options.readSprinkleContent?.('nope')).toBeNull();
      handle.stop();
    });
  });
  ```

  (The `startWithCapture` helper uses the `_onSyncOptions` test seam — see
  Step 3 — to grab the `LeaderSyncManagerOptions` object the factory hands to
  `new LeaderSyncManager()`. Tests then call the callbacks directly. This
  avoids reaching for non-public `LeaderSyncManager` methods that don't
  exist as a public API.)

- [ ] **Step 2: Run + verify fail**

  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `extension-leader-tray.ts` skeleton**

  Create `packages/chrome-extension/src/extension-leader-tray.ts`:

  ```ts
  /**
   * Extension-leader tray factory — offscreen-side equivalent of
   * page-leader-tray.ts. Constructs LeaderSyncManager + LeaderTrayPeerManager
   * + LeaderTrayManager and wires the data-source callbacks against
   * OffscreenBridge state.
   *
   * Extracted from offscreen.ts so unit tests can drive the factory with
   * stubbed transports (no chrome.runtime, no real RTCDataChannel,
   * no createKernelHost).
   */

  import { LeaderSyncManager } from '../../webapp/src/scoops/tray-leader-sync.js';
  import type { LeaderSyncManagerOptions } from '../../webapp/src/scoops/tray-leader-sync.js';
  import { LeaderTrayManager } from '../../webapp/src/scoops/tray-leader.js';
  import type { LeaderTrayRuntimeStatus } from '../../webapp/src/scoops/tray-leader.js';
  import { LeaderTrayPeerManager } from '../../webapp/src/scoops/tray-webrtc.js';
  import type { Orchestrator } from '../../webapp/src/scoops/orchestrator.js';
  import type { BrowserAPI } from '../../webapp/src/cdp/browser-api.js';
  import type { VirtualFS } from '../../webapp/src/fs/virtual-fs.js';
  import type { ChannelMessage } from '../../webapp/src/scoops/types.js';
  import type { OffscreenBridge } from './offscreen-bridge.js';
  import type { OffscreenLeaderSyncBridgeHandle } from './leader-sync-bridge.js';

  export interface ExtensionLeaderTrayHandle {
    /** Stop everything. Idempotent. */
    stop(): void;
    /** Reset the tray session. */
    reset(): Promise<LeaderTrayRuntimeStatus>;
    /** Exposed for testing. */
    readonly sync: LeaderSyncManager;
    readonly peers: LeaderTrayPeerManager;
    readonly leader: LeaderTrayManager;
  }

  /** Narrow surface the factory needs on OffscreenBridge. */
  export interface ExtensionLeaderBridge {
    getConeJid(): string | null;
    getActiveScoopJid(): string | null;
    setActiveScoopJid(jid: string | null): void;
    getMessagesForJid(jid: string): any[]; // ChatMessage[] (avoid circular type imports)
    getBuffer(jid: string): any[];
    persistScoop(jid: string): void;
    routeSprinkleLick(name: string, body: unknown, targetScoop?: string): Promise<void>;
    notifyPanelIncomingMessage(jid: string, msg: ChannelMessage): void;
    onAgentEvent(handler: (scoopJid: string, event: any) => void): () => void;
  }

  export interface StartExtensionLeaderTrayOptions {
    workerBaseUrl: string;
    bridge: ExtensionLeaderBridge;
    orchestrator: Orchestrator;
    sharedFs: VirtualFS | null;
    browser: BrowserAPI;
    log: {
      info: (msg: string, ctx?: any) => void;
      warn: (msg: string, ctx?: any) => void;
      error: (msg: string, ctx?: any) => void;
      debug?: (msg: string, ctx?: any) => void;
    };

    /** Pre-constructed leader bridge (so tests can stub). In production
     *  the offscreen.ts caller builds it via connectOffscreenLeaderSyncBridge. */
    leaderBridge: OffscreenLeaderSyncBridgeHandle;

    // --- Test-only injection seams ---
    /** @internal */ _trayLeaderFactory?: (cfg: any) => LeaderTrayManager;
    /** @internal */ _peerManagerFactory?: (cfg: any) => LeaderTrayPeerManager;
    /** @internal */ _refreshIntervalMs?: number;
    /** @internal Fires once with the LeaderSyncManagerOptions object the
     *  factory constructed, so tests can drive the callbacks directly
     *  without reaching for private LeaderSyncManager internals. */
    _onSyncOptions?: (opts: LeaderSyncManagerOptions) => void;
  }

  export function startExtensionLeaderTray(
    options: StartExtensionLeaderTrayOptions
  ): ExtensionLeaderTrayHandle {
    const { workerBaseUrl, bridge, orchestrator, sharedFs, browser, log, leaderBridge } = options;
    const refreshIntervalMs = options._refreshIntervalMs ?? 5000;

    // Forward declarations.
    let sync!: LeaderSyncManager;
    let trayLeader!: LeaderTrayManager;
    let trayPeers!: LeaderTrayPeerManager;

    const getActiveJid = (): string => bridge.getActiveScoopJid() ?? bridge.getConeJid() ?? '';

    const toScoopSummaries = () =>
      orchestrator.getScoops().map((s) => ({
        jid: s.jid,
        name: s.name,
        folder: s.folder,
        isCone: s.isCone,
        assistantLabel: s.assistantLabel,
        trigger: s.trigger,
      }));

    const syncOptions: LeaderSyncManagerOptions = {
      getMessages: () => bridge.getMessagesForJid(getActiveJid()) as any,
      getMessagesForScoop: (jid) => bridge.getMessagesForJid(jid) as any,
      getScoopJid: () => getActiveJid(),
      getScoops: toScoopSummaries,
      getSprinkles: () => leaderBridge.getSprinkles() as any,
      readSprinkleContent: async (name) => {
        const path = leaderBridge.resolveSprinklePath(name);
        if (!path || !sharedFs) return null;
        try {
          const raw = await sharedFs.readFile(path, { encoding: 'utf-8' });
          return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        } catch {
          return null;
        }
      },
      onSprinkleLick: (name, body, targetScoop) => {
        void bridge.routeSprinkleLick(name, body, targetScoop);
      },
      onFollowerMessage: () => {
        // Wired in Task 12.
      },
      onFollowerAbort: () => {
        const jid = getActiveJid();
        if (jid) orchestrator.stopScoop(jid);
      },
      browserAPI: browser,
      browserTransport: browser.getTransport?.() ?? undefined,
      vfs: sharedFs ?? undefined,
    };
    sync = new LeaderSyncManager(syncOptions);
    options._onSyncOptions?.(syncOptions);
    browser.setTrayTargetProvider?.(sync);

    // Stubs for the bits we'll fill in later tasks:
    const peerFactory = options._peerManagerFactory ?? ((cfg) => new LeaderTrayPeerManager(cfg));
    trayPeers = peerFactory({
      sendControlMessage: (m: any) => trayLeader.sendControlMessage(m),
      onPeerConnected: () => {
        // Wired in Task 13.
      },
      onPeerDisconnected: () => {},
    });

    const leaderFactory = options._trayLeaderFactory ?? ((cfg) => new LeaderTrayManager(cfg));
    trayLeader = leaderFactory({
      workerBaseUrl,
      runtime: 'slicc-extension-offscreen',
      // webSocketFactory + onControlMessage wired in Task 14.
      onControlMessage: () => {},
      onReconnecting: () => {},
      onReconnected: () => {},
      onReconnectGaveUp: () => {},
    });

    return {
      stop() {
        sync.stop();
        trayPeers.stop();
        trayLeader.stop();
      },
      async reset() {
        sync.stop();
        trayPeers.stop();
        trayLeader.stop();
        await trayLeader.clearSession();
        await trayLeader.start();
        const { getLeaderTrayRuntimeStatus } =
          await import('../../webapp/src/scoops/tray-leader.js');
        return getLeaderTrayRuntimeStatus();
      },
      sync,
      peers: trayPeers,
      leader: trayLeader,
    };
  }
  ```

- [ ] **Step 4: Run + verify pass**

  ```bash
  npx vitest run packages/chrome-extension/tests/extension-leader-tray.test.ts
  npm run typecheck
  ```

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/extension-leader-tray.ts packages/chrome-extension/tests/extension-leader-tray.test.ts
  git add packages/chrome-extension/src/extension-leader-tray.ts packages/chrome-extension/tests/extension-leader-tray.test.ts
  git commit -m "feat(extension): extension-leader-tray factory skeleton (#682)

  Mirror of page-leader-tray.ts. This commit wires LeaderSyncManager
  with the read-only data-source callbacks (getMessages, getScoops,
  getSprinkles, readSprinkleContent). LeaderTrayPeerManager +
  LeaderTrayManager wiring, onFollowerMessage, event tap, intervals,
  and teardown come in subsequent tasks.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 12: Wire `onFollowerMessage` (panel echo + buffer + rebroadcast + IIFE)

Most subtle part of the factory. Sync work runs inline; orchestrator dispatch runs in a fire-and-forget IIFE.

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts`
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  describe('startExtensionLeaderTray onFollowerMessage', () => {
    it('emits panel echo, persists, rebroadcasts synchronously', () => {
      const bridge = makeMockBridge({ coneJid: 'cone-1' });
      const { handle, options } = startWithCapture({ bridge: bridge as any });
      // Spy BEFORE invoking — otherwise the synchronous broadcast call
      // happens before the spy is installed and the assertion can't catch it.
      const broadcastSpy = vi.spyOn(handle.sync, 'broadcastUserMessage');
      options.onFollowerMessage('hi', 'm-99', undefined);
      expect(bridge.notifyPanelIncomingMessage).toHaveBeenCalledWith(
        'cone-1',
        expect.objectContaining({ id: 'm-99', channel: 'web' })
      );
      expect(bridge.persistScoop).toHaveBeenCalledWith('cone-1');
      expect(broadcastSpy).toHaveBeenCalledWith('hi', 'm-99', undefined);
      handle.stop();
    });

    it('orchestrator.handleMessage runs in fire-and-forget IIFE (no await)', async () => {
      const bridge = makeMockBridge({ coneJid: 'cone-1' });
      let dispatchResolve!: () => void;
      const orchestrator = makeMockOrchestrator([
        { jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' },
      ]);
      orchestrator.handleMessage = vi.fn(
        () =>
          new Promise<void>((res) => {
            dispatchResolve = res;
          })
      );
      const { handle, options } = startWithCapture({
        bridge: bridge as any,
        orchestrator: orchestrator as any,
      });
      // The callback returns undefined synchronously even though
      // handleMessage hasn't resolved.
      const returned = options.onFollowerMessage('hi', 'm-99', undefined);
      expect(returned).toBeUndefined();
      expect(orchestrator.handleMessage).toHaveBeenCalled();
      expect(orchestrator.createScoopTab).not.toHaveBeenCalled();
      dispatchResolve();
      await Promise.resolve();
      expect(orchestrator.createScoopTab).toHaveBeenCalledWith('cone-1');
      handle.stop();
    });

    it('no active scoop → no-op', () => {
      const bridge = makeMockBridge({ coneJid: null });
      const orchestrator = makeMockOrchestrator([]);
      const { handle, options } = startWithCapture({
        bridge: bridge as any,
        orchestrator: orchestrator as any,
      });
      options.onFollowerMessage('hi', 'm-99', undefined);
      expect(bridge.notifyPanelIncomingMessage).not.toHaveBeenCalled();
      expect(orchestrator.handleMessage).not.toHaveBeenCalled();
      handle.stop();
    });
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  Replace the stub `onFollowerMessage` in `extension-leader-tray.ts` with the full body from spec §4 (revision 5):

  ```ts
  onFollowerMessage: (text, messageId, attachments) => {
    const activeJid = getActiveJid();
    if (!activeJid) return;
    const channelMsg: ChannelMessage = {
      id: messageId,
      chatJid: activeJid,
      senderId: 'user',
      senderName: 'User',
      content: text,
      attachments,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'web',
    };

    // (1) Panel echo.
    bridge.notifyPanelIncomingMessage(activeJid, channelMsg);

    // (2) Buffer + persist.
    bridge.getBuffer(activeJid).push({
      id: messageId,
      role: 'user',
      content: text,
      attachments,
      timestamp: Date.now(),
    });
    bridge.persistScoop(activeJid);

    // (3) Rebroadcast immediately — don't gate on the agent turn.
    sync.broadcastUserMessage(text, messageId, attachments);

    // (4) Async orchestrator dispatch.
    void (async () => {
      try {
        await orchestrator.handleMessage(channelMsg);
        orchestrator.createScoopTab(activeJid);
      } catch (err) {
        log.error('Follower message dispatch failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  },
  ```

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/extension-leader-tray.ts packages/chrome-extension/tests/extension-leader-tray.test.ts
  git add -u
  git commit -m "feat(extension): onFollowerMessage with panel echo + IIFE dispatch (#682)

  Signature stays synchronous (LeaderSyncManagerOptions declares void
  at tray-leader-sync.ts:52 and the caller doesn't await). Panel echo
  via notifyPanelIncomingMessage because 'web' is not in
  EXTERNAL_LICK_CHANNELS — orchestrator.handleMessage's gated
  onIncomingMessage won't fire for it. Rebroadcast immediately
  (matches main.ts:2462 ordering); orchestrator dispatch in
  fire-and-forget IIFE with error log.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 13: Wire `LeaderTrayPeerManager` `onPeerConnected` → `sync.addFollower`

The actual gap fix — currently the extension's `onPeerConnected` just logs.

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts`
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  it('peer connected → sync.addFollower called with bootstrapId, channel, runtime, connectedAt', () => {
    const handle = startExtensionLeaderTray(/* … with captured peer manager cfg */);
    const addFollowerSpy = vi.spyOn(handle.sync, 'addFollower');
    // Reach into the peer-manager-factory captured config to invoke onPeerConnected:
    const capturedCfg = (options._peerManagerFactory as any).mock.calls[0][0];
    const fakeChannel = { send: vi.fn(), readyState: 'open' } as any;
    capturedCfg.onPeerConnected(
      {
        bootstrapId: 'boot-1',
        controllerId: 'ctl-1',
        attempt: 1,
        runtime: 'slicc-standalone',
        connectedAt: '2026-05-20T00:00:00Z',
      },
      fakeChannel
    );
    expect(addFollowerSpy).toHaveBeenCalledWith('boot-1', fakeChannel, {
      runtime: 'slicc-standalone',
      connectedAt: '2026-05-20T00:00:00Z',
    });
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  Replace the stub `onPeerConnected` in the factory:

  ```ts
  onPeerConnected: (peer: any, channel: any) => {
    log.info('Extension tray follower connected', {
      bootstrapId: peer.bootstrapId,
      runtime: peer.runtime,
    });
    sync.addFollower(peer.bootstrapId, channel, {
      runtime: peer.runtime,
      connectedAt: peer.connectedAt ?? undefined,
    });
  },
  onPeerDisconnected: (bootstrapId: string, reason: string) =>
    log.info('Extension tray follower disconnected', { bootstrapId, reason }),
  ```

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Commit**

  ```bash
  git add -u
  git commit -m "fix(extension): wire onPeerConnected → sync.addFollower (#682)

  This is the headline bug: the existing offscreen.ts:442-448
  workerBaseUrl branch logged the peer connection but never called
  sync.addFollower(bootstrapId, channel, …), so the data channel
  opened and sat silent. Followers connect but receive nothing.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 14: Wire `LeaderTrayManager` with `webhook.event` control routing

`webhook.event` control messages must hit `orchestrator.handleWebhookEvent` directly (extension `lickManager` is in-process — no `lick-webhook-event` bridge hop needed).

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts`
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  it('webhook.event control message routes to orchestrator.handleWebhookEvent', () => {
    const orchestrator = makeMockOrchestrator([
      { jid: 'cone-1', isCone: true, name: 'cone', folder: 'cone' },
    ]);
    const handle = startExtensionLeaderTray(/* … */);
    const capturedCfg = (options._trayLeaderFactory as any).mock.calls[0][0];
    capturedCfg.onControlMessage({
      type: 'webhook.event',
      webhookId: 'wh-1',
      headers: { 'x-test': '1' },
      body: { ok: true },
    });
    expect(orchestrator.handleWebhookEvent).toHaveBeenCalledWith(
      'wh-1',
      { 'x-test': '1' },
      { ok: true }
    );
  });

  it('non-webhook control messages route to trayPeers.handleControlMessage', async () => {
    const handle = startExtensionLeaderTray(/* … */);
    const cfg = (options._trayLeaderFactory as any).mock.calls[0][0];
    const peerCfg = (options._peerManagerFactory as any).mock.calls[0][0];
    const peerHandleSpy = vi.spyOn(handle.peers, 'handleControlMessage');
    cfg.onControlMessage({ type: 'webrtc.offer' /* … */ });
    expect(peerHandleSpy).toHaveBeenCalled();
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  Replace the stub `onControlMessage` in the factory's `LeaderTrayManager` construction:

  ```ts
  trayLeader = leaderFactory({
    workerBaseUrl,
    runtime: 'slicc-extension-offscreen',
    webSocketFactory: (url: string) => new ServiceWorkerLeaderTraySocket(url),
    onControlMessage: (message: any) => {
      if (message.type === 'webhook.event') {
        orchestrator.handleWebhookEvent(message.webhookId, message.headers, message.body);
        return;
      }
      void trayPeers.handleControlMessage(message).catch((err) => {
        log.warn('Tray leader bootstrap handling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onReconnecting: (attempt: number, lastError: any) =>
      log.info('Extension leader tray reconnecting', { attempt, lastError }),
    onReconnected: (session: any) =>
      log.info('Extension leader tray reconnected', { trayId: session.trayId }),
    onReconnectGaveUp: (lastError: any, attempts: number) =>
      log.warn('Extension leader tray reconnect gave up', { lastError, attempts }),
  });
  ```

  Import `ServiceWorkerLeaderTraySocket` from `./tray-socket-proxy.js`.

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/extension-leader-tray.ts packages/chrome-extension/tests/extension-leader-tray.test.ts
  git add -u
  git commit -m "feat(extension): route webhook.event control to orchestrator (#682)

  Standalone hops through the worker via lick-webhook-event because its
  LickManager lives in the worker. Extension's lickManager is in-process
  (createKernelHost), so onControlMessage can call
  orchestrator.handleWebhookEvent directly.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 15: Wire `onAgentEvent` tap with active-scoop filter

Subscribe to `bridge.onAgentEvent` and forward events to `sync.broadcastEvent` ONLY when the event's `scoopJid` matches the active scoop (matches standalone's implicit filter at offscreen-client.ts:496).

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts`
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  it('agent event for active scoop forwards to sync.broadcastEvent', () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    let agentHandler!: (scoopJid: string, event: any) => void;
    bridge.onAgentEvent.mockImplementation((h: any) => {
      agentHandler = h;
      return () => {};
    });
    const handle = startExtensionLeaderTray(/* … */);
    const broadcastSpy = vi.spyOn(handle.sync, 'broadcastEvent');
    agentHandler('cone-1', { type: 'content_delta', messageId: 'm', text: 'hi' });
    expect(broadcastSpy).toHaveBeenCalledWith({
      type: 'content_delta',
      messageId: 'm',
      text: 'hi',
    });
  });

  it('agent event for a background scoop is dropped', () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    bridge.getActiveScoopJid = vi.fn(() => 'cone-1');
    let agentHandler!: (scoopJid: string, event: any) => void;
    bridge.onAgentEvent.mockImplementation((h: any) => {
      agentHandler = h;
      return () => {};
    });
    const handle = startExtensionLeaderTray(/* … */);
    const broadcastSpy = vi.spyOn(handle.sync, 'broadcastEvent');
    agentHandler('scoop-other', { type: 'content_delta', messageId: 'm', text: 'hi' });
    expect(broadcastSpy).not.toHaveBeenCalled();
  });

  it('teardown unsubscribes the tap', () => {
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    const unsubAgent = vi.fn();
    bridge.onAgentEvent.mockImplementation(() => unsubAgent);
    const handle = startExtensionLeaderTray(/* … */);
    handle.stop();
    expect(unsubAgent).toHaveBeenCalled();
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  In the factory, after `sync` is constructed:

  ```ts
  const unsubAgent = bridge.onAgentEvent((eventScoopJid: string, event: any) => {
    if (eventScoopJid !== getActiveJid()) return;
    sync.broadcastEvent(event);
  });
  ```

  Add `unsubAgent` to the closure list, and call it inside `stop()`.

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Commit**

  ```bash
  git add -u
  git commit -m "feat(extension): agent-event tap with active-scoop filter (#682)

  LeaderSyncManager.broadcastEvent at tray-leader-sync.ts:300-304
  ignores the event's scoopJid and tags the wire payload with
  options.getScoopJid() (the active scoop). Without filtering, a
  background scoop's stream would be broadcast tagged as the active
  scoop — wrong content + wrong scope. The tap filters before
  forwarding, matching standalone's implicit filter in
  offscreen-client.ts:496.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 16: Wire CDP target refresh + broadcast intervals

5s `setInterval` for `setLocalTargets`, `broadcastScoopsList`, `broadcastSprinklesList`. CDP errors are throttled with `ThrottledErrorTracker`.

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts`
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  it('refreshLeaderTargets calls sync.setLocalTargets (NOT advertiseTargets)', async () => {
    const browser = makeStubBrowser();
    browser.listPages = vi
      .fn()
      .mockResolvedValue([{ targetId: 't1', title: 'A', url: 'about:blank' }]);
    const handle = startExtensionLeaderTray(/* …, browser, _refreshIntervalMs: 50 */);
    const setLocalSpy = vi.spyOn(handle.sync, 'setLocalTargets');
    // wait for first refresh tick (the factory calls refreshLeaderTargets immediately AND on interval)
    await new Promise((r) => setTimeout(r, 10));
    expect(setLocalSpy).toHaveBeenCalledWith([{ targetId: 't1', title: 'A', url: 'about:blank' }]);
    handle.stop();
  });

  it('broadcasts scoops + sprinkles lists on interval', async () => {
    const handle = startExtensionLeaderTray(/* …, _refreshIntervalMs: 30 */);
    const scoopsSpy = vi.spyOn(handle.sync, 'broadcastScoopsList');
    const sprinklesSpy = vi.spyOn(handle.sync, 'broadcastSprinklesList');
    await new Promise((r) => setTimeout(r, 100));
    expect(scoopsSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sprinklesSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    handle.stop();
  });

  it('teardown clears intervals', async () => {
    const handle = startExtensionLeaderTray(/* …, _refreshIntervalMs: 20 */);
    handle.stop();
    const scoopsSpy = vi.spyOn(handle.sync, 'broadcastScoopsList');
    await new Promise((r) => setTimeout(r, 80));
    expect(scoopsSpy).not.toHaveBeenCalled();
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  Add to the factory body (after sync construction + unsubAgent):

  ```ts
  const cdpThrottle = new ThrottledErrorTracker(log as any, {
    failureMessage: 'Extension leader CDP target refresh failed (best-effort, throttled)',
    recoveryMessage: 'Extension leader CDP target refresh recovered',
  });

  const refreshLeaderTargets = async () => {
    let pages: Awaited<ReturnType<BrowserAPI['listPages']>>;
    try {
      pages = await browser.listPages();
    } catch (err) {
      cdpThrottle.reportFailure(err);
      return;
    }
    cdpThrottle.reportSuccess();
    try {
      sync.setLocalTargets(
        pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url }))
      );
    } catch (err) {
      log.error('Extension leader target broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const intervals: ReturnType<typeof setInterval>[] = [
    setInterval(refreshLeaderTargets, refreshIntervalMs),
    setInterval(() => {
      try {
        sync.broadcastScoopsList();
        sync.broadcastSprinklesList();
      } catch (err) {
        log.error('Failed to broadcast follower lists', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, refreshIntervalMs),
  ];
  void refreshLeaderTargets();
  ```

  Add `intervals.forEach(clearInterval)` to `stop()`.

  Import `ThrottledErrorTracker` from `'../../webapp/src/scoops/throttled-error-tracker.js'`.

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Commit**

  ```bash
  git add -u
  git commit -m "feat(extension): CDP target refresh + broadcast intervals (#682)

  Mirrors page-leader-tray.ts:234-285. 5s setInterval for
  setLocalTargets, broadcastScoopsList, broadcastSprinklesList.
  Throttled CDP error reporting. setLocalTargets (LeaderSyncManager
  API at :725), NOT advertiseTargets (the follower API at
  tray-follower-sync.ts:315).

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 17: Wire host-command setters + `leader-tray-reset` RPC listener

Panel terminal `host` reads from module-level `host-command.ts` singletons. Wire `setConnectedFollowersGetter` and `setTrayResetter` from offscreen. Also install the `leader-tray-reset` envelope listener that performs the reset sequence and replies with the new status.

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts`
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  it('setConnectedFollowersGetter exposes the peer list', () => {
    const handle = startExtensionLeaderTray(/* … */);
    handle.peers.getPeers = vi.fn(
      () =>
        [
          { bootstrapId: 'b1', runtime: 'slicc-standalone', connectedAt: '2026-05-20T00:00:00Z' },
        ] as any
    );
    const followers = getConnectedFollowers(); // imported from host-command.ts
    expect(followers).toEqual([
      { runtimeId: 'b1', runtime: 'slicc-standalone', connectedAt: '2026-05-20T00:00:00Z' },
    ]);
  });

  it('leader-tray-reset envelope triggers reset + replies with status', async () => {
    const { handle } = startWithCapture();
    // Find the reset listener registered on chrome.runtime.onMessage.
    // It's the most recent addListener call; if multiple listeners are
    // registered the test should filter by predicate.
    sentMessages.length = 0;
    const listener = mockChrome.runtime.onMessage.addListener.mock.calls.at(-1)![0];
    listener(
      { source: 'panel', payload: { type: 'leader-tray-reset', requestId: 'r-1' } },
      {},
      () => {}
    );
    await new Promise((r) => setImmediate(r));
    const reply = sentMessages.find(
      (m: any) => m?.payload?.type === 'leader-tray-reset-response'
    ) as any;
    expect(reply.payload).toMatchObject({ requestId: 'r-1', ok: true });
    expect(handle.leader.clearSession).toHaveBeenCalled();
    // The factory itself doesn't call start() on boot — that's offscreen.ts's
    // job (Task 19). In this isolated factory test, reset is the only start.
    expect(handle.leader.start).toHaveBeenCalledTimes(1);
  });

  it('onFollowerCountChanged writes slicc.leaderTrayFollowers to localStorage', () => {
    const setItem = vi.fn();
    const originalLocalStorage = (globalThis as any).window?.localStorage;
    (globalThis as any).window = { localStorage: { setItem } };
    try {
      const { handle, options } = startWithCapture();
      handle.peers.getPeers = vi.fn(
        () =>
          [
            {
              bootstrapId: 'b1',
              runtime: 'slicc-standalone',
              connectedAt: '2026-05-20T00:00:00Z',
            },
          ] as any
      );
      options.onFollowerCountChanged?.(1);
      expect(setItem).toHaveBeenCalledWith(
        'slicc.leaderTrayFollowers',
        JSON.stringify([
          { runtimeId: 'b1', runtime: 'slicc-standalone', connectedAt: '2026-05-20T00:00:00Z' },
        ])
      );
    } finally {
      if (originalLocalStorage) (globalThis as any).window.localStorage = originalLocalStorage;
    }
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  In the factory:

  ```ts
  // Imports
  import {
    setConnectedFollowersGetter,
    setTrayResetter,
  } from '../../webapp/src/shell/supplemental-commands/host-command.js';
  import { getLeaderTrayRuntimeStatus } from '../../webapp/src/scoops/tray-leader.js';
  import type {
    LeaderTrayResetRequestMsg,
    LeaderTrayResetResponseMsg,
    ExtensionMessage,
  } from './messages.js';

  // After tray construction:
  setConnectedFollowersGetter(() =>
    trayPeers.getPeers().map((p) => ({
      runtimeId: p.bootstrapId,
      runtime: p.runtime,
      connectedAt: p.connectedAt ?? undefined,
    }))
  );

  const resetSequence = async (): Promise<LeaderTrayRuntimeStatus> => {
    sync.stop();
    trayPeers.stop();
    trayLeader.stop();
    await trayLeader.clearSession();
    await trayLeader.start();
    return getLeaderTrayRuntimeStatus();
  };
  setTrayResetter(resetSequence);

  // onFollowerCountChanged → write slicc.leaderTrayFollowers (parity with
  // standalone main.ts:2465-2476). Extension panel terminal runs in
  // offscreen via RemoteTerminalView and shares this realm's
  // localStorage, so the host-command.ts fallback at lines 74-84 picks
  // up the value.
  syncOptions.onFollowerCountChanged = (_count: number) => {
    const peers = trayPeers.getPeers().map((p) => ({
      runtimeId: p.bootstrapId,
      runtime: p.runtime,
      connectedAt: p.connectedAt ?? undefined,
    }));
    try {
      window.localStorage.setItem('slicc.leaderTrayFollowers', JSON.stringify(peers));
    } catch (err) {
      log.warn('Failed to persist leaderTrayFollowers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  // (If the factory has already constructed `sync` before reaching this
  // point, this assignment mutates the options object the sync holds a
  // reference to. If sync clones its options at construction time, declare
  // the callback inside the syncOptions object literal in Task 11
  // instead — verify by reading LeaderSyncManager.constructor, currently
  // tray-leader-sync.ts:155 stores `this.options = options` by reference,
  // so post-construction mutation works.)

  // leader-tray-reset RPC listener.
  const resetListener = (message: unknown) => {
    if (typeof message !== 'object' || message === null) return false;
    const env = message as { source?: string; payload?: { type?: string } };
    if (env.source !== 'panel') return false;
    if (env.payload?.type !== 'leader-tray-reset') return false;
    const req = env.payload as LeaderTrayResetRequestMsg;
    void (async () => {
      try {
        const status = await resetSequence();
        const reply: LeaderTrayResetResponseMsg = {
          type: 'leader-tray-reset-response',
          requestId: req.requestId,
          ok: true,
          status,
        };
        chrome.runtime.sendMessage({ source: 'offscreen', payload: reply }).catch(() => {});
      } catch (err) {
        const reply: LeaderTrayResetResponseMsg = {
          type: 'leader-tray-reset-response',
          requestId: req.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        chrome.runtime.sendMessage({ source: 'offscreen', payload: reply }).catch(() => {});
      }
    })();
    return false;
  };
  chrome.runtime.onMessage.addListener(resetListener);
  ```

  Add cleanup in `stop()`:

  ```ts
  chrome.runtime.onMessage.removeListener(resetListener);
  setConnectedFollowersGetter(null);
  setTrayResetter(null);
  ```

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Commit**

  ```bash
  git add -u
  git commit -m "feat(extension): host-command setters + tray-reset RPC (#682)

  Panel terminal 'host' now reads follower list and reset capability
  from the offscreen-wired setters (host-command.ts singletons share
  origin across panel + offscreen via the global module). 'host reset'
  routes through the new leader-tray-reset envelope, which performs
  the standalone reset sequence and replies with the new status.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 18: Wire `stop()` teardown order matching standalone

Order: `unsubAgent` → clear intervals → `sync.stop()` → `peers.stop()` → `leader.stop()` → host-command setters cleared → reset listener removed → `leaderBridge.detach()`.

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts`
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

  ```ts
  it('stop() tears down in the standalone order', () => {
    const calls: string[] = [];
    const unsubAgent = vi.fn(() => calls.push('unsubAgent'));
    const bridge = makeMockBridge({ coneJid: 'cone-1' });
    bridge.onAgentEvent.mockImplementation(() => unsubAgent);
    const leaderBridge = {
      getSprinkles: () => [],
      resolveSprinklePath: () => null,
      signalLeaderMode: vi.fn(() => calls.push('signalLeaderMode(false)')),
      detach: vi.fn(() => calls.push('leaderBridge.detach')),
    };
    const removeListenerSpy = vi.fn(() => calls.push('removeListener'));
    mockChrome.runtime.onMessage.removeListener = removeListenerSpy as any;

    const { handle } = startWithCapture({
      bridge: bridge as any,
      leaderBridge: leaderBridge as any,
    });
    vi.spyOn(handle.sync, 'stop').mockImplementation(() => {
      calls.push('sync');
    });
    vi.spyOn(handle.peers, 'stop').mockImplementation(() => {
      calls.push('peers');
    });
    vi.spyOn(handle.leader, 'stop').mockImplementation(() => {
      calls.push('leader');
    });
    handle.stop();
    expect(calls).toEqual([
      'unsubAgent',
      'sync',
      'peers',
      'leader',
      'removeListener',
      'signalLeaderMode(false)',
      'leaderBridge.detach',
    ]);
    // signalLeaderMode receives `false`.
    expect(leaderBridge.signalLeaderMode).toHaveBeenCalledWith(false);
  });

  it('stop() also clears intervals + host-command setters', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const { handle } = startWithCapture();
    handle.stop();
    expect(clearSpy).toHaveBeenCalled();
    expect(getConnectedFollowers()).toEqual([]); // setter cleared
  });

  it('stop() is idempotent', () => {
    const { handle } = startWithCapture();
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });
  ```

- [ ] **Step 2: Run + verify fail**

- [ ] **Step 3: Implement**

  Replace the existing `stop()` body:

  ```ts
  let stopped = false;
  // …
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      unsubAgent();
      for (const id of intervals) clearInterval(id);
      sync.stop();
      trayPeers.stop();
      trayLeader.stop();
      setConnectedFollowersGetter(null);
      setTrayResetter(null);
      chrome.runtime.onMessage.removeListener(resetListener);
      leaderBridge.signalLeaderMode(false);
      leaderBridge.detach();
    },
    // …
  };
  ```

  Note: `signalLeaderMode(false)` fires BEFORE `detach()` so the panel sees the deactivation before the listener goes away.

- [ ] **Step 4: Run + verify pass**

- [ ] **Step 5: Run all extension-leader-tray tests**

  ```bash
  npx vitest run packages/chrome-extension/tests/extension-leader-tray.test.ts
  ```

- [ ] **Step 6: Commit**

  ```bash
  npx prettier --write packages/chrome-extension/src/extension-leader-tray.ts packages/chrome-extension/tests/extension-leader-tray.test.ts
  git add -u
  git commit -m "feat(extension): teardown order matches standalone (#682)

  unsubAgent → intervals → sync → peers → leader → host-command
  setters → reset listener → bridge detach. Mirrors
  page-leader-tray.ts:316-323. Idempotent.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 19: Integrate factory into `offscreen.ts`

Delegate the `workerBaseUrl` branch to `startExtensionLeaderTray`. Construct the hub + leader bridge here (production wiring). Update `stopTrayRuntime` to call `handle.stop()`.

**Files:**

- Modify: `packages/chrome-extension/src/offscreen.ts`
- Test: integration via existing factory tests + manual

- [ ] **Step 1: Read current branch to confirm replacement scope**

  ```bash
  sed -n '438,480p' packages/chrome-extension/src/offscreen.ts
  ```

- [ ] **Step 2: Replace the `workerBaseUrl` branch**

  In `packages/chrome-extension/src/offscreen.ts`, find the existing `if (trayRuntimeConfig?.workerBaseUrl) { … }` block (currently logging-only) and replace its body with:

  ```ts
  if (trayRuntimeConfig?.workerBaseUrl) {
    // Build the panel↔offscreen hub (shared with the follower branch
    // when it constructs its own; each branch owns its own hub instance
    // and detaches on switch — see spec §8 lifecycle).
    const hub: OffscreenMessageHub = {
      sendToPanel: (envelope) => {
        chrome.runtime.sendMessage(envelope).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (/receiving end does not exist/i.test(msg)) return;
          log.error('Offscreen → panel sendMessage failed (leader)', { error: msg });
        });
      },
      onPanelMessage: (handler) => {
        const listener = (msg: unknown): boolean => {
          if (!msg || typeof msg !== 'object' || !('source' in msg) || !('payload' in msg)) {
            return false;
          }
          handler(msg as { source: string; payload: unknown });
          return false;
        };
        chrome.runtime.onMessage.addListener(listener);
        return () => chrome.runtime.onMessage.removeListener(listener);
      },
    };

    // Forward-declared so the bridge can resolve sync lazily.
    let activeHandle: ExtensionLeaderTrayHandle | null = null;
    const leaderBridge = connectOffscreenLeaderSyncBridge(
      hub,
      () => activeHandle?.sync ?? null,
      bridge
    );
    leaderBridge.signalLeaderMode(true);

    activeHandle = startExtensionLeaderTray({
      workerBaseUrl: trayRuntimeConfig.workerBaseUrl,
      bridge,
      orchestrator,
      sharedFs: host.sharedFs ?? null,
      browser,
      log,
      leaderBridge,
    });

    void activeHandle.leader.start().catch((err) => {
      log.warn('Extension leader tray start failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    stopTrayRuntime = () => {
      activeHandle?.stop();
      activeHandle = null;
    };
    return;
  }
  ```

  Add imports at the top:

  ```ts
  import {
    connectOffscreenLeaderSyncBridge,
    type OffscreenMessageHub,
  } from './leader-sync-bridge.js';
  import {
    startExtensionLeaderTray,
    type ExtensionLeaderTrayHandle,
  } from './extension-leader-tray.js';
  ```

  Remove the now-unused `LeaderTrayManager`, `LeaderTrayPeerManager`, `ServiceWorkerLeaderTraySocket` imports if no other caller in `offscreen.ts` references them. Run `npm run typecheck` to confirm.

- [ ] **Step 3: Format + typecheck + test**

  ```bash
  npx prettier --write packages/chrome-extension/src/offscreen.ts
  npm run typecheck
  npx vitest run packages/chrome-extension/tests/
  ```

  Expected: all green.

- [ ] **Step 4: Build the extension to confirm no production-only breakage**

  ```bash
  npm run build -w @slicc/chrome-extension
  ```

  Expected: success.

- [ ] **Step 5: Commit**

  ```bash
  git add -u
  git commit -m "feat(extension): delegate workerBaseUrl branch to startExtensionLeaderTray (#682)

  Replaces the silent-leader stub with the full factory. offscreen.ts
  is now ~30 LoC of wiring (hub construction + leader bridge + factory
  call). stopTrayRuntime delegates to handle.stop() which performs the
  standalone-order teardown.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 20: Panel-side wiring in `main.ts` — install/remove leader hooks

In `mainExtension` (the side-panel boot path), construct
`PanelLeaderSyncProxy`, install the leader-mode listener, and wire the
four push handlers (active scoop, sprinkles snapshot, sprinkle update,
local user echo). **Do NOT wire `setTrayResetter` here** — the panel
terminal runs in offscreen via `RemoteTerminalView`, so Task 17's
offscreen-side `setTrayResetter` is what `host reset` actually
consults. See Step 2 for the rationale.

**Files:**

- Modify: `packages/webapp/src/ui/main.ts`
- Test: integration via manual test plan (no isolated unit test feasible — the panel boot path is too coupled)

- [ ] **Step 1: Locate `mainExtension` and the tray-config block**

  ```bash
  grep -n "mainExtension\|extensionLeaderActive\|PanelLeaderSyncProxy" packages/webapp/src/ui/main.ts | head -10
  ```

  Confirm there's a section in `mainExtension` where the panel reads tray config + currently does nothing for the leader case. If no such section exists, add the install block after the existing tray-config import / pre-conditions.

- [ ] **Step 2: Add the install/remove block**

  Inside `mainExtension`, after `sprinkleManager` and `client` are constructed (search for the existing `client.createAgentHandle()` line for the right anchor):

  ```ts
  // Extension-leader-mode panel hooks. Activation/deactivation is
  // driven by offscreen via leader-mode-changed; the proxy round-trips
  // host-reset RPCs and sends the four panel-only pushes.
  const leaderSyncProxy = new PanelLeaderSyncProxy(panelSender, panelSubscriber, {
    onLeaderModeChange: (active) => {
      if (active) installLeaderHooks();
      else removeLeaderHooks();
    },
  });

  const handleScoopSelected = (jid: string) => leaderSyncProxy.pushActiveScoop(jid);
  const handleSprinklesChanged = () => {
    const opened = new Set(sprinkleManager.opened());
    leaderSyncProxy.pushSprinklesSnapshot(
      sprinkleManager.available().map((p) => ({
        name: p.name,
        title: p.title,
        path: p.path,
        open: opened.has(p.name),
        autoOpen: p.autoOpen,
      }))
    );
  };
  const handleSprinkleUpdate = (name: string, data: unknown) =>
    leaderSyncProxy.pushSprinkleUpdate(name, data);
  const handleLocalUserMessage = (
    text: string,
    messageId: string,
    attachments?: MessageAttachment[]
  ) => leaderSyncProxy.pushUserMessageEcho(text, messageId, attachments);

  let leaderHooksInstalled = false;
  let offScoopSelected: (() => void) | null = null;
  let offSprinklesChanged: (() => void) | null = null;

  function installLeaderHooks() {
    if (leaderHooksInstalled) return;
    leaderHooksInstalled = true;

    offScoopSelected = client.onScoopSelected(handleScoopSelected);
    if (client.selectedScoopJid) handleScoopSelected(client.selectedScoopJid);

    offSprinklesChanged = sprinkleManager.onChange(handleSprinklesChanged);
    void sprinkleManager.refresh().then(handleSprinklesChanged);

    sprinkleManager.setSendToSprinkleHook(handleSprinkleUpdate);
    layout.panels.chat.setOnLocalUserMessage(handleLocalUserMessage);

    // NOTE: do NOT wire setTrayResetter here. The extension panel terminal
    // executes in offscreen via RemoteTerminalView (main.ts:622-624,
    // 869-879), so `host reset` runs the offscreen-side host-command
    // singletons — Task 17 already wires setTrayResetter there. Adding a
    // panel-side setTrayResetter would bind a different module instance
    // that the terminal shell never consults.
  }

  function removeLeaderHooks() {
    if (!leaderHooksInstalled) return;
    leaderHooksInstalled = false;
    offScoopSelected?.();
    offScoopSelected = null;
    offSprinklesChanged?.();
    offSprinklesChanged = null;
    sprinkleManager.setSendToSprinkleHook(undefined);
    layout.panels.chat.setOnLocalUserMessage(undefined);
  }

  // Boot-time: ask offscreen to re-emit its current state so popouts
  // opening AFTER offscreen activated still install hooks.
  leaderSyncProxy.requestModeState();
  ```

  Add imports (path is relative to `packages/webapp/src/ui/main.ts`):

  ```ts
  import { PanelLeaderSyncProxy } from '../../../chrome-extension/src/leader-sync-bridge.js';
  ```

  Construct `panelSender` / `panelSubscriber` using the same shape as
  `followerSprinkleSender` at `main.ts:1436-1467` (the canonical
  chrome.runtime sender + subscriber for the panel). Specifically the
  `followerSprinkleSender` is `{ send: (envelope) => chrome.runtime.sendMessage(envelope).catch(…) }`
  and the matching subscriber is built from `chrome.runtime.onMessage.addListener`.
  Copy that exact shape (rename if you want a distinct identifier) — do
  not invent your own.

  The `PanelLeaderSyncProxy` exposes the `resetTray()` method but in
  extension mode no panel-side consumer calls it (host reset goes through
  offscreen, per Task 17). It's still useful to expose for future
  panel-realm callers — leave it on the class but don't wire it from
  install/removeLeaderHooks.

- [ ] **Step 3: Format + typecheck + build**

  ```bash
  npx prettier --write packages/webapp/src/ui/main.ts
  npm run typecheck
  npm run build
  npm run build -w @slicc/chrome-extension
  ```

  Expected: all four pass.

- [ ] **Step 4: Run tests**

  ```bash
  npm run test
  ```

  Expected: no regressions.

- [ ] **Step 5: Commit**

  ```bash
  git add -u
  git commit -m "feat(webapp): extension-leader panel hooks in mainExtension (#682)

  Installs PanelLeaderSyncProxy + the four push handlers (active scoop,
  sprinkles snapshot, sprinkle update, local user echo) when offscreen
  signals leader-mode active. Handles named so removeLeaderHooks can
  actually unsubscribe. Boot-time requestModeState() so detached popouts
  opening after offscreen activated still install hooks. setTrayResetter
  is NOT wired panel-side — the extension panel terminal runs in
  offscreen via RemoteTerminalView, so Task 17's offscreen-side wiring
  is authoritative.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 21: Documentation updates

Update `architecture.md` and `packages/chrome-extension/CLAUDE.md` to reflect the now-functional extension-leader.

**Files:**

- Modify: `docs/architecture.md`
- Modify: `packages/chrome-extension/CLAUDE.md`

- [ ] **Step 1: Update `architecture.md:370-371` extension-leader row**

  Find:

  ```
  | Extension leader            | `packages/chrome-extension/src/offscreen.ts` (`workerBaseUrl` branch in `syncTrayRuntime`)          | Uses `ServiceWorkerLeaderTraySocket` …
  ```

  Replace with a description that points to `extension-leader-tray.ts` and notes that the workerBaseUrl branch in offscreen.ts now delegates to that factory. Also remove any wording that implied sync was unwired (it's now functional).

- [ ] **Step 2: Add a "Tray leader" subsection to `packages/chrome-extension/CLAUDE.md`**

  Under the "Three-Layer Architecture" section, add:

  ```markdown
  ### Tray leader

  When the user configures a worker base URL with no join URL, offscreen
  becomes a tray leader via `extension-leader-tray.ts:startExtensionLeaderTray`.
  Mirror of `page-leader-tray.ts` for the offscreen runtime.

  - Constructs `LeaderSyncManager` with data-source callbacks against
    `OffscreenBridge` state.
  - `LeaderTrayPeerManager.onPeerConnected → sync.addFollower(...)` (the
    revision-3 gap fix for #682).
  - `webhook.event` control messages route directly to
    `orchestrator.handleWebhookEvent` (no `lick-webhook-event` hop —
    lickManager is in-process).
  - Panel-side `PanelLeaderSyncProxy` pushes sprinkle snapshots, sprinkle
    updates, user-message echoes, and active-scoop selection. Lifecycle
    via `leader-mode-changed`; `host reset` via `leader-tray-reset` RPC.
  ```

- [ ] **Step 3: Run prettier on docs**

  ```bash
  npx prettier --write docs/architecture.md packages/chrome-extension/CLAUDE.md
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add -u
  git commit -m "docs: extension-leader tray sync is now functional (#682)

  Updates architecture.md row and adds a 'Tray leader' subsection to
  the chrome-extension CLAUDE.md describing the offscreen leader
  factory + panel↔offscreen leader bridge.

  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
  ```

---

### Task 22: Full CI gate + manual verification

Run the complete CI gate the repo uses. Then drive the 13-step manual test plan from the spec.

- [ ] **Step 1: Run all CI gates including coverage**

  ```bash
  npx prettier --check .
  npm run typecheck
  npm run test
  npm run test:coverage:chrome-extension
  npm run build
  npm run build -w @slicc/chrome-extension
  ```

  Expected: all six pass. The `test:coverage:chrome-extension` gate
  enforces the 55/55/60/45 floors documented in root `CLAUDE.md` —
  most #682 additions land in `packages/chrome-extension/` so this
  is the gate most likely to bite. Run it locally before pushing.

- [ ] **Step 2: Manual test 1 — Boot extension as leader**

  ```bash
  SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension
  rm -rf /tmp/slicc-ext-build && cp -r dist/extension /tmp/slicc-ext-build
  # Launch Chrome for Testing per packages/chrome-extension/CLAUDE.md "Local QA" recipe.
  ```

  In the extension side panel, paste a tray worker URL (no join URL). Confirm: panel terminal `host` shows leader status active and reports the tray join URL.

- [ ] **Step 3: Manual test 2 — Standalone follower joins**

  In a separate window: `npm run dev` and open the standalone webapp. Paste the tray join URL. Verify the follower receives: initial snapshot, scoops list, sprinkles list.

- [ ] **Step 4: Manual test 3 — Leader chat → follower agent stream**

  Type a message in the **leader** chat. Verify the follower sees the user message live + agent stream tokens.

- [ ] **Step 5: Manual test 4 — Sprinkle send from panel terminal**

  In the leader's panel terminal: `sprinkle send welcome '{"action":"test"}'`. Verify the follower's welcome sprinkle receives the update.

- [ ] **Step 6: Manual test 5 — Sprinkle send via agent bash**

  Have the leader's agent send to a sprinkle via its bash tool. Verify the follower's sprinkle receives the update (different code path through the sprinkle proxy).

- [ ] **Step 7: Manual test 6 — Follower-side sprinkle click**

  Click a sprinkle on the **follower**. Verify the leader's lick router fires (cone receives a `sprinkle` channel message).

- [ ] **Step 8: Manual test 7 — Follower message → leader panel echo + multi-follower rebroadcast**

  Open a SECOND standalone follower against the same tray. Type a message on follower 1. Verify:
  - Leader's cone receives it.
  - Leader's panel chat shows the user message explicitly (regression check for the `notifyPanelIncomingMessage` fix).
  - Follower 2 also sees the user message (multi-follower rebroadcast).

- [ ] **Step 9: Manual test 8 — Sub-scoop selection**

  Switch the leader to a sub-scoop in the panel. Verify the follower's `scoops.list` updates with the new active scoop AND subsequent agent events reach the follower with the correct `scoopJid` on the wire. (TS follower has no scoop switcher UI; this validates protocol correctness only.)

- [ ] **Step 10: Manual test 9 — Webhook event**

  ```bash
  curl -X POST "<worker base>/webhook/<trayId>/<webhookId>" -d '{"hello":"world"}'
  ```

  Verify the leader's cone receives a `webhook` lick.

- [ ] **Step 11: Manual test 10 — Leader → follower mode switch**

  Paste a join URL into the leader's settings while connected. Verify:
  - Leader mode deactivates.
  - Follower mode activates.
  - No zombie WebSocket / data channel / interval / agent-event subscription / leader hub listener.

- [ ] **Step 12: Manual test 11 — Panel `host reset`**

  While the leader is connected, in the panel terminal: `host reset`. Verify the tray clears and re-starts; the already-connected follower re-handshakes with the new tray id.

- [ ] **Step 13: AgentEvent wire diff (open question #1 from spec)**

  Capture standalone-leader and extension-leader `agent.event` payloads under the same 3-turn scenario (text reply, tool call, error). Diff them. If the synthesized stream omits a field the protocol consumer relies on, extend `OffscreenBridge.fanOutAgentEvent` or fall back to a custom wire shape — see spec open question #1.

  Record the diff result in the PR description.

- [ ] **Step 14: Final commit + push**

  ```bash
  git status   # confirm clean
  git push -u origin fix/extension-leader-sync-682
  ```

  Open the PR with a body that summarizes the gap, the architecture, and the manual test results. Link to the spec.

---

## Self-Review

After writing the plan, the following spec sections must all be covered:

- §1 OffscreenBridge.onAgentEvent → **Task 8**
- §2 leader-sync-bridge.ts → **Tasks 9, 10**
- §3 message types → **Task 3**
- §4 extension-leader-tray.ts → **Tasks 11–18**
- §5 OffscreenBridge additions → **Tasks 4, 5, 6, 7**
- §6 main.ts panel-side wiring → **Task 20**
- §6a host reset → **Tasks 10 (PanelLeaderSyncProxy.resetTray RPC, unused by extension panel terminal but kept for future panel-realm callers) + 17 (factory-side setTrayResetter + listener — this is what the extension panel terminal actually invokes via the offscreen-resident host-command singleton)**
- §7 SprinkleManager.onChange → **Task 1**
- §8 Lifecycle → **Tasks 17, 18, 20**
- Tests → covered per task
- Manual test plan → **Task 22**
- Docs → **Task 21**

Open question #1 (turn_end / AgentEvent diff) — explicitly tracked in **Task 22 Step 13**.
Open question #2 (watcher coalescing) — covered by **Task 1 Step 1**'s coalesce assertion + manual sprinkle install during integration.
Open question #3 (`onScoopSelected` single mutation site) — verification in **Task 2 Step 1**.

All complete.
