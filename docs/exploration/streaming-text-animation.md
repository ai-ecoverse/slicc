# Streaming Text Animation

**Date:** 2026-03-12
**Status:** Research complete, not yet implemented
**Related PR:** #75 (fix/streaming-perf — rAF batching + marked)

## Problem

Streaming tokens appear abruptly. New lines "jump in" instead of flowing
smoothly. The current approach replaces `innerHTML` on the entire message
element every animation frame, which prevents any CSS animation from
persisting — every DOM node is destroyed and recreated on each update.

## How Production AI Chats Solve This

### 1. Token fade-in animation

New tokens are wrapped in `<span>` elements with a CSS animation:

```css
@keyframes token-in {
  from { opacity: 0; transform: translateY(3px); }
  to   { opacity: 1; transform: translateY(0); }
}
.new-token {
  animation: token-in 0.25s ease-out forwards;
}
```

Only `opacity` and `transform` are animated — both are GPU-composited
and skip layout/paint. Duration sweet spot: 0.2–0.35s with `ease-out`.

**Critical rule:** existing DOM nodes must not be touched. If you do
`innerHTML =` on the whole message, every token re-fires its animation
on every update. That's the source of the "brutal" feeling.

### 2. Scroll behavior

Production UIs use instant `scrollTop = scrollHeight` (not
`behavior: 'smooth'`) during active streaming. Smooth scroll is only
used for catch-up when re-engaging after the user scrolled away.

Pattern:
- Gate auto-scroll on proximity: `scrollHeight - scrollTop - clientHeight <= 100px`
- Use `ResizeObserver` on the message container as the scroll trigger
- Never force-scroll if the user scrolled up (reading history)

### 3. Markdown rendering during streaming

Two viable strategies:

**A. Streaming markdown parser** — parses tokens incrementally and
appends DOM nodes without touching existing ones. Libraries:
- `thetarnav/streaming-markdown` — vanilla JS, zero deps
- `vercel/streamdown` — Vercel's streaming markdown renderer
- `antgroup/FluidMarkdown` — Ant Group's fluid renderer
- `chuanqisun/semidown` — lightweight streaming markdown

**B. Hybrid approach** — append raw animated `<span>` elements during
streaming, then replace with full `marked` render on stream completion.
Simpler to integrate with existing architecture but loses markdown
formatting mid-stream (code blocks, tables render only at the end).

## Architectural Tension

```
marked wants:    full string → parse → full HTML → innerHTML =
animation wants: append new nodes only, never touch existing ones
```

These are fundamentally at odds. `innerHTML =` destroys all DOM nodes
and recreates them, resetting any in-progress CSS animations. The fix
requires changing how we add content to the DOM.

## Options for SLICC

### Option A: Streaming markdown parser (recommended)

Replace `marked` during streaming with a parser that emits DOM nodes
incrementally. Keep `marked` for final render on stream completion
(to ensure perfect markdown fidelity).

**Candidates:**
- `thetarnav/streaming-markdown` — best fit. Vanilla JS, no framework
  dependency, designed for exactly this use case. Appends to a container
  element, handles partial code blocks and lists gracefully.
- `vercel/streamdown` — more features but React-oriented.

**Integration sketch:**
```
streaming starts → create streaming-markdown parser instance
token arrives    → feed token to parser (appends DOM nodes)
                 → new nodes get .new-token CSS class
                 → rAF batching still applies (batch tokens per frame)
stream ends      → replace container innerHTML with marked render
                 → ensures final output is pixel-perfect markdown
```

**Pros:** Smooth animation mid-stream, markdown renders progressively.
**Cons:** New dependency, potential rendering differences between
streaming parser and `marked` (flash of re-layout on completion).

### Option B: Raw spans during streaming, marked on completion

During streaming, append each token batch as a `<span class="new-token">`.
No markdown rendering mid-stream. On completion, replace with `marked`.

**Integration sketch:**
```
streaming starts → switch to "raw append" mode
token arrives    → create <span class="new-token">{token}</span>
                 → append to message container
                 → rAF batching still applies
stream ends      → container.innerHTML = marked(fullText)
```

**Pros:** No new dependency, simpler implementation.
**Cons:** No markdown formatting during streaming (code blocks, bold,
links only appear at the end — noticeable for long responses).

### Option C: Animated innerHTML replacement (current + CSS tricks)

Keep `innerHTML =` but use CSS techniques to minimize visual disruption:
- `contain: content` on message container (isolate layout)
- Avoid layout-triggering properties in the message area
- Accept that per-token animation isn't possible with this approach

**Pros:** No architecture change.
**Cons:** Doesn't solve the core problem. The "brutal" feeling persists.

## Performance Considerations

- **rAF batching** (already implemented in PR #75) is a prerequisite for
  any animation approach — without it, per-token DOM writes cause layout
  thrashing regardless of animation strategy.
- `contain: content` on `.msg__content` isolates layout recalculation.
- Only animate `opacity` and `transform` — never `height`, `margin`,
  `padding`, or other layout-triggering properties.
- For long messages (1000+ tokens), consider removing the animation class
  from older tokens to reduce the number of active CSS animations.

## Libraries Reference

| Library | Size | Framework | Approach |
|---------|------|-----------|----------|
| [thetarnav/streaming-markdown](https://github.com/thetarnav/streaming-markdown) | ~5KB | Vanilla JS | Incremental DOM append |
| [vercel/streamdown](https://github.com/vercel/streamdown) | ~10KB | React-oriented | Streaming markdown |
| [chuanqisun/semidown](https://github.com/chuanqisun/semidown) | ~3KB | Vanilla JS | Lightweight streaming |
| [antgroup/FluidMarkdown](https://github.com/antgroup/FluidMarkdown) | ~15KB | React | Fluid rendering |
| [Ephibbs/flowtoken](https://github.com/Ephibbs/flowtoken) | ~8KB | React | Token animation |

## Next Steps

1. Evaluate `thetarnav/streaming-markdown` against SLICC's markdown needs
   (GFM tables, code blocks with syntax highlighting, nested lists)
2. Prototype Option A in a branch — feed tokens to streaming-markdown
   during streaming, swap to `marked` on completion
3. Compare visual smoothness with current rAF-only approach
4. Decide whether the dependency is justified or if Option B suffices
