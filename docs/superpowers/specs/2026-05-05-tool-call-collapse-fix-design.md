# Tool Call Collapse State Preservation

**Date:** 2026-05-05
**Status:** Approved

## Problem

Individual tool call rows and "Working" clusters both use `<details>` elements. Every time the agent makes a new tool call, `updateMessageEl` fires and replaces the entire message DOM element — destroying any `open` state the user had set. Similarly, `reflowToolClusters` tears down existing cluster elements and rebuilds them, also discarding open state.

Concretely: if a user expands a tool call or cluster while the agent is still running, the next tool call collapses it back.

## Scope

- Preserve open state within a browser session across mid-session DOM rebuilds.
- Browser refresh does not need to be preserved.

## Design

### New instance variables on `ChatPanel`

```ts
private userOpenedToolCalls = new Set<string>();  // keyed by ToolCall.id
private userOpenedClusters = new Set<string>();   // keyed by joined ToolCall IDs
```

### Individual tool calls (`createToolCallEl`)

1. Tag the `<details>` element: `el.dataset.toolCallId = tc.id`
2. Restore open state: `el.open = this.userOpenedToolCalls.has(tc.id)`
3. Attach a `toggle` listener:
   - On open: `this.userOpenedToolCalls.add(tc.id)`
   - On close: `this.userOpenedToolCalls.delete(tc.id)`

### Clusters (`createToolClusterEl` and `buildClusterFromElements`)

Cluster key = constituent tool call IDs joined with `,`. This is stable because `ToolCall.id` is assigned once via `uid()` when the tool call starts and never changes.

**`createToolClusterEl(toolCalls, msgId)`:**
1. Compute key: `toolCalls.map(tc => tc.id).join(',')`
2. Restore open state: `el.open = this.userOpenedClusters.has(key)`
3. Attach a `toggle` listener: add/remove key from `userOpenedClusters`

**`buildClusterFromElements(toolCallEls)`:**
1. Compute key: `toolCallEls.map(el => el.dataset.toolCallId ?? '').join(',')`
2. Same open restore + toggle listener pattern

### Side effect: force-open via tool UI

The existing logic that force-opens a cluster when a tool emits interactive UI (`enclosingCluster.open = true` at line 1151) continues to work correctly — the `toggle` listener fires when `open` is set programmatically, so the user-opened state is automatically recorded.

## Files Changed

- `packages/webapp/src/ui/chat-panel.ts` — two new Sets, toggle listeners, open restore in `createToolCallEl`, `createToolClusterEl`, `buildClusterFromElements`

## Testing

- Existing cluster tests in `packages/webapp/tests/ui/` should be reviewed for open-state assertions.
- Manual: expand a tool call mid-run, verify it stays open when the next tool call fires.
- Manual: expand a "Working" cluster mid-run, verify it stays open.
- Manual: collapse an expanded tool call, verify it stays collapsed.
