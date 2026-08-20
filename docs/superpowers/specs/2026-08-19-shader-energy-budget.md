# Spec: `slicc-shader` energy budget (fix idle CPU/GPU burn)

**Date:** 2026-08-19
**Branch:** `worktree-shader-energy-budget`
**Status:** Approved (root cause confirmed live on 2026-08-19). Codex (gpt-5.5, xhigh) pre-implementation review returned REWORK with 9 findings on 2026-08-19; this revision addresses all of them.

## Problem

The `<slicc-shader>` full-viewport WebGL background (`packages/webcomponents/src/freezer/slicc-shader.ts`, mounted by `wc-shell.ts` as the app-frame background in every WC-shell float) runs an **unconditional `requestAnimationFrame` loop at display rate, forever**. The only things that stop it are element disconnect, WebGL context loss, and `prefers-reduced-motion`.

Measured on a live thin-extension install (Chrome 151, Apple Silicon, leader tab visible in a background window, side panel closed, agent idle):

| Process             | CPU with shader | CPU after `document.querySelector('slicc-shader').remove()` |
| ------------------- | --------------- | ----------------------------------------------------------- |
| Chrome GPU process  | ~44%            | ~2%                                                         |
| Leader-tab renderer | ~18%            | 0.0%                                                        |

Confirmed causal by single-variable removal. Sample stacks showed ANGLE (`libGLESv2`) fragment-program encoding in the GPU process and rAF-driven JS + compositor frame production in the renderer.

Three aggravating factors:

1. The `cone` program (`FRAG_SUGAR`) runs two 3×3 Voronoi searches, a second 3×3×2 edge pass, and multiple 5-octave fbm calls **per pixel**, at up to `MAX_DPR = 2` — ~7-8M pixels × 60 fps on Retina.
2. The ambient motion is glacial by design (focal-orbit periods ~52-65 s; fastest shader component is `sin(t*2.7)` ≈ 0.43 Hz). 60 fps re-renders a near-static image.
3. The `speed` attribute is documented "0 = paused" but only zeroes `u_speed` inside the shader — `#renderFrame()` still pays full draw cost every frame.

Why Chrome doesn't save us: rAF pauses only for _hidden_ pages. A leader tab that is the selected tab of a partially-visible background window (macOS occlusion needs 100% coverage) stays "visible" and renders at full rate; the tray's open WebRTC connection additionally exempts the tab from timer throttling. The side panel's `?cherry=1&ui-only=1` follower mounts a second instance while open.

## Goals

1. **Ambient frame budget:** decorative motion renders at 15 fps, not display rate (~75% cost cut).
2. **Burst on interaction:** `pulse()`, observed attribute changes (incl. `scroll` parallax), theme flips, and resizes render at full display rate for a short window (800 ms) so direct responses stay crisp. Context restore is NOT a burst stimulus — the first-frame rule (`#lastFrameTs = -Infinity` reset) already renders immediately on restore, and 800 ms of full-rate frames after it would buy nothing.
3. **True static stop:** a field with no intrinsic motion — `cone` with `speed=0`, or `prefers-reduced-motion` — renders **once per stimulus and stops the loop**. "0 = paused" becomes literally true. A mode switch into a static field renders exactly its one synchronous anti-flicker frame — no post-switch burst double-draw.
4. **Resolution budget:** default canvas DPR cap drops 2 → 1 (the field is clamped to a ±20% deviation budget around the theme background; half-res is imperceptible, 4× fewer pixels on Retina). New `dpr` attribute (0.5–2) as an escape hatch for showcase/hero uses.
5. **Context-loss safety:** while the WebGL context is lost, the scheduler parks entirely (`#contextLost` guard in `#wake`) — without it, any stimulus during the lost window spins an empty rAF loop in animated modes because `#gl` stays non-null while `#program`/`#buffer` are invalid. Restore (and reconnect after a lost-context disconnect) clears the flag.
6. **Docs:** the frame-budget rule joins the existing "no per-frame reflow" animation rule (webcomponents `CLAUDE.md`, `docs/webcomponents-details.md`), and the incident lands in `docs/pitfalls.md`.

Combined idle-visible cost target: 60 fps→15 fps (÷4) and DPR 2→1 (÷4 pixels) ≈ **~44% → ~3% GPU process**, renderer main thread ~8.5% → ~2%.

## Non-goals / out of scope

- **Scheduling via `setTimeout`/`setInterval`** — rejected. The leader tab is throttle-exempt (WebRTC), so timers fire at full rate even when hidden; rAF is the only scheduler that pauses with visibility. The loop must stay rAF-based.
- **`visibilitychange` / IntersectionObserver gating** — rejected as redundant: Chrome already stops rAF for hidden pages, and the element is `inset:0` fixed (always in-viewport when visible). The burn case is _visible-but-background_, where rendering is legitimate — just budgeted.
- **Focus-tiered FPS** (drop further when `document.hasFocus()` is false) — YAGNI at ~3% residual; revisit only if measurements justify it.
- **Changing the app default to a static field** (`speed=0` in `wc-shell.ts`) — product/visual call, not this change.
- **Leader WebRTC teardown after last follower disconnects** — separate follow-up issue (keeps the tab throttle-exempt; unrelated to the shader).
- `slicc-frost-shader` (separate element) — audit later if measurements implicate it; not touched here.

## Design

### New pure module: `packages/webcomponents/src/freezer/frame-budget.ts`

DOM-free, unit-testable frame-gating logic (the repo already uses "verbatim pure modules" beside components):

- `AMBIENT_FPS = 15`, `AMBIENT_FRAME_MS = 1000 / 15`, `BURST_MS = 800`, `FRAME_EPSILON_MS = 4`
- `shouldRender(nowTs, lastFrameTs, energetic): boolean` — energetic frames always render; ambient frames render when `nowTs - lastFrameTs >= AMBIENT_FRAME_MS - FRAME_EPSILON_MS` (epsilon absorbs rAF jitter so 60 Hz hosts don't sag to ~12 fps).
- `advanceFrameTs(nowTs, lastFrameTs, energetic): number` — energetic or first frame → `nowTs`; ambient → advance on the 15 fps grid (`lastFrameTs + AMBIENT_FRAME_MS`) unless more than one interval behind (hidden-tab stall) → snap to `nowTs`. Grid advance keeps the long-run average at exactly 15 fps despite jitter; the snap prevents catch-up bursts after a stall.

### Scheduler restructure in `slicc-shader.ts`

Replace `#startLoop` / `#renderIfStatic` with **one entry point and a self-terminating tick**:

- New state: `#lastFrameTs = Number.NEGATIVE_INFINITY`, `#burstUntil = 0`, `#contextLost = false`.
- `#isAnimated(): boolean` — `false` when `#reduced`, `false` when `mode === 'cone' && speed === 0` (with `u_speed = 0` the crack clock, micro-wobble, and parallax — `sign(u_speed)` — are all zeroed, so the cone field is genuinely static), `true` otherwise (scoop and freezer animate on `u_time` unconditionally).
- `#wake({ burst? })` — sets `#burstUntil = performance.now() + BURST_MS` when bursting; schedules a rAF only if none pending, a GL context exists, AND the context is not lost. Called from: `connectedCallback` (no burst; also resets `#contextLost` so a reconnect after a lost-context disconnect works), `attributeChangedCallback` (burst — EXCEPT the mode-switch sync-render branch, which wakes without burst because the synchronous frame already delivered the response and a burst would double-draw a static field), `pulse()` (burst), theme refresh (burst), `ResizeObserver` (burst; the observer skips its spec-mandated initial notification on observe() — a mount artifact, not a resize), `webglcontextrestored` (no burst).
- `#tick(ts)` — `energetic = ts < #burstUntil || #energy > 0`; renders when `shouldRender(...)` admits the frame (updating `#lastFrameTs` via `advanceFrameTs`); then **self-terminates** when `#reduced || (!#isAnimated() && #energy === 0)`, else re-schedules. Self-termination runs _after_ the render so the final at-rest frame paints, and is unconditional on the burst window — a static field bursts at most one frame per wake.
- `pulse()` keeps energy decay semantics (×0.95 per rendered frame, floor to 0 below 0.001); `#energy > 0` counts as energetic so glow decay runs at display rate and completes in the same wall time as today. **Reduced-motion contract change:** pulses render one frame **per coalesced wake** — multiple `pulse()` calls before the next rAF draw once with the accumulated energy (previously each call drew synchronously). Intentional; do not restore per-call draws.
- Context-loss guard: `webglcontextlost` sets `#contextLost = true` (in addition to the existing `#stopLoop` + cache drop); `webglcontextrestored` clears it after `#setupGlResources()` succeeds.
- The synchronous anti-flicker render in the mode-switch branch of `attributeChangedCallback` stays, and additionally sets `#lastFrameTs = performance.now()` so the follow-up wake does not immediately re-draw.
- `#stopLoop()` survives for `disconnectedCallback` and `webglcontextlost`.
- Batched same-microtask attribute changes coalesce naturally into the single pending rAF.

### Resolution cap

- `MAX_DPR = 2` is replaced by `DEFAULT_DPR_CAP = 1` with clamp bounds `MIN_DPR_CAP = 0.5`, `MAX_DPR_CAP = 2`.
- New reflected attribute/property `dpr` (`get dpr()` clamps via `clampNum(..., 0.5, 2, 1)`), added to `observedAttributes` (a change re-renders through the normal `#wake({burst:true})` path).
- `#resize()` uses `Math.min(this.dpr, window.devicePixelRatio || 1)`.

### Documentation

- Component docblock: describe the budget; fix `@attr speed` ("0 = genuinely paused — renders once per change and stops"); add `@attr dpr`.
- `packages/webcomponents/CLAUDE.md` conventions bullet extended: animation loops must carry a frame budget (ambient cap + burst + static stop).
- `docs/webcomponents-details.md` "Animation loops and forced reflow" section gains the frame-budget pattern and points at `frame-budget.ts`.
- `docs/pitfalls.md` gains a section recording this incident (visible-in-background-window + WebRTC throttle exemption ⇒ Chrome will not save an ungated loop).

## Acceptance criteria

1. Mounted `mode="scoop"` (inherently animated) renders at **≤ 20 fps averaged over ≥ 1.5 s** (budget target 15; the bound rejects a 30 or 60 fps regression while tolerating CI jitter — behavioral draw-call-count test).
2. Mounted `cone` with `speed=0`: **zero** draw calls after settling; a `pulse()` or attribute change renders and then re-stops; a mode switch from an animated mode into the static field settles to a stopped loop.
3. Attribute changes (`scroll`, `tint`, `mode`, …) still re-render promptly (burst window, or the mode-switch synchronous frame).
4. Backing-store resolution proven under a stubbed `devicePixelRatio = 2`: default width 240 for a 240px element (cap 1), `dpr="2"` → 480 (escape hatch), `dpr="0.5"` → 120.
5. While the WebGL context is lost, stimuli (`pulse()`, attribute changes) issue **zero** draw calls and do not start a loop.
6. All 29 pre-existing `slicc-shader.test.ts` tests still pass unmodified.
7. Full verification pass green: `npm run verify`, `lint:ci`, `deadcode`, `deadcode:production-files`, `typecheck`, root `test`, webcomponents suite, `test:coverage:webcomponents`, both `build`s, `bundle-size`, `lint:docs`.
