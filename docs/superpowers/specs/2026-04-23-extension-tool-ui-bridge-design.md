# Extension Tool UI Bridge

## Problem

When the agent runs `mount /workspace` via the bash tool in extension mode, the tool UI approval dialog never appears and the command hangs forever.

Three missing pieces in the extension plumbing:

1. **Offscreen bridge missing callbacks** — `onToolUI`/`onToolUIDone` are not implemented in `OffscreenBridge.createCallbacks()`, so tool UI HTML emitted by `showToolUIFromContext()` never reaches the side panel.
2. **No action relay path** — no `PanelToOffscreenMessage` type exists to send user clicks from the side panel's `ToolUIRenderer` back to the offscreen's `toolUIRegistry`.
3. **Directory picker context mismatch** — mount's `onAction` callback calls `showDirectoryPicker()`, which requires user gesture in a visible window. The offscreen document has neither.

In CLI mode all three happen in the same JS context, so tool UI works. The extension's three-layer split (side panel / service worker / offscreen) breaks the assumption.

## Solution

Wire the existing tool UI system through the extension messaging layer, and handle the directory picker in the side panel where user gesture context exists.

### File Changes

#### 1. `packages/chrome-extension/src/messages.ts`

Extend `AgentEventMsg.eventType` union with `'tool_ui' | 'tool_ui_done'`. Add optional fields to `AgentEventMsg`:

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
  // existing fields...
  requestId?: string;
  html?: string;
}
```

Add a new panel→offscreen message:

```typescript
export interface ToolUIActionMsg {
  type: 'tool-ui-action';
  requestId: string;
  action: string;
  data?: unknown;
}
```

Add `ToolUIActionMsg` to the `PanelToOffscreenMessage` union.

#### 2. `packages/chrome-extension/src/offscreen-bridge.ts`

Add `onToolUI` and `onToolUIDone` to `createCallbacks()`:

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

Handle the new `tool-ui-action` panel message in `handlePanelMessage()`:

```typescript
case 'tool-ui-action': {
  const { requestId, action, data } = msg;
  toolUIRegistry.handleAction(requestId, { action, data });
  break;
}
```

Import `toolUIRegistry` from `packages/webapp/src/tools/tool-ui.js`.

#### 3. `packages/webapp/src/ui/offscreen-client.ts`

Handle `tool_ui` and `tool_ui_done` in `handleAgentEvent()`:

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

#### 4. `packages/webapp/src/ui/tool-ui-renderer.ts`

In extension mode, replace the local `toolUIRegistry.handleAction()` call with a relay to the offscreen document. When the action includes `picker: 'directory'`, call `showDirectoryPicker()` in the side panel (user gesture context), store the handle in the shared `slicc-pending-mount` IndexedDB, then include `{ handleInIdb: true, dirName }` in the relayed action data.

```typescript
// Extension mode: relay action to offscreen (where toolUIRegistry lives)
if (isExtension) {
  let actionData = msg.data;

  if (msg.picker === 'directory') {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      // Store in shared IDB so offscreen mount-commands can retrieve it
      const db = await openPendingMountDb();
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(handle, 'pendingMount');
      await new Promise((r) => {
        tx.oncomplete = r;
      });
      db.close();
      actionData = { ...(actionData || {}), handleInIdb: true, dirName: handle.name };
    } catch (err) {
      if (err.name === 'AbortError') {
        actionData = { cancelled: true };
      } else {
        actionData = { error: err.message };
      }
    }
  }

  chrome.runtime.sendMessage({
    source: 'panel',
    payload: {
      type: 'tool-ui-action',
      requestId: this.requestId,
      action: msg.action,
      data: actionData,
    },
  });
  return;
}
```

Helper for IDB access (same DB/store as the welcome sprinkle):

```typescript
function openPendingMountDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('slicc-pending-mount', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('handles');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

#### 5. `packages/chrome-extension/tool-ui-sandbox.html`

Extend the click handler to include `picker` in the posted message when the button has `data-picker`:

```javascript
sendToParent({
  type: 'tool-ui-action',
  id: window.__toolui_id,
  action: action,
  data: data,
  picker: target.dataset.picker || undefined,
});
```

#### 6. `packages/webapp/src/fs/mount-commands.ts`

Two changes:

**a)** Add `data-picker="directory"` to the approve button in the tool UI HTML:

```html
<button class="sprinkle-btn sprinkle-btn--primary" data-action="approve" data-picker="directory">
  Select directory
</button>
```

**b)** In `onAction`, check for `handleInIdb` and load from IndexedDB instead of calling the picker:

```typescript
onAction: async (action, data) => {
  if (action === 'approve') {
    const d = data as Record<string, unknown> | undefined;

    // Extension mode: side panel already ran the picker and stored handle in IDB
    if (d?.handleInIdb) {
      try {
        const handle = await loadPendingMountHandle();
        if (!handle) return { error: 'No directory handle found' };
        return { approved: true, handle, dirName: d.dirName };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }

    // CLI mode: call picker directly (has user gesture from onAction callback)
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      return { approved: true, handle };
    } catch (err) {
      if (err.name === 'AbortError') return { cancelled: true };
      return { error: err.message };
    }
  }
  return { denied: true };
},
```

Add helper to load handle from the same IDB the side panel wrote to:

```typescript
async function loadPendingMountHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('slicc-pending-mount', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('handles');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readonly');
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
    const req = tx.objectStore('handles').get('pendingMount');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return handle;
}
```

### Data Flow

```
Agent bash (offscreen) → mount → showToolUIFromContext() → onUpdate
  → scoop-context tool_execution_update → orchestrator onToolUI callback
  → offscreen-bridge emits agent-event {eventType: 'tool_ui', requestId, html}
  → chrome.runtime → service worker relay → side panel offscreen-client
  → emitToUI({type: 'tool_ui', ...}) → chat panel → ToolUIRenderer
  → tool-ui-sandbox.html renders approval card

User clicks "Select directory" [data-action="approve" data-picker="directory"]
  → tool-ui-sandbox posts {action: 'approve', picker: 'directory'} to parent
  → ToolUIRenderer detects picker='directory'
  → calls showDirectoryPicker() in side panel (user gesture ✓)
  → stores handle in slicc-pending-mount IndexedDB
  → sends panel→offscreen: {type: 'tool-ui-action', action: 'approve', data: {handleInIdb: true}}
  → offscreen-bridge → toolUIRegistry.handleAction()
  → mount onAction receives action='approve', data.handleInIdb=true
  → loads handle from IndexedDB
  → fs.mount(targetPath, handle) → success
```

### Testing

- Verify mount works from agent in extension mode (shows approval card, picker opens, mount succeeds)
- Verify mount still works from terminal in extension mode (direct picker, no approval card)
- Verify mount works from agent in CLI mode (existing behavior, no regression)
- Add unit test in `packages/chrome-extension/tests/` for the new message types
- Verify tool-ui-sandbox passes `picker` attribute in action messages

### Scope

This fix is specifically for the tool UI bridge in extension mode. The only tool currently using `showToolUIFromContext()` is the mount command, but the relay mechanism is generic — any future tool UI will work across the extension boundary without additional plumbing.
