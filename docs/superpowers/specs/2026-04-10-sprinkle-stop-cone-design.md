# Sprinkle Stop Cone

Add `slicc.stopCone()` to the sprinkle bridge API so a sprinkle can interrupt and stop the cone agent from a button click in the sprinkle UI.

## Scope

Stop the cone only. Running scoops continue unaffected.

## Approach

Callback pattern matching the existing `closeHandler` in `SprinkleBridge`. A new `stopConeHandler: () => void` callback flows through the same constructor chain. The sprinkle-side API is a flat fire-and-forget method on `slicc`, consistent with `slicc.close()`.

## Changes

### 1. Bridge API and interface (`sprinkle-bridge.ts`)

- Add `stopCone(): void` to `SprinkleBridgeAPI` interface.
- Add `stopConeHandler: () => void` constructor parameter to `SprinkleBridge`.
- Wire `stopCone` in `createAPI()`: calls `this.stopConeHandler()`.

### 2. Sprinkle manager (`sprinkle-manager.ts`)

- Add `stopConeHandler: () => void` constructor parameter.
- Pass it through to `new SprinkleBridge(fs, lickHandler, closeHandler, stopConeHandler)`.

### 3. postMessage protocol (`sprinkle-renderer.ts`)

New fire-and-forget message type: `sprinkle-stop-cone` (no payload).

- Sandbox mode message handler: add `sprinkle-stop-cone` case calling `this.bridge.stopCone()`.
- Full-doc mode message handler: same.
- Generated bridge script IIFE: add `stopCone: function() { parent.postMessage({ type: 'sprinkle-stop-cone' }, '*'); }` to the `api` object.

### 4. Extension sandbox (`sprinkle-sandbox.html`)

- Add `stopCone` to `window.slicc` bridge proxy: `parent.postMessage({ type: 'sprinkle-stop-cone' }, '*')`.
- Add `stopCone` to `buildNestedBridgeScript()` bridge object for full-doc nested iframes.
- Forward `sprinkle-stop-cone` in the nested iframe message relay.

### 5. Wiring in `main.ts`

Two `SprinkleManager` creation sites, one per mode:

**CLI/standalone mode** (~line 1432):

- `stopConeHandler` finds the cone via `orchestrator.getScoops().find(s => s.isCone)`.
- Calls `orchestrator.stopScoop(cone.jid)` and `orchestrator.clearQueuedMessages(cone.jid)`.

**Extension mode** (~line 539):

- `stopConeHandler` finds the cone via `client.getScoops().find(s => s.isCone)`.
- Calls `client.stopScoop(cone.jid)` which sends `{ type: 'abort', scoopJid }` to offscreen (handles stop + clear in one shot).

### 6. Documentation (`SKILL.md`)

Add `slicc.stopCone()` to the Bridge API list in `packages/vfs-root/workspace/skills/sprinkles/SKILL.md`.

### 7. Tests

Add a test verifying `stopCone()` calls the handler callback.

## Out of scope

- Dips (`dip.ts`): ephemeral chat widgets with a minimal lick-only bridge. Stop controls don't fit their use case.
- Stopping scoops from sprinkles. Only the cone is targeted.
- Pause/resume or other control verbs. If needed later, refactor then.
