# Sprinkle Stop Cone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let sprinkles interrupt the cone agent via `slicc.stopCone()`.

**Architecture:** New `stopConeHandler` callback flows through `SprinkleManager` → `SprinkleBridge` → `createAPI()`, matching the existing `closeHandler` pattern. The postMessage layer adds a fire-and-forget `sprinkle-stop-cone` message type. Two `main.ts` wiring sites (CLI and extension) find the cone and call its stop method.

**Tech Stack:** TypeScript, Vitest, vanilla JS (bridge scripts in sprinkle-renderer.ts and sprinkle-sandbox.html)

---

## File Map

| Action | File                                                    | Responsibility                                              |
| ------ | ------------------------------------------------------- | ----------------------------------------------------------- |
| Modify | `packages/webapp/src/ui/sprinkle-bridge.ts`             | Add `stopCone` to interface, constructor, and `createAPI()` |
| Modify | `packages/webapp/tests/ui/sprinkle-bridge.test.ts`      | Test `stopCone()` calls handler                             |
| Modify | `packages/webapp/src/ui/sprinkle-manager.ts`            | Accept and forward `stopConeHandler`                        |
| Modify | `packages/webapp/src/ui/sprinkle-renderer.ts`           | Handle `sprinkle-stop-cone` postMessage + bridge script     |
| Modify | `packages/chrome-extension/sprinkle-sandbox.html`       | Add `stopCone` to bridge proxy + nested bridge + relay      |
| Modify | `packages/webapp/src/ui/main.ts`                        | Wire handler at both creation sites                         |
| Modify | `packages/vfs-root/workspace/skills/sprinkles/SKILL.md` | Document `slicc.stopCone()`                                 |

---

### Task 1: Bridge API — test and implementation

**Files:**

- Modify: `packages/webapp/tests/ui/sprinkle-bridge.test.ts`
- Modify: `packages/webapp/src/ui/sprinkle-bridge.ts`

- [ ] **Step 1: Write the failing test**

Add to the end of the `describe('SprinkleBridge')` block in `packages/webapp/tests/ui/sprinkle-bridge.test.ts`:

```typescript
it('stopCone() calls the stop-cone handler', () => {
  const api = bridge.createAPI('test-sprinkle');
  api.stopCone();
  expect(stopConeHandlerMock).toHaveBeenCalledTimes(1);
});
```

Update the `beforeEach` to add the new mock and pass it to the constructor. The full updated `beforeEach` and variable block:

```typescript
let bridge: SprinkleBridge;
let lickHandler: (event: LickEvent) => void;
let lickHandlerMock: ReturnType<typeof vi.fn>;
let closeHandler: (name: string) => void;
let closeHandlerMock: ReturnType<typeof vi.fn>;
let stopConeHandlerMock: ReturnType<typeof vi.fn>;
let mockFs: VirtualFS;

beforeEach(() => {
  lickHandlerMock = vi.fn();
  lickHandler = lickHandlerMock as unknown as (event: LickEvent) => void;
  closeHandlerMock = vi.fn();
  closeHandler = closeHandlerMock as unknown as (name: string) => void;
  stopConeHandlerMock = vi.fn();
  mockFs = {
    readFile: vi.fn().mockResolvedValue('file content'),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readDir: vi.fn().mockResolvedValue([
      { name: 'test.txt', type: 'file' },
      { name: 'subdir', type: 'directory' },
    ]),
    exists: vi.fn().mockResolvedValue(true),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 42, mtime: 1000, ctime: 1000 }),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  } as unknown as VirtualFS;
  bridge = new SprinkleBridge(mockFs, lickHandler, closeHandler, stopConeHandlerMock);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/sprinkle-bridge.test.ts`

Expected: Compilation error — `SprinkleBridge` constructor doesn't accept 4th argument, and `stopCone` doesn't exist on `SprinkleBridgeAPI`.

- [ ] **Step 3: Implement `stopCone` in the bridge**

In `packages/webapp/src/ui/sprinkle-bridge.ts`, make three changes:

**3a.** Add `stopCone` to the interface (after `close(): void;` at line 42):

```typescript
/** Stop the cone agent */
stopCone(): void;
```

**3b.** Add the handler field and constructor parameter. The full updated class header and constructor:

```typescript
export class SprinkleBridge {
  private listeners = new Map<string, Set<UpdateCallback>>();
  private lickHandler: (event: LickEvent) => void;
  private fs: VirtualFS;
  private closeHandler: (name: string) => void;
  private stopConeHandler: () => void;

  constructor(
    fs: VirtualFS,
    lickHandler: (event: LickEvent) => void,
    closeHandler: (name: string) => void,
    stopConeHandler: () => void
  ) {
    this.fs = fs;
    this.lickHandler = lickHandler;
    this.closeHandler = closeHandler;
    this.stopConeHandler = stopConeHandler;
  }
```

**3c.** Wire `stopCone` in `createAPI()`. Add after the `close` line (after line 160):

```typescript
stopCone: () => this.stopConeHandler(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/webapp/tests/ui/sprinkle-bridge.test.ts`

Expected: All tests pass including the new `stopCone()` test. The existing tests will fail because of the missing 4th constructor arg — but we already updated `beforeEach` in step 1 to supply it, so they should all pass.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/sprinkle-bridge.ts packages/webapp/tests/ui/sprinkle-bridge.test.ts
git add packages/webapp/src/ui/sprinkle-bridge.ts packages/webapp/tests/ui/sprinkle-bridge.test.ts
git commit -m "feat(sprinkle-bridge): add stopCone() to bridge API and interface"
```

---

### Task 2: Sprinkle Manager — forward the handler

**Files:**

- Modify: `packages/webapp/src/ui/sprinkle-manager.ts`

- [ ] **Step 1: Add `stopConeHandler` parameter to `SprinkleManager` constructor**

Update the constructor signature and the `SprinkleBridge` creation. The full updated constructor:

```typescript
constructor(
  fs: VirtualFS,
  lickHandler: (event: LickEvent) => void,
  callbacks: SprinkleManagerCallbacks,
  stopConeHandler: () => void
) {
  this.fs = fs;
  this.bridge = new SprinkleBridge(fs, lickHandler, (name) => this.close(name), stopConeHandler);
  this.callbacks = callbacks;
}
```

Note: the `callbacks` parameter stays in its current 3rd position; `stopConeHandler` is appended as 4th. This matches the bridge's constructor order.

- [ ] **Step 2: Verify the bridge test still passes**

Run: `npx vitest run packages/webapp/tests/ui/sprinkle-bridge.test.ts`

Expected: All tests pass (SprinkleManager isn't directly tested here, but confirms the bridge interface is still compatible).

- [ ] **Step 3: Commit**

```bash
npx prettier --write packages/webapp/src/ui/sprinkle-manager.ts
git add packages/webapp/src/ui/sprinkle-manager.ts
git commit -m "feat(sprinkle-manager): accept and forward stopConeHandler"
```

---

### Task 3: postMessage protocol — renderer message handlers and bridge script

**Files:**

- Modify: `packages/webapp/src/ui/sprinkle-renderer.ts`

- [ ] **Step 1: Add `sprinkle-stop-cone` to the sandbox mode message handler**

In `sprinkle-renderer.ts`, find the sandbox mode message handler (around line 102-107). Add a new `else if` after the `sprinkle-close` case:

```typescript
} else if (msg.type === 'sprinkle-stop-cone') {
  this.bridge.stopCone();
}
```

The context — insert between the `sprinkle-close` block and the `sprinkle-storage-set` block:

```typescript
      } else if (msg.type === 'sprinkle-close') {
        this.bridge.close();
      } else if (msg.type === 'sprinkle-stop-cone') {
        this.bridge.stopCone();
      } else if (msg.type === 'sprinkle-storage-set') {
```

- [ ] **Step 2: Add `sprinkle-stop-cone` to the full-doc mode message handler**

Find the full-doc mode message handler (around line 464-469). Add the same case after `sprinkle-close`:

```typescript
      } else if (msg.type === 'sprinkle-close') {
        this.bridge.close();
      } else if (msg.type === 'sprinkle-stop-cone') {
        this.bridge.stopCone();
      } else if (msg.type === 'sprinkle-readfile') {
```

- [ ] **Step 3: Add `stopCone` to the generated bridge script IIFE**

In the `generateBridgeScript()` method, find the `close` function in the `api` object (around line 381). Add `stopCone` after it:

```javascript
    close: function() { parent.postMessage({ type: 'sprinkle-close' }, '*'); },
    stopCone: function() { parent.postMessage({ type: 'sprinkle-stop-cone' }, '*'); },
    name: ''
```

- [ ] **Step 4: Run typecheck to verify no errors**

Run: `npx tsc --noEmit -p packages/webapp/tsconfig.json`

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/sprinkle-renderer.ts
git add packages/webapp/src/ui/sprinkle-renderer.ts
git commit -m "feat(sprinkle-renderer): handle sprinkle-stop-cone postMessage"
```

---

### Task 4: Extension sandbox — bridge proxy, nested bridge, and relay

**Files:**

- Modify: `packages/chrome-extension/sprinkle-sandbox.html`

- [ ] **Step 1: Add `stopCone` to the `window.slicc` bridge proxy**

Find the `close` function on `window.slicc` (around line 223-225). Add `stopCone` after it:

```javascript
  close: function() {
    parent.postMessage({ type: 'sprinkle-close' }, '*');
  },
  stopCone: function() {
    parent.postMessage({ type: 'sprinkle-stop-cone' }, '*');
  },
};
```

- [ ] **Step 2: Add `stopCone` to `buildNestedBridgeScript()`**

In the `buildNestedBridgeScript()` function, find the `close` line in the `window.slicc` object (around line 324). Add `stopCone` after it:

```javascript
'close: function() { parent.postMessage({ type: "sprinkle-close" }, "*"); },' +
'stopCone: function() { parent.postMessage({ type: "sprinkle-stop-cone" }, "*"); }' +
```

Note: the `close` line previously ended the object (no trailing comma before the `};`). Now `close` needs a trailing comma and `stopCone` becomes the last entry.

- [ ] **Step 3: Add `sprinkle-stop-cone` to the nested iframe relay**

In the message handler at the bottom (around line 455-462), find the `bridgeTypes` array and add `'sprinkle-stop-cone'` to it:

```javascript
var bridgeTypes = [
  'sprinkle-lick',
  'sprinkle-set-state',
  'sprinkle-close',
  'sprinkle-stop-cone',
  'sprinkle-open',
  'sprinkle-readfile',
  'sprinkle-writefile',
  'sprinkle-readdir',
  'sprinkle-exists',
  'sprinkle-stat',
  'sprinkle-mkdir',
  'sprinkle-rm',
  'sprinkle-storage-set',
  'sprinkle-storage-remove',
  'sprinkle-storage-clear',
  'dip-lick',
  'dip-height',
];
```

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/chrome-extension/sprinkle-sandbox.html
git add packages/chrome-extension/sprinkle-sandbox.html
git commit -m "feat(extension): add stopCone to sprinkle sandbox bridge and relay"
```

---

### Task 5: Wire stopConeHandler in `main.ts`

**Files:**

- Modify: `packages/webapp/src/ui/main.ts`

- [ ] **Step 1: Wire handler for the extension mode SprinkleManager**

Find the extension-mode `SprinkleManager` creation (around line 539-600). It currently has 3 arguments: `localFs`, `lickHandler`, `callbacks`. Add the 4th argument `stopConeHandler` after the callbacks object:

```typescript
const sprinkleManager = new SprinkleManager(
  localFs,
  async (event: LickEvent) => {
    // ... existing lick handler unchanged ...
  },
  {
    addSprinkle: (name, title, element, zone) =>
      layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined),
    removeSprinkle: (name) => layout.removeSprinkle(name),
  },
  () => {
    const cone = client.getScoops().find((s) => s.isCone);
    if (cone) {
      client.stopScoop(cone.jid);
    }
  }
);
```

- [ ] **Step 2: Wire handler for the CLI/standalone mode SprinkleManager**

Find the CLI-mode `SprinkleManager` creation (around line 1430-1436). It currently has 3 arguments: `sharedFs`, `routeLickToScoop`, `callbacks`. Add the 4th argument:

```typescript
sprinkleManager = new SprinkleManager(
  sharedFs,
  routeLickToScoop,
  {
    addSprinkle: (name, title, element, zone) =>
      layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined),
    removeSprinkle: (name) => layout.removeSprinkle(name),
  },
  () => {
    const cone = orchestrator.getScoops().find((s) => s.isCone);
    if (cone) {
      orchestrator.stopScoop(cone.jid);
      orchestrator.clearQueuedMessages(cone.jid).catch((err) => {
        log.error('Failed to clear queued messages on sprinkle stopCone', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
);
```

Note: the CLI handler calls both `stopScoop` and `clearQueuedMessages` (matching `coneAgentHandle.stop()` at line 1215). The extension handler only calls `client.stopScoop()` because the offscreen bridge's `abort` handler already clears queued messages.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p packages/webapp/tsconfig.json`

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
npx prettier --write packages/webapp/src/ui/main.ts
git add packages/webapp/src/ui/main.ts
git commit -m "feat(main): wire stopConeHandler for CLI and extension sprinkle managers"
```

---

### Task 6: Documentation

**Files:**

- Modify: `packages/vfs-root/workspace/skills/sprinkles/SKILL.md`

- [ ] **Step 1: Add `slicc.stopCone()` to the Bridge API list**

In `SKILL.md`, find the Bridge API section (around line 47-61). Add after the `slicc.close()` entry (line 52):

```markdown
- `slicc.stopCone()` — stop the cone agent
```

The updated block:

```markdown
- `slicc.lick({action: 'refresh', data: {...}})` — send a lick event to the cone (cone routes to the right scoop)
- `slicc.on('update', function(data) {...})` — receive data sent via `sprinkle send`
- `slicc.name` — the sprinkle's name
- `slicc.close()` — close the sprinkle
- `slicc.stopCone()` — stop the cone agent
- `slicc.readFile(path)` — read a VFS file (returns `Promise<string>`)
```

- [ ] **Step 2: Commit**

```bash
npx prettier --write packages/vfs-root/workspace/skills/sprinkles/SKILL.md
git add packages/vfs-root/workspace/skills/sprinkles/SKILL.md
git commit -m "docs(sprinkles): document slicc.stopCone() in bridge API"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`

Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: No errors.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: Clean build.

- [ ] **Step 4: Run extension build**

Run: `npm run build -w @slicc/chrome-extension`

Expected: Clean build including the modified `sprinkle-sandbox.html`.
