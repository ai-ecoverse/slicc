# Follower Lick Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward follower-observed `navigate` (handoff) licks to the leader's agent with a leader-stamped origin, and surface that origin on the leader's sprinkle licks too — so the handoff feature works for extension and standalone followers instead of dying in a phantom local cone.

**Architecture:** `LickManager.emitEvent` becomes a true single dispatch chokepoint with an optional forwarder. On a follower, forwardable licks (`navigate`) ship over a new generic `lick` tray message; the leader validates, scrubs, and stamps origin from the connection it already holds, then routes through its own `lickManager.emitEvent` → the shared `formatLickEventForCone`. Extension installs the forwarder directly on the offscreen `lickManager`; standalone bridges the worker's `lickManager` to the page's `FollowerSyncManager` over the kernel `MessageChannel`. Sprinkle licks keep their existing forward path; only the leader-side formatter is unified to render origin.

**Tech Stack:** TypeScript, Vitest (`fake-indexeddb/auto`, hand-rolled `FakeChannel` mocks), WebRTC data channels (`TraySyncChannel`), Chrome MV3 offscreen document, DedicatedWorker (kernel worker) over `MessageChannel`.

---

## Spec

`docs/superpowers/specs/2026-05-29-follower-lick-forwarding-design.md`. Decisions locked: cover **extension + standalone** followers; **leader-side unification only** (no follower-side sprinkle→emitEvent migration); origin = opaque `originFollowerId` + readable `originLabel`; keep legacy `sprinkle.lick` (defer iOS); forward failure = log and drop.

## Phase layout

- **Phase 1** — core lick primitives (`lick-manager.ts`, `lick-formatting.ts`). Float-agnostic.
- **Phase 2** — tray protocol + sync managers (`tray-sync-protocol.ts`, `tray-follower-sync.ts`, `tray-leader-sync.ts`).
- **Phase 3** — extension wiring (`offscreen.ts`, `extension-leader-tray.ts`).
- **Phase 4** — standalone worker↔page bridge (`messages.ts`, `offscreen-client.ts`, `offscreen-bridge.ts`, `page-follower-tray.ts`, `main.ts`).
- **Phase 5** — sprinkle origin display (leader-side formatter unification).
- **Phase 6** — docs + full verification.

Phases 1–3 deliver the working navigate fix for the most-exposed float (extension). Phase 4 extends it to standalone. Phase 5 is the sprinkle-origin polish.

**Prerequisite:** establish a clean baseline before starting — `npm run test` from the worktree root. Record pass/fail counts; the one known-flaky `remote-cache.test.ts` timing test may fail and is unrelated.

**Reminder:** the husky pre-commit hook is not executable in this worktree, so it will NOT auto-format. Run `npx prettier --write <changed files>` before every commit (CI runs `prettier --check .`).

---

## Phase 1 — Core lick primitives

### Task 1: `LickManager` dispatch chokepoint + forwarder + forwardable set

**Files:**

- Modify: `packages/webapp/src/scoops/lick-manager.ts`
- Test: `packages/webapp/tests/scoops/lick-manager.test.ts` (create)

Current `LickEvent` is `packages/webapp/src/scoops/lick-manager.ts:35-55`; `emitEvent` at `:104-108`; the webhook handler's direct `this.eventHandler?.(event)` at `:197`; the cron scheduler's at `:324`. There is no constructor (field initializers at `:61-65`). No `lick-manager.test.ts` exists today; create one.

- [ ] **Step 1: Write the failing test**

Create `packages/webapp/tests/scoops/lick-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  LickManager,
  FORWARDABLE_TO_LEADER,
  type LickEvent,
} from '../../src/scoops/lick-manager.js';

// Every LickEvent type must be classified so a future 8th type can't
// silently regress. `sprinkle` forwards via its own dedicated path
// (`sprinkle.lick`), so it is neither in FORWARDABLE_TO_LEADER nor local.
const SPRINKLE_DEDICATED: ReadonlySet<LickEvent['type']> = new Set(['sprinkle']);
const LOCAL_ONLY: ReadonlySet<LickEvent['type']> = new Set([
  'webhook',
  'cron',
  'fswatch',
  'session-reload',
  'upgrade',
]);
// Compile-time guard: keep this array in sync with the LickEvent union.
const ALL_LICK_TYPES: LickEvent['type'][] = [
  'webhook',
  'cron',
  'sprinkle',
  'fswatch',
  'session-reload',
  'navigate',
  'upgrade',
];
const _exhaustive: Record<LickEvent['type'], true> = {
  webhook: true,
  cron: true,
  sprinkle: true,
  fswatch: true,
  'session-reload': true,
  navigate: true,
  upgrade: true,
};
void _exhaustive;

function navEvent(): LickEvent {
  return { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
}

describe('LickManager forwarder dispatch', () => {
  let manager: LickManager;
  beforeEach(() => {
    manager = new LickManager();
  });

  it('classifies every lick type as forwardable, sprinkle-dedicated, or local', () => {
    for (const t of ALL_LICK_TYPES) {
      const classified =
        FORWARDABLE_TO_LEADER.has(t) || SPRINKLE_DEDICATED.has(t) || LOCAL_ONLY.has(t);
      expect(classified, `type "${t}" is unclassified`).toBe(true);
    }
    expect([...FORWARDABLE_TO_LEADER]).toEqual(['navigate']);
  });

  it('emitEvent forwards a forwardable lick and skips the local handler', () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);

    manager.emitEvent(navEvent());

    expect(forwarder).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('emitEvent runs the local handler for a non-forwardable lick even with a forwarder', () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);

    manager.emitEvent({ type: 'session-reload', timestamp: 't', body: {} });

    expect(forwarder).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('emitEvent runs the local handler when no forwarder is installed (leader/standalone)', () => {
    const handler = vi.fn();
    manager.setEventHandler(handler);

    manager.emitEvent(navEvent());

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('clearing the forwarder restores local handling', () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);
    manager.setForwarder(null);

    manager.emitEvent(navEvent());

    expect(forwarder).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('webhook events go to the local handler, never the forwarder', async () => {
    const handler = vi.fn();
    const forwarder = vi.fn();
    manager.setEventHandler(handler);
    manager.setForwarder(forwarder);

    await manager.createWebhook('hook1', 'cone');
    const created = manager.getLicksForScoop('cone', 'cone').webhooks[0];
    await manager.handleWebhookEvent(created.id, {}, { ok: true });

    expect(forwarder).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tests/scoops/lick-manager.test.ts`
Expected: FAIL — `FORWARDABLE_TO_LEADER` / `setForwarder` not exported / not a function.

- [ ] **Step 3: Add the origin fields, the forwardable set, the forwarder, and the dispatch chokepoint**

In `packages/webapp/src/scoops/lick-manager.ts`, add two optional fields to the `LickEvent` interface (after `targetScoop?: string;` at `:51`):

```ts
  targetScoop?: string;
  /**
   * Set ONLY by the leader when it re-emits a lick forwarded from a
   * follower. `originFollowerId` is the follower's bootstrapId (reserved
   * for future per-follower response routing); `originLabel` is a
   * human-readable source ("extension follower", "iOS follower", …)
   * surfaced to the agent by `formatLickEventForCone`.
   */
  originFollowerId?: string;
  originLabel?: string;
```

Add the forwardable set just after the `LickEventHandler` type (`:57`):

```ts
export type LickEventHandler = (event: LickEvent) => void;

/**
 * Lick types that an `emitEvent`-emitting follower forwards to the
 * leader's agent (and that the leader accepts on the generic `lick`
 * tray message). `navigate` is the only such type today. `sprinkle`
 * also belongs to the leader's agent but forwards via its own
 * dedicated `sprinkle.lick` path, so it is intentionally NOT here.
 */
export const FORWARDABLE_TO_LEADER: ReadonlySet<LickEvent['type']> = new Set<LickEvent['type']>([
  'navigate',
]);
```

Add the forwarder field next to the other private fields (`:65`):

```ts
  private eventHandler: LickEventHandler | null = null;
  private forwarder: ((event: LickEvent) => void) | null = null;
```

Add `setForwarder` next to `setEventHandler` (`:99-102`):

```ts
  /** Set the handler for lick events */
  setEventHandler(handler: LickEventHandler): void {
    this.eventHandler = handler;
  }

  /**
   * Install a forwarder (follower mode) or clear it (leader/standalone,
   * pass `null`). When set, forwardable lick types are shipped to the
   * leader via the forwarder instead of running the local handler.
   */
  setForwarder(forwarder: ((event: LickEvent) => void) | null): void {
    this.forwarder = forwarder;
  }

  /**
   * Single dispatch chokepoint. Every emit site (emitEvent, webhook,
   * cron) routes through here so the forwarder gate is consistent.
   */
  private dispatch(event: LickEvent): void {
    if (this.forwarder && FORWARDABLE_TO_LEADER.has(event.type)) {
      this.forwarder(event);
      return;
    }
    this.eventHandler?.(event);
  }
```

Change `emitEvent` (`:104-108`) to call `dispatch`:

```ts
  /** Emit an externally-generated lick event (e.g., from fswatch). */
  emitEvent(event: LickEvent): void {
    log.info('External lick event', { type: event.type, target: event.targetScoop });
    this.dispatch(event);
  }
```

Change the webhook direct call at `:197` from `this.eventHandler?.(event);` to:

```ts
this.dispatch(event);
```

Change the cron direct call at `:324` from `this.eventHandler?.(event);` to:

```ts
this.dispatch(event);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @slicc/webapp -- tests/scoops/lick-manager.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/webapp/src/scoops/lick-manager.ts packages/webapp/tests/scoops/lick-manager.test.ts
git add packages/webapp/src/scoops/lick-manager.ts packages/webapp/tests/scoops/lick-manager.test.ts
git commit -m "feat(licks): add LickManager forwarder dispatch chokepoint + origin fields"
```

---

### Task 2: `formatLickEventForCone` renders `originLabel`

**Files:**

- Modify: `packages/webapp/src/scoops/lick-formatting.ts:119-123`
- Test: `packages/webapp/tests/scoops/lick-formatting.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/lick-formatting.test.ts` inside the existing `describe('formatLickEventForCone', …)`:

```ts
it('prefixes a forwarded origin label when present', () => {
  const event = {
    type: 'navigate',
    navigateUrl: 'https://example.com',
    timestamp: '2026-05-29T00:00:00Z',
    body: { url: 'https://example.com', verb: 'upskill' },
    originFollowerId: 'b1',
    originLabel: 'extension follower',
  } as unknown as LickEvent;
  const out = formatLickEventForCone(event);
  expect(out).not.toBeNull();
  expect(out!.content).toContain('Forwarded from extension follower');
  expect(out!.content).toContain('[Navigate Event: https://example.com]');
});

it('omits the origin prefix when no originLabel is set', () => {
  const event = {
    type: 'navigate',
    navigateUrl: 'https://example.com',
    timestamp: '2026-05-29T00:00:00Z',
    body: {},
  } as unknown as LickEvent;
  const out = formatLickEventForCone(event);
  expect(out!.content).not.toContain('Forwarded from');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tests/scoops/lick-formatting.test.ts`
Expected: FAIL — content lacks "Forwarded from".

- [ ] **Step 3: Render the origin prefix in the generic fallback**

In `packages/webapp/src/scoops/lick-formatting.ts`, replace the generic fallback return (`:119-123`):

```ts
// Generic fallback: webhook / sprinkle / fswatch / navigate / cron.
const origin = event.originLabel ? `_Forwarded from ${event.originLabel}._\n\n` : '';
return {
  label,
  content: `${origin}[${label}: ${eventName}]\n\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @slicc/webapp -- tests/scoops/lick-formatting.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/webapp/src/scoops/lick-formatting.ts packages/webapp/tests/scoops/lick-formatting.test.ts
git add packages/webapp/src/scoops/lick-formatting.ts packages/webapp/tests/scoops/lick-formatting.test.ts
git commit -m "feat(licks): render forwarded-follower origin label in formatLickEventForCone"
```

---

## Phase 2 — Tray protocol + sync managers

### Task 3: Generic `lick` message on the follower→leader wire

**Files:**

- Modify: `packages/webapp/src/scoops/tray-sync-protocol.ts` (imports `:24-29`; `FollowerToLeaderMessage` `:93-132`)
- Test: `packages/webapp/tests/scoops/tray-sync-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-sync-protocol.test.ts`:

```ts
it('round-trips a generic lick message follower→leader', () => {
  const dc = new FakeSyncDataChannel();
  const sync = new TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage>(dc);
  sync.send({
    type: 'lick',
    event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
  });
  expect(JSON.parse(dc.sent[0])).toEqual({
    type: 'lick',
    event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-sync-protocol.test.ts`
Expected: FAIL — `{ type: 'lick' }` not assignable to `FollowerToLeaderMessage` (TS compile error in the test).

- [ ] **Step 3: Add the `lick` member + import `LickEvent`**

In `packages/webapp/src/scoops/tray-sync-protocol.ts`, add the type import after `:27`:

```ts
import { createLogger } from '../core/logger.js';
import type { LickEvent } from './lick-manager.js';
```

Add the member to `FollowerToLeaderMessage` (right after the `sprinkle.lick` member, `:105`):

```ts
  | {
      type: 'sprinkle.lick';
      sprinkleName: string;
      body: unknown;
      targetScoop?: string;
    }
  | { type: 'lick'; event: LickEvent }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-sync-protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/webapp/src/scoops/tray-sync-protocol.ts packages/webapp/tests/scoops/tray-sync-protocol.test.ts
git add packages/webapp/src/scoops/tray-sync-protocol.ts packages/webapp/tests/scoops/tray-sync-protocol.test.ts
git commit -m "feat(tray): add generic follower->leader lick message"
```

---

### Task 4: `FollowerSyncManager.forwardLick` + drop-on-closed-channel

**Files:**

- Modify: `packages/webapp/src/scoops/tray-follower-sync.ts` (imports near top; `sendSprinkleLick` `:415-418`)
- Test: `packages/webapp/tests/scoops/tray-follower-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-follower-sync.test.ts`:

```ts
it('forwardLick sends a generic lick to the leader and returns true', () => {
  const channel = new FakeChannel();
  const follower = new FollowerSyncManager(channel);
  const ok = follower.forwardLick({
    type: 'navigate',
    navigateUrl: 'https://x',
    timestamp: 't',
    body: { v: 1 },
  });
  expect(ok).toBe(true);
  expect(channel.parseSent()).toEqual([
    {
      type: 'lick',
      event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
    },
  ]);
});

it('forwardLick returns false and sends nothing when the channel is closed', () => {
  const channel = new FakeChannel();
  const follower = new FollowerSyncManager(channel);
  channel.close();
  const ok = follower.forwardLick({
    type: 'navigate',
    navigateUrl: 'https://x',
    timestamp: 't',
    body: {},
  });
  expect(ok).toBe(false);
  expect(channel.sent).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-follower-sync.test.ts`
Expected: FAIL — `forwardLick` is not a function.

- [ ] **Step 3: Add `forwardLick` and harden `sendSprinkleLick`**

In `packages/webapp/src/scoops/tray-follower-sync.ts`, ensure `LickEvent` is imported (add to the existing type imports near the top):

```ts
import type { LickEvent } from './lick-manager.js';
```

Replace `sendSprinkleLick` (`:415-418`) and add `forwardLick` beside it:

```ts
  /** Forward a sprinkle lick (from a follower-rendered sprinkle) to the leader. */
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void {
    const ok = this.sync.send({ type: 'sprinkle.lick', sprinkleName, body, targetScoop });
    if (!ok) log.warn('sendSprinkleLick dropped: tray channel closed', { sprinkleName });
  }

  /**
   * Forward a generic lick (e.g. `navigate`) to the leader's agent.
   * Returns false (and drops) if the channel is closed/failed — never
   * falls back to local handling (that is the phantom-cone bug).
   */
  forwardLick(event: LickEvent): boolean {
    const ok = this.sync.send({ type: 'lick', event });
    if (!ok) log.warn('forwardLick dropped: tray channel closed', { type: event.type });
    return ok;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-follower-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/webapp/src/scoops/tray-follower-sync.ts packages/webapp/tests/scoops/tray-follower-sync.test.ts
git add packages/webapp/src/scoops/tray-follower-sync.ts packages/webapp/tests/scoops/tray-follower-sync.test.ts
git commit -m "feat(tray): FollowerSyncManager.forwardLick with drop-on-closed-channel"
```

---

### Task 5: `FloatType` gains `ios` + `labelForFollower` helper

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts:67-77`
- Test: `packages/webapp/tests/scoops/tray-leader-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-leader-sync.test.ts` (import `labelForFollower` from the module — add it to the existing import block at `:4-7`):

```ts
import {
  LeaderSyncManager,
  labelForFollower,
  type LeaderSyncManagerOptions,
} from '../../src/scoops/tray-leader-sync.js';
```

```ts
describe('labelForFollower', () => {
  it('maps known float types to readable labels', () => {
    expect(labelForFollower('extension')).toBe('extension follower');
    expect(labelForFollower('standalone')).toBe('standalone follower');
    expect(labelForFollower('electron')).toBe('Electron follower');
    expect(labelForFollower('ios')).toBe('iOS follower');
  });
  it('falls back to the raw runtime string for unknown', () => {
    expect(labelForFollower('unknown', 'slicc-weird')).toBe('follower (slicc-weird)');
    expect(labelForFollower('unknown')).toBe('follower');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-leader-sync.test.ts`
Expected: FAIL — `labelForFollower` not exported; `'ios'` not assignable to `FloatType`.

- [ ] **Step 3: Add `ios` to the union, the derive case, and the label helper**

In `packages/webapp/src/scoops/tray-leader-sync.ts`, replace `:67-77`:

```ts
/** Derived float type from the runtime string (e.g. 'slicc-standalone' → 'standalone'). */
export type FloatType = 'standalone' | 'extension' | 'electron' | 'ios' | 'unknown';

/** Derive a FloatType from the follower's runtime string. */
function deriveFloatType(runtime?: string): FloatType {
  if (!runtime) return 'unknown';
  if (runtime.includes('ios')) return 'ios';
  if (runtime.includes('standalone')) return 'standalone';
  if (runtime.includes('extension')) return 'extension';
  if (runtime.includes('electron')) return 'electron';
  return 'unknown';
}

/** Human-readable origin label for a forwarded lick, for the agent. */
export function labelForFollower(floatType: FloatType, runtime?: string): string {
  switch (floatType) {
    case 'extension':
      return 'extension follower';
    case 'standalone':
      return 'standalone follower';
    case 'electron':
      return 'Electron follower';
    case 'ios':
      return 'iOS follower';
    default:
      return runtime ? `follower (${runtime})` : 'follower';
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-leader-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
npx prettier --write packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/tests/scoops/tray-leader-sync.test.ts
git add packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/tests/scoops/tray-leader-sync.test.ts
git commit -m "feat(tray): FloatType ios case + labelForFollower helper"
```

---

### Task 6: Leader `onForwardedLick` option + inbound `lick` handler (validate, scrub, stamp)

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts` (`LeaderSyncManagerOptions` `:36-65`; `handleFollowerMessage` `:564`; imports)
- Test: `packages/webapp/tests/scoops/tray-leader-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-leader-sync.test.ts`:

```ts
describe('inbound generic lick', () => {
  it('stamps origin from the connection and calls onForwardedLick', () => {
    const onForwardedLick = vi.fn();
    const { manager } = createManager({ onForwardedLick });
    const channel = new FakeChannel();
    manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

    channel.simulateMessage({
      type: 'lick',
      event: { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: { v: 1 } },
    });

    expect(onForwardedLick).toHaveBeenCalledTimes(1);
    const [event, bootstrapId] = onForwardedLick.mock.calls[0];
    expect(bootstrapId).toBe('b1');
    expect(event).toMatchObject({
      type: 'navigate',
      originFollowerId: 'b1',
      originLabel: 'extension follower',
    });
  });

  it('rejects a non-forwardable lick type', () => {
    const onForwardedLick = vi.fn();
    const { manager } = createManager({ onForwardedLick });
    const channel = new FakeChannel();
    manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

    channel.simulateMessage({
      type: 'lick',
      event: { type: 'webhook', timestamp: 't', body: {} },
    } as unknown as FollowerToLeaderMessage);

    expect(onForwardedLick).not.toHaveBeenCalled();
  });

  it('scrubs follower-sent origin fields before stamping', () => {
    const onForwardedLick = vi.fn();
    const { manager } = createManager({ onForwardedLick });
    const channel = new FakeChannel();
    manager.addFollower('b1', channel, { runtime: 'slicc-extension-offscreen' });

    channel.simulateMessage({
      type: 'lick',
      event: {
        type: 'navigate',
        navigateUrl: 'https://x',
        timestamp: 't',
        body: {},
        originFollowerId: 'SPOOFED',
        originLabel: 'SPOOFED',
      },
    } as unknown as FollowerToLeaderMessage);

    const [event] = onForwardedLick.mock.calls[0];
    expect(event.originFollowerId).toBe('b1');
    expect(event.originLabel).toBe('extension follower');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-leader-sync.test.ts`
Expected: FAIL — `onForwardedLick` not a known option; no `lick` case handled.

- [ ] **Step 3: Add imports, the option, and the inbound case**

In `packages/webapp/src/scoops/tray-leader-sync.ts`, add the import (near the other `./` imports):

```ts
import { FORWARDABLE_TO_LEADER, type LickEvent } from './lick-manager.js';
```

Add the option to `LeaderSyncManagerOptions` (after `onSprinkleLick`, `:50`):

```ts
  /** Forward a sprinkle lick (from a follower's open or inline sprinkle) to the leader's lick router. */
  onSprinkleLick?: (sprinkleName: string, body: unknown, targetScoop?: string) => void;
  /**
   * Handle a generic lick (e.g. `navigate`) forwarded by a follower.
   * The event arrives already validated, scrubbed, and stamped with
   * `originFollowerId`/`originLabel`. Adapters route it into the
   * leader's `lickManager.emitEvent`.
   */
  onForwardedLick?: (event: LickEvent, originBootstrapId: string) => void;
```

Add the `case 'lick'` to `handleFollowerMessage` (after the `sprinkle.lick` case, `:617`):

```ts
      case 'lick': {
        const incoming = message.event;
        if (!FORWARDABLE_TO_LEADER.has(incoming.type)) {
          log.warn('Rejecting non-forwardable lick from follower', {
            bootstrapId,
            type: incoming.type,
          });
          break;
        }
        const follower = this.followers.get(bootstrapId);
        // Strip any follower-sent origin fields — the leader is the sole
        // authority on origin.
        const { originFollowerId: _o1, originLabel: _o2, ...rest } = incoming;
        const stamped: LickEvent = {
          ...rest,
          originFollowerId: bootstrapId,
          originLabel: labelForFollower(follower?.floatType ?? 'unknown', follower?.runtime),
        };
        try {
          this.options.onForwardedLick?.(stamped, bootstrapId);
        } catch (err) {
          log.warn('onForwardedLick handler threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-leader-sync.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, format, commit**

```bash
npm run typecheck
npx prettier --write packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/tests/scoops/tray-leader-sync.test.ts
git add packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/tests/scoops/tray-leader-sync.test.ts
git commit -m "feat(tray): leader inbound lick handler — validate, scrub, stamp origin"
```

---

## Phase 3 — Extension wiring

### Task 7: Install/clear the forwarder on the extension follower's offscreen `lickManager`

**Files:**

- Modify: `packages/chrome-extension/src/offscreen.ts` (`detachSync` `:291-305`; after `bridge.setFollowerSync(sync)` `:426`)

`lickManager` is in scope from the `:124` destructure; `sync` is local to `onConnected`. This is glue with no unit harness (offscreen boot can't be unit-tested cheaply) — verified by Phase-3 manual QA below.

- [ ] **Step 1: Add the forwarder install on connect**

In `packages/chrome-extension/src/offscreen.ts`, immediately after `bridge.setFollowerSync(sync);` (`:426`), add:

```ts
bridge.setFollowerSync(sync);
// Follower mode: forwardable licks (navigate/handoff) observed
// locally must go to the LEADER's agent, not this follower's
// (model-less or invisible) local cone. The LickManager dispatch
// chokepoint ships them over the data channel.
lickManager.setForwarder((event) => sync.forwardLick(event));
```

- [ ] **Step 2: Clear the forwarder on detach**

In `detachSync` (`:300-304`), add the clear alongside `bridge.setFollowerSync(null)`:

```ts
if (!activeSync) return;
bridge.setFollowerSync(null);
lickManager.setForwarder(null);
browser.setTrayTargetProvider(null);
activeSync.close();
activeSync = null;
```

- [ ] **Step 3: Typecheck + build the extension**

Run: `npm run typecheck && npm run build -w @slicc/chrome-extension`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/chrome-extension/src/offscreen.ts
git add packages/chrome-extension/src/offscreen.ts
git commit -m "feat(ext): extension follower forwards navigate licks to the leader"
```

---

### Task 8: Wire the extension leader's `onForwardedLick` → `lickManager.emitEvent`

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts` (`StartExtensionLeaderTrayOptions` `:101-118`; destructure `:123`; `syncOptions` `:143-242`)
- Modify: `packages/chrome-extension/src/offscreen.ts:478-486` (pass `lickManager`)
- Test: `packages/chrome-extension/tests/extension-leader-tray.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/chrome-extension/tests/extension-leader-tray.test.ts` (the `startWithCapture` helper at `:80` captures `LeaderSyncManagerOptions` via `_onSyncOptions`):

```ts
it('onForwardedLick emits the event into the provided lickManager', () => {
  const emitEvent = vi.fn();
  const { options } = startWithCapture({ lickManager: { emitEvent } as any });
  const event = {
    type: 'navigate',
    navigateUrl: 'https://x',
    timestamp: 't',
    body: {},
    originFollowerId: 'b1',
    originLabel: 'standalone follower',
  };
  options.onForwardedLick!(event as any, 'b1');
  expect(emitEvent).toHaveBeenCalledWith(event);
});
```

In `startWithCapture` (`:80`), add a default `lickManager` to the `startExtensionLeaderTray({...})` call so existing tests keep compiling:

```ts
      log: console as any,
      lickManager: overrides.lickManager ?? ({ emitEvent: vi.fn() } as any),
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/chrome-extension -- tests/extension-leader-tray.test.ts`
Expected: FAIL — `lickManager` not a known option; `onForwardedLick` undefined.

- [ ] **Step 3: Add `lickManager` to options and wire `onForwardedLick`**

In `packages/chrome-extension/src/extension-leader-tray.ts`, add the import (near the top, alongside the other webapp imports):

```ts
import type { LickManager } from '../../webapp/src/scoops/lick-manager.js';
```

Add to `StartExtensionLeaderTrayOptions` (`:101-118`):

```ts
log: Logger;
leaderBridge: OffscreenLeaderSyncBridgeHandle;
/** Offscreen LickManager — used to route follower-forwarded licks into the leader's cone. */
lickManager: LickManager;
```

Add `lickManager` to the destructure (`:123`):

```ts
const { workerBaseUrl, bridge, orchestrator, sharedFs, browser, leaderBridge, lickManager } =
  options;
```

Add `onForwardedLick` to `syncOptions` (right after the `onSprinkleLick` block, `:179`):

```ts
    onForwardedLick: (event) => {
      // Leader-side: route the forwarded lick through our own LickManager
      // so it hits defaultLickEventHandler → formatLickEventForCone (with
      // the stamped origin label) → the cone.
      lickManager.emitEvent(event);
    },
```

In `packages/chrome-extension/src/offscreen.ts`, add `lickManager` to the `startExtensionLeaderTray({...})` call (`:478-486`):

```ts
activeHandle = startExtensionLeaderTray({
  workerBaseUrl: trayRuntimeConfig.workerBaseUrl,
  bridge,
  orchestrator,
  sharedFs: host.sharedFs ?? null,
  browser,
  log,
  leaderBridge,
  lickManager,
});
```

- [ ] **Step 4: Run the test + typecheck + build**

Run: `npm run test -w @slicc/chrome-extension -- tests/extension-leader-tray.test.ts && npm run typecheck && npm run build -w @slicc/chrome-extension`
Expected: PASS + both succeed.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/chrome-extension/src/extension-leader-tray.ts packages/chrome-extension/src/offscreen.ts packages/chrome-extension/tests/extension-leader-tray.test.ts
git add packages/chrome-extension/src/extension-leader-tray.ts packages/chrome-extension/src/offscreen.ts packages/chrome-extension/tests/extension-leader-tray.test.ts
git commit -m "feat(ext): leader routes forwarded follower licks into its cone"
```

**Phase 3 manual QA (extension):** Build with `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension`, run the Chrome-for-Testing recipe in `packages/chrome-extension/CLAUDE.md`. With one instance as leader and the extension as follower (paste join URL), browse the follower to a URL that returns the SLICC handoff `Link` header; confirm the handoff approval card appears in the **leader's** cone reading "Forwarded from extension follower", and that Accept runs the action on the leader.

---

## Phase 4 — Standalone worker↔page bridge

In standalone, the navigate lick fires in the kernel **worker**'s `lickManager`, while `FollowerSyncManager` (follower) and `LeaderSyncManager` (leader) live on the **page**. Three new kernel-transport messages bridge them. The worker-side dispatcher is `OffscreenBridge.handlePanelMessage` (shared by extension offscreen + standalone worker); the page side is `OffscreenClient`.

### Task 9: Declare the three bridge messages

**Files:**

- Modify: `packages/chrome-extension/src/messages.ts` (`PanelToOffscreenMessage` union `:447`; `OffscreenToPanelMessage` union `~:486`)

> **Import watch-point:** `messages.ts` uses a structural mirror (`SprinkleSummaryEnvelope`) because it cannot import `tray-sync-protocol.ts` under the worker tsconfig. If a type-only `import type { LickEvent } from '../../webapp/src/scoops/lick-manager.js'` fails the `@slicc/chrome-extension` typecheck the same way, define a local structural mirror instead: `type ForwardedLickEvent = { type: string; timestamp: string; body: unknown; [k: string]: unknown };` and use it in the three message interfaces below. Try the real import first.

- [ ] **Step 1: Add the message interfaces + union members**

In `packages/chrome-extension/src/messages.ts`, add the type import near the top (try the real import first; fall back to the structural mirror per the watch-point):

```ts
import type { LickEvent } from '../../webapp/src/scoops/lick-manager.js';
```

Add three interfaces near the other panel/offscreen message interfaces:

```ts
/** Page→worker (standalone follower): toggle the worker LickManager's forwarder. */
export interface SetFollowerForwardingMsg {
  type: 'set-follower-forwarding';
  enabled: boolean;
}

/** Page→worker (standalone leader): inject a follower-forwarded lick into the worker LickManager. */
export interface InjectForwardedLickMsg {
  type: 'inject-forwarded-lick';
  event: LickEvent;
}

/** Worker→page (standalone follower): a forwardable lick the page must relay to the leader. */
export interface ForwardLickMsg {
  type: 'forward-lick';
  event: LickEvent;
}
```

Add `SetFollowerForwardingMsg` and `InjectForwardedLickMsg` to the `PanelToOffscreenMessage` union (`:447`), and `ForwardLickMsg` to the `OffscreenToPanelMessage` union (`~:486`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: succeeds (or apply the structural-mirror fallback if the `LickEvent` import is rejected, then re-run).

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/chrome-extension/src/messages.ts
git add packages/chrome-extension/src/messages.ts
git commit -m "feat(kernel-bridge): declare set-follower-forwarding / inject-forwarded-lick / forward-lick messages"
```

---

### Task 10: `OffscreenClient` send methods + inbound `forward-lick` handler

**Files:**

- Modify: `packages/webapp/src/ui/offscreen-client.ts` (`sendSprinkleLick`/`sendWebhookEvent` `:374-397`; `handleOffscreenMessage` `:427-514`; private fields)
- Test: `packages/webapp/tests/ui/offscreen-client.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/ui/offscreen-client.test.ts`:

```ts
it('sendSetFollowerForwarding posts the toggle to the worker', () => {
  client.sendSetFollowerForwarding(true);
  const env = sentMessages.at(-1) as { source: string; payload: any };
  expect(env.source).toBe('panel');
  expect(env.payload).toEqual({ type: 'set-follower-forwarding', enabled: true });
});

it('sendForwardedLick posts the event to the worker', () => {
  const event = { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
  client.sendForwardedLick(event as any);
  const env = sentMessages.at(-1) as { source: string; payload: any };
  expect(env.payload).toEqual({ type: 'inject-forwarded-lick', event });
});

it('dispatches inbound forward-lick to the registered handler', () => {
  const handler = vi.fn();
  client.setForwardLickHandler(handler);
  const event = { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
  simulateMessage('offscreen', { type: 'forward-lick', event });
  expect(handler).toHaveBeenCalledWith(event);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tests/ui/offscreen-client.test.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Add the methods, the handler field, and the inbound case**

In `packages/webapp/src/ui/offscreen-client.ts`, add the type import near the top:

```ts
import type { LickEvent } from '../scoops/lick-manager.js';
import type { ForwardLickMsg } from '../../../chrome-extension/src/messages.js';
```

> If the cross-package `ForwardLickMsg` import trips the webapp tsconfig boundary, inline the cast instead: `(msg as { type: 'forward-lick'; event: LickEvent })`.

Add a private field near the other handler fields (e.g. next to `sprinkleOpHandler`, `:371`):

```ts
  private forwardLickHandler: ((event: LickEvent) => void) | null = null;
```

Add the methods next to `sendSprinkleLick`/`sendWebhookEvent` (`:374-397`):

```ts
  /** Standalone follower: tell the worker to forward (or stop forwarding) licks. */
  sendSetFollowerForwarding(enabled: boolean): void {
    this.send({ type: 'set-follower-forwarding', enabled } as PanelToOffscreenMessage);
  }

  /** Standalone leader: inject a follower-forwarded lick into the worker's LickManager. */
  sendForwardedLick(event: LickEvent): void {
    this.send({ type: 'inject-forwarded-lick', event } as PanelToOffscreenMessage);
  }

  /** Register the page-side handler the worker's forward-lick messages dispatch into. */
  setForwardLickHandler(handler: ((event: LickEvent) => void) | null): void {
    this.forwardLickHandler = handler;
  }
```

Add the inbound `case 'forward-lick'` to `handleOffscreenMessage` (`:427`):

```ts
      case 'forward-lick':
        this.forwardLickHandler?.((msg as ForwardLickMsg).event);
        break;
```

- [ ] **Step 4: Run the test + typecheck**

Run: `npm run test -w @slicc/webapp -- tests/ui/offscreen-client.test.ts && npm run typecheck`
Expected: PASS + typecheck succeeds.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/offscreen-client.ts packages/webapp/tests/ui/offscreen-client.test.ts
git add packages/webapp/src/ui/offscreen-client.ts packages/webapp/tests/ui/offscreen-client.test.ts
git commit -m "feat(kernel-bridge): OffscreenClient forward-lick send + inbound handler"
```

---

### Task 11: Worker dispatcher cases in `OffscreenBridge.handlePanelMessage`

**Files:**

- Modify: `packages/chrome-extension/src/offscreen-bridge.ts` (`handlePanelMessage` switch `:1053`; `emit` `:1332`)
- Test: `packages/chrome-extension/tests/offscreen-bridge.test.ts`

The bridge holds no `lickManager`; reach it via `globalThis.__slicc_lickManager` (published in `host.ts:360`), matching how shell commands reach it.

- [ ] **Step 1: Write the failing test**

Add to `packages/chrome-extension/tests/offscreen-bridge.test.ts` a `describe` that stubs the global LickManager and drives `handlePanelMessage` (the existing tests call `await (bridge as any).handlePanelMessage(msg)` after `bridge.bind(mockOrchestrator)`):

```ts
describe('OffscreenBridge follower-forwarding bridge', () => {
  let bridge: InstanceType<typeof OffscreenBridge>;
  let setForwarder: ReturnType<typeof vi.fn>;
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    sentMessages.length = 0;
    messageListeners.length = 0;
    vi.clearAllMocks();
    setForwarder = vi.fn();
    emitEvent = vi.fn();
    (globalThis as any).__slicc_lickManager = { setForwarder, emitEvent };
    bridge = new OffscreenBridge();
    await bridge.bind({
      getScoops: vi.fn(() => []),
      handleMessage: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  it('set-follower-forwarding(true) installs a forwarder that emits forward-lick to the page', async () => {
    const emitSpy = vi.spyOn(bridge as any, 'emit');
    await (bridge as any).handlePanelMessage({ type: 'set-follower-forwarding', enabled: true });
    expect(setForwarder).toHaveBeenCalledTimes(1);
    const fwd = setForwarder.mock.calls[0][0] as (e: unknown) => void;
    const event = { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
    fwd(event);
    expect(emitSpy).toHaveBeenCalledWith({ type: 'forward-lick', event });
  });

  it('set-follower-forwarding(false) clears the forwarder', async () => {
    await (bridge as any).handlePanelMessage({ type: 'set-follower-forwarding', enabled: false });
    expect(setForwarder).toHaveBeenCalledWith(null);
  });

  it('inject-forwarded-lick emits the event into the worker LickManager', async () => {
    const event = { type: 'navigate', navigateUrl: 'https://x', timestamp: 't', body: {} };
    await (bridge as any).handlePanelMessage({ type: 'inject-forwarded-lick', event });
    expect(emitEvent).toHaveBeenCalledWith(event);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/chrome-extension -- tests/offscreen-bridge.test.ts`
Expected: FAIL — cases unhandled (no `setForwarder`/`emitEvent` calls).

- [ ] **Step 3: Add the two cases**

In `packages/chrome-extension/src/offscreen-bridge.ts`, add to the `handlePanelMessage` switch (after the `lick-webhook-event` case, `:1239`):

```ts
      case 'set-follower-forwarding': {
        // Standalone follower: install/clear a forwarder on the worker's
        // LickManager that relays forwardable licks to the page, which
        // hands them to the FollowerSyncManager. Extension never sends
        // this (it installs the forwarder directly in offscreen.ts).
        const lm = (globalThis as Record<string, unknown>).__slicc_lickManager as
          | { setForwarder(fn: ((e: LickEvent) => void) | null): void }
          | undefined;
        if (!lm) break;
        if (msg.enabled) {
          lm.setForwarder((event) => this.emit({ type: 'forward-lick', event }));
        } else {
          lm.setForwarder(null);
        }
        break;
      }
      case 'inject-forwarded-lick': {
        // Standalone leader: route a follower-forwarded lick into the
        // worker's LickManager (→ defaultLickEventHandler → cone).
        const lm = (globalThis as Record<string, unknown>).__slicc_lickManager as
          | { emitEvent(e: LickEvent): void }
          | undefined;
        lm?.emitEvent(msg.event);
        break;
      }
```

Add the type import near the top of the file:

```ts
import type { LickEvent } from '../../webapp/src/scoops/lick-manager.js';
```

> If `this.emit(...)` is typed to only accept the existing `OffscreenToPanelMessage` members, the `ForwardLickMsg` addition from Task 9 already widens that union — confirm `emit` accepts it; if `emit` has a narrower local type, cast: `this.emit({ type: 'forward-lick', event } as OffscreenToPanelMessage)`.

- [ ] **Step 4: Run the test + typecheck + build**

Run: `npm run test -w @slicc/chrome-extension -- tests/offscreen-bridge.test.ts && npm run typecheck && npm run build -w @slicc/chrome-extension`
Expected: PASS + both succeed.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
git add packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
git commit -m "feat(kernel-bridge): worker handles set-follower-forwarding + inject-forwarded-lick"
```

---

### Task 12: Standalone follower — toggle forwarding + relay forward-lick to the leader

**Files:**

- Modify: `packages/webapp/src/ui/page-follower-tray.ts` (`StartPageFollowerTrayOptions` `:46-110`; `wireFollowerSync` near `:228`; `detachSync` `:144-157`)
- Modify: `packages/webapp/src/ui/main.ts` (follower start `:2842-2868` AND the hot-join site `:2961-2978`; register the forward-lick handler once near the `client` setup)
- Test: `packages/webapp/tests/ui/page-follower-tray.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/ui/page-follower-tray.test.ts` (this file only exercises the options surface — assert the new option is accepted and the handle still behaves):

```ts
it('accepts an onForwardingToggle option without throwing', () => {
  const toggle = vi.fn();
  const opts = { ...makeBaseOptions(), onForwardingToggle: toggle };
  const handle = startPageFollowerTray(opts);
  try {
    expect(handle.currentSync).toBeNull();
  } finally {
    handle.stop();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tests/ui/page-follower-tray.test.ts`
Expected: FAIL — `onForwardingToggle` not in `StartPageFollowerTrayOptions` (TS error).

- [ ] **Step 3: Add the option and call it on connect/detach**

In `packages/webapp/src/ui/page-follower-tray.ts`, add to `StartPageFollowerTrayOptions` (`:46-110`):

```ts
  /**
   * Called with `true` once a follower connection is live and `false`
   * on detach/stop. Standalone wires this to
   * `client.sendSetFollowerForwarding(enabled)` so the kernel worker
   * forwards navigate licks while connected.
   */
  onForwardingToggle?: (enabled: boolean) => void;
```

In the connect path, right after `activeSync = sync;` / `options.setChatAgent(sync);` (`~:228-231`):

```ts
activeSync = sync;
options.setChatAgent(sync);
options.onForwardingToggle?.(true);
```

In `detachSync` (`:144-157`), before clearing `activeSync`:

```ts
options.onForwardingToggle?.(false);
```

In `packages/webapp/src/ui/main.ts`, register the forward-lick handler once, right after `client = host.client;` (`~:2014`):

```ts
client.setForwardLickHandler((event) => {
  const sync = pageFollowerTray?.currentSync;
  if (sync) sync.forwardLick(event);
  else log.warn('forward-lick dropped: no active follower sync');
});
```

Add `onForwardingToggle` to **both** `startPageFollowerTray({...})` calls — the boot site (`:2843`) and the hot-join site (`:2961`):

```ts
        removeSprinkle: (name) => layout.removeSprinkle(name),
        onForwardingToggle: (enabled) => client.sendSetFollowerForwarding(enabled),
      });
```

> The `:2954-2960` comment warns the two follower-start sites must stay in sync — add the option to both or hot-join diverges from boot.

- [ ] **Step 4: Run the test + typecheck + build**

Run: `npm run test -w @slicc/webapp -- tests/ui/page-follower-tray.test.ts && npm run typecheck && npm run build -w @slicc/webapp`
Expected: PASS + both succeed.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/page-follower-tray.ts packages/webapp/src/ui/main.ts packages/webapp/tests/ui/page-follower-tray.test.ts
git add packages/webapp/src/ui/page-follower-tray.ts packages/webapp/src/ui/main.ts packages/webapp/tests/ui/page-follower-tray.test.ts
git commit -m "feat(standalone): follower toggles worker forwarding + relays forward-lick to leader"
```

---

### Task 13: Standalone leader — wire `onForwardedLick` → worker `lickManager`

**Files:**

- Modify: `packages/webapp/src/ui/main.ts` (`buildLeaderTrayOptions` `:2541-2600`)
- Modify: `packages/webapp/src/ui/page-leader-tray.ts` (`StartPageLeaderTrayOptions` — add `onForwardedLick`, forward it into the `LeaderSyncManager` options)

`buildLeaderTrayOptions` already wires `onSprinkleLick: (…) => client.sendSprinkleLick(…)`; mirror it for the generic lick.

- [ ] **Step 1: Thread `onForwardedLick` through `StartPageLeaderTrayOptions`**

In `packages/webapp/src/ui/page-leader-tray.ts`, add to `StartPageLeaderTrayOptions` (next to `onSprinkleLick`):

```ts
  onForwardedLick?: (event: LickEvent, originBootstrapId: string) => void;
```

Add the type import:

```ts
import type { LickEvent } from '../scoops/lick-manager.js';
```

Where it constructs the `LeaderSyncManager` options object, pass it through (next to `onSprinkleLick`):

```ts
    onForwardedLick: options.onForwardedLick,
```

- [ ] **Step 2: Wire it in `buildLeaderTrayOptions`**

In `packages/webapp/src/ui/main.ts`, add to the object returned by `buildLeaderTrayOptions` (right after the `onSprinkleLick` line, `:2575`):

```ts
    onSprinkleLick: (sprinkleName: string, body: unknown, targetScoop?: string) =>
      client.sendSprinkleLick(sprinkleName, body, targetScoop),
    onForwardedLick: (event) => client.sendForwardedLick(event),
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build -w @slicc/webapp`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/webapp/src/ui/main.ts packages/webapp/src/ui/page-leader-tray.ts
git add packages/webapp/src/ui/main.ts packages/webapp/src/ui/page-leader-tray.ts
git commit -m "feat(standalone): leader routes forwarded follower licks into the worker cone"
```

**Phase 4 manual QA (standalone):** Run two standalone instances (`npm run dev` and `PORT=5720 npm run dev`). Make one a leader (enable multi-browser sync) and join the other as a follower via the join URL. In the follower's agent-driven Chrome, navigate to a handoff-`Link` URL; confirm the approval card appears in the leader's cone with "Forwarded from standalone follower".

---

## Phase 5 — Sprinkle origin display (leader-side formatter unification)

Sprinkle licks already forward; this phase makes the leader render their origin and unifies the leader's sprinkle content on `formatLickEventForCone` (resolving review finding F5). `routeSprinkleLick` keeps its panel-buffer bookkeeping; only its content-builder changes.

### Task 14: Thread `originLabel` through `onSprinkleLick` → `routeSprinkleLick`

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts` (`onSprinkleLick` option `:50`; `sprinkle.lick` case `:605-617`)
- Modify: `packages/chrome-extension/src/offscreen-bridge.ts` (`routeSprinkleLick` `:673-714`)
- Modify: `packages/chrome-extension/src/extension-leader-tray.ts` (`onSprinkleLick` wiring `:171-179`)
- Modify: `packages/chrome-extension/src/messages.ts` (`SprinkleLickMsg` — add `originLabel`)
- Modify: `packages/webapp/src/ui/offscreen-client.ts` (`sendSprinkleLick` — add `originLabel`)
- Modify: `packages/webapp/src/ui/main.ts` (`buildLeaderTrayOptions.onSprinkleLick` — pass `originLabel`)
- Test: `packages/webapp/tests/scoops/tray-leader-sync.test.ts`, `packages/chrome-extension/tests/offscreen-bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/webapp/tests/scoops/tray-leader-sync.test.ts`, update the existing `sprinkle.lick` test (`:2022`) to expect the stamped label as a 4th arg:

```ts
it('sprinkle.lick invokes onSprinkleLick with name, body, targetScoop, and origin label', () => {
  const onSprinkleLick = vi.fn();
  const { manager } = createManager({ onSprinkleLick });
  const channel = new FakeChannel();
  manager.addFollower('b1', channel, { runtime: 'slicc-ios' });

  channel.simulateMessage({
    type: 'sprinkle.lick',
    sprinkleName: 'welcome',
    body: { action: 'click' },
    targetScoop: 'scoop-1',
  });

  expect(onSprinkleLick).toHaveBeenCalledWith(
    'welcome',
    { action: 'click' },
    'scoop-1',
    'iOS follower'
  );
});
```

In `packages/chrome-extension/tests/offscreen-bridge.test.ts`, add to the `routeSprinkleLick` describe (`:1131`):

```ts
it('includes the forwarded origin label in the lick content', async () => {
  await bridge.routeSprinkleLick('welcome', { action: 'go' }, 'helper', 'iOS follower');
  expect(mockOrchestrator.handleMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining('Forwarded from iOS follower'),
    })
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-leader-sync.test.ts && npm run test -w @slicc/chrome-extension -- tests/offscreen-bridge.test.ts`
Expected: both FAIL.

- [ ] **Step 3: Add the `originLabel` param end-to-end**

In `packages/webapp/src/scoops/tray-leader-sync.ts`, widen the option signature (`:50`):

```ts
  onSprinkleLick?: (
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    originLabel?: string
  ) => void;
```

Update the `sprinkle.lick` case to stamp and pass the label (`:605-617`):

```ts
      case 'sprinkle.lick': {
        log.info('Follower sprinkle lick received', {
          bootstrapId,
          sprinkleName: message.sprinkleName,
        });
        const follower = this.followers.get(bootstrapId);
        const originLabel = labelForFollower(follower?.floatType ?? 'unknown', follower?.runtime);
        try {
          this.options.onSprinkleLick?.(
            message.sprinkleName,
            message.body,
            message.targetScoop,
            originLabel
          );
        } catch (err) {
          log.warn('onSprinkleLick handler threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      }
```

In `packages/chrome-extension/src/offscreen-bridge.ts`, update `routeSprinkleLick` (`:673-714`) to accept `originLabel` and build content via the shared formatter. Add the import:

```ts
import { formatLickEventForCone } from '../../webapp/src/scoops/lick-formatting.js';
```

Replace the signature and the `content` line:

```ts
  async routeSprinkleLick(
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    originLabel?: string
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
    if (!target) {
      target = scoops.find((s) => s.isCone);
    }
    if (!target) return;
    const msgId = `sprinkle-${sprinkleName}-${Date.now()}`;
    const formatted = formatLickEventForCone({
      type: 'sprinkle',
      sprinkleName,
      timestamp: new Date().toISOString(),
      body,
      originLabel,
    } as LickEvent);
    const content =
      formatted?.content ??
      `[Sprinkle Event: ${sprinkleName}]\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``;
```

(Leave the rest of `routeSprinkleLick` — the `ChannelMessage` build, the buffer push, `persistScoop`, `handleMessage` — unchanged.) Add the `LickEvent` type import if not already present from Task 11.

In `packages/chrome-extension/src/extension-leader-tray.ts`, update the `onSprinkleLick` wiring (`:171-179`) to forward the label:

```ts
    onSprinkleLick: (name, body, targetScoop, originLabel) => {
      void bridge.routeSprinkleLick(name, body, targetScoop, originLabel).catch((err) => {
        options.log.error('routeSprinkleLick failed', {
          name,
          targetScoop,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
```

In `packages/chrome-extension/src/messages.ts`, add `originLabel?: string;` to the `SprinkleLickMsg` interface (the `sprinkle-lick` message).

In `packages/webapp/src/ui/offscreen-client.ts`, widen `sendSprinkleLick` (`:374-381`):

```ts
  sendSprinkleLick(
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    originLabel?: string
  ): void {
    this.send({
      type: 'sprinkle-lick',
      sprinkleName,
      body,
      targetScoop,
      originLabel,
    } as PanelToOffscreenMessage);
  }
```

In `packages/chrome-extension/src/offscreen-bridge.ts`, update the `sprinkle-lick` panel-message case (`:1223-1230`) to pass the label through:

```ts
      case 'sprinkle-lick': {
        const lickMsg = msg as any;
        await this.routeSprinkleLick(
          lickMsg.sprinkleName,
          lickMsg.body,
          lickMsg.targetScoop,
          lickMsg.originLabel
        );
        break;
      }
```

In `packages/webapp/src/ui/main.ts`, update `buildLeaderTrayOptions.onSprinkleLick` (`:2574`):

```ts
    onSprinkleLick: (sprinkleName: string, body: unknown, targetScoop?: string, originLabel?: string) =>
      client.sendSprinkleLick(sprinkleName, body, targetScoop, originLabel),
```

- [ ] **Step 4: Run the tests + typecheck + builds**

Run: `npm run test -w @slicc/webapp -- tests/scoops/tray-leader-sync.test.ts && npm run test -w @slicc/chrome-extension -- tests/offscreen-bridge.test.ts && npm run typecheck && npm run build -w @slicc/webapp && npm run build -w @slicc/chrome-extension`
Expected: PASS + all succeed.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/scoops/tray-leader-sync.ts packages/chrome-extension/src/offscreen-bridge.ts packages/chrome-extension/src/extension-leader-tray.ts packages/chrome-extension/src/messages.ts packages/webapp/src/ui/offscreen-client.ts packages/webapp/src/ui/main.ts packages/webapp/tests/scoops/tray-leader-sync.test.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
git add -A
git commit -m "feat(licks): leader renders origin on forwarded sprinkle licks via shared formatter"
```

---

## Phase 6 — Docs + full verification

### Task 15: Documentation

**Files:**

- Modify: root `CLAUDE.md` (Licks / Tray addendum — note the generic `lick` message + leader-stamped origin)
- Modify: `packages/webapp/CLAUDE.md` (Tray Sync section — `forwardLick`, `onForwardedLick`, the worker↔page forward-lick bridge)
- Modify: `packages/chrome-extension/CLAUDE.md` (offscreen follower forwarder install + leader `onForwardedLick`)
- Modify: `docs/architecture.md` (Multi-Browser Sync matrix — add the `lick` message row, follower-origin stamping, and the standalone worker→page bridge)
- Modify: `packages/ios-app/CLAUDE.md` (note: iOS sprinkle licks now show origin via leader-side stamping; generic-`lick` migration remains a follow-up)

- [ ] **Step 1: Update each doc** with 2–4 sentences in the relevant section. Keep the wire-format detail in `docs/architecture.md`; keep `CLAUDE.md` entries navigation-level.

- [ ] **Step 2: Format and commit**

```bash
npx prettier --write CLAUDE.md packages/webapp/CLAUDE.md packages/chrome-extension/CLAUDE.md docs/architecture.md packages/ios-app/CLAUDE.md
git add CLAUDE.md packages/webapp/CLAUDE.md packages/chrome-extension/CLAUDE.md docs/architecture.md packages/ios-app/CLAUDE.md
git commit -m "docs: follower lick forwarding (generic lick message + leader origin stamping)"
```

### Task 16: Full verification gate

- [ ] **Step 1: Run the complete gate**

```bash
npx prettier --check .
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: all pass. The known-flaky `remote-cache.test.ts:20` timing test may fail; confirm it is the only failure and unrelated.

- [ ] **Step 2: If coverage dropped below a floor**, add focused tests to the package that regressed (per the floors in root `CLAUDE.md`) and re-run `npm run test:coverage`.

- [ ] **Step 3: Final commit** (only if Step 2 added tests)

```bash
npx prettier --write <new test files>
git add <new test files>
git commit -m "test: restore coverage floor for follower lick forwarding"
```

---

## Follow-ups

Items deferred to avoid test infrastructure sprawl or production changes for testability:

- **`onForwardingToggle` connect/detach test** — `page-follower-tray.ts` calls `onForwardingToggle(true)` on successful follower connection and `onForwardingToggle(false)` on detach/stop. Testing this edge requires driving a live WebRTC connection through `startFollowerWithAutoReconnect`, which in turn requires mocking the full tray-webrtc/signaling/RTCPeerConnection stack. No clean injection seam exists (the existing `_fetchImpl`/`_sleep` hooks prevent connection, not simulate it). Adding a test hook to production code for this single assertion was deemed overkill; deferred pending a live-connection test harness.
- **`main.ts` forward-lick handler composition** — The glue in `main.ts` that sets `client.setForwardLickHandler((event) => pageFollowerTray?.currentSync?.forwardLick(event))` is untested. Testing it requires mocking `mainStandaloneWorker` internals. Not refactored for testability per guardrails.

## Self-review notes (for the implementer)

- **Cross-package imports** (`LickEvent` into `messages.ts`; `ForwardLickMsg` into `offscreen-client.ts`; `formatLickEventForCone` into `offscreen-bridge.ts`) are the highest-risk typecheck points. Each task flags a structural-mirror or inline-cast fallback. Run `npm run typecheck` after Tasks 9–11 specifically.
- **Two follower-start sites** in `main.ts` (`:2843` boot, `:2961` hot-join) must both get `onForwardingToggle` (Task 12) or hot-join silently won't forward.
- **`emit` union widening:** Task 9 adds `ForwardLickMsg` to `OffscreenToPanelMessage`; Task 11's `this.emit({ type: 'forward-lick', … })` depends on that — do Task 9 first.
- **Sprinkle buffer bookkeeping:** Task 14 changes only `routeSprinkleLick`'s content string source, never its `getBuffer`/`persistScoop`/`handleMessage` calls — preserving panel display behavior.
