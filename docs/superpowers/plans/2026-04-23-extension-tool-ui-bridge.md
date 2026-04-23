# Extension Tool UI Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tool UI (mount approval dialog) work in extension mode by bridging onToolUI/onToolUIDone through the offscreen messaging layer.

**Architecture:** Extend the existing agent-event stream with tool_ui/tool_ui_done event types, add a tool-ui-action panel→offscreen message for relaying user clicks, and handle showDirectoryPicker() in the side panel where user gesture context exists.

**Tech Stack:** TypeScript, Chrome Extension APIs (chrome.runtime messaging), IndexedDB (FileSystemDirectoryHandle sharing), Vitest

**Spec:** `docs/superpowers/specs/2026-04-23-extension-tool-ui-bridge-design.md`

---

### File Map

| File                                                       | Action | Responsibility                                                      |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `packages/chrome-extension/src/messages.ts`                | Modify | Add tool_ui/tool_ui_done event types + ToolUIActionMsg              |
| `packages/chrome-extension/src/offscreen-bridge.ts`        | Modify | Emit tool UI events, handle tool-ui-action relay                    |
| `packages/webapp/src/ui/offscreen-client.ts`               | Modify | Receive tool UI events, dispatch to chat panel                      |
| `packages/webapp/src/ui/tool-ui-renderer.ts`               | Modify | Extension mode: relay actions to offscreen, handle directory picker |
| `packages/chrome-extension/tool-ui-sandbox.html`           | Modify | Pass data-picker attribute in action messages                       |
| `packages/webapp/src/fs/mount-commands.ts`                 | Modify | Add data-picker to button, handle IDB-stored handle in onAction     |
| `packages/chrome-extension/tests/offscreen-bridge.test.ts` | Modify | Test new callbacks and message handling                             |

---

### Task 1: Add message types

**Files:**

- Modify: `packages/chrome-extension/src/messages.ts`

- [ ] **Step 1: Add tool_ui and tool_ui_done to AgentEventMsg.eventType**

In `packages/chrome-extension/src/messages.ts`, change the `AgentEventMsg` interface:

```typescript
export interface AgentEventMsg {
  type: 'agent-event';
  scoopJid: string;
  eventType:
    | 'text_delta'
    | 'tool_start'
    | 'tool_end'
    | 'turn_end'
    | 'response_done'
    | 'tool_ui'
    | 'tool_ui_done';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: string;
  isError?: boolean;
  requestId?: string;
  html?: string;
}
```

- [ ] **Step 2: Add ToolUIActionMsg**

Add below the `ReloadSkillsMsg` interface:

```typescript
export interface ToolUIActionMsg {
  type: 'tool-ui-action';
  requestId: string;
  action: string;
  data?: unknown;
}
```

- [ ] **Step 3: Add ToolUIActionMsg to PanelToOffscreenMessage union**

```typescript
export type PanelToOffscreenMessage =
  | UserMessageMsg
  | ConeCreateMsg
  | ScoopFeedMsg
  | ScoopDropMsg
  | AbortMsg
  | SetModelMsg
  | RequestStateMsg
  | ClearChatMsg
  | ClearFilesystemMsg
  | RefreshModelMsg
  | RefreshTrayRuntimeMsg
  | PanelCdpCommandMsg
  | OAuthRequestMsg
  | SprinkleLickMsg
  | ReloadSkillsMsg
  | ToolUIActionMsg;
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (new types are additive, nothing consumes them yet)

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/chrome-extension/src/messages.ts
git add packages/chrome-extension/src/messages.ts
git commit -m "feat: add tool_ui message types for extension tool UI bridge"
```

---

### Task 2: Wire offscreen bridge callbacks

**Files:**

- Modify: `packages/chrome-extension/src/offscreen-bridge.ts`

- [ ] **Step 1: Add import for toolUIRegistry**

At the top of `offscreen-bridge.ts`, add:

```typescript
import { toolUIRegistry } from '../../../packages/webapp/src/tools/tool-ui.js';
```

- [ ] **Step 2: Add onToolUI callback to createCallbacks()**

In the `createCallbacks()` method, after the `onToolEnd` callback (around line 213), add:

```typescript
onToolUI: (scoopJid, toolName, requestId, html) => {
  bridge.emit({
    type: 'agent-event',
    scoopJid,
    eventType: 'tool_ui',
    toolName,
    requestId,
    html,
  });
},

onToolUIDone: (scoopJid, requestId) => {
  bridge.emit({
    type: 'agent-event',
    scoopJid,
    eventType: 'tool_ui_done',
    requestId,
  });
},
```

- [ ] **Step 3: Handle tool-ui-action in handlePanelMessage()**

In the `handlePanelMessage()` switch, add a new case before the closing `}`:

```typescript
case 'tool-ui-action': {
  const { requestId, action, data } = msg as import('./messages.js').ToolUIActionMsg;
  toolUIRegistry.handleAction(requestId, { action, data });
  break;
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/chrome-extension/src/offscreen-bridge.ts
git add packages/chrome-extension/src/offscreen-bridge.ts
git commit -m "feat: wire onToolUI/onToolUIDone and tool-ui-action in offscreen bridge"
```

---

### Task 3: Handle tool UI events in offscreen-client

**Files:**

- Modify: `packages/webapp/src/ui/offscreen-client.ts`

- [ ] **Step 1: Add tool_ui case to handleAgentEvent()**

In the `handleAgentEvent()` method's switch statement, after the `tool_end` case, add:

```typescript
case 'tool_ui': {
  let msgId = this.currentMessageId.get(msg.scoopJid);
  if (!msgId) {
    msgId = `scoop-${msg.scoopJid}-${uid()}`;
    this.currentMessageId.set(msg.scoopJid, msgId);
    this.emitToUI({ type: 'message_start', messageId: msgId });
  }
  this.emitToUI({
    type: 'tool_ui',
    messageId: msgId,
    toolName: msg.toolName ?? '',
    requestId: msg.requestId ?? '',
    html: msg.html ?? '',
  });
  break;
}

case 'tool_ui_done': {
  const msgId = this.currentMessageId.get(msg.scoopJid);
  if (msgId) {
    this.emitToUI({
      type: 'tool_ui_done',
      messageId: msgId,
      requestId: msg.requestId ?? '',
    });
  }
  break;
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/webapp/src/ui/offscreen-client.ts
git add packages/webapp/src/ui/offscreen-client.ts
git commit -m "feat: dispatch tool_ui events from offscreen-client to chat panel"
```

---

### Task 4: Pass data-picker from tool-ui-sandbox

**Files:**

- Modify: `packages/chrome-extension/tool-ui-sandbox.html`

- [ ] **Step 1: Include picker attribute in action messages**

In `tool-ui-sandbox.html`, in the click handler (around line 105), change the `sendToParent` call:

Before:

```javascript
sendToParent({
  type: 'tool-ui-action',
  id: window.__toolui_id,
  action: action,
  data: data,
});
```

After:

```javascript
var picker = target.dataset.picker || undefined;
sendToParent({
  type: 'tool-ui-action',
  id: window.__toolui_id,
  action: action,
  data: data,
  picker: picker,
});
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write packages/chrome-extension/tool-ui-sandbox.html
git add packages/chrome-extension/tool-ui-sandbox.html
git commit -m "feat: pass data-picker attribute in tool-ui-sandbox action messages"
```

---

### Task 5: Extension mode action relay in ToolUIRenderer

**Files:**

- Modify: `packages/webapp/src/ui/tool-ui-renderer.ts`

- [ ] **Step 1: Add IDB helper function**

At the bottom of `tool-ui-renderer.ts`, before the `activeRenderers` map, add:

```typescript
const PENDING_MOUNT_DB = 'slicc-pending-mount';

function openPendingMountDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PENDING_MOUNT_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

- [ ] **Step 2: Replace local toolUIRegistry call with offscreen relay in extension mode**

In the `renderInSandbox` method's message handler (around line 91), replace the existing `tool-ui-action` handler:

Before:

```typescript
if (msg.type === 'tool-ui-action' && msg.id === this.requestId) {
  log.info('Tool UI action received', { id: msg.id, action: msg.action });
  toolUIRegistry.handleAction(msg.id, {
    action: msg.action,
    data: msg.data,
  });
}
```

After:

```typescript
if (msg.type === 'tool-ui-action' && msg.id === this.requestId) {
  log.info('Tool UI action received', { id: msg.id, action: msg.action });
  this.relayActionToOffscreen(msg.action, msg.data, msg.picker);
}
```

- [ ] **Step 3: Add the relayActionToOffscreen method**

Add this method to the `ToolUIRenderer` class:

```typescript
private async relayActionToOffscreen(
  action: string,
  data: unknown,
  picker?: string
): Promise<void> {
  let actionData = data;

  if (picker === 'directory') {
    try {
      type ShowDirPicker = (opts?: object) => Promise<FileSystemDirectoryHandle>;
      const w = window as Window & typeof globalThis & { showDirectoryPicker?: ShowDirPicker };
      if (!w.showDirectoryPicker) {
        actionData = { error: 'showDirectoryPicker not available' };
      } else {
        const handle = await w.showDirectoryPicker({ mode: 'readwrite' });
        const idbKey = `pendingMount:${this.requestId}`;
        const db = await openPendingMountDb();
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(handle, idbKey);
        await new Promise<void>((r) => {
          tx.oncomplete = () => r();
        });
        db.close();
        actionData = { handleInIdb: true, idbKey, dirName: handle.name };
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        actionData = { cancelled: true };
      } else {
        actionData = { error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  chrome.runtime
    .sendMessage({
      source: 'panel' as const,
      payload: {
        type: 'tool-ui-action' as const,
        requestId: this.requestId,
        action,
        data: actionData,
      },
    })
    .catch((err: unknown) => {
      log.warn('Failed to relay tool UI action to offscreen', {
        requestId: this.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/tool-ui-renderer.ts
git add packages/webapp/src/ui/tool-ui-renderer.ts
git commit -m "feat: relay tool UI actions to offscreen with directory picker support"
```

---

### Task 6: Update mount-commands for IDB handle

**Files:**

- Modify: `packages/webapp/src/fs/mount-commands.ts`

- [ ] **Step 1: Add data-picker to approve button HTML**

In `mount-commands.ts`, in the `execute` method's tool UI HTML (around line 133), change the approve button:

Before:

```html
<button class="sprinkle-btn sprinkle-btn--primary" data-action="approve">Select directory</button>
```

After:

```html
<button class="sprinkle-btn sprinkle-btn--primary" data-action="approve" data-picker="directory">
  Select directory
</button>
```

- [ ] **Step 2: Add IDB helper to load and clean up handle**

Add at the bottom of the file, before the closing of the class:

```typescript
async function loadAndClearPendingHandle(
  idbKey: string
): Promise<FileSystemDirectoryHandle | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('slicc-pending-mount', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readwrite');
  const store = tx.objectStore('handles');
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
    const req = store.get(idbKey);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
  store.delete(idbKey);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
  db.close();
  return handle;
}
```

- [ ] **Step 3: Update onAction to handle IDB-stored handle**

Replace the `onAction` callback in the tool UI request (around line 138):

Before:

```typescript
onAction: async (action) => {
  if (action === 'approve') {
    // This runs with user gesture context!
    try {
      const handle = await (
        window as Window &
          typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }
      ).showDirectoryPicker({ mode: 'readwrite' });
      return { approved: true, handle };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { cancelled: true };
      }
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { denied: true };
},
```

After:

```typescript
onAction: async (action, data) => {
  if (action === 'approve') {
    const d = data as Record<string, unknown> | undefined;

    if (d?.handleInIdb && typeof d.idbKey === 'string') {
      try {
        const handle = await loadAndClearPendingHandle(d.idbKey);
        if (!handle) return { error: 'No directory handle found in storage' };
        return { approved: true, handle };
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (d?.cancelled) return { cancelled: true };
    if (d?.error) return { error: String(d.error) };

    try {
      const handle = await (
        window as Window &
          typeof globalThis & { showDirectoryPicker: ShowDirectoryPickerFn }
      ).showDirectoryPicker({ mode: 'readwrite' });
      return { approved: true, handle };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { cancelled: true };
      }
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { denied: true };
},
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/fs/mount-commands.ts
git add packages/webapp/src/fs/mount-commands.ts
git commit -m "feat: mount command handles IDB-stored directory handle from extension side panel"
```

---

### Task 7: Tests

**Files:**

- Modify: `packages/chrome-extension/tests/offscreen-bridge.test.ts`

- [ ] **Step 1: Read existing offscreen-bridge tests for patterns**

Read `packages/chrome-extension/tests/offscreen-bridge.test.ts` to understand the mock setup.

- [ ] **Step 2: Add test for onToolUI callback**

Add a test in the offscreen-bridge test file verifying that the `onToolUI` callback emits an `agent-event` message with `eventType: 'tool_ui'`:

```typescript
it('onToolUI emits agent-event with tool_ui eventType', () => {
  const callbacks = OffscreenBridge.createCallbacks(bridge);
  callbacks.onToolUI!('cone_1', 'bash', 'req-123', '<div>Mount?</div>');

  expect(sentMessages).toContainEqual(
    expect.objectContaining({
      source: 'offscreen',
      payload: expect.objectContaining({
        type: 'agent-event',
        scoopJid: 'cone_1',
        eventType: 'tool_ui',
        toolName: 'bash',
        requestId: 'req-123',
        html: '<div>Mount?</div>',
      }),
    })
  );
});
```

- [ ] **Step 3: Add test for onToolUIDone callback**

```typescript
it('onToolUIDone emits agent-event with tool_ui_done eventType', () => {
  const callbacks = OffscreenBridge.createCallbacks(bridge);
  callbacks.onToolUIDone!('cone_1', 'req-123');

  expect(sentMessages).toContainEqual(
    expect.objectContaining({
      source: 'offscreen',
      payload: expect.objectContaining({
        type: 'agent-event',
        scoopJid: 'cone_1',
        eventType: 'tool_ui_done',
        requestId: 'req-123',
      }),
    })
  );
});
```

- [ ] **Step 4: Add test for tool-ui-action handling**

This test verifies that a `tool-ui-action` message from the panel calls `toolUIRegistry.handleAction()`:

```typescript
it('tool-ui-action message calls toolUIRegistry.handleAction', async () => {
  // Need to import and mock the registry
  const { toolUIRegistry } = await import('../../../packages/webapp/src/tools/tool-ui.js');
  const spy = vi.spyOn(toolUIRegistry, 'handleAction').mockResolvedValue(undefined);

  // Simulate a panel message arriving
  const panelMsg = {
    source: 'panel',
    payload: {
      type: 'tool-ui-action',
      requestId: 'req-456',
      action: 'approve',
      data: { handleInIdb: true, idbKey: 'pendingMount:req-456', dirName: 'mydir' },
    },
  };

  // Trigger the message listener
  runtimeMessageListeners.forEach((listener) => listener(panelMsg, {}, () => {}));

  // Wait for async handling
  await vi.waitFor(() => {
    expect(spy).toHaveBeenCalledWith('req-456', {
      action: 'approve',
      data: { handleInIdb: true, idbKey: 'pendingMount:req-456', dirName: 'mydir' },
    });
  });

  spy.mockRestore();
});
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/chrome-extension/tests/offscreen-bridge.test.ts`
Expected: All tests pass including the new ones.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/chrome-extension/tests/offscreen-bridge.test.ts
git add packages/chrome-extension/tests/offscreen-bridge.test.ts
git commit -m "test: add tool UI bridge tests for offscreen-bridge"
```

---

### Task 8: Verification

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `npm run test`
Expected: PASS

- [ ] **Step 3: Build extension**

Run: `npm run build -w @slicc/chrome-extension`
Expected: PASS

- [ ] **Step 4: Build webapp (CLI)**

Run: `npm run build -w @slicc/webapp`
Expected: PASS

- [ ] **Step 5: Manual test — extension mode, agent mount**

1. Load extension from `dist/extension/` in `chrome://extensions`
2. Open side panel
3. Ask agent: "mount /workspace"
4. Verify approval card appears in chat
5. Click "Select directory" → directory picker opens
6. Select a directory → mount succeeds
7. Run `mount list` to confirm

- [ ] **Step 6: Manual test — extension mode, terminal mount**

1. In the terminal tab, type: `mount /mnt/test`
2. Directory picker should open directly (no approval card)
3. Select directory → mount succeeds

- [ ] **Step 7: Manual test — CLI mode, agent mount**

1. Run `npm run dev`
2. Ask agent: "mount /workspace"
3. Approval card appears, picker opens, mount succeeds (existing behavior)

- [ ] **Step 8: Format all changed files and final commit**

```bash
npx prettier --write packages/chrome-extension/src/messages.ts packages/chrome-extension/src/offscreen-bridge.ts packages/webapp/src/ui/offscreen-client.ts packages/webapp/src/ui/tool-ui-renderer.ts packages/chrome-extension/tool-ui-sandbox.html packages/webapp/src/fs/mount-commands.ts packages/chrome-extension/tests/offscreen-bridge.test.ts
git add -A
git status
```
