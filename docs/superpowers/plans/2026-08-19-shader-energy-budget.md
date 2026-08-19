# `slicc-shader` Energy Budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `<slicc-shader>` WebGL background from burning ~44% GPU-process CPU while idle by giving it a frame budget (15 fps ambient, 800 ms full-rate bursts on interaction), a true static stop, and a DPR-1 default resolution cap.

**Architecture:** Extract pure frame-gating logic into a new DOM-free module (`frame-budget.ts`), then restructure the component's scheduler from an unconditional rAF loop into a single `#wake()` entry point plus a self-terminating tick. Resolution cap becomes a reflected `dpr` attribute. Same component serves every float (leader tab, side-panel follower), so one fix covers all.

**Tech Stack:** Vanilla web components (`@slicc/webcomponents` conventions), WebGL1, Vitest browser mode (real Chromium via Playwright).

**Spec:** `docs/superpowers/specs/2026-08-19-shader-energy-budget.md` (read it first — it carries the measured evidence, the design rationale, and the rejected alternatives).

**Review log:** Codex (gpt-5.5, xhigh) adversarial pre-implementation review on 2026-08-19 returned REWORK with 9 findings; this revision addresses all of them (exact-indentation snippets in formatter-proof fences, `#contextLost` guard, no-burst mode-switch wake, per-wake reduced-motion pulse contract, no-burst context restore, robust pulse-decay test, DPR tests under stubbed `devicePixelRatio`, tighter ambient margins over a longer window, full CI gate list).

## Global Constraints

- Work in this worktree on branch `worktree-shader-energy-budget` (already created; `npm install` and `npx playwright install chromium` already run; baseline `slicc-shader.test.ts` = 29/29 green). Leave the locally-modified `package-lock.json` uncommitted.
- **Old-string discipline:** when performing a "Replace X with Y" edit, ALWAYS open `slicc-shader.ts` and copy the old text from the source with its exact leading whitespace — do not paste from this document, in case a doc formatter re-wrapped a fence. Method bodies are 4-space indented; nested blocks 6-space. This matters doubly for the two textually-identical replace targets — the `connectedCallback` tail (4-space indent) and the `webglcontextrestored` tail (6-space indent) — where indentation is the ONLY disambiguator.
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
- Produces: unchanged public API. Behavioral contract for Tasks 3/4: every stimulus routes through the private `#wake(opts?: { burst?: boolean })`; the tick self-terminates when `#reduced || (!#isAnimated() && #energy === 0)`; `#wake` is a no-op while `#contextLost` is set.

- [ ] **Step 1: Write the failing behavioral tests**

Append to `packages/webcomponents/tests/freezer/slicc-shader.test.ts` (inside the top-level `describe('slicc-shader', ...)` block, after the last existing `it`). The file already imports `afterEach` and `vi` from vitest and defines `mount()` and `frame()`:

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
    await wait(1500);
    // 1500ms at 15fps ≈ 23 draws. Upper bound 30 (= 20fps average) rejects a
    // 30fps or 60fps regression while tolerating rAF jitter; lower bound
    // tolerates heavily-throttled CI. Do not tighten either bound.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(30);
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
    // 0.0011 falls below the 0.001 rest floor after ~2 rendered frames, so
    // decay completes fast even on a throttled CI rAF.
    el.pulse(0.0011);
    await wait(200);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Poll until the draw count is stable across a 250ms window (decay done),
    // then assert it stays stable for one more window.
    let settled = spy.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      await wait(250);
      const next = spy.mock.calls.length;
      if (next === settled) break;
      settled = next;
    }
    await wait(250);
    expect(spy.mock.calls.length).toBe(settled);
  });

  it('switching an animated field into cone speed=0 settles to a stopped loop', async () => {
    const el = mount({ mode: 'scoop' });
    if (el.noWebgl) return;
    await wait(100);
    el.setAttribute('speed', '0');
    el.setAttribute('mode', 'cone');
    await wait(900); // outlast the attribute-change burst window
    const spy = spyDraws();
    await wait(250);
    expect(spy.mock.calls.length).toBe(0);
  });

  it('ignores stimuli while the WebGL context is lost', async () => {
    const el = mount({ mode: 'scoop' });
    if (el.noWebgl) return;
    await wait(100);
    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    const gl = canvas.getContext('webgl') as WebGLRenderingContext;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (!lose) return; // extension unavailable: nothing to exercise
    lose.loseContext();
    await wait(100); // let the webglcontextlost event land
    const spy = spyDraws();
    el.pulse();
    el.setAttribute('scroll', '50');
    await wait(250);
    expect(spy.mock.calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/slicc-shader.test.ts`
Expected: the 29 pre-existing tests PASS. New failures: `renders ambient motion` (count ≈ 90 > 30), `cone with speed=0 renders once and stops` (count > 0), `switching an animated field into cone speed=0` (count > 0), `pulse() … re-stops` (count keeps growing on the old always-on loop... it stabilizes only because the old loop never stops — the final equality fails), `ignores stimuli while the WebGL context is lost` may pass or fail on the old code (loop is stopped by the lost handler; a passing result here pre-implementation is acceptable — it exists to pin the NEW `#wake` paths). `an attribute change re-renders a static field` passes before and after (the old loop draws constantly) — it exists to guard the new wake path.

- [ ] **Step 3: Implement the scheduler**

All edits in `packages/webcomponents/src/freezer/slicc-shader.ts`. **Copy every old-string from the source file, never from this plan** (see Global Constraints). The snippets below are shown in formatter-proof plain fences with the source's real indentation.

**3a.** Add the import at the top (after the existing two imports):

```
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

**3c.** Add scheduler state. Replace (2-space class-field indent)

```
  #raf = 0;
  #start = 0;
  #energy = 0;
```

with

```
  #raf = 0;
  #start = 0;
  #energy = 0;
  #lastFrameTs = Number.NEGATIVE_INFINITY;
  #burstUntil = 0;
  #contextLost = false;
```

**3d.** Rewire the `connectedCallback` tail (4-space indent — NOT the 6-space twin inside `#installContextHandlers`). Replace

```
    this.#start = performance.now() / 1000;
    if (this.#reduced) this.#renderFrame();
    else this.#startLoop();
```

with

```
    this.#start = performance.now() / 1000;
    this.#lastFrameTs = Number.NEGATIVE_INFINITY;
    this.#contextLost = false;
    this.#wake();
```

(The `#contextLost` reset matters: a disconnect while the context was lost must not brick a later reconnect, which acquires a fresh context via `#initGl`.)

**3e.** Rewire `attributeChangedCallback`. Replace the whole method (2-space method indent, body 4/6)

```
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

```
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
        // No burst: the sync render above already delivered the response, and
        // a burst here would double-draw a static field. The wake only (re)arms
        // the loop for animated modes.
        this.#wake();
        return;
      }
    }
    this.#applyFallbackBg();
    this.#wake({ burst: true });
  }
```

**3f.** Rewire `pulse`. Replace

```
  pulse(amount = 1): void {
    this.#energy = Math.min(1.4, this.#energy + amount);
    if (this.#reduced) this.#renderFrame();
  }
```

with

```
  pulse(amount = 1): void {
    this.#energy = Math.min(1.4, this.#energy + amount);
    this.#wake({ burst: true });
  }
```

Contract note (spec §Design): under reduced motion, multiple `pulse()` calls in the same frame now coalesce into ONE rendered frame (the wake is rAF-pending); the accumulated energy still shows. This is an intentional improvement over the previous per-call synchronous render — do not "fix" it back.

**3g.** Delete the `#renderIfStatic` method entirely:

```
  #renderIfStatic(): void {
    if (this.#reduced && this.#gl) this.#renderFrame();
  }
```

**3h.** Rewire its two remaining callers. In `connectedCallback` (6-space indent), replace

```
      this.#ro = new ResizeObserver(() => this.#renderIfStatic());
```

with

```
      this.#ro = new ResizeObserver(() => this.#wake({ burst: true }));
```

In `#observeTheme` (4-space indent, 6-space body), replace

```
    const refresh = (): void => {
      this.#refreshColorUniforms();
      this.#renderIfStatic();
    };
```

with

```
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

**3i.** Guard the context-loss window. In `#installContextHandlers`, replace (4-space assignment, 6-space body)

```
    this.#onContextLost = (e: Event) => {
      e.preventDefault();
      this.#stopLoop();
```

with

```
    this.#onContextLost = (e: Event) => {
      e.preventDefault();
      this.#contextLost = true;
      this.#stopLoop();
```

and replace

```
    this.#onContextRestored = () => {
      if (!this.isConnected || !this.#gl) return;
      this.#programs = {};
      if (!this.#setupGlResources()) return;
```

with

```
    this.#onContextRestored = () => {
      if (!this.isConnected || !this.#gl) return;
      this.#programs = {};
      if (!this.#setupGlResources()) return;
      this.#contextLost = false;
```

Why: after `webglcontextlost`, `#gl` stays non-null while `#program`/`#buffer` are invalid. Without the flag, any pulse/attribute/theme/resize during the lost window schedules `#tick`, `#renderFrame()` no-ops, energy never decays, and an animated mode reschedules an empty rAF loop forever.

**3j.** Rewire the `webglcontextrestored` tail (6-space indent — the twin of 3d). Replace

```
      this.#start = performance.now() / 1000;
      if (this.#reduced) this.#renderFrame();
      else this.#startLoop();
```

with

```
      this.#start = performance.now() / 1000;
      this.#lastFrameTs = Number.NEGATIVE_INFINITY;
      this.#wake();
```

(No burst on restore — the `-Infinity` reset makes the first tick render immediately via the first-frame rule; a burst would add nothing but 800 ms of full-rate frames.)

**3k.** Replace `#startLoop` with the new scheduler. Replace

```
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

```
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
   *  the one pending rAF. A lost GL context parks the scheduler entirely until
   *  restore (render would no-op but an animated mode would spin the loop). */
  #wake(opts: { burst?: boolean } = {}): void {
    if (opts.burst) this.#burstUntil = performance.now() + BURST_MS;
    if (this.#raf || !this.#gl || this.#contextLost) return;
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
Expected: PASS — all 29 pre-existing + 6 new. If `renders ambient motion` is flaky-low on your machine, the loop is over-gated (check `FRAME_EPSILON_MS` wiring); if flaky-high, bursts are leaking (check that `connectedCallback` and the mode-switch branch wake WITHOUT burst).

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

Append at the same level as the other `it`s in the top-level describe. CI runs at `devicePixelRatio` 1, where a DPR-1 cap is invisible — so the cap test stubs the ratio to 2 (this is what makes the default-cap assertion genuinely fail before implementation: uncapped width would be 480):

```ts
it('caps the backing store at DPR 1 by default and honors the dpr escape hatch', async () => {
  const original = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
  try {
    const el = mount();
    if (el.noWebgl) return;
    await frame();
    await frame();
    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    expect(el.dpr).toBe(1);
    expect(canvas.width).toBe(240); // min(cap 1, ratio 2) × 240px — was 480 uncapped
    el.setAttribute('dpr', '2');
    await frame();
    await frame();
    expect(canvas.width).toBe(480); // escape hatch: min(2, 2)
    el.setAttribute('dpr', '0.5');
    await frame();
    await frame();
    expect(canvas.width).toBe(120);
  } finally {
    if (original) Object.defineProperty(window, 'devicePixelRatio', original);
    else delete (window as { devicePixelRatio?: number }).devicePixelRatio;
  }
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

Note: the default cone (speed 0.0625) is animated, so the loop is live and `#resize` picks the new ratio up within the two awaited frames plus the attribute-change burst.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/slicc-shader.test.ts`
Expected: both new tests FAIL — `el.dpr` is `undefined`, and the default-cap assertion sees `canvas.width === 480` (uncapped `MAX_DPR = 2` behavior under the stubbed ratio).

- [ ] **Step 3: Implement**

In `packages/webcomponents/src/freezer/slicc-shader.ts`:

**3a.** Replace the constant

```
const MAX_DPR = 2;
```

with

```
/** Backing-store resolution caps, in device-pixel-ratio units. The field is a
 *  background clamped to a ±20% deviation budget around the theme bg, so
 *  DPR 1 is visually indistinguishable at a quarter of DPR 2's pixel cost on
 *  Retina; showcase/hero uses can opt back up via the `dpr` attribute. */
const DEFAULT_DPR_CAP = 1;
const MIN_DPR_CAP = 0.5;
const MAX_DPR_CAP = 2;
```

**3b.** Add `'dpr'` to `observedAttributes` (after the `'speed'` entry, 4-space indent):

```
    'speed',
    'dpr',
```

**3c.** Add the accessor pair after the `speed` setter (2-space member indent):

```
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

**3d.** Rewire `#resize` (4-space indent). Replace

```
    const dpr = Math.min(MAX_DPR, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
```

with

```
    const dpr = Math.min(this.dpr, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
```

**3e.** Add to the docblock's `@attr` list (after the `speed` lines):

```
 * @attr dpr - canvas resolution cap in device-pixel-ratio units (0.5..2,
 *   default 1 — the washed background field does not need Retina density)
```

- [ ] **Step 4: Run the suite**

Run: `npm run test -w @slicc/webcomponents -- tests/freezer/slicc-shader.test.ts`
Expected: PASS (29 + 6 + 2).

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
- Park the scheduler entirely while the WebGL context is lost — rendering
  no-ops then, but an animated mode would still spin an empty rAF loop.

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

- [ ] **Step 1: Read the verification runbook, then run the gates**

Read `.agents/skills/verifying-before-push/SKILL.md` and follow it — it is authoritative for CI-only gates (the touched-file debt gate / `check-touched-exemptions`, manifest justifications, coverage floors). Then run, in order:

```bash
npm run verify           # the repo's own pre-push gate script — run this FIRST
npm run lint:ci          # biome check WITHOUT --write — fixable organizeImports = error here
npm run deadcode         # knip — new frame-budget.ts exports must all be consumed or test-covered
npm run deadcode:production-files
npm run typecheck        # browser + node configs
npm run test             # root vitest (node projects; webcomponents excluded by design)
npm run test -w @slicc/webcomponents          # full browser-mode suite
npm run test:coverage:webcomponents           # coverage floor (coverage-thresholds.json)
npm run build            # production build, all workspaces
npm run build -w @slicc/chrome-extension      # extension build
npm run bundle-size      # size-limit gate (webcomponents changes trigger it in CI)
npm run lint:docs
```

Expected: all green. Known trap: if `deadcode` flags `frame-budget.ts` exports (`AMBIENT_FPS`, `FRAME_EPSILON_MS` are consumed only by tests), keep them exported — they are part of the documented contract; add them to the knip entry allowlist ONLY if knip actually fails, and say so in the PR body.

- [ ] **Step 2: Optional live smoke (recommended)**

`npm run dev` from the worktree, open the standalone UI, and in DevTools confirm: (a) the background field still animates; (b) with the Performance monitor open, CPU settles far below the pre-fix level; (c) `document.querySelector('slicc-shader').setAttribute('speed','0')` stops draw activity entirely (Performance tab shows no recurring rAF work). Kill only processes started by this worktree (scope kills to this worktree's path/PID/port — NEVER broad `pkill -f`).

- [ ] **Step 3: Push and open the PR**

Follow `.agents/skills/verifying-before-push/SKILL.md` for push mechanics (rebase onto `origin/main` first — CI enforces linear history). PR title: `perf(webcomponents): frame-budget the slicc-shader background (idle 44% GPU → ~3%)`. PR body must link the spec/plan (they ship in this branch by repo convention — do NOT strip them; the release process purges them from main), state the measured before/after from the spec, note the Codex review verdict and that all findings were addressed, and note that Storybook PR screenshots will re-capture the `freezer` area stories (expected: visually near-identical — CI captures at devicePixelRatio 1 where the DPR cap is a no-op).
