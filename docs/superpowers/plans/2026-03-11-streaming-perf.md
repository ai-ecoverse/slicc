# Streaming Performance Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LLM streaming in the slicc chat feel smooth by batching DOM updates to ~60fps and only updating the content node during streaming.

**Architecture:** Two changes in `ChatPanel`: (1) rAF-batched delta accumulation replaces per-token rendering, (2) a targeted content-only DOM update replaces full element rebuild during streaming. Modeled after `@mariozechner/pi-web-ui`'s `StreamingMessageContainer`.

**Tech Stack:** Vanilla TypeScript, unified.js (existing), requestAnimationFrame (browser API)

---

## Chunk 1: Implementation

### Task 1: Add rAF batching state and flush helper

**Files:**
- Modify: `src/ui/chat-panel.ts:68-78` (add new private fields after existing state)
- Modify: `src/ui/chat-panel.ts` (add flushPendingDelta and cancelPendingDelta methods)

- [ ] **Step 1: Add two new private fields to ChatPanel**

In `src/ui/chat-panel.ts`, add after line 78 (after `onDeleteQueuedMessage`):

```typescript
private pendingDeltaText = '';
private streamingRafId: number | null = null;
```

- [ ] **Step 2: Add `flushPendingDelta()` method**

Add this private method after the `findMessage` method (after line 638):

```typescript
private flushPendingDelta(): void {
  this.streamingRafId = null;
  if (!this.pendingDeltaText || !this.currentStreamId) return;
  const msg = this.findMessage(this.currentStreamId);
  if (!msg) {
    this.pendingDeltaText = '';
    return;
  }
  msg.content += this.pendingDeltaText;
  this.pendingDeltaText = '';
  this.updateStreamingContent(this.currentStreamId);
}
```

- [ ] **Step 3: Add `cancelPendingDelta()` method**

Add right after `flushPendingDelta`:

```typescript
private cancelPendingDelta(): void {
  if (this.streamingRafId !== null) {
    cancelAnimationFrame(this.streamingRafId);
    this.streamingRafId = null;
  }
  this.pendingDeltaText = '';
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (new methods are private and not yet called, new fields initialized)

- [ ] **Step 5: Commit**

```bash
git add src/ui/chat-panel.ts
git commit -m "feat: add rAF batching state and flush/cancel helpers"
```

### Task 2: Add targeted streaming content update

**Files:**
- Modify: `src/ui/chat-panel.ts` (add `updateStreamingContent` method)

- [ ] **Step 1: Add `updateStreamingContent()` method**

Add after the `cancelPendingDelta` method. This is the fast path — only updates `.msg__content` innerHTML during streaming, skipping the full element rebuild:

```typescript
private updateStreamingContent(messageId: string): void {
  const msg = this.findMessage(messageId);
  if (!msg) return;
  const wrapper = this.messagesEl.querySelector(`[data-msg-id="${messageId}"]`);
  if (!wrapper) return;
  const contentEl = wrapper.querySelector('.msg__content');
  if (contentEl) {
    contentEl.innerHTML = renderChatMessageContent(msg);
    if (msg.isStreaming) {
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      contentEl.appendChild(cursor);
    }
  } else if (msg.content.trim().length > 0) {
    // First content arriving — need the full rebuild to create the bubble
    this.updateMessageEl(messageId);
    return;
  }
  this.scrollToBottom();
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/ui/chat-panel.ts
git commit -m "feat: add targeted streaming content update method"
```

### Task 3: Wire rAF batching into handleContentDelta

**Files:**
- Modify: `src/ui/chat-panel.ts:527-532` (replace `handleContentDelta` body)

- [ ] **Step 1: Replace `handleContentDelta` implementation**

Replace lines 527-532 with:

```typescript
private handleContentDelta(messageId: string, text: string): void {
  const msg = this.findMessage(messageId);
  if (!msg) return;
  this.pendingDeltaText += text;
  if (this.streamingRafId === null) {
    this.streamingRafId = requestAnimationFrame(() => this.flushPendingDelta());
  }
}
```

Instead of immediately calling `msg.content += text` and `updateMessageEl()` on every token, this accumulates text and schedules a single rAF render.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: 1054 tests passing (ChatPanel is DOM-dependent, not covered by Node tests)

- [ ] **Step 4: Commit**

```bash
git add src/ui/chat-panel.ts
git commit -m "feat: wire rAF batching into handleContentDelta"
```

### Task 4: Add cleanup to content_done, switchToContext, and dispose

**Files:**
- Modify: `src/ui/chat-panel.ts:534-539` (handleContentDone)
- Modify: `src/ui/chat-panel.ts:133-159` (switchToContext)
- Modify: `src/ui/chat-panel.ts:967-976` (dispose)

- [ ] **Step 1: Update `handleContentDone` to flush before final render**

Replace `handleContentDone` (lines 534-539) with:

```typescript
private handleContentDone(messageId: string): void {
  // Flush any pending delta text before the final full render
  if (this.pendingDeltaText && this.currentStreamId === messageId) {
    const msg = this.findMessage(messageId);
    if (msg) msg.content += this.pendingDeltaText;
  }
  this.cancelPendingDelta();
  const msg = this.findMessage(messageId);
  if (!msg) return;
  msg.isStreaming = false;
  this.updateMessageEl(messageId);
}
```

- [ ] **Step 2: Add cleanup to `switchToContext`**

In `switchToContext`, add `this.cancelPendingDelta();` after line 141 (`this.currentStreamId = null;`):

```typescript
// Reset streaming state — prevents stale isStreaming from a different scoop
// from locking the input in the new context
this.setStreamingState(false);
this.currentStreamId = null;
this.cancelPendingDelta();
```

- [ ] **Step 3: Add cleanup to `dispose`**

In `dispose`, add `this.cancelPendingDelta();` as the first line of the method body (before `this.unsubscribe?.()`):

```typescript
dispose(): void {
  this.cancelPendingDelta();
  this.unsubscribe?.();
  this.voiceInput?.destroy();
  // ... rest unchanged
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run tests**

Run: `npm run test`
Expected: 1054 tests passing

- [ ] **Step 6: Commit**

```bash
git add src/ui/chat-panel.ts
git commit -m "feat: flush/cancel pending deltas on content_done, context switch, dispose"
```

### Task 5: Full verification gate

**Files:** None (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS on both tsconfig targets

- [ ] **Step 2: Tests**

Run: `npm run test`
Expected: 1054 tests, 0 failures

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 4: Extension build**

Run: `npm run build:extension`
Expected: Clean build, no errors

- [ ] **Step 5: Commit verification result (if any fixups needed)**

If any gate fails, fix the issue and re-run all four gates before committing.
