# Design: `slicc.captureScreen()` — Direct Screenshot Bridge Method

**Date:** 2026-05-22  
**Status:** Approved  
**Approach:** B (Panel-RPC proxy)

## Problem

Taking a screenshot from a sprinkle currently requires multiple LLM turns:
1. Sprinkle fires a lick to the agent
2. Agent calls `bash` → `screencapture -v /tmp/shot.png`
3. Chrome's native `getDisplayMedia()` picker appears, user selects target
4. Agent reads the file back and processes it

This is slow and wasteful — the infrastructure to capture screenshots already exists (`screencapture` command + panel-RPC handler), but sprinkles can't access it directly.

## Solution

Add `slicc.captureScreen()` to the sprinkle bridge API. It triggers Chrome's native `getDisplayMedia()` picker via the existing panel-RPC `screencapture` handler and returns the result directly as a Promise. Zero LLM involvement.

## API

```typescript
interface SprinkleBridgeAPI {
  // ... existing methods ...

  /** Capture a screen/window/tab via Chrome's native picker. Returns base64 PNG + metadata. */
  captureScreen(): Promise<{
    base64: string;      // PNG image data (no data: prefix)
    width: number;       // Pixel width
    height: number;      // Pixel height
    mimeType: string;    // Always 'image/png'
  }>;
}
```

### Usage from a sprinkle

```javascript
const shot = await slicc.captureScreen();
img.src = `data:${shot.mimeType};base64,${shot.base64}`;

// Or attach to chat for the agent to see:
slicc.attachImage(shot.base64, 'screenshot.png', shot.mimeType);
```

## Architecture

### Data Flow

```
Sprinkle calls slicc.captureScreen()
  → postMessage({ type: 'sprinkle-capture-screen', id })
    → SprinkleRenderer.messageHandler receives it
      → panelRpc.call('screencapture', { mimeType: 'image/png', quality: 1.0 })
        → panel-rpc-handlers.ts: getDisplayMedia() → Chrome native picker
        → User selects tab/window/screen
        → Canvas capture → Uint8Array bytes
      ← returns { bytes: Uint8Array }
    → Convert bytes to base64, extract dimensions from PNG header
  ← postMessage({ type: 'sprinkle-capture-screen-response', id, base64, width, height, mimeType })
← Promise resolves in sprinkle
```

### Why Panel-RPC

The `screencapture` panel-RPC handler already exists in `panel-rpc-handlers.ts` and handles:
- Local DOM path (CLI mode — has `navigator.mediaDevices` directly)
- Worker path (kernel worker → panel-RPC → page-side capture)
- 5-minute timeout for the picker dialog
- Focus management after capture

By routing through panel-RPC, we get all this for free with zero duplication.

### Extension Mode

In extension mode, sprinkles render inside `sprinkle-sandbox.html` (CSP-exempt iframe). The message flow is:

```
Sprinkle → postMessage → sandbox parent (sprinkle-renderer.ts)
  → panelRpc.call('screencapture', ...) → panel-rpc-handlers.ts
  → getDisplayMedia() on the side panel page
  → response flows back through the same postMessage chain
```

Same pattern already used by `readFile`, `writeFile`, `exists`, etc.

## Files to Change

| File | Change |
|------|--------|
| `packages/webapp/src/ui/sprinkle-bridge.ts` | Add `captureScreen()` to `SprinkleBridgeAPI` interface. Add implementation in `createAPI()` that calls a new constructor-injected handler. |
| `packages/webapp/src/ui/sprinkle-renderer.ts` | Add `sprinkle-capture-screen` message handler. Uses `hasLocalDom()` to decide path: if local DOM available, call `captureLocally()` directly (CLI mode — renderer is on the page with `navigator.mediaDevices`); otherwise call panel-RPC. Converts bytes to base64, extracts PNG dimensions, posts response back. |
| `packages/webapp/src/ui/sprinkle-renderer.ts` | Extend the postMessage bridge script (injected into full-document iframes) with the `captureScreen` wrapper that generates an `id`, posts the message, and returns a Promise. |
| `packages/webapp/src/ui/sprinkle-manager.ts` | Wire the new handler through to the bridge (if needed — may just need the panel-RPC client reference). |
| `packages/webapp/src/shell/supplemental-commands/screencapture-command.ts` | Extract `captureLocally()` to a shared util so both the shell command and sprinkle renderer can import it without duplicating code. |

## PNG Dimension Extraction

To return `width` and `height` without decoding the full image, read the PNG IHDR chunk:
- Bytes 16-19: width (big-endian uint32)
- Bytes 20-23: height (big-endian uint32)

This is a 4-line utility — no external dependencies needed.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| User cancels picker | Promise rejects: `"User cancelled or permission denied"` |
| `getDisplayMedia` unavailable | Promise rejects: `"Screen capture not supported in this browser"` |
| Timeout (5 min) | Promise rejects: panel-RPC timeout error |
| Panel-RPC unavailable (no DOM, no bridge) | Promise rejects: `"Screen capture unavailable in this environment"` |

## Testing

- Unit test: mock panel-RPC, verify message flow and base64 conversion
- Unit test: PNG dimension extraction from IHDR
- Unit test: error cases (cancel, timeout, unsupported)
- Integration: manual test in CLI mode — sprinkle calls `captureScreen()`, verify picker appears and image data returns

## Out of Scope

- Tab selection without user interaction (would bypass browser security model)
- Video/stream capture (single frame only)
- Scoop-level access (scoops use shell commands; this is sprinkle-bridge only)
- Custom picker UI (Chrome's native `getDisplayMedia` dialog is sufficient)
