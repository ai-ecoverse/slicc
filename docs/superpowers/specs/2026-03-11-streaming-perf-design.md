# Streaming Performance: rAF-batched rendering with targeted DOM updates

## Problem

LLM streaming in the slicc chat feels sluggish. Every token delta triggers a full message element rebuild including a synchronous markdown pipeline on the entire accumulated content. Three compounding issues:

1. **O(n^2) markdown rendering** -- the markdown pipeline re-parses the full accumulated content on every token.
2. **Full DOM destruction/recreation** -- the entire message element (role label, content, tool calls) is destroyed and rebuilt via `replaceWith()` per token.
3. **Zero throttling** -- no batching between token arrival and DOM update.

## Prior art

`@mariozechner/pi-web-ui` (the official pi chat UI) solves this with:

- **`requestAnimationFrame` batching** in `StreamingMessageContainer.setMessage()` -- coalesces all tokens within one frame into a single render (~60fps max).
- **Two-container isolation** -- a frozen `<message-list>` for completed messages + a separate streaming container that is the only element re-rendering.
- Full markdown re-parse per frame (using `marked`), accepted as fast enough at 60fps.

## Design

Apply the pi-web-ui pattern to slicc's vanilla TypeScript ChatPanel. Two targeted changes in `src/ui/chat-panel.ts`.

### 1. rAF-batched delta accumulation

In `handleContentDelta()`, instead of calling `updateMessageEl()` per token:

- Append the delta text to a `pendingDeltaText` buffer.
- If no `requestAnimationFrame` is already scheduled, schedule one.
- When the rAF fires, flush `pendingDeltaText` into `msg.content` and render once.

Multiple tokens within one frame (~16ms) coalesce into a single render.

```
Token 1 arrives -> append to pendingDeltaText, schedule rAF
Token 2 arrives -> append to pendingDeltaText (rAF already scheduled)
Token 3 arrives -> append to pendingDeltaText (rAF already scheduled)
rAF fires       -> flush into msg.content, render ONCE
```

### 2. Targeted content-only DOM update during streaming

Add a fast path `updateStreamingContent(messageId)` that:

1. Finds the existing `.msg__content` element inside the message's `[data-msg-id]` wrapper.
2. Re-renders only its innerHTML (markdown) and re-appends the streaming cursor.
3. Skips recreating the wrapper, role label, and tool call elements.

The full `createMessageEl` + `replaceWith` path remains for non-streaming updates:

| Event            | Update path                | Scope                     |
|------------------|----------------------------|---------------------------|
| Streaming token  | `updateStreamingContent()` | `.msg__content` innerHTML |
| Tool use start   | `updateMessageEl()`        | Full element rebuild      |
| Content done     | `updateMessageEl()`        | Full element rebuild      |
| Turn end         | (no render)                | State cleanup only        |

### 3. New state

Two new private fields on `ChatPanel`:

- `pendingDeltaText: string` -- accumulated text between rAF frames.
- `streamingRafId: number | null` -- the scheduled rAF handle.

### 4. Cleanup

Cancel any pending rAF and flush remaining text in:

- `switchToContext()` -- prevents stale renders leaking across scoop switches.
- `dispose()` -- standard cleanup.
- `handleContentDone()` -- flush before final full render.

## What stays the same

- **Markdown pipeline** -- markdown is still fully re-parsed on every rAF-batched render (currently via `marked` + `DOMPurify`), at ~60fps max instead of per-token.
- **Event flow** -- ScoopContext, Orchestrator, offscreen bridge, offscreen client are untouched.
- **`scrollToBottom()`** -- already uses rAF internally; called once per batched render.
- **Session persistence** -- only fires on `content_done` / `turn_end`, unaffected.
- **Extension mode** -- chrome.runtime message hops add per-token latency, but rAF batching absorbs it.

## Files changed

Only `src/ui/chat-panel.ts` (~30-50 lines modified/added).

## Verification

- `npm run typecheck` -- both tsconfig targets
- `npm run test` -- all 1054 tests pass
- `npm run build` -- production build
- `npm run build:extension` -- extension build
- Manual testing: build extension, load in Chrome, verify smooth streaming with live markdown, tool calls render correctly, content_done produces clean final render.
