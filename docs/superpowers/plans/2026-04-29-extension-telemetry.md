# Extension Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SLICC Chrome extension's side panel emit Helix RUM beacons via an inlined `rum.js` (modeled on `@adobe/aem-sidekick`), while CLI/Electron continue to use `@adobe/helix-rum-js`. Finish wiring three previously-declared-but-dead `track*` functions at panel-realm callsites in shared UI code.

**Architecture:** `packages/webapp/src/ui/telemetry.ts` becomes a small dispatcher branching on `getModeLabel()`: extension → inlined `./rum.js` (default export); CLI/Electron → `@adobe/helix-rum-js` (named `sampleRUM`). Both implementations share the `(checkpoint, data)` signature so the public `track*` wrappers are untouched. `trackChatSend` moves from `orchestrator.ts:1065` to `ChatPanel.sendMessage()` so the beacon fires from the panel realm (where telemetry actually inits in extension mode). Three new wirings (`trackSettingsOpen`, `trackImageView`, `trackError`) land in shared UI code; automatic `error` capture is gated to the extension branch only to avoid double-firing alongside helix-rum-js's built-in handlers.

**Tech Stack:** TypeScript + plain JS (`rum.js`), Vitest for tests, vanilla DOM (no framework), `navigator.sendBeacon`, JSDOM-friendly. Spec at `docs/superpowers/specs/2026-04-28-extension-telemetry-design.md`.

---

## Task 1: Create the inlined `rum.js` (TDD)

**Files:**

- Create: `packages/webapp/src/ui/rum.js`
- Test: `packages/webapp/tests/ui/rum.test.ts`

- [ ] **Step 1.1: Write the failing test for selection logic + beacon shape**

Create `packages/webapp/tests/ui/rum.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('rum.js', () => {
  let sendBeaconSpy: ReturnType<typeof vi.fn>;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete (globalThis as any).window;
    (globalThis as any).window = {
      hlx: undefined,
      location: { href: 'https://example.test/page' },
      RUM_GENERATION: 'slicc-extension',
    };
    sendBeaconSpy = vi.fn().mockReturnValue(true);
    (globalThis as any).navigator = { sendBeacon: sendBeaconSpy };
    const store: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
    vi.resetModules();
  });

  afterEach(() => {
    randomSpy?.mockRestore();
    delete (globalThis as any).window;
    delete (globalThis as any).navigator;
    delete (globalThis as any).localStorage;
  });

  it('sends a beacon when isSelected (random*weight < 1)', async () => {
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    sampleRUM('formsubmit', { source: 'cone', target: 'claude' });

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeaconSpy.mock.calls[0];
    expect(url).toBe('https://rum.hlx.page/.rum/10');
    const parsed = JSON.parse(body as string);
    expect(parsed).toMatchObject({
      weight: 10,
      checkpoint: 'formsubmit',
      source: 'cone',
      target: 'claude',
      generation: 'slicc-extension',
      referer: 'https://example.test/page',
    });
    expect(typeof parsed.id).toBe('string');
  });

  it('skips beacons when not selected (random*weight >= 1)', async () => {
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    sampleRUM('formsubmit', { source: 'cone' });

    expect(sendBeaconSpy).not.toHaveBeenCalled();
  });

  it('debug flag forces weight=1 and selection', async () => {
    (globalThis as any).localStorage.setItem('slicc-rum-debug', '1');
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    sampleRUM('navigate', { target: 'extension' });

    expect(sendBeaconSpy).toHaveBeenCalledTimes(1);
    const [url, body] = sendBeaconSpy.mock.calls[0];
    expect(url).toBe('https://rum.hlx.page/.rum/1');
    expect(JSON.parse(body as string)).toMatchObject({ weight: 1 });
  });

  it('caches the per-pageview decision on window.hlx.rum', async () => {
    randomSpy = vi.spyOn(Math, 'random').mockReturnValueOnce(0.05).mockReturnValueOnce(0.99);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    sampleRUM('a');
    sampleRUM('b');

    expect(sendBeaconSpy).toHaveBeenCalledTimes(2);
    const id1 = JSON.parse(sendBeaconSpy.mock.calls[0][1] as string).id;
    const id2 = JSON.parse(sendBeaconSpy.mock.calls[1][1] as string).id;
    expect(id1).toBe(id2);
  });

  it('never throws on internal errors', async () => {
    sendBeaconSpy.mockImplementation(() => {
      throw new Error('boom');
    });
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.05);
    const { default: sampleRUM } = await import('../../src/ui/rum.js');

    expect(() => sampleRUM('formsubmit')).not.toThrow();
  });
});
```

- [ ] **Step 1.2: Run the test — verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/rum.test.ts`
Expected: FAIL with `Cannot find module '.../rum.js'`.

- [ ] **Step 1.3: Implement `rum.js` minimally**

Create `packages/webapp/src/ui/rum.js`:

```js
/**
 * Inlined Helix RUM sampler — extension panel only.
 * Modeled on @adobe/aem-sidekick's src/extension/utils/rum.js.
 * Fires fire-and-forget beacons via navigator.sendBeacon to rum.hlx.page.
 *
 * Substitutions vs aem-sidekick:
 *   - pageview source: window.location (not target-page location)
 *   - debug flag: localStorage 'slicc-rum-debug' === '1' (not URL query)
 *   - generation: window.RUM_GENERATION (set by telemetry.ts)
 */

export default function sampleRUM(checkpoint, data = {}) {
  try {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    window.hlx = window.hlx || {};
    if (!window.hlx.rum) {
      let debug = false;
      try {
        debug = localStorage.getItem('slicc-rum-debug') === '1';
      } catch {
        // localStorage may be inaccessible in some contexts
      }
      const weight = debug ? 1 : 10;
      const random = Math.random();
      const isSelected = random * weight < 1;
      const id = `${hashCode(window.location.href)}-${Date.now()}-${rand14()}`;
      window.hlx.rum = { weight, id, random, isSelected, sampleRUM };
    }
    const { weight, id, isSelected } = window.hlx.rum;
    if (!isSelected) return;
    const body = JSON.stringify({
      weight,
      id,
      referer: window.location.href,
      generation: window.RUM_GENERATION,
      checkpoint,
      ...data,
    });
    navigator.sendBeacon(`https://rum.hlx.page/.rum/${weight}`, body);
  } catch {
    // never throw
  }
}

function hashCode(s) {
  return s.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
}

function rand14() {
  return Math.random().toString(16).slice(2, 16);
}
```

- [ ] **Step 1.4: Run the tests — verify they pass**

Run: `npx vitest run packages/webapp/tests/ui/rum.test.ts`
Expected: 5 passed.

- [ ] **Step 1.5: Run prettier on touched files**

Run: `npx prettier --write packages/webapp/src/ui/rum.js packages/webapp/tests/ui/rum.test.ts`

- [ ] **Step 1.6: Commit**

```bash
git add packages/webapp/src/ui/rum.js packages/webapp/tests/ui/rum.test.ts
git commit -m "feat(extension-rum): add inlined rum.js for extension-side beacon"
```

---

## Task 2: Make `telemetry.ts` a mode dispatcher (TDD on extension branch)

The current `telemetry.ts` always imports `@adobe/helix-rum-js`. Add an extension branch that imports `./rum.js` and sets `RUM_GENERATION` per mode.

**Files:**

- Modify: `packages/webapp/src/ui/telemetry.ts`
- Modify: `packages/webapp/tests/ui/telemetry.test.ts`

- [ ] **Step 2.1a: Switch `telemetry.test.ts` to jsdom**

The existing test file uses Vitest's default `node` environment, where `window` is `undefined`. The new assertions read `window.RUM_GENERATION` and the Task 3 tests dispatch `window` events, so the file needs a real `window`. Add this directive as the very first line of `packages/webapp/tests/ui/telemetry.test.ts` (matches the pattern used by `chat-panel-lick.test.ts` and `tab-zone.test.ts`):

```ts
// @vitest-environment jsdom
```

Run: `npx vitest run packages/webapp/tests/ui/telemetry.test.ts`
Expected: the existing 10 tests still pass under jsdom.

- [ ] **Step 2.1: Add the failing extension-branch test**

Append a new `describe` block at the end of `packages/webapp/tests/ui/telemetry.test.ts`:

```ts
describe('telemetry — extension branch', () => {
  const mockSampleRumJs = vi.fn();

  beforeEach(() => {
    mockLocalStorage.clear();
    mockSampleRUM.mockClear();
    mockSampleRumJs.mockClear();
    vi.resetModules();
    vi.stubGlobal('chrome', { runtime: { id: 'test-extension' } });
    vi.doMock('../../src/ui/rum.js', () => ({ default: mockSampleRumJs }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../src/ui/rum.js');
    vi.resetModules();
  });

  it('uses the inlined rum.js (default export) and sets RUM_GENERATION=slicc-extension', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    expect(mockSampleRumJs).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({ target: 'extension' })
    );
    expect(mockSampleRUM).not.toHaveBeenCalled();
    expect((globalThis as any).window?.RUM_GENERATION).toBe('slicc-extension');
  });

  it('does NOT set SAMPLE_PAGEVIEWS_AT_RATE in the extension branch', async () => {
    const { initTelemetry } = await import('../../src/ui/telemetry.js');
    if ((globalThis as any).window) {
      delete (globalThis as any).window.SAMPLE_PAGEVIEWS_AT_RATE;
    }
    await initTelemetry();
    expect((globalThis as any).window?.SAMPLE_PAGEVIEWS_AT_RATE).toBeUndefined();
  });

  it('forwards trackChatSend through the extension sampleRUM', async () => {
    const { initTelemetry, trackChatSend } = await import('../../src/ui/telemetry.js');
    await initTelemetry();
    mockSampleRumJs.mockClear();

    trackChatSend('cone', 'claude-sonnet');
    expect(mockSampleRumJs).toHaveBeenCalledWith('formsubmit', {
      source: 'cone',
      target: 'claude-sonnet',
    });
  });
});
```

Add one CLI-branch generation assertion. Insert this `it` block inside the existing `describe('telemetry', ...)` block, after `'initializes and emits navigate checkpoint'`:

```ts
it('sets RUM_GENERATION=slicc-cli in the CLI branch', async () => {
  const { initTelemetry } = await import('../../src/ui/telemetry.js');
  await initTelemetry();
  expect((globalThis as any).window?.RUM_GENERATION).toBe('slicc-cli');
});
```

- [ ] **Step 2.2: Run tests — verify the new ones fail**

Run: `npx vitest run packages/webapp/tests/ui/telemetry.test.ts`
Expected: 4 new tests fail.

- [ ] **Step 2.3: Implement the dispatcher in `telemetry.ts`**

Replace the body of `initTelemetry()` (lines 42–66 of the current file) with:

```ts
export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  if (typeof localStorage !== 'undefined' && localStorage.getItem('telemetry-disabled') === 'true')
    return;

  try {
    const mode = getModeLabel();

    if (typeof window !== 'undefined') {
      window.RUM_GENERATION = `slicc-${mode}`;
    }

    if (mode === 'extension') {
      const mod = await import('./rum.js');
      sampleRUM = mod.default as SampleRUM;
    } else {
      // CLI / Electron — keep existing behavior.
      if (typeof window !== 'undefined') {
        window.SAMPLE_PAGEVIEWS_AT_RATE = 'high';
      }
      const mod = await import('@adobe/helix-rum-js');
      sampleRUM = mod.sampleRUM;
    }

    initialized = true;

    if (sampleRUM) {
      sampleRUM('navigate', {
        source: typeof document !== 'undefined' ? document.referrer : '',
        target: mode,
      });
    }
  } catch {
    // Telemetry init must never block the UI
  }
}
```

- [ ] **Step 2.4: Run tests — verify they pass**

Run: `npx vitest run packages/webapp/tests/ui/telemetry.test.ts`
Expected: 14 passed.

- [ ] **Step 2.5: Run prettier**

Run: `npx prettier --write packages/webapp/src/ui/telemetry.ts packages/webapp/tests/ui/telemetry.test.ts`

- [ ] **Step 2.6: Commit**

```bash
git add packages/webapp/src/ui/telemetry.ts packages/webapp/tests/ui/telemetry.test.ts
git commit -m "feat(extension-rum): branch initTelemetry on getModeLabel + RUM_GENERATION per mode"
```

---

## Task 3: Add `sanitizeError` helper + extension-only window error listeners (TDD)

In the extension branch, helix-rum-js is not loaded, so its built-in `error` and `unhandledrejection` listeners do not run. Register equivalent listeners only in that branch.

**Files:**

- Modify: `packages/webapp/src/ui/telemetry.ts`
- Modify: `packages/webapp/tests/ui/telemetry.test.ts`

- [ ] **Step 3.1: Write the failing tests**

Append two `it` blocks inside the existing `describe('telemetry — extension branch', ...)` block:

```ts
it('registers window error listeners that call trackError("js", sanitized)', async () => {
  const { initTelemetry } = await import('../../src/ui/telemetry.js');
  await initTelemetry();
  mockSampleRumJs.mockClear();

  const errorEvent = new Event('error') as ErrorEvent;
  Object.defineProperty(errorEvent, 'message', {
    value: 'TypeError: x is not a function at /workspace/skills/foo/bar.ts:10',
  });
  window.dispatchEvent(errorEvent);

  expect(mockSampleRumJs).toHaveBeenCalledWith(
    'error',
    expect.objectContaining({
      source: 'js',
      target: expect.stringContaining('/workspace/.../'),
    })
  );
  expect(mockSampleRumJs.mock.calls[0][1].target).not.toContain('/foo/bar.ts');
});

it('registers unhandledrejection listener that calls trackError("js", sanitized)', async () => {
  const { initTelemetry } = await import('../../src/ui/telemetry.js');
  await initTelemetry();
  mockSampleRumJs.mockClear();

  const rejection = new Event('unhandledrejection') as PromiseRejectionEvent;
  Object.defineProperty(rejection, 'reason', { value: new Error('boom') });
  window.dispatchEvent(rejection);

  expect(mockSampleRumJs).toHaveBeenCalledWith(
    'error',
    expect.objectContaining({ source: 'js', target: expect.stringContaining('boom') })
  );
});
```

Append one negative test inside the existing `describe('telemetry', ...)` (CLI branch):

```ts
it('does NOT register window error listeners in CLI branch', async () => {
  const { initTelemetry } = await import('../../src/ui/telemetry.js');
  await initTelemetry();

  const before = mockSampleRUM.mock.calls.length;
  const errorEvent = new Event('error') as ErrorEvent;
  Object.defineProperty(errorEvent, 'message', { value: 'oops' });
  window.dispatchEvent(errorEvent);

  // SLICC's listener would emit `{source:'js', target:'oops'}`. Helix's mock
  // is a stub and won't auto-listen. So no SLICC-shape error call should appear.
  const sliccShape = mockSampleRUM.mock.calls
    .slice(before)
    .filter(([cp, data]) => cp === 'error' && data?.source === 'js');
  expect(sliccShape).toHaveLength(0);
});
```

- [ ] **Step 3.2: Run the tests — verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/telemetry.test.ts`
Expected: 2 extension-branch listener tests fail.

- [ ] **Step 3.3: Implement `sanitizeError` and the extension-only listeners**

Add the helper near the bottom of `telemetry.ts` (just before `isTelemetryEnabled`):

```ts
/**
 * Reduce error messages to a privacy-safe form.
 * - Truncate to 200 characters.
 * - Collapse VFS-style paths (/<root>/...) past their first segment to /<root>/.../
 *   so `/workspace/skills/foo/bar.ts` becomes `/workspace/.../`.
 */
function sanitizeError(msg: string): string {
  const truncated = (msg ?? '').slice(0, 200);
  return truncated.replace(/(\/[a-z]+)(?:\/[^\s/]+)+/gi, '$1/.../');
}
```

Update the extension branch of `initTelemetry()` to register listeners after `sampleRUM` is assigned:

```ts
if (mode === 'extension') {
  const mod = await import('./rum.js');
  sampleRUM = mod.default as SampleRUM;

  // Helix-rum-js auto-registers its own error/unhandledrejection listeners
  // for selected sessions. The inlined rum.js does not — register equivalents
  // here so the extension panel still records JS errors. Do NOT add these to
  // the CLI/Electron branch (would double-fire alongside helix's listeners).
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      trackError('js', sanitizeError((e as ErrorEvent).message ?? ''));
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = (e as PromiseRejectionEvent).reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      trackError('js', sanitizeError(msg));
    });
  }
}
```

- [ ] **Step 3.4: Run tests — verify pass**

Run: `npx vitest run packages/webapp/tests/ui/telemetry.test.ts`
Expected: 17 passed.

- [ ] **Step 3.5: Run prettier**

Run: `npx prettier --write packages/webapp/src/ui/telemetry.ts packages/webapp/tests/ui/telemetry.test.ts`

- [ ] **Step 3.6: Commit**

```bash
git add packages/webapp/src/ui/telemetry.ts packages/webapp/tests/ui/telemetry.test.ts
git commit -m "feat(extension-rum): wire window error listeners in extension branch only"
```

---

## Task 4: Cover the previously-untested `track*` wrappers in CLI branch

Today's `telemetry.test.ts` does not cover `trackImageView` or `trackSettingsOpen`. Add coverage so wiring tasks (5–8) can rely on these wrappers being well-tested.

**Files:**

- Modify: `packages/webapp/tests/ui/telemetry.test.ts`

- [ ] **Step 4.1: Add coverage for the wrappers**

Append three `it` blocks inside the existing `describe('telemetry', ...)` block, after `'trackError emits error'`:

```ts
it('trackImageView emits viewmedia', async () => {
  const { initTelemetry, trackImageView } = await import('../../src/ui/telemetry.js');
  await initTelemetry();
  mockSampleRUM.mockClear();

  trackImageView('chat');
  expect(mockSampleRUM).toHaveBeenCalledWith('viewmedia', { source: 'chat' });
});

it('trackSettingsOpen emits signup', async () => {
  const { initTelemetry, trackSettingsOpen } = await import('../../src/ui/telemetry.js');
  await initTelemetry();
  mockSampleRUM.mockClear();

  trackSettingsOpen('button');
  expect(mockSampleRUM).toHaveBeenCalledWith('signup', { source: 'button' });
});

it('trackError forwards source/target as-is (sanitization happens at the listener)', async () => {
  const { initTelemetry, trackError } = await import('../../src/ui/telemetry.js');
  await initTelemetry();
  mockSampleRUM.mockClear();

  const long = 'x'.repeat(250);
  trackError('js', long);
  expect(mockSampleRUM).toHaveBeenCalledWith('error', { source: 'js', target: long });
});
```

- [ ] **Step 4.2: Run tests — verify pass**

Run: `npx vitest run packages/webapp/tests/ui/telemetry.test.ts`
Expected: 20 passed.

- [ ] **Step 4.3: Run prettier**

Run: `npx prettier --write packages/webapp/tests/ui/telemetry.test.ts`

- [ ] **Step 4.4: Commit**

```bash
git add packages/webapp/tests/ui/telemetry.test.ts
git commit -m "test(extension-rum): cover trackImageView/trackSettingsOpen and trackError shape"
```

---

## Task 5: Move `trackChatSend` into `ChatPanel.sendMessage()` (TDD)

The orchestrator's `trackChatSend` runs in offscreen in extension mode and silently no-ops there. Move it to the chat panel's send method — the single funnel for all send paths.

**Files:**

- Modify: `packages/webapp/src/ui/chat-panel.ts`
- Test: `packages/webapp/tests/ui/chat-panel-telemetry.test.ts` (NEW)

- [ ] **Step 5.1: Write the failing wiring test**

Create `packages/webapp/tests/ui/chat-panel-telemetry.test.ts`. Note the jsdom directive at the top — needed for DOM access:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ui/telemetry.js')>(
    '../../src/ui/telemetry.js'
  );
  return { ...actual, trackChatSend: vi.fn() };
});

import { trackChatSend } from '../../src/ui/telemetry.js';

describe('ChatPanel — trackChatSend wiring', () => {
  beforeEach(() => {
    vi.mocked(trackChatSend).mockClear();
    const store: Record<string, string> = { 'selected-model': 'claude-sonnet' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Type-only assist for poking private state in tests. The real public path
  // is `await panel.switchToContext(id, false, scoopName?)`, which loads from
  // SessionStore — overkill for these wiring tests. The cast below is a
  // narrow, explicit test seam; it does NOT change production code.
  type ChatPanelInternals = { currentScoopName: string | null };
  function setScoopForTest(panel: unknown, scoopName: string | null) {
    (panel as unknown as ChatPanelInternals).currentScoopName = scoopName;
  }

  it('fires trackChatSend with "cone" when currentScoopName is null', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    setScoopForTest(panel, null); // null = cone (matches ChatPanel's state model)
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'hello';
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(trackChatSend).toHaveBeenCalledWith('cone', 'claude-sonnet');
  });

  it('fires trackChatSend with the scoop name when currentScoopName is set', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    setScoopForTest(panel, 'researcher');
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);

    const textarea = container.querySelector('textarea')!;
    textarea.value = 'do thing';
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(trackChatSend).toHaveBeenCalledWith('researcher', 'claude-sonnet');
  });

  it('does not fire on empty input', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    const panel = new ChatPanel(container);
    setScoopForTest(panel, null);
    panel.setAgent({
      sendMessage: vi.fn(),
      onEvent: () => () => {},
      stop: vi.fn(),
    } as any);

    const textarea = container.querySelector('textarea')!;
    textarea.value = '   ';
    const sendBtn = container.querySelector('.chat__send-btn')!;
    (sendBtn as HTMLButtonElement).click();

    expect(trackChatSend).not.toHaveBeenCalled();
  });
});
```

> **Implementer note:** `ChatPanel` does not expose any `setActiveScoop` method. The real public path for putting the panel in a named scoop thread is `await panel.switchToContext(contextId, readOnly, scoopName?)` (`chat-panel.ts:134`), which loads from `SessionStore` and is unnecessarily heavy for these wiring tests. The narrow `setScoopForTest` cast above is an explicit test seam: it pokes the private `currentScoopName` field (the same field production code reads). If you prefer not to touch private state, use `await panel.switchToContext('test-session', false, 'researcher')` and stub `SessionStore` accordingly. The agent is wired via the **public** `setAgent(agent: AgentHandle)` method (`chat-panel.ts:88`) — used as shown above. The behavioral contract — `trackChatSend(scoopName, modelId)` fires from `sendMessage()` after the empty-text guard — is what matters. Note: `currentScoopName ?? 'cone'` only coerces `null`/`undefined`; in practice `switchToContext` only ever sets a real scoop name or `null`, so the empty-string edge case doesn't occur.

- [ ] **Step 5.2: Run tests — verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/chat-panel-telemetry.test.ts`
Expected: FAIL — `trackChatSend` not called (still in orchestrator).

- [ ] **Step 5.3: Wire `trackChatSend` in `ChatPanel.sendMessage()`**

Add an import at the top of `packages/webapp/src/ui/chat-panel.ts` (alongside other UI imports):

```ts
import { trackChatSend } from './telemetry.js';
```

Modify the `sendMessage()` method (around line 608). Insert the telemetry call right after the empty-text guard. **Use the real `currentScoopName` state** — `null` means cone, a string means a named scoop:

```ts
private sendMessage(): void {
  const text = this.textarea.value.trim();
  if (!text) return;

  // Telemetry — fire once per send, mirroring orchestrator's previous logic.
  // ChatPanel models the active scoop as `currentScoopName: string | null`
  // where null === cone (see field declaration around line 64).
  const scoopName = this.currentScoopName ?? 'cone';
  const modelId = localStorage.getItem('selected-model') ?? 'unknown';
  trackChatSend(scoopName, modelId);

  // ... existing body unchanged ...
```

> **Implementer note:** the previous orchestrator-side parity logic was `scoop?.isCone ? 'cone' : (scoop?.name ?? 'unknown')`. The panel's equivalent is simpler because `currentScoopName: null` already means cone — just `?? 'cone'` covers it. There is no `'unknown'` fallback in the panel because `currentScoopName` is always either `null` (cone) or a known scoop name (set via `switchToContext`).

- [ ] **Step 5.4: Run tests — verify pass**

Run: `npx vitest run packages/webapp/tests/ui/chat-panel-telemetry.test.ts`
Expected: 3 passed.

- [ ] **Step 5.5: Run prettier**

Run: `npx prettier --write packages/webapp/src/ui/chat-panel.ts packages/webapp/tests/ui/chat-panel-telemetry.test.ts`

- [ ] **Step 5.6: Commit**

```bash
git add packages/webapp/src/ui/chat-panel.ts packages/webapp/tests/ui/chat-panel-telemetry.test.ts
git commit -m "feat(extension-rum): fire trackChatSend from ChatPanel.sendMessage()"
```

---

## Task 6: Remove the now-dead `trackChatSend` call from `orchestrator.ts`

**Files:**

- Modify: `packages/webapp/src/scoops/orchestrator.ts`

- [ ] **Step 6.1: Remove the import and the call**

In `packages/webapp/src/scoops/orchestrator.ts`:

1. Remove the import on **line 29**:

   ```ts
   import { trackChatSend } from '../ui/telemetry.js';
   ```

2. Remove the block at **lines 1062–1065**:

   ```ts
   // Telemetry: track chat sends
   const scoop = this.scoops.get(message.chatJid);
   const scoopName = scoop?.isCone ? 'cone' : (scoop?.name ?? 'unknown');
   trackChatSend(scoopName, localStorage.getItem('selected-model') ?? 'unknown');
   ```

   Delete all four lines.

- [ ] **Step 6.2: Verify single production callsite remains**

A naive `grep -rn 'trackChatSend('` matches the export in `telemetry.ts`, the new call in `chat-panel.ts`, and any number of test mocks/expectations. Use a scoped search that excludes tests and the export site:

Run:

```bash
grep -rn 'trackChatSend(' packages/webapp/src --include='*.ts' \
  | grep -v 'telemetry.ts:' \
  | grep -v '.test.'
```

Expected: exactly one line — the call inside `chat-panel.ts` `sendMessage()` from Task 5. If there are more, you have a stray callsite to remove. If there are zero, Task 5 was reverted — abort.

- [ ] **Step 6.3: Run typecheck and the affected test files**

Run: `npm run typecheck`
Expected: clean.

Run: `npx vitest run packages/webapp/tests/ui/chat-panel-telemetry.test.ts packages/webapp/tests/ui/telemetry.test.ts`
Expected: all pass.

- [ ] **Step 6.4: Run prettier**

Run: `npx prettier --write packages/webapp/src/scoops/orchestrator.ts`

- [ ] **Step 6.5: Commit**

```bash
git add packages/webapp/src/scoops/orchestrator.ts
git commit -m "refactor(extension-rum): drop trackChatSend from orchestrator (moved to ChatPanel)"
```

---

## Task 7: Wire `trackSettingsOpen` in `showProviderSettings()` (TDD)

**Files:**

- Modify: `packages/webapp/src/ui/provider-settings.ts`
- Test: `packages/webapp/tests/ui/provider-settings-telemetry.test.ts` (NEW)

- [ ] **Step 7.1: Write the failing test**

Create `packages/webapp/tests/ui/provider-settings-telemetry.test.ts` (note the jsdom directive — `showProviderSettings` builds DOM):

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ui/telemetry.js')>(
    '../../src/ui/telemetry.js'
  );
  return { ...actual, trackSettingsOpen: vi.fn() };
});

import { trackSettingsOpen } from '../../src/ui/telemetry.js';

describe('showProviderSettings — trackSettingsOpen wiring', () => {
  beforeEach(() => {
    vi.mocked(trackSettingsOpen).mockClear();
    document.body.replaceChildren();
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('fires trackSettingsOpen("button") on dialog open', async () => {
    const { showProviderSettings } = await import('../../src/ui/provider-settings.js');
    void showProviderSettings();
    expect(trackSettingsOpen).toHaveBeenCalledWith('button');
  });
});
```

- [ ] **Step 7.2: Run the test — verify it fails**

Run: `npx vitest run packages/webapp/tests/ui/provider-settings-telemetry.test.ts`
Expected: FAIL — `trackSettingsOpen` not called.

- [ ] **Step 7.3: Add the import and the call**

In `packages/webapp/src/ui/provider-settings.ts`, add an import near the other UI imports at the top:

```ts
import { trackSettingsOpen } from './telemetry.js';
```

Modify `showProviderSettings()` (line 684). Insert the telemetry call as the first statement inside the function body:

```ts
export function showProviderSettings(options?: ShowProviderSettingsOptions): Promise<boolean> {
  trackSettingsOpen('button');
  return new Promise((resolve) => {
    const accountsBefore = localStorage.getItem(ACCOUNTS_KEY) ?? '';
```

> **Note:** today there is a single entry path (the gear button in `layout.ts:567`). Pass `'button'` unconditionally. If a shortcut path is added later, thread a `trigger` parameter through `ShowProviderSettingsOptions`.

- [ ] **Step 7.4: Run the test — verify pass**

Run: `npx vitest run packages/webapp/tests/ui/provider-settings-telemetry.test.ts`
Expected: 1 passed.

- [ ] **Step 7.5: Run prettier**

Run: `npx prettier --write packages/webapp/src/ui/provider-settings.ts packages/webapp/tests/ui/provider-settings-telemetry.test.ts`

- [ ] **Step 7.6: Commit**

```bash
git add packages/webapp/src/ui/provider-settings.ts packages/webapp/tests/ui/provider-settings-telemetry.test.ts
git commit -m "feat(extension-rum): fire trackSettingsOpen on provider settings dialog open"
```

---

## Task 8: Wire `trackImageView` via MutationObserver in `ChatPanel` (TDD)

A `MutationObserver` on the chat messages container fires `trackImageView('chat')` for every `<img>` that lands in the chat tree. Covers markdown images, screenshot insertions, and tool-result images uniformly.

**Files:**

- Modify: `packages/webapp/src/ui/chat-panel.ts`
- Modify: `packages/webapp/tests/ui/chat-panel-telemetry.test.ts` (extend file from Task 5)

- [ ] **Step 8.1: Replace the top-of-file mock and add the failing tests**

In `packages/webapp/tests/ui/chat-panel-telemetry.test.ts`, replace the existing single-function mock with one that mocks both `trackChatSend` AND `trackImageView`. Replace this block at the top:

```ts
vi.mock('../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ui/telemetry.js')>(
    '../../src/ui/telemetry.js'
  );
  return { ...actual, trackChatSend: vi.fn() };
});

import { trackChatSend } from '../../src/ui/telemetry.js';
```

with:

```ts
vi.mock('../../src/ui/telemetry.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/ui/telemetry.js')>(
    '../../src/ui/telemetry.js'
  );
  return { ...actual, trackChatSend: vi.fn(), trackImageView: vi.fn() };
});

import { trackChatSend, trackImageView } from '../../src/ui/telemetry.js';
```

Then append a new `describe` block at the end of the file. (The file already starts with `// @vitest-environment jsdom` from Task 5.1, so no re-declaration is needed.)

```ts
describe('ChatPanel — trackImageView wiring', () => {
  beforeEach(() => {
    vi.mocked(trackImageView).mockClear();
  });

  it('fires trackImageView("chat") for each <img> appended to messagesEl', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    new ChatPanel(container);

    const messagesEl = container.querySelector('.chat__messages')!;
    const img1 = document.createElement('img');
    img1.src = 'data:image/png;base64,iVBORw0KGgo=';
    messagesEl.appendChild(img1);
    const img2 = document.createElement('img');
    img2.src = 'https://example.test/x.png';
    messagesEl.appendChild(img2);

    // MutationObserver delivers asynchronously — yield a microtask.
    await new Promise((r) => setTimeout(r, 0));

    expect(trackImageView).toHaveBeenCalledTimes(2);
    expect(trackImageView).toHaveBeenCalledWith('chat');

    container.remove();
  });

  it('fires once per <img> even when nested inside other elements', async () => {
    const { ChatPanel } = await import('../../src/ui/chat-panel.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    new ChatPanel(container);

    const messagesEl = container.querySelector('.chat__messages')!;
    // Build the wrapper without innerHTML — explicit DOM construction.
    const wrapper = document.createElement('p');
    wrapper.append('text ');
    const img1 = document.createElement('img');
    img1.src = 'x.png';
    wrapper.appendChild(img1);
    wrapper.append(' middle ');
    const img2 = document.createElement('img');
    img2.src = 'y.png';
    wrapper.appendChild(img2);
    wrapper.append(' end');
    messagesEl.appendChild(wrapper);

    await new Promise((r) => setTimeout(r, 0));
    expect(trackImageView).toHaveBeenCalledTimes(2);

    container.remove();
  });
});
```

- [ ] **Step 8.2: Run the tests — verify they fail**

Run: `npx vitest run packages/webapp/tests/ui/chat-panel-telemetry.test.ts`
Expected: 2 new tests fail; the 3 from Task 5 still pass.

- [ ] **Step 8.3: Install the MutationObserver in `ChatPanel`**

Update the import line added in Task 5:

```ts
import { trackChatSend } from './telemetry.js';
```

becomes:

```ts
import { trackChatSend, trackImageView } from './telemetry.js';
```

In the `ChatPanel` constructor, immediately after `this.messagesEl` is created and inserted into the DOM (around line 364 of the current file), install the observer:

```ts
this.messagesEl = document.createElement('div');
this.messagesEl.className = 'chat__messages';
// ... existing setup that appends messagesInner / messagesEl into the container ...

// Telemetry — fire trackImageView('chat') exactly once per <img> attached
// to the messages tree. Covers markdown images, screenshots, and tool-result
// images uniformly.
const imgObserver = new MutationObserver((records) => {
  for (const r of records) {
    r.addedNodes.forEach((node) => {
      if (!(node instanceof Element)) return;
      if (node.tagName === 'IMG') {
        trackImageView('chat');
      } else {
        node.querySelectorAll?.('img').forEach(() => trackImageView('chat'));
      }
    });
  }
});
imgObserver.observe(this.messagesEl, { childList: true, subtree: true });
```

> **Note:** no explicit `disconnect()` — the panel lives for the lifetime of the side panel; when the panel is destroyed, GC reclaims the observer. If a future change adds an explicit panel teardown method, add `imgObserver.disconnect()` there.

- [ ] **Step 8.4: Run the tests — verify pass**

Run: `npx vitest run packages/webapp/tests/ui/chat-panel-telemetry.test.ts`
Expected: 5 passed.

- [ ] **Step 8.5: Run prettier**

Run: `npx prettier --write packages/webapp/src/ui/chat-panel.ts packages/webapp/tests/ui/chat-panel-telemetry.test.ts`

- [ ] **Step 8.6: Commit**

```bash
git add packages/webapp/src/ui/chat-panel.ts packages/webapp/tests/ui/chat-panel-telemetry.test.ts
git commit -m "feat(extension-rum): observe chat <img> insertions and fire trackImageView"
```

---

## Task 9: Update `docs/operational-telemetry.md`

The file is the canonical user-facing telemetry document. Restructure to reflect the dispatcher.

**Files:**

- Modify: `docs/operational-telemetry.md`

- [ ] **Step 9.1: Read the current file**

Run: `cat docs/operational-telemetry.md | head -120`
Familiarize yourself with the current "Integration Approach" structure — sub-sections `### CLI mode`, `### Extension mode`, `### Electron mode` with dispatcher-irrelevant content.

- [ ] **Step 9.2: Replace the "Integration Approach" section**

Replace the content from `## Integration Approach` heading through the end of the `### Electron mode` sub-section (typically up through line ~115 — verify by reading) with this:

````markdown
## Integration Approach

`packages/webapp/src/ui/telemetry.ts` is a small dispatcher chosen at init time by `getModeLabel()`:

- **CLI / Electron** load `@adobe/helix-rum-js` (npm dep). Helix's auto-loaded enhancer fetches CWV/auto-click instrumentation from `rum.hlx.page` — there is no extension manifest CSP in this mode (it's a regular page served by the dev server in CLI, an Electron BrowserWindow in Electron), so the cross-origin script load and beacon are unrestricted. `window.SAMPLE_PAGEVIEWS_AT_RATE = 'high'` is set before the import — helix interprets `'high'` as 1-in-10 sampling.

- **Extension** loads `packages/webapp/src/ui/rum.js` instead — a self-contained ~50-line beacon that fires `navigator.sendBeacon` to `https://rum.hlx.page/.rum/<weight>` (default weight 10). The inlined approach avoids the auto-loaded enhancer (CSP-blocked) and matches `@adobe/aem-sidekick`'s pattern of bundling a tiny RUM utility into the extension itself.

Both implementations share the `(checkpoint, data)` signature. `window.RUM_GENERATION` is set to `slicc-cli`, `slicc-extension`, or `slicc-electron` so dashboard queries can split by deployment mode.

### Extension debug override

Force 100% sampling in the side panel for verification:

```js
// In side-panel DevTools (right-click panel → Inspect → Console):
localStorage.setItem('slicc-rum-debug', '1');
// Reload the panel. The next pageview is sampled with weight=1.
localStorage.removeItem('slicc-rum-debug');
```

The flag is read by `rum.js` on first call and cached in `window.hlx.rum`. CLI/Electron have no equivalent override.

### Why two implementations

- The extension's manifest CSP and the no-target-page-URL nature of the side panel make the inlined approach simpler and avoid an external script load that would silently 404.
- CLI/Electron benefit from helix-rum-js's enhancer (CWV, auto-click) which is not reproduced manually.
- The cost is a per-mode sampling decision (independent RNG draws) and an `error`-beacon payload-shape asymmetry (see below).
````

- [ ] **Step 9.3: Update the "Checkpoints" section**

Find the `### Checkpoint mapping` table. Below it, add this paragraph:

```markdown
**Wiring status (post-2026-04-29):**

- `navigate`, `formsubmit`, `fill`, `viewblock` — wired in both CLI/Electron and extension.
- `signup`, `viewmedia` — newly wired; fire in both modes.
- `error` — fires in both modes, but the **automatic capture path** differs:
  - CLI/Electron: helix-rum-js installs its own `window.error` and `unhandledrejection` listeners and emits its native payload shape.
  - Extension: `telemetry.ts` registers SLICC's listeners after assigning `sampleRUM` from `rum.js`, emitting `{source: 'js', target: sanitizedMessage}`. Sanitization collapses VFS paths to `/<root>/.../` and truncates to 200 characters.
  - Manual `trackError(...)` calls produce the SLICC shape in both modes.
  - Cross-mode error queries should split by `RUM_GENERATION` and treat each shape separately.
```

- [ ] **Step 9.4: Document the `fill`-beacon asymmetry**

Either inside the Checkpoints section or in a new "Mode-specific behaviors" section near the bottom, add:

```markdown
### Mode-specific shell-command coverage

`fill` beacons fire from `wasm-shell.ts:679`, which runs in two contexts in the extension: the panel terminal and the offscreen agent shell.

- **CLI / Electron:** both contexts are the same realm; every shell command produces a beacon.
- **Extension:** only the panel-terminal `WasmShell` initializes telemetry. The offscreen agent shell's `trackShellCommand` calls silently no-op. Extension `fill` beacons therefore represent commands the user typed in the panel terminal — not commands the agent ran via its bash tool.

Dashboard readers comparing extension and CLI shell volume should expect this gap.
```

- [ ] **Step 9.5: Add an "Out of scope" section near the bottom**

```markdown
### Not instrumented in this iteration

- The offscreen document (`packages/chrome-extension/src/offscreen.ts`). Agent-loop events — turn end, tool-call durations, scoop create/delegate/drop — would require offscreen-side init.
- The extension service worker (`packages/chrome-extension/src/service-worker.ts`). CDP attach/detach, OAuth completion, navigate-licks, tray-socket lifecycle.
- Core Web Vitals in the extension. The helix enhancer that captures CWV cannot run under the extension's CSP, and we do not self-host it here.

These are tracked as future work in `docs/superpowers/specs/2026-04-28-extension-telemetry-design.md`.
```

- [ ] **Step 9.6: Run prettier**

Run: `npx prettier --write docs/operational-telemetry.md`

- [ ] **Step 9.7: Commit**

```bash
git add docs/operational-telemetry.md
git commit -m "docs(extension-rum): describe dispatcher, debug flag, and mode-specific behaviors"
```

---

## Task 10: Add a one-liner to `packages/chrome-extension/CLAUDE.md`

**Files:**

- Modify: `packages/chrome-extension/CLAUDE.md`

- [ ] **Step 10.1: Add a Telemetry section**

Open `packages/chrome-extension/CLAUDE.md`. After the existing "Runtime Conventions" section (and before "Build Notes"), insert:

```markdown
## Telemetry

The side panel emits Helix RUM beacons via the inlined `packages/webapp/src/ui/rum.js` (extension-only). CLI/Electron use `@adobe/helix-rum-js` instead; the choice is made by `telemetry.ts:initTelemetry()` based on `getModeLabel()`. Offscreen and the service worker are not instrumented. Force 100% sampling for debugging by setting `localStorage.setItem('slicc-rum-debug', '1')` in the side panel's DevTools and reloading. See `docs/operational-telemetry.md`.
```

- [ ] **Step 10.2: Run prettier**

Run: `npx prettier --write packages/chrome-extension/CLAUDE.md`

- [ ] **Step 10.3: Commit**

```bash
git add packages/chrome-extension/CLAUDE.md
git commit -m "docs(extension-rum): note panel-side rum.js in chrome-extension/CLAUDE.md"
```

---

## Task 11: Final verification (CI gates + manual smoke)

**Files:** none — verification only.

- [ ] **Step 11.1: Run prettier check**

Run: `npx prettier --check .`
Expected: clean. If any file complains, run `npx prettier --write <files>` and recommit per the relevant earlier task.

- [ ] **Step 11.2: Run typecheck**

Run: `npm run typecheck`
Expected: clean across all three configs (CLI, browser, worker).

- [ ] **Step 11.3: Run the full test suite**

Run: `npm run test`
Expected: pre-change baseline + ~22 net new tests, all passing. Breakdown of new tests by file:

- `rum.test.ts` — 5 tests (Task 1).
- `telemetry.test.ts` — 8 net new (4 extension-branch in Task 2, 2 extension-listener + 1 CLI-negative in Task 3, 3 wrapper-coverage in Task 4 — minus the existing `trackError` test that's already there, plus 1 CLI RUM_GENERATION assertion). The exact arithmetic depends on the file's prior state; what matters is that all existing tests still pass and every new test passes.
- `chat-panel-telemetry.test.ts` — 5 tests (3 from Task 5 + 2 from Task 8).
- `provider-settings-telemetry.test.ts` — 1 test (Task 7).

Don't anchor on a specific total — the repo's baseline drifts with other unrelated changes. The right success criterion is: zero failures, no skipped tests beyond the existing ones.

- [ ] **Step 11.4: Run the webapp build**

Run: `npm run build`
Expected: clean exit.

- [ ] **Step 11.5: Run the extension build**

Run: `npm run build -w @slicc/chrome-extension`
Expected: clean exit. `dist/extension/` populated.

- [ ] **Step 11.6: Manual smoke (extension)**

Load `dist/extension/` as an unpacked extension in `chrome://extensions`. Open the side panel. Right-click → Inspect → Console:

```js
localStorage.setItem('slicc-rum-debug', '1');
location.reload();
```

In the panel's DevTools Network tab, filter by `rum.hlx.page`.

- Submit a chat message → expect a `formsubmit` beacon.
- Open settings → expect a `signup` beacon.
- Open a sprinkle → expect a `viewblock` beacon.
- Send an assistant message that contains an image (or paste a screenshot) → expect a `viewmedia` beacon.
- In the panel's DevTools console, run `window.dispatchEvent(new ErrorEvent('error', { message: 'manual test' }))` → expect an `error` beacon with `target` containing `manual test`.

Then disable telemetry and verify silence:

```js
localStorage.setItem('telemetry-disabled', 'true');
location.reload();
```

Repeat the chat/settings/sprinkle actions → expect zero beacons.

- [ ] **Step 11.7: Manual smoke (CLI)**

Run: `npm run dev`
Open the SLICC UI. In its DevTools Network tab, filter by `rum.hlx.page`. Repeat the same actions:

- Chat send → `formsubmit`.
- Settings open → `signup`.
- Sprinkle open → `viewblock`.
- Image render → `viewmedia`.

`error` may also fire from helix's built-in handlers — either shape is acceptable in CLI per the spec asymmetry.

If any expected beacon is missing, halt and reopen the relevant task before merging.

---

## Notes for the implementer

- **Divergence from spec on `trackImageView` wiring.** The spec's architecture file list shows `message-renderer.ts (MODIFIED) — trackImageView wired when chat-message images render`. The plan instead installs a MutationObserver on `ChatPanel.messagesEl` (Task 8) that fires `trackImageView('chat')` exactly once per `<img>` attached to the chat tree. This is functionally stronger than wiring at the renderer: it covers markdown images (rendered by `message-renderer.ts`), screenshots inserted at `chat-panel.ts:1452`, and tool-result images extracted from `<img:data:...>` markers (`chat-panel.ts:743–744`) uniformly. The behavioral contract from the spec — "exactly once per image, when it first attaches to the DOM" — is preserved. Do NOT also wire `message-renderer.ts`; doing so would double-fire for markdown images.
- **Test seams already match the real ChatPanel API.** The wiring tests in Tasks 5 and 8 use `currentScoopName: string | null` (the real private field, where `null` === cone) and the `.chat__send-btn` selector (the real button class set at `chat-panel.ts:405`). They do **not** use any `setActiveScoop` or `data-test="send"` — those don't exist. The prose in Task 5.1 explains the test seam choice. If you prefer the heavier path, replace the `setScoopForTest` cast with `await panel.switchToContext(...)` and stub `SessionStore`.
- **Do not regress the existing 10 telemetry tests.** They are CLI-branch and must keep mocking `@adobe/helix-rum-js`. The extension-branch tests added in Tasks 2–3 live in their own `describe('telemetry — extension branch', ...)` block with chrome-stub setup/teardown.
- **Order matters.** Tasks 5 and 6 must commit in that order (move first, delete second) so neither commit leaves the codebase with zero `trackChatSend` callsites.
- **Extension network access for beacons.** The extension's manifest declares `host_permissions: ["<all_urls>"]`, which is what allows `navigator.sendBeacon` from extension pages to reach `rum.hlx.page`. The manifest CSP (`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`) does not set an explicit `connect-src` directive, so beacons are not blocked by CSP either. If a future change tightens the CSP with an explicit `connect-src`, add `https://rum.hlx.page` there too — out of scope for this plan.
- **Follow Karl's standing orders.** Every commit must pass prettier, typecheck, and the affected test files. The husky pre-commit hook runs lint-staged — let it run.
