# `slicc-shader` Energy Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `<slicc-shader>` WebGL background from burning ~44% GPU-process CPU while idle by giving it a frame budget (15 fps ambient, 800 ms full-rate bursts on interaction), a true static stop, and a DPR-1 default resolution cap.

**Architecture:** Extract pure frame-gating logic into a new DOM-free module (`frame-budget.ts`), then restructure the component's scheduler from an unconditional rAF loop into a single `#wake()` entry point plus a self-terminating tick. Resolution cap becomes a reflected `dpr` attribute. Same component serves every float (leader tab, side-panel follower), so one fix covers all.

**Tech Stack:** Vanilla web components (`@slicc/webcomponents` conventions), WebGL1, Vitest browser mode (real Chromium via Playwright).

**Spec:** `docs/superpowers/specs/2026-08-19-shader-energy-budget.md` (read it first — it carries the measured evidence, the design rationale, and the rejected alternatives).

## Global Constraints

- Work in this worktree on branch `worktree-shader-energy-budget` (already created; `npm install` and `npx playwright install chromium` already run; baseline `slicc-shader.test.ts` = 29/29 green).
- Node >= 22.18.0.
- Relative imports MUST carry `.js` (`./frame-budget.js`) — NodeNext, tsc-enforced, including in tests.
- No `innerHTML` (lint-gated); build DOM via `internal/dom.ts` helpers — not relevant here but do not regress.
- The scheduler must stay `requestAnimationFrame`-based. NEVER schedule frames with `setTimeout`/`setInterval`: the leader tab is throttle-exempt (open WebRTC), so timers fire at full rate even when the page is hidden; rAF is the only scheduler that pauses with visibility.
- Run `npx prettier --write <touched files>` before EVERY commit (CI rejects unformatted code).
- Linear history — no merge commits. Do not hand-edit `dist/`.
- No "Added in PR #NNN" breadcrumbs in any `CLAUDE.md`.
- Test command for one file: `npm run test -w @slicc/webcomponents -- tests/freezer/<name>.test.ts` (browser mode, real Chromium; behavioral timing assertions must keep the wide margins written below — do not tighten them, CI runners are slow).

---

### Task 1: `frame-budget.ts` pure module

**Files:**

- Create: `packages/webcomponents/src/freezer/frame-budget.ts`
- Test: `packages/webcomponents/tests/freezer/frame-budget.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (Task 2 imports these exact names from `./frame-budget.js`):
  - `AMBIENT_FPS: 15`, `AMBIENT_FRAME_MS: number`, `BURST_MS: 800`, `FRAME_EPSILON_MS: 4`
  - `shouldRender(nowTs: number, lastFrameTs: number, energetic: boolean): boolean`
  - `advanceFrameTs(nowTs: number, lastFrameTs: number, energetic: boolean): number`

- [ ] **Step 1: Write the failing test**

Create `packages/webcomponents/tests/freezer/frame-budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  advanceFrameTs,
  AMBIENT_FPS,
  AMBIENT_FRAME_MS,
  BURST_MS,
  FRAME_EPSILON_MS,
  shouldRender,
} from '../../src/freezer/frame-budget.js';

/** Simulate a rAF host ticking at `hz` for `seconds`, counting admitted frames. */
function simulate(hz: number, seconds: number, energetic: boolean): number {
  let last = Number.NEGATIVE_INFINITY;
  let renders = 0;
  const ticks = Math.floor(hz * seconds);
  for (let i = 0; i < ticks; i++) {
    const now = i * (1000 / hz);
    if (shouldRender(now, last, energetic)) {
      last = advanceFrameTs(now, last, energetic);
      renders++;
    }
  }
  return renders;
}

describe('frame-budget', () => {
  it('exposes the tuned constants', () => {
    expect(AMBIENT_FPS).toBe(15);
    expect(AMBIENT_FRAME_MS).toBeCloseTo(1000 / 15, 5);
    expect(BURST_MS).toBe(800);
    expect(FRAME_EPSILON_MS).toBe(4);
  });

  it('admits ~15 fps from a 60 Hz host', () => {
    const renders = simulate(60, 1, false);
    expect(renders).toBeGreaterThanOrEqual(14);
    expect(renders).toBeLessThanOrEqual(16);
  });

  it('admits ~15 fps from a 120 Hz host (epsilon absorbs jitter)', () => {
    const renders = simulate(120, 1, false);
    expect(renders).toBeGreaterThanOrEqual(14);
    expect(renders).toBeLessThanOrEqual(16);
  });

  it('admits every frame while energetic', () => {
    expect(simulate(60, 1, true)).toBe(60);
  });

  it('always admits the first frame', () => {
    expect(shouldRender(0, Number.NEGATIVE_INFINITY, false)).toBe(true);
  });

  it('advances on the ambient grid to avoid drift', () => {
    // Render at t=0, then a jittery tick at 68ms: the grid advance keeps the
    // next deadline anchored at 66.67+66.67, not 68+66.67.
    const afterFirst = advanceFrameTs(0, Number.NEGATIVE_INFINITY, false);
    expect(afterFirst).toBe(0);
    const afterSecond = advanceFrameTs(68, afterFirst, false);
    expect(afterSecond).toBeCloseTo(AMBIENT_FRAME_MS, 5);
  });

  it('snaps to now after a long stall instead of fast-forwarding', () => {
    // Hidden tab for 5s: one frame on resume, no catch-up burst.
    expect(advanceFrameTs(5000, 0, false)).toBe(5000);
  });

  it('takes nowTs verbatim for energetic frames', () => {
    expect(advanceFrameTs(123.4, 100, true)).toBe(123.4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/frame-budget.test.ts`
Expected: FAIL — cannot resolve `../../src/freezer/frame-budget.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/webcomponents/src/freezer/frame-budget.ts`:

```ts
/**
 * Frame budget for decorative animation loops.
 *
 * Ambient decorative motion renders at AMBIENT_FPS; interactive stimuli
 * (pulse, attribute changes, theme flips, resizes) open a BURST_MS window at
 * full display rate so direct responses stay crisp. Pure and DOM-free so the
 * gating math is unit-testable without rAF timing.
 *
 * Rule of thumb (see docs/webcomponents-details.md "Animation loops"): a
 * background field whose fastest visible component is well under 1 Hz —
 * slicc-shader's is sin(t*2.7) ≈ 0.43 Hz — is ~35x oversampled at 15 fps.
 */

/** Ambient cadence for decorative fields. */
export const AMBIENT_FPS = 15;
export const AMBIENT_FRAME_MS = 1000 / AMBIENT_FPS;
/** Full-rate window opened by an interactive stimulus. */
export const BURST_MS = 800;
/**
 * Scheduling jitter allowance. Without it a 60 Hz host (16.67 ms ticks)
 * arrives just under each 66.67 ms deadline and slips a whole tick late,
 * sagging the effective rate toward 12 fps.
 */
export const FRAME_EPSILON_MS = 4;

/**
 * Decide whether a rAF tick at `nowTs` should render. `energetic` means a
 * burst window is open or pulse energy is still decaying.
 */
export function shouldRender(nowTs: number, lastFrameTs: number, energetic: boolean): boolean {
  if (energetic) return true;
  return nowTs - lastFrameTs >= AMBIENT_FRAME_MS - FRAME_EPSILON_MS;
}

/**
 * Advance the last-frame timestamp after a render. Ambient frames advance on
 * the 15 fps grid (keeps the long-run average exactly at budget despite rAF
 * jitter); a stall of more than one interval (hidden tab) snaps to `nowTs` so
 * resume does not fast-forward. Energetic frames and the first frame
 * (lastFrameTs = -Infinity) take `nowTs` verbatim.
 */
export function advanceFrameTs(nowTs: number, lastFrameTs: number, energetic: boolean): number {
  if (energetic || !Number.isFinite(lastFrameTs)) return nowTs;
  const gridNext = lastFrameTs + AMBIENT_FRAME_MS;
  return nowTs - gridNext > AMBIENT_FRAME_MS ? nowTs : gridNext;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/frame-budget.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webcomponents/src/freezer/frame-budget.ts packages/webcomponents/tests/freezer/frame-budget.test.ts
git add packages/webcomponents/src/freezer/frame-budget.ts packages/webcomponents/tests/freezer/frame-budget.test.ts
git commit -m "feat(webcomponents): pure frame-budget gating for decorative animation loops"
```

---

### Task 2: Scheduler restructure in `slicc-shader.ts`

**Files:**

- Modify: `packages/webcomponents/src/freezer/slicc-shader.ts`
- Test: `packages/webcomponents/tests/freezer/slicc-shader.test.ts` (append; do not modify the 29 existing tests)

**Interfaces:**

- Consumes: `shouldRender`, `advanceFrameTs`, `BURST_MS` from `./frame-budget.js` (Task 1).
- Produces: unchanged public API. Behavioral contract for Task 3/4: every stimulus routes through the private `#wake(opts?: { burst?: boolean })`; the tick self-terminates when `#reduced || (!#isAnimated() && #energy === 0)`.

- [ ] **Step 1: Write the failing behavioral tests**

Append to `packages/webcomponents/tests/freezer/slicc-shader.test.ts` (inside the top-level `describe('slicc-shader', ...)` block, after the last existing `it`). The file already imports `vi` from vitest and defines `mount()`:

```ts
describe('frame budget', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Count WebGL draw calls from the moment of installation. */
  const spyDraws = () => vi.spyOn(WebGLRenderingContext.prototype, 'drawArrays');

  afterEach(() => vi.restoreAllMocks());

  it('renders ambient motion on the 15fps budget, not at display rate', async () => {
    const el = mount({ mode: 'scoop' }); // scoop animates unconditionally
    if (el.noWebgl) return; // CSS-fallback host: nothing to measure
    await wait(50); // let the first frame land
    const spy = spyDraws();
    await wait(800);
    // 800ms at 15fps ≈ 12 draws; at display rate it would be ≈ 48+.
    // Margins are deliberately wide for slow CI runners — do not tighten.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(24);
  });

  it('cone with speed=0 renders once and stops', async () => {
    const el = mount({ speed: '0' });
    if (el.noWebgl) return;
    await wait(150); // settle: connect renders exactly one frame
    const spy = spyDraws();
    await wait(250);
    expect(spy.mock.calls.length).toBe(0);
  });

  it('an attribute change re-renders a static field', async () => {
    const el = mount({ speed: '0' });
    if (el.noWebgl) return;
    await wait(150);
    const spy = spyDraws();
    el.setAttribute('scroll', '120');
    await wait(120);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('pulse() wakes a static field and it re-stops after the energy decays', async () => {
    const el = mount({ speed: '0' });
    if (el.noWebgl) return;
    await wait(150);
    const spy = spyDraws();
    // 0.002 decays below the 0.001 rest floor in ~14 rendered frames.
    el.pulse(0.002);
    await wait(600);
    const afterDecay = spy.mock.calls.length;
    expect(afterDecay).toBeGreaterThanOrEqual(2);
    await wait(250);
    expect(spy.mock.calls.length).toBe(afterDecay);
  });
});
```

Also add `afterEach` to the existing vitest import if not present (it already imports `afterEach` — verify).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/slicc-shader.test.ts`
Expected: the 29 pre-existing tests PASS; `renders ambient motion on the 15fps budget` FAILS (count ≈ 48 > 24), `cone with speed=0 renders once and stops` FAILS (count > 0), `pulse() … re-stops` FAILS.

- [ ] **Step 3: Implement the scheduler**

All edits in `packages/webcomponents/src/freezer/slicc-shader.ts`.

**3a.** Add the import at the top (after the existing two imports):

```ts
import { advanceFrameTs, BURST_MS, shouldRender } from './frame-budget.js';
```

**3b.** Update the component docblock: replace the sentence fragment

```
 * Sits behind the app (`position: fixed; inset: 0; z-index: 0; pointer-events:
 * none`). Honors `prefers-reduced-motion` (one static frame), pauses on
 * disconnect, and falls back to a per-mode CSS gradient when WebGL is absent.
```

with

```
 * Sits behind the app (`position: fixed; inset: 0; z-index: 0; pointer-events:
 * none`). Renders on a frame budget: ambient motion at 15 fps, bursting to
 * display rate for 800 ms after an interactive stimulus (pulse, attribute /
 * theme / size changes). A static field — `cone` with `speed=0`, or
 * `prefers-reduced-motion` — renders once per stimulus and stops the loop
 * entirely. Pauses on disconnect and falls back to a per-mode CSS gradient
 * when WebGL is absent.
```

and replace the `@attr speed` line

```
 * @attr speed - 0..2 cone glass animation rate multiplier (default 0.0625)
```

with

```
 * @attr speed - 0..2 cone glass animation rate multiplier (default 0.0625;
 *   0 genuinely pauses — the field renders once per change and stops)
```

**3c.** Add scheduler state. Replace

```ts
  #raf = 0;
  #start = 0;
  #energy = 0;
```

with

```ts
  #raf = 0;
  #start = 0;
  #energy = 0;
  #lastFrameTs = Number.NEGATIVE_INFINITY;
  #burstUntil = 0;
```

**3d.** Rewire `connectedCallback`. Replace its tail

```ts
this.#start = performance.now() / 1000;
if (this.#reduced) this.#renderFrame();
else this.#startLoop();
```

with

```ts
this.#start = performance.now() / 1000;
this.#lastFrameTs = Number.NEGATIVE_INFINITY;
this.#wake();
```

**3e.** Rewire `attributeChangedCallback`. Replace the whole method body

```ts
  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    // `tint` drives the tint + event-tint uniforms. A mode change also refreshes
    // the cache because a tint-less cone uses the Caramel default.
    if (name === 'tint' || name === 'mode') this.#refreshColorUniforms();
    if (name === 'mode' && this.#gl && this.mode !== this.#builtMode) {
      // Switch to the (cached) program and repaint synchronously so the
      // previous mode's frame does not linger for a rAF — the blue flicker.
      if (this.#linkMode()) {
        this.#renderFrame();
        this.#applyFallbackBg();
        return;
      }
    }
    this.#applyFallbackBg();
    this.#renderIfStatic();
  }
```

with

```ts
  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    // `tint` drives the tint + event-tint uniforms. A mode change also refreshes
    // the cache because a tint-less cone uses the Caramel default.
    if (name === 'tint' || name === 'mode') this.#refreshColorUniforms();
    if (name === 'mode' && this.#gl && this.mode !== this.#builtMode) {
      // Switch to the (cached) program and repaint synchronously so the
      // previous mode's frame does not linger for a rAF — the blue flicker.
      if (this.#linkMode()) {
        this.#renderFrame();
        this.#lastFrameTs = performance.now();
        this.#applyFallbackBg();
        this.#wake({ burst: true });
        return;
      }
    }
    this.#applyFallbackBg();
    this.#wake({ burst: true });
  }
```

**3f.** Rewire `pulse`. Replace

```ts
  pulse(amount = 1): void {
    this.#energy = Math.min(1.4, this.#energy + amount);
    if (this.#reduced) this.#renderFrame();
  }
```

with

```ts
  pulse(amount = 1): void {
    this.#energy = Math.min(1.4, this.#energy + amount);
    this.#wake({ burst: true });
  }
```

**3g.** Delete the `#renderIfStatic` method entirely:

```ts
  #renderIfStatic(): void {
    if (this.#reduced && this.#gl) this.#renderFrame();
  }
```

**3h.** Rewire its two remaining callers. In `connectedCallback`, replace

```ts
this.#ro = new ResizeObserver(() => this.#renderIfStatic());
```

with

```ts
this.#ro = new ResizeObserver(() => this.#wake({ burst: true }));
```

In `#observeTheme`, replace

```ts
const refresh = (): void => {
  this.#refreshColorUniforms();
  this.#renderIfStatic();
};
```

with

```ts
const refresh = (): void => {
  this.#refreshColorUniforms();
  this.#wake({ burst: true });
};
```

Also update the `#observeTheme` doc comment's last sentence — replace

```
 *  A running rAF loop picks the new cache up on its next frame; reduced-motion
 *  mode repaints once via #renderIfStatic. */
```

with

```
 *  The wake below repaints promptly (burst window); a static or reduced-motion
 *  field renders exactly one frame and re-stops. */
```

**3i.** Rewire `webglcontextrestored`. Inside `#installContextHandlers`, replace

```ts
this.#start = performance.now() / 1000;
if (this.#reduced) this.#renderFrame();
else this.#startLoop();
```

with

```ts
this.#start = performance.now() / 1000;
this.#lastFrameTs = Number.NEGATIVE_INFINITY;
this.#wake();
```

**3j.** Replace `#startLoop` with the new scheduler. Replace

```ts
  #startLoop(): void {
    if (this.#raf) return;
    const tick = (): void => {
      this.#renderFrame();
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);
  }
```

with

```ts
  /** True while the field has intrinsic motion. Cone glass with `speed` 0 is
   *  genuinely static — u_speed zeroes the crack clock, the micro-wobble, and
   *  (via sign(u_speed)) the parallax — while scoop and freezer animate on
   *  u_time unconditionally. Reduced motion always reads as static. */
  #isAnimated(): boolean {
    if (this.#reduced) return false;
    if (this.mode === 'cone' && this.speed === 0) return false;
    return true;
  }

  /** Single scheduler entry point — every stimulus lands here: connect, any
   *  observed attribute change, theme flip, resize, context restore, pulse().
   *  `burst` opens a BURST_MS full-rate window so the response is crisp; the
   *  tick decides per-frame whether the budget admits a render and whether the
   *  loop keeps running at all. Batched same-microtask stimuli coalesce into
   *  the one pending rAF. */
  #wake(opts: { burst?: boolean } = {}): void {
    if (opts.burst) this.#burstUntil = performance.now() + BURST_MS;
    if (this.#raf || !this.#gl) return;
    this.#raf = requestAnimationFrame(this.#tick);
  }

  #tick = (ts: number): void => {
    this.#raf = 0;
    const energetic = ts < this.#burstUntil || this.#energy > 0;
    if (shouldRender(ts, this.#lastFrameTs, energetic)) {
      this.#lastFrameTs = advanceFrameTs(ts, this.#lastFrameTs, energetic);
      this.#renderFrame();
    }
    // Self-terminate AFTER the render so the final at-rest frame paints:
    // static fields stop dead; reduced motion never loops (one frame per wake).
    if (this.#reduced || (!this.#isAnimated() && this.#energy === 0)) return;
    this.#raf = requestAnimationFrame(this.#tick);
  };
```

`#stopLoop` stays exactly as is (still used by `disconnectedCallback` and `webglcontextlost`).

- [ ] **Step 4: Run the full shader suite**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/slicc-shader.test.ts`
Expected: PASS — all 29 pre-existing + 4 new. If `renders ambient motion` is flaky-low on your machine, the loop is over-gated (check `FRAME_EPSILON_MS` wiring); if flaky-high, bursts are leaking (check that `connectedCallback` wakes WITHOUT burst).

- [ ] **Step 5: Run the frame-budget tests and typecheck**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/frame-budget.test.ts && npm run typecheck -w @slicc/webcomponents`
Expected: PASS, no type errors (private-field arrow `#tick` requires no config change).

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/webcomponents/src/freezer/slicc-shader.ts packages/webcomponents/tests/freezer/slicc-shader.test.ts
git add packages/webcomponents/src/freezer/slicc-shader.ts packages/webcomponents/tests/freezer/slicc-shader.test.ts
git commit -m "perf(webcomponents): frame-budget the slicc-shader loop (15fps ambient, burst on interaction, true static stop)"
```

---

### Task 3: Resolution cap (`dpr` attribute, default 1)

**Files:**

- Modify: `packages/webcomponents/src/freezer/slicc-shader.ts`
- Test: `packages/webcomponents/tests/freezer/slicc-shader.test.ts` (append)

**Interfaces:**

- Consumes: `#wake({ burst: true })` from Task 2 (fires automatically via `attributeChangedCallback` — `dpr` just joins `observedAttributes`).
- Produces: reflected `dpr` attribute/property, `get dpr(): number` clamped 0.5–2, default 1.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('frame budget', ...)` block's parent describe (same level as the other `it`s):

```ts
it('caps the canvas backing store at DPR 1 by default', async () => {
  const el = mount();
  if (el.noWebgl) return;
  await frame();
  await frame();
  const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
  // 240px element; effective dpr = min(1, devicePixelRatio) — headless CI
  // runs at devicePixelRatio 1, so the cap and the floor agree on 240.
  expect(canvas.width).toBe(240);
  expect(el.dpr).toBe(1);
});

it('respects a sub-1 dpr cap and re-renders when it changes', async () => {
  const el = mount({ dpr: '0.5' });
  if (el.noWebgl) return;
  await frame();
  await frame();
  const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
  expect(canvas.width).toBe(120);
  el.setAttribute('dpr', '1');
  await frame();
  await frame();
  expect(canvas.width).toBe(240);
});

it('clamps dpr to 0.5..2 and defaults bogus values to 1', () => {
  const el = mount({ dpr: '9' });
  expect(el.dpr).toBe(2);
  el.setAttribute('dpr', '0.1');
  expect(el.dpr).toBe(0.5);
  el.setAttribute('dpr', 'nope');
  expect(el.dpr).toBe(1);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/slicc-shader.test.ts`
Expected: the three new tests FAIL (`el.dpr` undefined; default canvas width 480 on a dpr-2 host / cap ignored).

- [ ] **Step 3: Implement**

In `packages/webcomponents/src/freezer/slicc-shader.ts`:

**3a.** Replace the constant

```ts
const MAX_DPR = 2;
```

with

```ts
/** Backing-store resolution caps, in device-pixel-ratio units. The field is a
 *  background clamped to a ±20% deviation budget around the theme bg, so
 *  DPR 1 is visually indistinguishable at a quarter of DPR 2's pixel cost on
 *  Retina; showcase/hero uses can opt back up via the `dpr` attribute. */
const DEFAULT_DPR_CAP = 1;
const MIN_DPR_CAP = 0.5;
const MAX_DPR_CAP = 2;
```

**3b.** Add `'dpr'` to `observedAttributes` (after `'speed'`):

```ts
    'speed',
    'dpr',
```

**3c.** Add the accessor pair after the `speed` setter:

```ts
  /** Canvas resolution cap in device-pixel-ratio units (0.5..2, default 1). */
  get dpr(): number {
    return clampNum(
      Number.parseFloat(this.getAttribute('dpr') ?? ''),
      MIN_DPR_CAP,
      MAX_DPR_CAP,
      DEFAULT_DPR_CAP
    );
  }
  set dpr(value: number) {
    this.setAttribute('dpr', String(value));
  }
```

**3d.** Rewire `#resize`. Replace

```ts
const dpr = Math.min(MAX_DPR, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
```

with

```ts
const dpr = Math.min(this.dpr, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
```

**3e.** Add to the docblock's `@attr` list (after the `speed` line):

```
 * @attr dpr - canvas resolution cap in device-pixel-ratio units (0.5..2,
 *   default 1 — the washed background field does not need Retina density)
```

- [ ] **Step 4: Run the suite**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/slicc-shader.test.ts`
Expected: PASS (29 + 4 + 3).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webcomponents/src/freezer/slicc-shader.ts packages/webcomponents/tests/freezer/slicc-shader.test.ts
git add packages/webcomponents/src/freezer/slicc-shader.ts packages/webcomponents/tests/freezer/slicc-shader.test.ts
git commit -m "perf(webcomponents): cap slicc-shader backing store at DPR 1 with a dpr attribute escape hatch"
```

---

### Task 4: Documentation

**Files:**

- Modify: `packages/webcomponents/CLAUDE.md` (conventions bullet)
- Modify: `docs/webcomponents-details.md` ("Animation loops and forced reflow" section)
- Modify: `docs/pitfalls.md` (new section)

- [ ] **Step 1: Extend the webcomponents CLAUDE.md conventions bullet**

In `packages/webcomponents/CLAUDE.md`, replace

```
- **Animation loops must not force reflow.** A `requestAnimationFrame` loop must never read computed style/layout per frame; resolve CSS-derived values once and cache, invalidating on attribute + theme changes. Pattern: `docs/webcomponents-details.md`.
```

with

```
- **Animation loops must not force reflow — and must carry a frame budget.** A `requestAnimationFrame` loop must never read computed style/layout per frame; resolve CSS-derived values once and cache, invalidating on attribute + theme changes. Decorative/ambient loops render at `AMBIENT_FPS` (15) with an 800 ms full-rate burst on interaction, and stop entirely when the field is static (`src/freezer/frame-budget.ts` is the shared gate; `slicc-shader` is the reference consumer). Never schedule frames with timers — rAF is the only scheduler that pauses when the page hides. Pattern: `docs/webcomponents-details.md`.
```

(Char budget: the file must stay under 20,000 chars — `npm run lint:docs` enforces; this edit adds ~350.)

- [ ] **Step 2: Extend `docs/webcomponents-details.md`**

Replace the section

```
## Animation loops and forced reflow

A `requestAnimationFrame` loop must never call `getComputedStyle` or read
computed style/layout per frame — the regression that motivated this rule was
`slicc-shader` doing ~360 style recalcs/sec at 120 Hz. Resolve CSS-derived
values once and cache them; invalidate on attribute and theme changes via a
`MutationObserver` on `<html>`/`<body>` `class`/`data-theme` plus a
`prefers-color-scheme` listener, both torn down in `disconnectedCallback`.
```

with

```
## Animation loops: no forced reflow, and a frame budget

A `requestAnimationFrame` loop must never call `getComputedStyle` or read
computed style/layout per frame — the regression that motivated this rule was
`slicc-shader` doing ~360 style recalcs/sec at 120 Hz. Resolve CSS-derived
values once and cache them; invalidate on attribute and theme changes via a
`MutationObserver` on `<html>`/`<body>` `class`/`data-theme` plus a
`prefers-color-scheme` listener, both torn down in `disconnectedCallback`.

A decorative loop must also carry a **frame budget**
(`src/freezer/frame-budget.ts`): ambient motion renders at `AMBIENT_FPS` (15 —
the shader's fastest visible component is ~0.43 Hz, so this is still ~35x
oversampled), interactive stimuli (pulse, attribute/theme/size changes) open a
`BURST_MS` (800 ms) full-display-rate window, and a field with no intrinsic
motion (cone glass at `speed=0`, `prefers-reduced-motion`) renders one frame
per stimulus and stops its loop entirely. The regression that motivated THIS
rule was `slicc-shader` again: its ungated 60 fps loop burned ~44% of Chrome's
GPU process while the leader tab sat idle but visible in a background window —
rAF only pauses for *hidden* pages, and the tray's open WebRTC connection
exempts the tab from every other throttle. Never move a decorative loop to
`setTimeout`/`setInterval` for the same reason: timers keep firing in that tab
even when it IS hidden; rAF is the only scheduler that pauses with visibility.
```

- [ ] **Step 3: Add the pitfalls entry**

In `docs/pitfalls.md`, append a new section at the end of the file:

```
## Decorative rAF/WebGL Loops Must Budget Frames

**The Incident**

The `<slicc-shader>` full-viewport WebGL background ran an unconditional
`requestAnimationFrame` loop at display rate. With the thin-extension leader
tab *visible but backgrounded* (the selected tab of a partially visible
window — macOS occlusion marks a tab hidden only under 100% coverage), the
loop never paused: ~44% GPU-process CPU + ~18% renderer CPU, continuously,
while SLICC sat idle. Confirmed causal by removing the element live
(44% → 2%). Two system facts made "the browser will throttle it" false:

1. Chrome pauses rAF only for **hidden** pages — a visible-but-background
   window renders at full rate.
2. The leader tab holds an open WebRTC tray connection, which exempts it
   from timer throttling and freezing — deliberately (a frozen leader kills
   the tray), so nothing else reins a hot loop in either.

**The Rule**

Every decorative/ambient animation loop must carry a frame budget:

- Ambient cadence capped well below display rate
  (`packages/webcomponents/src/freezer/frame-budget.ts`, `AMBIENT_FPS = 15`),
  with a short full-rate burst window for interactive stimuli.
- A field with no intrinsic motion must render once per stimulus and STOP
  its loop ("paused" attributes must actually pause the draw calls, not just
  zero a uniform — `slicc-shader`'s `speed=0` originally still paid full
  per-frame shader cost).
- Stay on `requestAnimationFrame`. Timer-based scheduling
  (`setTimeout`/`setInterval`) runs at full rate in the throttle-exempt
  leader tab even when hidden.
- Full-screen fragment work should default to a reduced backing-store
  resolution (`dpr` cap 1) when it is a washed background rather than hero
  content.

**Related Files**

- `packages/webcomponents/src/freezer/frame-budget.ts` — shared gating logic
- `packages/webcomponents/src/freezer/slicc-shader.ts` — reference consumer
- `docs/webcomponents-details.md` — the companion no-reflow-per-frame rule
```

- [ ] **Step 4: Verify doc gates**

Run: `npm run lint:docs`
Expected: PASS (webcomponents `CLAUDE.md` stays under its 20,000-char cap).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webcomponents/CLAUDE.md docs/webcomponents-details.md docs/pitfalls.md
git add packages/webcomponents/CLAUDE.md docs/webcomponents-details.md docs/pitfalls.md
git commit -m "docs: frame-budget rule for decorative animation loops + shader idle-burn pitfall"
```

---

### Task 5: Full verification pass + PR

**Files:** none new — verification only.

- [ ] **Step 1: Read the verification runbook**

Read `.agents/skills/verifying-before-push/SKILL.md` and follow it. At minimum, in this order:

```bash
npm run lint:ci          # biome check WITHOUT --write — fixable organizeImports = error here
npm run deadcode         # knip — new frame-budget.ts exports must all be consumed or test-covered
npm run typecheck        # browser + node configs
npm run test             # root vitest (node projects; webcomponents excluded by design)
npm run test -w @slicc/webcomponents          # full browser-mode suite
npm run test:coverage:webcomponents           # coverage floor (coverage-thresholds.json)
npm run build            # production build, all workspaces
npm run build -w @slicc/chrome-extension      # extension build
npm run lint:docs
```

Expected: all green. Known trap: if `deadcode` flags `frame-budget.ts` exports (`AMBIENT_FPS`, `FRAME_EPSILON_MS` are consumed only by tests), keep them exported — they are part of the documented contract; add them to the knip entry allowlist ONLY if knip actually fails, and say so in the PR body.

- [ ] **Step 2: Optional live smoke (recommended)**

`npm run dev` from the worktree, open the standalone UI, and in DevTools confirm: (a) the background field still animates; (b) with the Performance monitor open, CPU settles far below the pre-fix level; (c) `document.querySelector('slicc-shader').setAttribute('speed','0')` stops draw activity entirely (Performance tab shows no recurring rAF work). Kill only processes started by this worktree (scope kills to this worktree's path/PID/port — NEVER broad `pkill -f`).

- [ ] **Step 3: Push and open the PR**

Follow `.agents/skills/verifying-before-push/SKILL.md` for push mechanics (rebase onto `origin/main` first — CI enforces linear history). PR title: `perf(webcomponents): frame-budget the slicc-shader background (idle 44% GPU → ~3%)`. PR body must link the spec/plan (they ship in this branch by repo convention — do NOT strip them; the release process purges them from main), state the measured before/after from the spec, and note that Storybook PR screenshots will re-capture the `freezer` area stories (expected: visually near-identical — CI captures at devicePixelRatio 1 where the DPR cap is a no-op).

```

```
