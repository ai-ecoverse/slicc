# Cherry Embedded SLICC Follower Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a SLICC follower in an iframe on a third-party host page so a remote cloud-cone leader can drive the host page as a CDP target over cooperative, postMessage-backed synthetic CDP.

**Architecture:** A new `@slicc/cherry` host SDK mounts the worker-served webapp (`?cherry=1`) in an iframe. The iframe runs a `CherryHostTransport` (a third `CDPTransport` impl) that speaks synthetic CDP to the host SDK over a three-factor-pinned postMessage channel. The follower advertises a capability-tagged `cherry` target into the existing tray/federated-CDP system; the leader's `BrowserAPI` drives it unchanged. Host→cone events arrive as a new `'cherry'` lick.

**Tech Stack:** TypeScript, Vitest (jsdom for SDK/transport, node elsewhere), postMessage, existing tray WebRTC data channel, Cloudflare Worker static asset serving, isomorphic git workspace tooling. No new runtime deps in the SDK; `html2canvas` is a lazy optional peer for screenshots.

> **Descope note (2026-06-01):** The shipped PR implements **embedding only**.
> `joinToken` is the **required** mounting mechanism — the host (or its backend)
> supplies a ready tray join URL and the follower embeds against it. Every
> **cloud-cone creation / provisioning** step in the tasks below
> (`imsToken` / `coneName` / `createIfMissing`, `handshake.welcome.auth`, the
> iframe-side `/api/cloud/*` orchestration in `resolveCherryJoinUrl`, and the
> `CherryHostTransport.provisioningAuth` field + its tests) was **removed before
> merge** and is deferred to a separate future PR (a third-party host's IMS token
> fails the cloud proxy's `validateBearer`, and secrets must not transit the
> browser handshake). Those task fragments are retained as the historical record
> for that future creation PR; ignore them when reading the as-shipped behavior.

---

## File Structure

**New package `packages/cherry/`** (the host SDK that third parties embed):

- `package.json` — `@slicc/cherry`, ESM, no required deps
- `tsconfig.json` — bundler resolution, extends root browser config shape
- `src/index.ts` — public surface: `mountSlicc`, types (`MountSliccOptions`, `HostCapabilities`, `HostHooks`, `SliccHandle`)
- `src/protocol.ts` — structural mirror of the envelope union (SDK side; no import from webapp)
- `src/mount.ts` — `mountSliccImpl`: iframe creation, permission gate, cdp.request dispatch to host handlers, slicc.event routing
- `src/cdp-host-handlers.ts` — host-realm execution of synthetic CDP (`createCdpHostHandler`)
- `tests/*` — mirrors `src/`

> **Provisioning is iframe-side, not in this SDK.** The spec (§"Provisioning happens iframe-side (kills CORS)") requires the `/api/cloud/*` orchestration to run in the webapp iframe (same-origin with the worker). The host SDK only forwards `{ token, coneName, createIfMissing }` (or a ready `joinUrl`) into the iframe over the handshake. The `resolveCherryJoinUrl` orchestration therefore lives in `packages/webapp/src/ui/main-cherry.ts` (Task 13), **not** in a `packages/cherry/src/provisioning.ts`. Task 12 is adjusted accordingly (it no longer calls `/api/cloud/*` host-side).

**Changed in `packages/webapp/src/`:** (paths verified against current source — note `scoops/` and `ui/`, not `core/` or `src` root)

- `cdp/cherry-host-protocol.ts` (new) — envelope union, `isCherryEnvelope`, `acceptEnvelope` three-factor validator
- `cdp/cherry-host-transport.ts` (new) — `CherryHostTransport implements CDPTransport`
- `ui/runtime-identity.ts` (new) — `canonicalRuntimeId`
- `ui/runtime-mode.ts` — add `'cherry'` to `UiRuntimeMode` + detect in `resolveUiRuntimeMode`
- `ui/main.ts` / `ui/main-cherry.ts` (new) — cherry boot branch
- `scoops/tray-sync-protocol.ts`, `scoops/tray-target-registry.ts`, `cdp/browser-api.ts`, `scoops/tray-leader-sync.ts` — capability-tagged target plumbing
- `scoops/lick-manager.ts`, `scoops/lick-formatting.ts` — `'cherry'` lick type
- `shell/supplemental-commands/cherry-emit-command.ts` (new) — `cherry-emit`

**Changed in `packages/cloudflare-worker/src/index.ts`:** `serveSPA` framing/CSP branch on `?cherry=1`.

**Changed in `packages/ios-app/`:** `SyncProtocol.swift` + `AppState.swift` mirror (target kind/capabilities, cherry slicc-event no-op case).

**Docs:** new `/workspace/skills/cherry/SKILL.md`; updates to root + webapp + worker + ios `CLAUDE.md`, `docs/architecture.md`, `README.md`, new `packages/cherry/CLAUDE.md`.

---

### Task 1: Scaffold `@slicc/cherry` package

**Files:**

- Create: `packages/cherry/package.json`
- Create: `packages/cherry/tsconfig.json`
- Create: `packages/cherry/src/index.ts`
- Create: `packages/cherry/tests/index.test.ts`
- Modify: `vitest.config.ts` (root — add the `cherry` project to the `projects[]` array)
- Modify: `package.json` (root — workspaces, build chain, typecheck, coverage script)
- Modify: `.github/workflows/ci.yml`
- Modify: `knip.json` (if present at root)

> **This repo has ONE root `vitest.config.ts` with a `projects[]` array — packages do NOT carry their own vitest config.** Cherry is added as a new project entry there (Step 1), not via a standalone `packages/cherry/vitest.config.ts`. The default test environment is `node`; the cherry project sets `environment: 'jsdom'` because the whole SDK is DOM-bound. Per-package coverage runs via a root `test:coverage:<name>` script of the form `vitest run --project <name> --coverage` (some packages add explicit `--coverage.thresholds.*` flags to tighten the floor; cherry uses the global 50/50/50/40 default), not per-package config.

> **Ordering note (unified vitest model).** `npm run test -w @slicc/cherry` resolves to `vitest run --root ../.. --config vitest.config.ts --project cherry`. That command can only run once (a) `packages/cherry` is a workspace and (b) a `cherry` project exists in the root `vitest.config.ts`. So the workspace + project registration are infrastructure that must land BEFORE the red test run — they are not what makes the test fail. The test fails (red) purely because `src/index.ts` does not exist yet. Steps are ordered accordingly.

- [ ] **Step 1: Create package scaffolding + register the vitest project**

This is pre-test infrastructure (no `src/index.ts` yet, so the test will still be red).

`packages/cherry/package.json`:

```json
{
  "name": "@slicc/cherry",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run --root ../.. --config vitest.config.ts --project cherry"
  },
  "devDependencies": {
    "@types/jsdom": "^28.0.0",
    "jsdom": "^29.0.0",
    "typescript": "6.0.3"
  }
}
```

> The `test` script mirrors `packages/webapp/package.json` exactly — it runs the root config and filters to the `cherry` project. Coverage is NOT a per-package script here; it's the root `test:coverage:cherry` (Step 5) so it shares the root config's v8 provider + exclude list. `@vitest/coverage-v8` and `vitest` are already root devDependencies (every package uses the hoisted root install — `packages/webapp/package.json` re-lists neither), so cherry only needs `jsdom`/`@types/jsdom` (for the `environment: 'jsdom'` project) and `typescript` pinned at `6.0.3` (matching webapp, for its `tsc -p` build/typecheck).

`packages/cherry/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*.ts"]
}
```

> No `packages/cherry/vitest.config.ts` — the cherry project is registered in the root `vitest.config.ts` below.

Add `"packages/cherry"` to the root `package.json` `workspaces` array (current array: `["packages/shared-ts","packages/cloud-core","packages/webapp","packages/node-server","packages/chrome-extension","packages/cloudflare-worker","packages/swift-launcher","packages/swift-server"]`; place it after `packages/webapp` — order is cosmetic).

Register the `cherry` project in the root `vitest.config.ts` `projects:` array (alongside the existing `webapp`/`node-server`/`shared`/`chrome-extension`/`cloudflare-worker`/`cloud-core` entries). Add it after the `cloud-core` entry:

```ts
      {
        extends: true,
        test: {
          name: 'cherry',
          environment: 'jsdom',
          include: ['packages/cherry/tests/**/*.test.ts'],
        },
      },
```

`extends: true` inherits the root coverage config (v8 provider + `baseCoverageExclude`). `environment: 'jsdom'` overrides the root default `'node'` because the entire SDK is DOM-bound (iframe, postMessage, `HTMLElement`). The cherry project does NOT need the `define: { __DEV__ }` block that the `webapp`/`chrome-extension` projects carry — cherry imports no webapp modules, so nothing reads `__DEV__` at load.

- [ ] **Step 2: Write the failing test**

`packages/cherry/tests/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mountSlicc } from '../src/index.js';

describe('@slicc/cherry public surface', () => {
  it('exports mountSlicc as a function', () => {
    expect(typeof mountSlicc).toBe('function');
  });

  it('throws when no container element is provided', () => {
    expect(() => mountSlicc({} as never)).toThrow(/container/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm install` (so the new workspace + jsdom resolve) then `npm run test -w @slicc/cherry`
Expected: FAIL — Vitest finds the `cherry` project but cannot resolve `../src/index.js` (`mountSlicc` not defined).

- [ ] **Step 4: Create the SDK stub**

`packages/cherry/src/index.ts`:

```ts
/**
 * @slicc/cherry — embed a SLICC follower in an iframe on a host page and lend
 * the host page to a remote cloud-cone leader as a driveable CDP target.
 */

export interface HostCapabilities {
  /** Allow the leader to navigate the host page top-level frame. */
  navigate: boolean;
  /** Screenshot strategy. 'html2canvas' lazy-loads the lib; 'none' disables. */
  screenshot: 'html2canvas' | 'none';
  /** Allow the leader to request opening URLs in new host tabs/windows. */
  openUrl: boolean;
}

export interface HostHooks {
  /** Called when the follower asks the host to open a URL (openUrl capability). */
  onOpenUrl?: (url: string) => void;
  /** Called for slicc.event envelopes the host opts to observe (telemetry). */
  onSliccEvent?: (name: string, detail: unknown) => void;
  /** Gate each synthetic CDP domain the leader tries to use. Return false to deny. */
  onPermissionRequest?: (domain: string) => boolean | Promise<boolean>;
}

export interface MountSliccOptions {
  /** Element the follower iframe is appended to. Required. */
  container: HTMLElement;
  /** Origin serving the worker-hosted webapp, e.g. https://app.sliccy.ai */
  sliccOrigin: string;
  /** Capabilities the host lends to the leader. */
  capabilities: HostCapabilities;
  /** Optional host-side hooks. */
  hooks?: HostHooks;
  /**
   * IMS bearer forwarded into the iframe over the handshake for same-origin
   * /api/cloud provisioning. Browser-resident only; never forwarded to
   * third-party or E2B. The SDK does NOT call /api/cloud itself — the iframe
   * (same-origin with the worker) does (Task 13 `resolveCherryJoinUrl`).
   */
  imsToken?: string;
  /** Target cone name to resume/start during iframe-side provisioning. */
  coneName?: string;
  /** When true and no matching cone exists, the iframe starts a new one. */
  createIfMissing?: boolean;
  /** Existing tray/session join URL to use, bypassing provisioning entirely. */
  joinToken?: string;
}

export interface SliccHandle {
  /** The mounted iframe element. */
  iframe: HTMLIFrameElement;
  /** Tear down the channel and remove the iframe. */
  destroy(): void;
}

export function mountSlicc(options: MountSliccOptions): SliccHandle {
  if (!options || !options.container) {
    throw new Error('mountSlicc: options.container is required');
  }
  // Implemented in Task 12 (mount.ts). Stub keeps the surface importable.
  throw new Error('mountSlicc: not yet implemented');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w @slicc/cherry`
Expected: PASS — `mountSlicc` is a function; calling with `{}` throws `/container/i`.

- [ ] **Step 6: Finish the monorepo wiring (build, typecheck, coverage, CI, knip)**

The workspace + vitest project were added in Step 1. The remaining root wiring:

The root `package.json` `build` script is a single ordered `&&` chain. Splice cherry in after the webapp build:

```
... && npm run build -w @slicc/webapp && npm run build -w @slicc/cherry && npm run build -w @slicc/node-server && ...
```

The root `package.json` `typecheck` script is a fixed `&&` chain of named tsconfigs:

```
tsc --noEmit -p tsconfig.cli.json && tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.worker.json && tsc --noEmit -p tsconfig.webapp-worker.json && tsc --noEmit -p packages/cloud-core/tsconfig.json
```

Append `&& tsc --noEmit -p packages/cherry/tsconfig.json` to it.

Add the root coverage script (mirror `test:coverage:webapp`, which is `vitest run --project webapp --coverage` — cherry shares the global 50/50/50/40 floor, so no explicit `--coverage.thresholds.*` flags are needed, unlike `cloudflare-worker` which tightens them):

```json
"test:coverage:cherry": "vitest run --project cherry --coverage",
```

> Note: the root `CLAUDE.md` Module Map is itself stale — it omits `packages/shared-ts` and `packages/cloud-core`. Don't try to "fix" that here; just add the `packages/cherry/` row (Task 14 covers the doc update).

**`.github/workflows/ci.yml` — three concrete edits** (this repo uses per-package jobs gated by a `changes` paths-filter job, NOT a build matrix):

1. In the `changes` job `outputs:` block (after the `cloudflare-worker:` line), add:

```yaml
cherry: ${{ steps.filter.outputs.cherry }}
```

2. In the `dorny/paths-filter` `filters:` block (after the `cloudflare-worker:` filter), add:

```yaml
cherry:
  - 'packages/cherry/**'
```

3. Add a discrete `cherry:` job (model it on the existing `node-server:` job — TS package, typecheck + coverage gate + build, no Vite bundle scan since cherry is plain `tsc` output of hand-written DOM code with no deps):

```yaml
cherry:
  needs: changes
  if: >-
    needs.changes.outputs.cherry == 'true' ||
    needs.changes.outputs.root-config == 'true'
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
    - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
      with:
        node-version: 24
        cache: npm
    - run: npm ci
    - name: Typecheck
      run: tsc --noEmit -p packages/cherry/tsconfig.json
    - name: Test (with coverage threshold gate)
      run: npm run test:coverage:cherry
    - name: Upload coverage report
      if: always()
      uses: actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
      with:
        name: coverage-cherry
        path: coverage/
        if-no-files-found: ignore
    - name: Build
      run: npm run build -w @slicc/cherry
```

4. (Optional but recommended) Add `needs.changes.outputs.cherry == 'true' ||` to the `node-matrix-tests` job's `if:` so a cherry-only change still gets multi-Node-major coverage. That job runs the root `npm run test`, which already includes the `cherry` project once it is registered — this only widens the trigger condition.

If `knip.json` lists packages explicitly, add `packages/cherry`.

- [ ] **Step 7: Verify full wiring**

Run: `npm install` then `npm run typecheck` then `npm run test:coverage:cherry`
Expected: install updates `package-lock.json`; typecheck passes including the new tsconfig; the coverage gate passes (stub file is fully covered by the two tests).

- [ ] **Step 8: Commit**

```bash
npx prettier --write packages/cherry package.json vitest.config.ts .github/workflows/ci.yml
git add packages/cherry package.json package-lock.json vitest.config.ts .github/workflows/ci.yml knip.json
git commit -m "feat(cherry): scaffold @slicc/cherry host SDK package"
```

---

### Task 2: Cherry host protocol (envelope union + three-factor validator)

**Files:**

- Create: `packages/webapp/src/cdp/cherry-host-protocol.ts`
- Test: `packages/webapp/tests/cdp/cherry-host-protocol.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/webapp/tests/cdp/cherry-host-protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CHERRY_PROTOCOL_VERSION,
  isCherryEnvelope,
  acceptEnvelope,
  type CherryEnvelope,
} from '../../src/cdp/cherry-host-protocol.js';

const make = (over: Partial<CherryEnvelope> = {}): CherryEnvelope =>
  ({
    cherry: CHERRY_PROTOCOL_VERSION,
    channelId: 'cherry-abc',
    kind: 'cdp.request',
    id: 1,
    method: 'Page.enable',
    ...over,
  }) as CherryEnvelope;

describe('isCherryEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isCherryEnvelope(make())).toBe(true);
  });
  it('rejects wrong protocol version', () => {
    expect(isCherryEnvelope({ ...make(), cherry: 999 })).toBe(false);
  });
  it('rejects non-objects', () => {
    expect(isCherryEnvelope(null)).toBe(false);
    expect(isCherryEnvelope('x')).toBe(false);
  });
});

describe('acceptEnvelope three-factor pinning', () => {
  const expectedSource = {} as MessageEventSource;
  const ctx = {
    allowOrigins: ['https://host.example'],
    expectedSource,
    channelId: 'cherry-abc',
  };

  it('accepts matching origin + source + channelId', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(true);
  });

  it('rejects foreign origin', () => {
    const ev = {
      origin: 'https://evil.example',
      source: expectedSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('rejects mismatched source', () => {
    const ev = {
      origin: 'https://host.example',
      source: {} as MessageEventSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('rejects mismatched channelId', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make({ channelId: 'cherry-other' }),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('accepts pre-handshake when ctx.channelId is null', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make({ kind: 'handshake.hello', channelId: 'cherry-new' }),
    } as MessageEvent;
    expect(acceptEnvelope(ev, { ...ctx, channelId: null })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webapp -- cherry-host-protocol`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the protocol module**

`packages/webapp/src/cdp/cherry-host-protocol.ts`:

```ts
/**
 * Cherry host protocol: the postMessage envelope contract between the embedded
 * SLICC follower (iframe) and the @slicc/cherry host SDK.
 *
 * Security: every inbound message is validated by acceptEnvelope() against three
 * independent factors — origin allowlist, MessageEvent.source identity, and a
 * per-mount channelId nonce — before any synthetic CDP is acted on.
 */

export const CHERRY_PROTOCOL_VERSION = 1;

export interface CherryHandshakeHello {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'handshake.hello';
  capabilities: { navigate: boolean; screenshot: boolean; openUrl: boolean };
}

export interface CherryHandshakeWelcome {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'handshake.welcome';
  /** Direct tray join URL when the host supplied one (no provisioning needed). */
  joinUrl?: string;
  /**
   * Provisioning payload forwarded by the host SDK when it supplied an IMS token
   * instead of a join URL. The iframe (same-origin with the worker) runs the
   * `/api/cloud/*` orchestration; see `main-cherry.ts:resolveCherryJoinUrl`
   * (Task 13). Exactly one of `joinUrl` / `auth` is expected.
   */
  auth?: { token: string; coneName?: string; createIfMissing?: boolean };
}

export interface CherryCdpRequest {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.request';
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CherryCdpResponse {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.response';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface CherryCdpEvent {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'cdp.event';
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CherryPermissionRequest {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'permission.request';
  id: number;
  domain: string;
}

export interface CherryPermissionResponse {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'permission.response';
  id: number;
  granted: boolean;
}

export interface CherryHostEvent {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'host.event';
  name: string;
  detail?: unknown;
}

export interface CherrySliccEvent {
  cherry: typeof CHERRY_PROTOCOL_VERSION;
  channelId: string;
  kind: 'slicc.event';
  name: string;
  detail?: unknown;
}

export type CherryEnvelope =
  | CherryHandshakeHello
  | CherryHandshakeWelcome
  | CherryCdpRequest
  | CherryCdpResponse
  | CherryCdpEvent
  | CherryPermissionRequest
  | CherryPermissionResponse
  | CherryHostEvent
  | CherrySliccEvent;

const KINDS = new Set<CherryEnvelope['kind']>([
  'handshake.hello',
  'handshake.welcome',
  'cdp.request',
  'cdp.response',
  'cdp.event',
  'permission.request',
  'permission.response',
  'host.event',
  'slicc.event',
]);

export function isCherryEnvelope(value: unknown): value is CherryEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.cherry === CHERRY_PROTOCOL_VERSION &&
    typeof v.channelId === 'string' &&
    typeof v.kind === 'string' &&
    KINDS.has(v.kind as CherryEnvelope['kind'])
  );
}

export interface AcceptContext {
  /** Allowlisted origins of the counterpart frame. */
  allowOrigins: string[];
  /** The MessageEventSource we expect (iframe.contentWindow or window.parent). */
  expectedSource: MessageEventSource | null;
  /** Pinned channel nonce. null only during pre-handshake (accept any). */
  channelId: string | null;
}

/**
 * Three-factor gate. ALL must hold before a message is acted on:
 *  1. event.origin is in the allowlist
 *  2. event.source is identity-equal to the expected window
 *  3. envelope.channelId equals the pinned nonce (skipped only when null = pre-handshake)
 */
export function acceptEnvelope(event: MessageEvent, ctx: AcceptContext): boolean {
  if (!ctx.allowOrigins.includes(event.origin)) return false;
  if (ctx.expectedSource !== null && event.source !== ctx.expectedSource) return false;
  if (!isCherryEnvelope(event.data)) return false;
  if (ctx.channelId !== null && event.data.channelId !== ctx.channelId) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/webapp -- cherry-host-protocol`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/cdp/cherry-host-protocol.ts packages/webapp/tests/cdp/cherry-host-protocol.test.ts
git add packages/webapp/src/cdp/cherry-host-protocol.ts packages/webapp/tests/cdp/cherry-host-protocol.test.ts
git commit -m "feat(cherry): add host protocol envelope union and three-factor validator"
```

---

### Task 3: CherryHostTransport (third CDPTransport impl)

**Files:**

- Create: `packages/webapp/src/cdp/cherry-host-transport.ts`
- Test: `packages/webapp/tests/cdp/cherry-host-transport.test.ts`

The transport runs **inside the follower iframe**. It implements `CDPTransport` (same interface as `CDPClient`/`DebuggerClient`) but instead of a WebSocket or `chrome.debugger`, it sends `cdp.request` envelopes to the host SDK (`window.parent`) and resolves on `cdp.response`. It synthesizes the session lifecycle that `BrowserAPI` depends on (`Target.getTargets`/`attachToTarget`, `Page/Runtime/DOM.enable`, `getFrameTree`) and, critically, emits `Page.frameNavigated` + `Page.loadEventFired` after a `Page.navigate` resolves so `BrowserAPI.navigate()` does not hang.

- [ ] **Step 1: Write the failing test**

`packages/webapp/tests/cdp/cherry-host-transport.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CherryHostTransport } from '../../src/cdp/cherry-host-transport.js';
import { CHERRY_PROTOCOL_VERSION } from '../../src/cdp/cherry-host-protocol.js';

function makeTransport() {
  const posted: any[] = [];
  const parent = { postMessage: (m: any) => posted.push(m) } as unknown as Window;
  const transport = new CherryHostTransport({
    counterpart: parent,
    allowOrigins: ['https://host.example'],
    targetOrigin: 'https://host.example',
  });
  // Drive inbound messages as if from the host.
  const inbound = (data: any) =>
    transport.__test_receive({
      origin: 'https://host.example',
      source: parent as unknown as MessageEventSource,
      data,
    } as MessageEvent);
  return { transport, posted, parent, inbound };
}

describe('CherryHostTransport', () => {
  let h: ReturnType<typeof makeTransport>;
  beforeEach(() => {
    h = makeTransport();
  });

  it('handshakes: sends hello, resolves connect on welcome', async () => {
    const p = h.transport.connect();
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');
    expect(hello).toBeTruthy();
    expect(hello.cherry).toBe(CHERRY_PROTOCOL_VERSION);
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
      joinUrl: 'https://app.example/join?t=Z',
    });
    await expect(p).resolves.toBeUndefined();
    expect(h.transport.state).toBe('connected');
    expect(h.transport.joinUrl).toBe('https://app.example/join?t=Z');
  });

  it('synthesizes Target.getTargets locally without a host round-trip', async () => {
    await connectHelper(h);
    const res = await h.transport.send('Target.getTargets');
    expect(Array.isArray((res as any).targetInfos)).toBe(true);
    expect((res as any).targetInfos[0].type).toBe('page');
  });

  it('forwards leaf methods and resolves on cdp.response', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const p = h.transport.send('Runtime.evaluate', { expression: '1+1' });
    const req = h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'Runtime.evaluate');
    expect(req).toBeTruthy();
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      result: { result: { type: 'number', value: 2 } },
    });
    await expect(p).resolves.toEqual({ result: { type: 'number', value: 2 } });
  });

  it('emits frameNavigated + loadEventFired after Page.navigate resolves', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const events: string[] = [];
    h.transport.on('Page.frameNavigated', () => events.push('frameNavigated'));
    h.transport.on('Page.loadEventFired', () => events.push('loadEventFired'));
    const p = h.transport.send('Page.navigate', { url: 'https://host.example/next' });
    const req = h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'Page.navigate');
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      result: { frameId: 'cherry-frame' },
    });
    await p;
    expect(events).toEqual(['frameNavigated', 'loadEventFired']);
  });

  it('rejects inbound from a foreign origin', async () => {
    await connectHelper(h);
    const before = h.posted.length;
    h.transport.__test_receive({
      origin: 'https://evil.example',
      source: h.parent as unknown as MessageEventSource,
      data: { cherry: CHERRY_PROTOCOL_VERSION, channelId: 'x', kind: 'cdp.event', method: 'X' },
    } as MessageEvent);
    expect(h.posted.length).toBe(before); // no reaction
  });
});

async function connectHelper(h: ReturnType<typeof makeTransport>) {
  const p = h.transport.connect();
  const hello = h.posted.find((m) => m.kind === 'handshake.hello');
  h.inbound({
    cherry: CHERRY_PROTOCOL_VERSION,
    channelId: hello.channelId,
    kind: 'handshake.welcome',
  });
  await p;
}
function lastChannelId(h: ReturnType<typeof makeTransport>) {
  return h.posted.find((m) => m.kind === 'handshake.hello').channelId as string;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webapp -- cherry-host-transport`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the transport**

`packages/webapp/src/cdp/cherry-host-transport.ts`:

```ts
import type { CDPTransport } from './transport.js';
import type { CDPEventListener, CDPConnectOptions, ConnectionState } from './types.js';
import {
  CHERRY_PROTOCOL_VERSION,
  acceptEnvelope,
  type CherryEnvelope,
} from './cherry-host-protocol.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('cherry-transport');

export interface CherryHostTransportOptions {
  /** The counterpart window (the host page = window.parent). */
  counterpart: Window;
  /** Allowlisted host origins. */
  allowOrigins: string[];
  /** Origin to target on postMessage (the host origin). */
  targetOrigin: string;
  capabilities?: { navigate: boolean; screenshot: boolean; openUrl: boolean };
}

const SYNTHETIC_SESSION = 'cherry-session';
const SYNTHETIC_TARGET = 'cherry-target';
const SYNTHETIC_FRAME = 'cherry-frame';

export class CherryHostTransport implements CDPTransport {
  private opts: CherryHostTransportOptions;
  private channelId: string | null = null;
  private nextId = 1;
  private _state: ConnectionState = 'disconnected';
  private pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private listeners = new Map<string, Set<CDPEventListener>>();
  private connectResolve: (() => void) | null = null;
  private _joinUrl: string | null = null;
  private _provisioningAuth: {
    token: string;
    coneName?: string;
    createIfMissing?: boolean;
  } | null = null;
  private boundHandler = (ev: MessageEvent) => this.handleMessage(ev);

  constructor(opts: CherryHostTransportOptions) {
    this.opts = opts;
  }

  get state(): ConnectionState {
    return this._state;
  }

  /**
   * The leader join URL the host SDK supplied in handshake.welcome, if any.
   * The cherry boot path (Task 13) reads this to start the follower against
   * the same leader the host provisioned.
   */
  get joinUrl(): string | null {
    return this._joinUrl;
  }

  /**
   * Provisioning payload from handshake.welcome when the host handed an IMS
   * token instead of a join URL. The cherry boot path (Task 13) runs the
   * same-origin `/api/cloud/*` orchestration against it iframe-side. Held in
   * memory only — never persisted, never re-emitted.
   */
  get provisioningAuth(): { token: string; coneName?: string; createIfMissing?: boolean } | null {
    return this._provisioningAuth;
  }

  async connect(_options?: CDPConnectOptions): Promise<void> {
    if (this._state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this._state}`);
    }
    this._state = 'connecting';
    this.channelId = `cherry-${crypto.randomUUID()}`;
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.boundHandler);
    }
    return new Promise<void>((resolve) => {
      this.connectResolve = resolve;
      this.post({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: this.channelId!,
        kind: 'handshake.hello',
        capabilities: this.opts.capabilities ?? {
          navigate: true,
          screenshot: true,
          openUrl: true,
        },
      });
    });
  }

  disconnect(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.boundHandler);
    }
    for (const [, p] of this.pending) p.reject(new Error('Cherry transport disconnected'));
    this.pending.clear();
    this._state = 'disconnected';
    this.channelId = null;
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
    _sessionId?: string,
    timeout = 30000
  ): Promise<Record<string, unknown>> {
    if (this._state !== 'connected') throw new Error('Cherry transport is not connected');

    const synthetic = this.handleSynthetic(method, params);
    if (synthetic) return synthetic;

    const id = this.nextId++;
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Cherry CDP timed out after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.post({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: this.channelId!,
        kind: 'cdp.request',
        id,
        method,
        params,
      });
    });

    if (method === 'Page.navigate') {
      this.synthesizeNavigationLifecycle(result);
    }
    return result;
  }

  on(event: string, listener: CDPEventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: CDPEventListener): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(event);
    }
  }

  once(event: string, timeout = 30000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, handler);
        reject(new Error(`Timed out waiting for event: ${event}`));
      }, timeout);
      const handler: CDPEventListener = (params) => {
        clearTimeout(timer);
        this.off(event, handler);
        resolve(params);
      };
      this.on(event, handler);
    });
  }

  /** Test seam: inject a MessageEvent without a real window. */
  __test_receive(event: MessageEvent): void {
    this.handleMessage(event);
  }

  // ---------------------------------------------------------------------------

  private post(env: CherryEnvelope): void {
    this.opts.counterpart.postMessage(env, this.opts.targetOrigin);
  }

  private emit(method: string, params: Record<string, unknown>): void {
    const set = this.listeners.get(method);
    if (!set) return;
    for (const l of set) {
      try {
        l(params);
      } catch {
        /* one listener must not break others */
      }
    }
  }

  /** Methods the transport answers locally to satisfy BrowserAPI's session setup. */
  private handleSynthetic(
    method: string,
    _params?: Record<string, unknown>
  ): Promise<Record<string, unknown>> | null {
    switch (method) {
      case 'Target.getTargets':
        return Promise.resolve({
          targetInfos: [
            {
              targetId: SYNTHETIC_TARGET,
              type: 'page',
              title: 'Cherry Host Page',
              url: typeof location !== 'undefined' ? location.href : 'about:blank',
              attached: true,
            },
          ],
        });
      case 'Target.attachToTarget':
        return Promise.resolve({ sessionId: SYNTHETIC_SESSION });
      case 'Target.detachFromTarget':
      case 'Target.closeTarget':
        return Promise.resolve({ success: true });
      case 'Page.enable':
      case 'Runtime.enable':
      case 'DOM.enable':
      case 'Page.bringToFront':
        return Promise.resolve({});
      case 'Page.getFrameTree':
        return Promise.resolve({
          frameTree: {
            frame: {
              id: SYNTHETIC_FRAME,
              loaderId: 'cherry-loader',
              url: typeof location !== 'undefined' ? location.href : 'about:blank',
              securityOrigin: this.opts.targetOrigin,
              mimeType: 'text/html',
            },
            childFrames: [],
          },
        });
      case 'Runtime.createIsolatedWorld':
        return Promise.resolve({ executionContextId: 1 });
      default:
        return null;
    }
  }

  private synthesizeNavigationLifecycle(navResult: Record<string, unknown>): void {
    const frameId = (navResult.frameId as string) ?? SYNTHETIC_FRAME;
    const url = typeof location !== 'undefined' ? location.href : 'about:blank';
    this.emit('Page.frameNavigated', {
      frame: {
        id: frameId,
        loaderId: 'cherry-loader',
        url,
        securityOrigin: this.opts.targetOrigin,
        mimeType: 'text/html',
      },
      sessionId: SYNTHETIC_SESSION,
    });
    this.emit('Page.loadEventFired', {
      timestamp: Date.now() / 1000,
      sessionId: SYNTHETIC_SESSION,
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (
      !acceptEnvelope(event, {
        allowOrigins: this.opts.allowOrigins,
        expectedSource: this.opts.counterpart as unknown as MessageEventSource,
        channelId: this.channelId,
      })
    ) {
      return;
    }
    const env = event.data as CherryEnvelope;
    switch (env.kind) {
      case 'handshake.welcome':
        this._state = 'connected';
        this._joinUrl = env.joinUrl ?? null;
        this._provisioningAuth = env.auth ?? null;
        log.info('Cherry handshake complete', { channelId: this.channelId });
        this.connectResolve?.();
        this.connectResolve = null;
        return;
      case 'cdp.response': {
        const p = this.pending.get(env.id);
        if (!p) return;
        this.pending.delete(env.id);
        if (env.error)
          p.reject(new Error(`Cherry CDP error: ${env.error.message} (${env.error.code})`));
        else p.resolve(env.result ?? {});
        return;
      }
      case 'cdp.event':
        this.emit(env.method, {
          ...(env.params ?? {}),
          sessionId: env.sessionId ?? SYNTHETIC_SESSION,
        });
        return;
      default:
        return;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/webapp -- cherry-host-transport`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/cdp/cherry-host-transport.ts packages/webapp/tests/cdp/cherry-host-transport.test.ts
git add packages/webapp/src/cdp/cherry-host-transport.ts packages/webapp/tests/cdp/cherry-host-transport.test.ts
git commit -m "feat(cherry): add CherryHostTransport synthetic-CDP transport"
```

---

### Task 4: Host-side CDP handlers (`createCdpHostHandler`)

**Files:**

- Create: `packages/cherry/src/cdp-host-handlers.ts`
- Test: `packages/cherry/tests/cdp-host-handlers.test.ts`

This runs **on the host page** (inside `@slicc/cherry`). It receives `cdp.request` methods the transport forwarded and executes them against the real host DOM. Unsupported methods return a clean CDP "method not found" error (code `-32601`) so the leader degrades gracefully rather than hanging.

**`Runtime.evaluate` note (security):** The CDP contract for `Runtime.evaluate` is to evaluate an expression string in the page realm. Cherry does NOT invent its own evaluator — it delegates to the host page's own realm via the standard indirect-eval entry point, which is governed entirely by the **host page's own Content-Security-Policy**. If the host's CSP forbids dynamic evaluation, `Runtime.evaluate` fails closed with the browser's native error surfaced as `exceptionDetails` — Cherry adds no escape hatch of its own. The capability is only reachable because the host explicitly opted in via `mountSlicc({ capabilities })` and passed the per-domain `onPermissionRequest` gate. Implement realm evaluation by capturing the global evaluator through an indirect reference (`const evalInRealm = (0, eval);`) and calling it on the expression; wrap in try/catch and translate any thrown value into `exceptionDetails`. Keep the inline comment documenting the host-CSP-governs-eval invariant.

- [ ] **Step 1: Write the failing test**

`packages/cherry/tests/cdp-host-handlers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createCdpHostHandler, CherryUnsupportedError } from '../src/cdp-host-handlers.js';

describe('createCdpHostHandler', () => {
  let handle: ReturnType<typeof createCdpHostHandler>;
  beforeEach(() => {
    const btn = document.createElement('button');
    btn.id = 'b';
    btn.textContent = 'Hi';
    document.body.replaceChildren(btn);
    handle = createCdpHostHandler({
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
    });
  });

  it('Runtime.evaluate returns a primitive remote object', async () => {
    const res = await handle('Runtime.evaluate', { expression: '40 + 2' });
    expect((res as any).result.value).toBe(42);
    expect((res as any).result.type).toBe('number');
  });

  it('Runtime.evaluate surfaces thrown errors as exceptionDetails', async () => {
    const res = await handle('Runtime.evaluate', { expression: 'throw new Error("boom")' });
    expect((res as any).exceptionDetails).toBeTruthy();
  });

  it('DOM.getDocument returns a root node id', async () => {
    const res = await handle('DOM.getDocument', {});
    expect(typeof (res as any).root.nodeId).toBe('number');
  });

  it('rejects unsupported methods with -32601', async () => {
    await expect(handle('Network.enable', {})).rejects.toBeInstanceOf(CherryUnsupportedError);
    await expect(handle('Network.enable', {})).rejects.toMatchObject({ code: -32601 });
  });

  it('Page.captureScreenshot rejects cleanly when screenshot is none', async () => {
    await expect(handle('Page.captureScreenshot', {})).rejects.toBeInstanceOf(
      CherryUnsupportedError
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/cherry -- cdp-host-handlers`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handlers**

`packages/cherry/src/cdp-host-handlers.ts`:

```ts
/**
 * Host-realm execution of the synthetic CDP subset Cherry supports.
 * Runs on the third-party host page inside @slicc/cherry.
 */

export class CherryUnsupportedError extends Error {
  readonly code = -32601;
  constructor(method: string) {
    super(`Cherry: unsupported CDP method '${method}'`);
    this.name = 'CherryUnsupportedError';
  }
}

export interface CdpHostHandlerOptions {
  capabilities: { navigate: boolean; screenshot: 'html2canvas' | 'none'; openUrl: boolean };
  onOpenUrl?: (url: string) => void;
}

type Handler = (
  method: string,
  params: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export function createCdpHostHandler(opts: CdpHostHandlerOptions): Handler {
  const nodeIds = new WeakMap<Node, number>();
  const nodesById = new Map<number, Node>();
  let nextNodeId = 1;

  const idFor = (node: Node): number => {
    let id = nodeIds.get(node);
    if (id === undefined) {
      id = nextNodeId++;
      nodeIds.set(node, id);
      nodesById.set(id, node);
    }
    return id;
  };

  const toRemoteObject = (value: unknown): Record<string, unknown> => {
    const type = typeof value;
    if (value === null) return { type: 'object', subtype: 'null', value: null };
    if (type === 'undefined') return { type: 'undefined' };
    if (type === 'number' || type === 'boolean' || type === 'string') {
      return { type, value };
    }
    return { type: 'object', description: String(value) };
  };

  // Host-CSP-governs-eval invariant: we delegate to the page realm's own
  // evaluator via indirect eval. If the host CSP forbids dynamic eval, this
  // throws natively and we surface it as exceptionDetails — Cherry adds no
  // escape hatch of its own.
  const evalInRealm = (0, eval) as (src: string) => unknown;

  return async function handle(method, params) {
    switch (method) {
      case 'Runtime.evaluate': {
        const expression = String(params.expression ?? '');
        try {
          const value = evalInRealm(expression);
          const resolved = value instanceof Promise ? await value : value;
          return { result: toRemoteObject(resolved) };
        } catch (err) {
          return {
            result: { type: 'object', subtype: 'error' },
            exceptionDetails: {
              text: err instanceof Error ? err.message : String(err),
              exception: { type: 'object', description: String(err) },
            },
          };
        }
      }
      case 'DOM.getDocument': {
        return { root: { nodeId: idFor(document), nodeName: '#document', childNodeCount: 1 } };
      }
      case 'DOM.querySelector': {
        const root = nodesById.get(Number(params.nodeId)) ?? document;
        const sel = String(params.selector ?? '');
        const el = (root as ParentNode).querySelector?.(sel) ?? null;
        return { nodeId: el ? idFor(el) : 0 };
      }
      case 'DOM.getBoxModel': {
        const node = nodesById.get(Number(params.nodeId));
        const el = node as Element | undefined;
        const r = el?.getBoundingClientRect?.();
        if (!r) throw new CherryUnsupportedError('DOM.getBoxModel(no-rect)');
        const quad = [r.left, r.top, r.right, r.top, r.right, r.bottom, r.left, r.bottom];
        return { model: { content: quad, width: r.width, height: r.height } };
      }
      case 'Input.dispatchMouseEvent': {
        const x = Number(params.x ?? 0);
        const y = Number(params.y ?? 0);
        const target = document.elementFromPoint(x, y);
        if (target && params.type === 'mousePressed') {
          (target as HTMLElement).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })
          );
        }
        return {};
      }
      case 'Input.dispatchKeyEvent': {
        const active = document.activeElement as HTMLElement | null;
        if (active && params.type === 'keyDown' && typeof params.key === 'string') {
          active.dispatchEvent(new KeyboardEvent('keydown', { key: params.key, bubbles: true }));
        }
        return {};
      }
      case 'Page.captureScreenshot': {
        if (opts.capabilities.screenshot !== 'html2canvas') {
          throw new CherryUnsupportedError('Page.captureScreenshot');
        }
        const { default: html2canvas } = await import('html2canvas');
        const canvas = await html2canvas(document.body);
        const data = canvas.toDataURL('image/png').split(',')[1] ?? '';
        return { data };
      }
      case 'Page.navigate': {
        if (!opts.capabilities.navigate) throw new CherryUnsupportedError('Page.navigate');
        const url = String(params.url ?? '');
        location.assign(url);
        return { frameId: 'cherry-frame', loaderId: 'cherry-loader' };
      }
      case 'Target.createTarget': {
        if (!opts.capabilities.openUrl) throw new CherryUnsupportedError('Target.createTarget');
        const url = String(params.url ?? '');
        opts.onOpenUrl?.(url);
        return { targetId: 'cherry-opened' };
      }
      default:
        throw new CherryUnsupportedError(method);
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/cherry -- cdp-host-handlers`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/cherry/src/cdp-host-handlers.ts packages/cherry/tests/cdp-host-handlers.test.ts
git add packages/cherry/src/cdp-host-handlers.ts packages/cherry/tests/cdp-host-handlers.test.ts
git commit -m "feat(cherry): add host-realm CDP handlers with clean unsupported-method errors"
```

---

### Task 5: Capability-tagged targets in tray sync protocol

**Files:**

- Modify: `packages/webapp/src/scoops/tray-sync-protocol.ts`
- Modify: `packages/webapp/src/scoops/tray-target-registry.ts`
- Modify: `packages/webapp/src/cdp/browser-api.ts`
- Test: `packages/webapp/tests/scoops/tray-sync-protocol.test.ts`

**Current shapes (verified):** `RemoteTargetInfo` is `{ targetId: string; title: string; url: string }` — there is **no `type` field today**. `TrayTargetEntry` is `{ targetId; localTargetId; runtimeId; title; url; isLocal }`. There are **two** message unions in this file: `TraySyncMessage` (leader→follower) and `FollowerToLeaderMessage` (follower→leader). The cherry messages go in **different** unions (see Step 3) — do not add both to `TraySyncMessage`.

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-sync-protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  isCherrySliccEventMessage,
  type RemoteTargetInfo,
} from '../../src/scoops/tray-sync-protocol.js';

describe('cherry target tagging', () => {
  it('RemoteTargetInfo carries kind and capabilities', () => {
    const t: RemoteTargetInfo = {
      targetId: 't1',
      title: 'Host',
      url: 'https://host.example',
      kind: 'cherry',
      capabilities: { navigate: true, network: false, screenshot: true },
    };
    expect(t.kind).toBe('cherry');
    expect(t.capabilities?.network).toBe(false);
  });

  it('isCherrySliccEventMessage narrows the union', () => {
    expect(
      isCherrySliccEventMessage({
        type: 'cherry.slicc_event',
        targetId: 't1',
        name: 'open-url',
        detail: { url: 'https://x' },
      })
    ).toBe(true);
    expect(isCherrySliccEventMessage({ type: 'cdp.request' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tray-sync-protocol`
Expected: FAIL — `kind`/`capabilities` not on type; `isCherrySliccEventMessage` undefined.

- [ ] **Step 3: Extend the protocol**

In `packages/webapp/src/scoops/tray-sync-protocol.ts`, extend `RemoteTargetInfo` (add only the two optional fields — keep the existing three):

```ts
export interface RemoteTargetInfo {
  targetId: string;
  title: string;
  url: string;
  /** Distinguishes a real browser page from a cooperative cherry host page. */
  kind?: 'browser' | 'cherry';
  /** Only present for kind === 'cherry'. What the host page lends to the leader. */
  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}
```

Extend `TrayTargetEntry` (`{ targetId; localTargetId; runtimeId; title; url; isLocal }`) to carry the same optional `kind`/`capabilities`. Define the two cherry messages and their guards:

```ts
export interface CherryHostEventMessage {
  type: 'cherry.host_event';
  targetId: string;
  name: string;
  detail?: unknown;
}

export interface CherrySliccEventMessage {
  type: 'cherry.slicc_event';
  targetId: string;
  name: string;
  detail?: unknown;
}

export function isCherryHostEventMessage(m: unknown): m is CherryHostEventMessage {
  return (
    typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cherry.host_event'
  );
}

export function isCherrySliccEventMessage(m: unknown): m is CherrySliccEventMessage {
  return (
    typeof m === 'object' && m !== null && (m as { type?: string }).type === 'cherry.slicc_event'
  );
}
```

Add each to the **correct** union by direction:

- `CherrySliccEventMessage` (`'cherry.slicc_event'`, cone→host) → add to the **`TraySyncMessage`** union (leader→follower).
- `CherryHostEventMessage` (`'cherry.host_event'`, host→cone) → add to the **`FollowerToLeaderMessage`** union (follower→leader).

(Both interfaces and both guards still live in this one file; only the union membership differs.)

- [ ] **Step 4: Propagate through registry + browser-api**

In `packages/webapp/src/scoops/tray-target-registry.ts` `getEntries()`, copy `kind` and `capabilities` from the source target onto each emitted `TrayTargetEntry` (default `kind: 'browser'` when absent). In `browser-api.ts` `listAllTargets()`, carry `kind`/`capabilities` through onto the returned target info so teleport selection (Task 6) can read them.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -w @slicc/webapp -- tray-sync-protocol`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/webapp/src/scoops/tray-sync-protocol.ts packages/webapp/src/scoops/tray-target-registry.ts packages/webapp/src/cdp/browser-api.ts packages/webapp/tests/scoops/tray-sync-protocol.test.ts
git add packages/webapp/src/scoops/tray-sync-protocol.ts packages/webapp/src/scoops/tray-target-registry.ts packages/webapp/src/cdp/browser-api.ts packages/webapp/tests/scoops/tray-sync-protocol.test.ts
git commit -m "feat(cherry): tag tray targets with kind and capabilities; add cherry event messages"
```

---

### Task 6: Leader-side cherry target handling

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts`
- Test: `packages/webapp/tests/scoops/tray-leader-sync.test.ts`

**Verified context:** `TrayLeaderSync.getBestFollowerForTeleport()` takes **no arguments** and returns a follower _runtime_ (`{ runtimeId, bootstrapId, floatType } | null`) by floatType/lastActivity — it does **not** inspect targets, so cherry capability filtering does NOT belong inside it. `handleFollowerMessage(bootstrapId, message)` is the follower→leader switch (currently handles `user_message`, `targets.advertise`, `cdp.request`, `tab.open`, etc.). The federated "open a URL on a follower" path is the existing **`tab.open` / `tab.opened` / `tab.open.error`** message flow — there is no `Target.createTarget` in this layer.

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/tray-leader-sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isCherryTarget, selectTeleportPool } from '../../src/scoops/tray-leader-sync.js';

describe('cherry teleport selection', () => {
  const browserTarget = { targetId: 'b', kind: 'browser' as const };
  const cherryTarget = {
    targetId: 'c',
    kind: 'cherry' as const,
    capabilities: { navigate: true, network: false, screenshot: true },
  };

  it('isCherryTarget detects cherry kind', () => {
    expect(isCherryTarget(cherryTarget)).toBe(true);
    expect(isCherryTarget(browserTarget)).toBe(false);
  });

  it('selectTeleportPool excludes cherry targets when network is required', () => {
    const pool = selectTeleportPool([browserTarget, cherryTarget], { requireNetwork: true });
    expect(pool.map((t) => t.targetId)).toEqual(['b']);
  });

  it('selectTeleportPool includes cherry targets when network is not required', () => {
    const pool = selectTeleportPool([browserTarget, cherryTarget], { requireNetwork: false });
    expect(pool.map((t) => t.targetId).sort()).toEqual(['b', 'c']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webapp -- tray-leader-sync`
Expected: FAIL — `isCherryTarget`/`selectTeleportPool` undefined.

- [ ] **Step 3: Implement selection + event routing**

In `packages/webapp/src/scoops/tray-leader-sync.ts`:

```ts
import type { RemoteTargetInfo } from './tray-sync-protocol.js';

export function isCherryTarget(t: Pick<RemoteTargetInfo, 'kind'>): boolean {
  return t.kind === 'cherry';
}

export function selectTeleportPool<
  T extends Pick<RemoteTargetInfo, 'kind' | 'capabilities'> & { targetId: string },
>(targets: T[], opts: { requireNetwork: boolean }): T[] {
  return targets.filter((t) => {
    if (!isCherryTarget(t)) return true;
    if (opts.requireNetwork) return false;
    return true;
  });
}
```

Wiring (anchored to the real code):

- **Teleport filtering** does NOT go in `getBestFollowerForTeleport()` (it selects a follower runtime, not a target). Apply `selectTeleportPool` where the leader chooses a _target_ to drive — i.e. at the target-selection site that consumes the `targets.registry` / advertised `RemoteTargetInfo[]` (read the actual teleport entry point; `playwright-command.ts` and `tray-leader-sync` target routing are the consumers). Pass `requireNetwork: true` for any teleport that needs `Network.*`.
- **Host→cone events:** in the `handleFollowerMessage(bootstrapId, message)` switch, add `case 'cherry.host_event':` that calls `lickManager.emitEvent({ type: 'cherry', cherryRuntimeId: ..., cherryName: message.name, cherryOrigin: ..., body: message.detail, timestamp: new Date().toISOString() })` (the `'cherry'` lick type lands in Task 7).
- **Open-url:** there is no `Target.createTarget` in this layer. Lean on the existing `tab.open` flow — when the host's `capabilities.openUrl` (mapped to the target's advertised capability) is false, the leader must not emit a `tab.open` for that cherry target; surface it as the clean unsupported result on the requesting path rather than silently dropping.
- **Cone→host:** add `emitCherrySliccEvent(targetId, name, detail)` that sends a `cherry.slicc_event` message (the `TraySyncMessage` member from Task 5) to the follower that owns `targetId`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/webapp -- tray-leader-sync`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/tests/scoops/tray-leader-sync.test.ts
git add packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/tests/scoops/tray-leader-sync.test.ts
git commit -m "feat(cherry): leader-side cherry teleport pool selection and event routing"
```

---

### Task 7: `'cherry'` lick type + formatter

**Files:**

- Modify: `packages/webapp/src/scoops/lick-manager.ts`
- Modify: `packages/webapp/src/scoops/lick-formatting.ts`
- Test: `packages/webapp/tests/scoops/lick-formatting.test.ts`

**Verified context:** `LickEvent` (in `scoops/lick-manager.ts`) is a single interface with a `type` union, **required** `timestamp: string` and `body: unknown`, plus type-specific name fields (`webhookName`, `cronName`, `navigateUrl`, …). Follow that convention: add `'cherry'` to the union and add `cherryName?`, `cherryRuntimeId?`, `cherryOrigin?` — the payload goes in `body`, not a new `detail` field. `formatLickEventForCone(event): FormattedLick | null` returns **`{ label, content }`** (or `null` to drop), and is built from **chained ternaries** (there is no `switch`). `EXTERNAL_LICK_CHANNELS` is a `ReadonlySet<LickEvent['type']>` in `lick-formatting.ts`.

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/scoops/lick-formatting.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatLickEventForCone } from '../../src/scoops/lick-formatting.js';

describe('cherry lick formatting', () => {
  it('formats a cherry host event for the cone', () => {
    const formatted = formatLickEventForCone({
      type: 'cherry',
      cherryName: 'checkout-complete',
      cherryRuntimeId: 'follower-abc',
      cherryOrigin: 'https://shop.example',
      timestamp: new Date().toISOString(),
      body: { orderId: 42 },
    } as never);
    expect(formatted).not.toBeNull();
    expect(formatted!.label).toBe('Cherry Event');
    expect(formatted!.content).toContain('checkout-complete');
    expect(formatted!.content).toContain('shop.example');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webapp -- lick-formatting`
Expected: FAIL — `'cherry'` not handled.

- [ ] **Step 3: Add the type and formatter**

In `scoops/lick-manager.ts`, extend the `LickEvent` interface: add `'cherry'` to the `type` union and add three optional fields alongside the other typed name fields:

```ts
  /** For cherry events: the host-page event name, owning follower runtime, and host origin. */
  cherryName?: string;
  cherryRuntimeId?: string;
  cherryOrigin?: string;
```

In `scoops/lick-formatting.ts`, weave cherry into the existing **ternary chains** (there is no `switch` to add a `case` to) and return a `FormattedLick`:

1. Add a discriminant near the others: `const isCherry = event.type === 'cherry';`
2. Extend the `eventName` ternary chain so cherry resolves to `event.cherryName`.
3. Extend the `label` ternary chain so cherry resolves to `'Cherry Event'`.
4. Before the generic JSON fallback `return`, add a cherry branch that surfaces origin + runtime + name + body:

```ts
if (isCherry) {
  const origin = (event as { cherryOrigin?: string }).cherryOrigin ?? 'unknown origin';
  const runtime = (event as { cherryRuntimeId?: string }).cherryRuntimeId ?? 'unknown';
  const name = (event as { cherryName?: string }).cherryName ?? 'unnamed';
  return {
    label,
    content:
      `[${label}: ${name}] from ${origin} (runtime ${runtime})\n` +
      `\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``,
  };
}
```

(The generic fallback `eventName`/`label` chains already produce the right `label` via step 3; the explicit branch is what adds origin/runtime context, matching the `isUpgrade` precedent in the same file.)

Add `'cherry'` to `EXTERNAL_LICK_CHANNELS` so the cone surfaces it like other external licks.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/webapp -- lick-formatting`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/scoops/lick-manager.ts packages/webapp/src/scoops/lick-formatting.ts packages/webapp/tests/scoops/lick-formatting.test.ts
git add packages/webapp/src/scoops/lick-manager.ts packages/webapp/src/scoops/lick-formatting.ts packages/webapp/tests/scoops/lick-formatting.test.ts
git commit -m "feat(cherry): add 'cherry' lick type and cone formatter"
```

---

### Task 8: Canonical runtime identity helper

**Files:**

- Create: `packages/webapp/src/ui/runtime-identity.ts`
- Modify: `packages/webapp/src/ui/page-follower-tray.ts` (line ~161 — advertisement side)
- Modify: `packages/webapp/src/ui/main.ts` (leader bookkeeping — **two** sites, ~2588 and ~2611)
- Test: `packages/webapp/tests/ui/runtime-identity.test.ts`

**Verified context (read before editing):**

- Advertisement side: `page-follower-tray.ts:161` is `const runtimeId = \`follower-${connection.bootstrapId}\`;` — the canonical/prefixed form.
- Leader bookkeeping stores the **raw** `bootstrapId` at two sites in `ui/main.ts`, both building `{ runtimeId: p.bootstrapId, runtime, connectedAt }`:
  - `~2588` inside the `onFollowerCountChanged` callback (the `slicc.leaderTrayFollowers` localStorage write).
  - `~2611` inside `wireLeaderHooks` → `setConnectedFollowersGetter`.
    These two objects feed `getConnectedFollowers`, which `cherry-emit --runtime` and the leader-side cherry registry (Task 9) resolve against — so both must be reconciled to the prefixed form, or `--runtime` resolves against an id the advertisement side never uses.

- [ ] **Step 1: Write the failing test**

`packages/webapp/tests/ui/runtime-identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { canonicalRuntimeId } from '../../src/ui/runtime-identity.js';

describe('canonicalRuntimeId', () => {
  it('prefixes a bootstrap id', () => {
    expect(canonicalRuntimeId('abc')).toBe('follower-abc');
  });
  it('is idempotent for already-canonical ids', () => {
    expect(canonicalRuntimeId('follower-abc')).toBe('follower-abc');
  });
  it('throws on empty input', () => {
    expect(() => canonicalRuntimeId('')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webapp -- runtime-identity`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement and adopt the helper**

`packages/webapp/src/ui/runtime-identity.ts`:

```ts
/**
 * Single source of truth for the follower runtime id used to address a
 * specific follower (e.g. from the cherry-emit shell command).
 */
export function canonicalRuntimeId(bootstrapId: string): string {
  if (!bootstrapId) throw new Error('canonicalRuntimeId: bootstrapId is required');
  return bootstrapId.startsWith('follower-') ? bootstrapId : `follower-${bootstrapId}`;
}
```

Adopt the helper at all three sites (all in `packages/webapp/src/ui/`, so import `from './runtime-identity.js'`):

- `page-follower-tray.ts:161` — replace `const runtimeId = \`follower-${connection.bootstrapId}\`;`with`const runtimeId = canonicalRuntimeId(connection.bootstrapId);`. This is a no-op refactor (same output) but locks the format to one place.
- `ui/main.ts:~2588` — change `runtimeId: p.bootstrapId,` to `runtimeId: canonicalRuntimeId(p.bootstrapId),` inside the `onFollowerCountChanged` localStorage mapping.
- `ui/main.ts:~2611` — change `runtimeId: p.bootstrapId,` to `runtimeId: canonicalRuntimeId(p.bootstrapId),` inside the `setConnectedFollowersGetter` mapping.

After this change the leader's `getConnectedFollowers()` and the advertisement id agree, so `cherry-emit --runtime follower-<bootstrapId>` resolves deterministically.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/webapp -- runtime-identity`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/runtime-identity.ts packages/webapp/src/ui/page-follower-tray.ts packages/webapp/src/ui/main.ts packages/webapp/tests/ui/runtime-identity.test.ts
git add packages/webapp/src/ui/runtime-identity.ts packages/webapp/src/ui/page-follower-tray.ts packages/webapp/src/ui/main.ts packages/webapp/tests/ui/runtime-identity.test.ts
git commit -m "refactor(cherry): centralize follower runtime id via canonicalRuntimeId"
```

---

### Task 9: `cherry-emit` shell command

**Files:**

- Create: `packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts`
- Modify: `packages/webapp/src/shell/supplemental-commands/index.ts` (add the factory to `createSupplementalCommands` + a config field)
- Test: `packages/webapp/tests/shell/supplemental-commands/cherry-emit-command.test.ts`

`cherry-emit <name> [--detail <json>] [--runtime <id>]` lets the agent push a `slicc.event` out through a follower to the host page. With a single active follower runtime, `--runtime` defaults to it; with multiple, it errors and lists them.

**Verified context (read before editing — `which-command.ts` / `which-command.test.ts` / `index.ts`):**

- `defineCommand(name, async (args, ctx) => ({ stdout, stderr, exitCode }))` — `defineCommand` takes a **name string + handler**, not an options object. There is no `describe`/`run` shape.
- Supplemental commands are **factory functions** (`createWhichCommand(opts): Command`) that close over their dependencies; there is no `ctx.registry`. Inject the cherry registry through the factory closure.
- Commands are invoked in tests as `createXCommand(opts).execute(args, ctx)` and **return** `{ stdout, stderr, exitCode }`. Error conditions return `{ stdout: '', stderr: '…\n', exitCode: 1 }` — they are **not** thrown (mirror `which`'s "missing argument" path).
- Registration lives in `createSupplementalCommands(options)` in `index.ts`, which builds a `Command[]`. Add a `cherryRuntimeRegistry?: CherryRuntimeRegistry` field to `SupplementalCommandsConfig` and push `createCherryEmitCommand({ registry: options.cherryRuntimeRegistry })`.

- [ ] **Step 1: Write the failing test**

`packages/webapp/tests/shell/supplemental-commands/cherry-emit-command.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import {
  createCherryEmitCommand,
  type CherryRuntimeRegistry,
} from '../../../src/shell/supplemental-commands/cherry-emit-command.js';

function createMockCtx() {
  return {
    fs: {} as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
  };
}

function runtimeRegistry(
  ids: string[]
): CherryRuntimeRegistry & { emitSliccEvent: ReturnType<typeof vi.fn> } {
  return { listRuntimeIds: () => ids, emitSliccEvent: vi.fn() };
}

describe('cherry-emit command', () => {
  it('has correct name', () => {
    expect(createCherryEmitCommand({ registry: runtimeRegistry([]) }).name).toBe('cherry-emit');
  });

  it('emits to the sole runtime when --runtime omitted', async () => {
    const reg = runtimeRegistry(['follower-a']);
    const cmd = createCherryEmitCommand({ registry: reg });
    const result = await cmd.execute(['ping', '--detail', '{"x":1}'], createMockCtx());
    expect(reg.emitSliccEvent).toHaveBeenCalledWith('follower-a', 'ping', { x: 1 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('follower-a');
  });

  it('errors (exit 1) when multiple runtimes and no --runtime', async () => {
    const reg = runtimeRegistry(['follower-a', 'follower-b']);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/multiple/i);
    expect(reg.emitSliccEvent).not.toHaveBeenCalled();
  });

  it('errors (exit 1) when no runtimes are connected', async () => {
    const reg = runtimeRegistry([]);
    const result = await createCherryEmitCommand({ registry: reg }).execute(
      ['ping'],
      createMockCtx()
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no .*runtime/i);
  });

  it('errors (exit 1) when registry is absent', async () => {
    const result = await createCherryEmitCommand({}).execute(['ping'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no .*runtime/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webapp -- cherry-emit-command`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

`packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts`:

```ts
import { defineCommand } from 'just-bash';
import type { Command } from 'just-bash';

/**
 * Leader-side registry the `cherry-emit` command drives. Bound to the same
 * object that calls `emitCherrySliccEvent` from Task 6 (the leader's cherry
 * runtime registry). `listRuntimeIds()` returns canonical ids
 * (`follower-<bootstrapId>`, see Task 8).
 */
export interface CherryRuntimeRegistry {
  listRuntimeIds(): string[];
  emitSliccEvent(runtimeId: string, name: string, detail: unknown): void;
}

export interface CherryEmitCommandOptions {
  /** Leader-side registry; absent in non-leader contexts (command still discoverable, reports no runtime). */
  registry?: CherryRuntimeRegistry;
}

export function createCherryEmitCommand(options: CherryEmitCommandOptions = {}): Command {
  const { registry } = options;
  return defineCommand('cherry-emit', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `cherry-emit - push a slicc.event to a cherry host page through a follower runtime

Usage: cherry-emit <name> [--detail <json>] [--runtime <id>]

  --detail <json>   JSON payload delivered as the event detail
  --runtime <id>    Target a specific follower runtime (canonical id, e.g. follower-abc).
                    Defaults to the sole connected runtime; required when more than one.
`,
        stderr: '',
        exitCode: 0,
      };
    }

    const positionals: string[] = [];
    let detailJson: string | undefined;
    let runtime: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--detail') detailJson = args[++i];
      else if (args[i] === '--runtime') runtime = args[++i];
      else positionals.push(args[i]!);
    }

    const name = positionals[0];
    if (!name) {
      return { stdout: '', stderr: 'cherry-emit: event name is required\n', exitCode: 1 };
    }

    const ids = registry?.listRuntimeIds() ?? [];
    if (ids.length === 0) {
      return {
        stdout: '',
        stderr: 'cherry-emit: no cherry follower runtime is connected\n',
        exitCode: 1,
      };
    }
    if (!runtime) {
      if (ids.length > 1) {
        return {
          stdout: '',
          stderr: `cherry-emit: multiple runtimes connected, pass --runtime <id>. Available: ${ids.join(', ')}\n`,
          exitCode: 1,
        };
      }
      runtime = ids[0];
    } else if (!ids.includes(runtime)) {
      return {
        stdout: '',
        stderr: `cherry-emit: runtime '${runtime}' not connected. Available: ${ids.join(', ')}\n`,
        exitCode: 1,
      };
    }

    let detail: unknown;
    if (detailJson !== undefined) {
      try {
        detail = JSON.parse(detailJson);
      } catch {
        return { stdout: '', stderr: 'cherry-emit: --detail must be valid JSON\n', exitCode: 1 };
      }
    }

    registry!.emitSliccEvent(runtime!, name, detail);
    return { stdout: `cherry-emit: sent '${name}' to ${runtime}\n`, stderr: '', exitCode: 0 };
  });
}
```

Register it in `createSupplementalCommands` (`index.ts`). Add the import + a config field, then push the factory:

```ts
// at top of index.ts, with the other command imports:
import { createCherryEmitCommand } from './cherry-emit-command.js';
import type { CherryRuntimeRegistry } from './cherry-emit-command.js';

// add to the SupplementalCommandsConfig interface:
//   /** Leader-side cherry runtime registry (Task 6). Absent outside leader contexts. */
//   cherryRuntimeRegistry?: CherryRuntimeRegistry;

// inside the `commands` array in createSupplementalCommands:
createCherryEmitCommand({ registry: options.cherryRuntimeRegistry }),
```

The leader's tray boot (`page-leader-tray.ts` / `main.ts` leader wiring) passes the same registry object that Task 6's `emitCherrySliccEvent` lives on when constructing the shell's supplemental commands; non-leader floats leave `cherryRuntimeRegistry` undefined and the command reports "no cherry follower runtime is connected".

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/webapp -- cherry-emit-command`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts packages/webapp/src/shell/supplemental-commands/index.ts packages/webapp/tests/shell/supplemental-commands/cherry-emit-command.test.ts
git add packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts packages/webapp/src/shell/supplemental-commands/index.ts packages/webapp/tests/shell/supplemental-commands/cherry-emit-command.test.ts
git commit -m "feat(cherry): add cherry-emit shell command"
```

---

### Task 10: iOS follower mirror

**Files:**

- Modify: `packages/ios-app/SliccFollower/.../SyncProtocol.swift`
- Modify: `packages/ios-app/SliccFollower/.../AppState.swift`
- Test: `packages/ios-app/SliccFollower/Tests/.../SyncProtocolTests.swift`

The tray protocol changed (Task 5), so the 5-step iOS mirror invariant applies: extend the Swift model, handle the new message in `handleDataChannelMessage`, add the no-op case, and test it.

- [ ] **Step 1: Write the failing test**

Add to `SyncProtocolTests.swift`:

```swift
func testRemoteTargetInfoDecodesCherryKindAndCapabilities() throws {
    let json = """
    {"targetId":"c","type":"page","title":"Host","url":"https://host.example",
     "kind":"cherry","capabilities":{"navigate":true,"network":false,"screenshot":true}}
    """.data(using: .utf8)!
    let target = try JSONDecoder().decode(RemoteTargetInfo.self, from: json)
    XCTAssertEqual(target.kind, "cherry")
    XCTAssertEqual(target.capabilities?.network, false)
}

func testCherrySliccEventMessageDecodes() throws {
    let json = """
    {"type":"cherry.slicc_event","targetId":"c","name":"open-url","detail":{"url":"https://x"}}
    """.data(using: .utf8)!
    let msg = try JSONDecoder().decode(AgentEvent.self, from: json)
    if case .cherrySliccEvent(let targetId, let name, _) = msg {
        XCTAssertEqual(targetId, "c")
        XCTAssertEqual(name, "open-url")
    } else {
        XCTFail("expected cherrySliccEvent")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `swift test --package-path packages/ios-app/SliccFollower`
Expected: FAIL — `kind`/`capabilities` not decodable; `.cherrySliccEvent` case missing.

- [ ] **Step 3: Mirror the protocol**

In `SyncProtocol.swift`, add optional fields to `RemoteTargetInfo`:

```swift
struct RemoteTargetInfo: Codable {
    let targetId: String
    let type: String
    let title: String
    let url: String
    var kind: String?
    var capabilities: CherryCapabilities?
}

struct CherryCapabilities: Codable {
    let navigate: Bool
    let network: Bool
    let screenshot: Bool
}
```

Add a `.cherrySliccEvent(targetId: String, name: String, detail: AnyCodable?)` case to the `AgentEvent` enum with its `init(from:)` decoding branch keyed on `type == "cherry.slicc_event"`.

- [ ] **Step 4: Handle the message (no-op) in AppState**

In `AppState.handleDataChannelMessage`, add a `case .cherrySliccEvent:` branch. The iOS follower does not host cherry pages, so it is a documented no-op (log and ignore) — present so the switch stays exhaustive and future cherry-on-iOS support has a seam.

- [ ] **Step 5: Run test to verify it passes**

Run: `swift test --package-path packages/ios-app/SliccFollower`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/ios-app/SliccFollower
git commit -m "feat(cherry): mirror cherry target kind/capabilities and slicc event in iOS follower"
```

---

### Task 11: Worker framing/CSP for `?cherry=1`

**Files:**

- Modify: `packages/cloudflare-worker/src/index.ts` (`serveSPA`)
- Modify: `packages/cloudflare-worker/tests/index.test.ts`

No routes change (no entries added to the routes table), so the 3-file route mirror rule does NOT apply — only `serveSPA` header behavior and its unit test change.

**Verified context (read before editing — `packages/cloudflare-worker/src/index.ts`, `tests/index.test.ts`):**

- `serveSPA(request, env)` (`index.ts:52`) is currently a bare passthrough: `return env.ASSETS.fetch(request);` — it sets **no** CSP today. It is reached by the join/controller browser-nav path (`~343`) and the catch-all SPA fallback (`~364`). So `https://app.example/` (root, no `?json=true`) routes through `serveSPA`.
- The full `frame-ancestors 'none'` CSP at `~199-206` is the separate `/cloud` dashboard branch (it builds its own `Response` and does **not** call `serveSPA`), so cherry framing does not touch it.
- `WorkerEnv` is the interface at `index.ts:34-50` (not a `ctx`-style env). The test harness calls `worker.fetch(request, env)` with **two** args (no `ctx`); `env` is built by the module-level `createTestHarness()` helper (`tests/index.test.ts:146`). `worker` is the default export, already imported at the top of the test file.
- **Behavior note:** adding `frame-ancestors 'none'` to the non-cherry `serveSPA` path is a new default (the app SPA had no framing CSP before). This is a deliberate hardening that matches what `/cloud` already does — call it out in the commit body.

- [ ] **Step 1: Write the failing test**

Append to `packages/cloudflare-worker/tests/index.test.ts` (the `worker` default import and the `createTestHarness` helper are already in scope — do not re-import):

```ts
describe('cherry framing policy', () => {
  it('default SPA forbids framing and is not no-store', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://app.example/'), env);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control') ?? '').not.toContain('no-store');
  });

  it('cherry boot allows configured ancestors and is uncacheable', async () => {
    const env = {
      ...createTestHarness().env,
      ALLOWED_CHERRY_HOST_ORIGINS: 'https://host.example',
    };
    const res = await worker.fetch(new Request('https://app.example/?cherry=1'), env);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('frame-ancestors https://host.example');
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('vary') ?? '').toContain('Sec-Fetch-Dest');
  });

  it('cherry boot with no configured ancestors falls back to none', async () => {
    const { env } = createTestHarness();
    const res = await worker.fetch(new Request('https://app.example/?cherry=1'), env);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/cloudflare-worker -- index`
Expected: FAIL — `serveSPA` sets no CSP today, so the default-SPA assertion fails.

- [ ] **Step 3: Implement the branch**

First add the binding to `WorkerEnv` (`index.ts:34-50`):

```ts
  /** Space-separated origins permitted to frame the `?cherry=1` SPA. Empty = deny. */
  ALLOWED_CHERRY_HOST_ORIGINS?: string;
```

Then rewrite `serveSPA` (`index.ts:52`) — it currently is a one-line passthrough, so the executor must convert it to `async`, await the asset into a variable, clone for mutable headers, and branch on the query param:

```ts
async function serveSPA(request: Request, env: WorkerEnv): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  const url = new URL(request.url);
  const out = new Response(res.body, res); // clone for mutable headers

  if (url.searchParams.get('cherry') === '1') {
    const allowed = (env.ALLOWED_CHERRY_HOST_ORIGINS ?? '').trim();
    const ancestors = allowed.length > 0 ? allowed : "'none'";
    out.headers.set('Content-Security-Policy', `frame-ancestors ${ancestors}`);
    // Cherry and non-cherry responses must never share a cache entry.
    out.headers.set('Cache-Control', 'no-store');
    out.headers.set('Vary', 'Sec-Fetch-Dest');
  } else {
    out.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  }
  return out;
}
```

Add `"ALLOWED_CHERRY_HOST_ORIGINS": ""` to the `vars` block in `wrangler.jsonc` (and the staging env's `vars` if it has its own) so the binding is declared for deploy.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/cloudflare-worker -- index`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/tests/index.test.ts packages/cloudflare-worker/wrangler.jsonc
git add packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/tests/index.test.ts packages/cloudflare-worker/wrangler.jsonc
git commit -m "feat(cherry): serve ?cherry=1 with frame-ancestors CSP and cache isolation"
```

---

### Task 12: `@slicc/cherry` SDK — protocol mirror, mount, auth forwarding

> **Provisioning is NOT in this SDK.** The spec (§"Provisioning happens iframe-side (kills CORS)") requires the `/api/cloud/*` orchestration to run in the webapp iframe (same-origin with the worker), not in the host SDK (which sits on the third-party origin and would incur CORS + leak a third-party `Authorization` header). The SDK's only role here is to **forward** the host's auth (`{ token, coneName, createIfMissing }`) — or a ready `joinToken` — into the iframe over the `handshake.welcome` envelope. Task 13's `resolveCherryJoinUrl` (webapp-side) does the actual `/api/cloud/*` calls. There is **no** `packages/cherry/src/provisioning.ts`.

**Files:**

- Create: `packages/cherry/src/protocol.ts`
- Create: `packages/cherry/src/mount.ts`
- Modify: `packages/cherry/src/index.ts` (delegate `mountSlicc` to `mountSliccImpl`)
- Test: `packages/cherry/tests/mount.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/cherry/tests/mount.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { mountSliccImpl } from '../src/mount.js';

describe('mountSliccImpl', () => {
  it('creates an iframe in the container pointed at ?cherry=1', () => {
    const container = document.createElement('div');
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
    });
    const iframe = container.querySelector('iframe')!;
    expect(iframe).toBeTruthy();
    expect(iframe.src).toContain('cherry=1');
    handle.destroy();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('honors onPermissionRequest denials before dispatching CDP', async () => {
    const container = document.createElement('div');
    const onPermissionRequest = vi.fn(() => false);
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: false },
      hooks: { onPermissionRequest },
      joinToken: 'https://app.example/join?t=X',
    });
    // Drive a cdp.request for a denied domain through the test seam.
    const res = await handle.__test_receive({
      kind: 'cdp.request',
      id: 7,
      method: 'Page.navigate',
      params: { url: 'https://evil' },
    } as never);
    expect(onPermissionRequest).toHaveBeenCalledWith('Page');
    expect(res?.error?.code).toBe(-32601);
    handle.destroy();
  });

  it('forwards a ready joinToken in the welcome envelope (no auth)', async () => {
    const container = document.createElement('div');
    const posted: unknown[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=PRE',
      __test_post: (env) => posted.push(env),
    });
    await handle.__test_receive({
      cherry: 1,
      channelId: 'ch-1',
      kind: 'handshake.hello',
    } as never);
    const welcome = posted.find(
      (e): e is { kind: string; joinUrl?: string; auth?: unknown } =>
        (e as { kind?: string }).kind === 'handshake.welcome'
    );
    expect(welcome?.joinUrl).toBe('https://app.example/join?t=PRE');
    expect(welcome?.auth).toBeUndefined();
    handle.destroy();
  });

  it('forwards IMS auth in the welcome envelope when no joinToken is given', async () => {
    const container = document.createElement('div');
    const posted: unknown[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      imsToken: 'tok',
      coneName: 'demo',
      createIfMissing: true,
      __test_post: (env) => posted.push(env),
    });
    await handle.__test_receive({
      cherry: 1,
      channelId: 'ch-1',
      kind: 'handshake.hello',
    } as never);
    const welcome = posted.find(
      (
        e
      ): e is {
        kind: string;
        joinUrl?: string;
        auth?: { token: string; coneName?: string; createIfMissing?: boolean };
      } => (e as { kind?: string }).kind === 'handshake.welcome'
    );
    expect(welcome?.joinUrl).toBeUndefined();
    expect(welcome?.auth).toEqual({ token: 'tok', coneName: 'demo', createIfMissing: true });
    handle.destroy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @slicc/cherry -- mount`
Expected: FAIL — `mount.js` not found.

- [ ] **Step 3: Implement protocol mirror**

`packages/cherry/src/protocol.ts` — a structural copy of the envelope shapes and `CHERRY_PROTOCOL_VERSION = 1` (the SDK must not import from `@slicc/webapp`). Mirror `isCherryEnvelope` and an `acceptEnvelope(event, ctx)` identical in semantics to Task 2 (origin allowlist + source identity + channelId). The `handshake.welcome` member must carry both optional provisioning fields so the SDK can forward either:

```ts
| {
    cherry: typeof CHERRY_PROTOCOL_VERSION;
    channelId: string;
    kind: 'handshake.welcome';
    joinUrl?: string;
    auth?: { token: string; coneName?: string; createIfMissing?: boolean };
  }
```

This matches `CherryHandshakeWelcome` in Task 3's `cherry-host-protocol.ts` (webapp side). Keep the two files structurally identical; a comment in each points at the other as the cross-check.

- [ ] **Step 4: Implement mount (with auth forwarding)**

`MountSliccOptions` (in `index.ts`) carries the provisioning inputs the SDK forwards but never acts on: `imsToken?: string`, `coneName?: string`, `createIfMissing?: boolean`, `joinToken?: string`. (Add these to the existing `MountSliccOptions` interface if not already present.) The SDK does NOT call `/api/cloud/*`.

`packages/cherry/src/mount.ts`:

```ts
import type { MountSliccOptions, SliccHandle } from './index.js';
import { createCdpHostHandler, CherryUnsupportedError } from './cdp-host-handlers.js';
import { CHERRY_PROTOCOL_VERSION, acceptEnvelope, type CherryEnvelope } from './protocol.js';

interface CdpResponseShape {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface CherrySliccHandle extends SliccHandle {
  /** Test seam: feed a parsed envelope as if it arrived via postMessage. */
  __test_receive(env: CherryEnvelope): Promise<CdpResponseShape | undefined>;
}

/** `mountSliccImpl` accepts an optional `__test_post` seam to capture outbound envelopes in tests. */
type MountSliccImplOptions = MountSliccOptions & {
  __test_post?: (env: CherryEnvelope) => void;
};

export function mountSliccImpl(options: MountSliccImplOptions): CherrySliccHandle {
  const iframe = document.createElement('iframe');
  const src = new URL(options.sliccOrigin);
  src.searchParams.set('cherry', '1');
  iframe.src = src.toString();
  iframe.style.border = '0';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  options.container.appendChild(iframe);

  let channelId: string | null = null;
  const hostHandler = createCdpHostHandler({
    capabilities: options.capabilities,
    onOpenUrl: options.hooks?.onOpenUrl,
  });

  const post = (env: CherryEnvelope) => {
    if (options.__test_post) {
      options.__test_post(env);
      return;
    }
    iframe.contentWindow?.postMessage(env, options.sliccOrigin);
  };

  const dispatchCdp = async (
    env: Extract<CherryEnvelope, { kind: 'cdp.request' }>
  ): Promise<CdpResponseShape> => {
    const domain = env.method.split('.')[0] ?? env.method;
    const granted = options.hooks?.onPermissionRequest
      ? await options.hooks.onPermissionRequest(domain)
      : true;
    if (!granted) {
      return { error: { code: -32601, message: `Cherry: permission denied for ${domain}` } };
    }
    try {
      const result = await hostHandler(env.method, env.params ?? {});
      return { result };
    } catch (err) {
      if (err instanceof CherryUnsupportedError) {
        return { error: { code: err.code, message: err.message } };
      }
      return {
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  };

  const handleEnvelope = async (env: CherryEnvelope): Promise<CdpResponseShape | undefined> => {
    switch (env.kind) {
      case 'handshake.hello': {
        channelId = env.channelId;
        // The SDK forwards either a ready joinToken OR the IMS auth for the
        // iframe to provision with (same-origin /api/cloud/*). It never calls
        // the cloud API itself — that would be a cross-origin request from the
        // third-party host with a third-party Authorization header.
        const welcome: Extract<CherryEnvelope, { kind: 'handshake.welcome' }> = {
          cherry: CHERRY_PROTOCOL_VERSION,
          channelId,
          kind: 'handshake.welcome',
        };
        if (options.joinToken) {
          welcome.joinUrl = options.joinToken;
        } else if (options.imsToken) {
          welcome.auth = {
            token: options.imsToken,
            coneName: options.coneName,
            createIfMissing: options.createIfMissing,
          };
        }
        post(welcome);
        return undefined;
      }
      case 'cdp.request': {
        const resp = await dispatchCdp(env);
        post({
          cherry: CHERRY_PROTOCOL_VERSION,
          channelId: channelId!,
          kind: 'cdp.response',
          id: env.id,
          ...resp,
        });
        return resp;
      }
      case 'slicc.event': {
        options.hooks?.onSliccEvent?.(env.name, env.detail);
        if (env.name === 'open-url' && options.capabilities.openUrl) {
          const url = (env.detail as { url?: string } | undefined)?.url;
          if (url) options.hooks?.onOpenUrl?.(url);
        }
        return undefined;
      }
      default:
        return undefined;
    }
  };

  const onMessage = (event: MessageEvent) => {
    if (
      !acceptEnvelope(event, {
        allowOrigins: [options.sliccOrigin],
        expectedSource: iframe.contentWindow,
        channelId,
      })
    ) {
      return;
    }
    void handleEnvelope(event.data as CherryEnvelope);
  };
  window.addEventListener('message', onMessage);

  return {
    iframe,
    destroy() {
      window.removeEventListener('message', onMessage);
      iframe.remove();
    },
    __test_receive: (env) => handleEnvelope(env),
  };
}
```

- [ ] **Step 5: Wire `mountSlicc` to the impl**

In `index.ts`, replace the `mountSlicc` stub body with `return mountSliccImpl(options);` (keep the `container` guard). Ensure `MountSliccOptions` declares the forwarded provisioning fields (`imsToken?`, `coneName?`, `createIfMissing?`, `joinToken?`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test -w @slicc/cherry`
Expected: PASS (index, mount, cdp-host-handlers).

- [ ] **Step 7: Commit**

```bash
npx prettier --write packages/cherry/src packages/cherry/tests
git add packages/cherry/src packages/cherry/tests
git commit -m "feat(cherry): implement SDK mount, auth forwarding, and protocol mirror"
```

---

### Task 13: Cherry boot mode in the webapp

**Files:**

- Modify: `packages/webapp/src/ui/runtime-mode.ts` (add `'cherry'` to `UiRuntimeMode`, detect in `resolveUiRuntimeMode`)
- Modify: `packages/webapp/src/ui/main.ts` (boot routing ~3357-3376 + the standalone-worker transport/follower branches)
- Modify: `packages/webapp/src/ui/page-follower-tray.ts` (thread a `runtime` tag through `StartPageFollowerTrayOptions`)
- Create: `packages/webapp/src/ui/main-cherry.ts` (cherry-specific transport + joinUrl resolution helper, called from `mainStandaloneWorker`)
- Test: `packages/webapp/tests/ui/runtime-mode.test.ts`

**Verified context (read before editing — `ui/runtime-mode.ts`, `ui/main.ts`, `ui/page-follower-tray.ts`, `cdp/browser-api.ts`, `scoops/tray-webrtc.ts`):**

- The real detector is `resolveUiRuntimeMode(locationHref: string, isExtension: boolean): UiRuntimeMode` — **not** `detectRuntimeMode(url)`. It takes the href string + the extension flag, parses internally, and returns the union (`'standalone' | 'extension' | 'electron-overlay' | 'extension-detached' | 'hosted-leader'`).
- `main()` (`ui/main.ts:~3263`) calls `resolveUiRuntimeMode(window.location.href, isExtension)` (~3357) and dispatches: `extension-detached`/`extension` → `mainExtension`; everything else → `mainStandaloneWorker(app, runtimeMode)` (~3376). `hosted-leader`, `electron-overlay`, and `standalone` are all handled **inside** `mainStandaloneWorker` by branching on `runtimeMode`. Cherry follows the same pattern — it is a standalone-worker variant, **not** a separate top-level boot.
- There is **no** `startFollowerWithAutoReconnect({ transport, runtime })` entry point. The real follower boot is `startPageFollowerTray({ joinUrl, browserAPI, onSnapshot, onUserMessage, onStatus, setChatAgent, addSprinkle, removeSprinkle })` (`ui/main.ts:~2843` and `~2961`). `startFollowerWithAutoReconnect` (in `scoops/tray-webrtc.ts`) requires `{ joinUrl: string; runtime: string; ... }` — a WebRTC tray join, called **internally** by `startPageFollowerTray`. Cherry reuses `startPageFollowerTray` so it inherits the full chat/sprinkle UI wiring that `mainStandaloneWorker` already builds.
- Transport injection point: `mainStandaloneWorker` does `const browser = new BrowserAPI();` (~1861) then `const realCdpTransport = browser.getTransport();` and `spawnKernelWorker({ realCdpTransport, ... })`. `BrowserAPI`'s constructor is `constructor(client?: CDPTransport)` (`browser-api.ts:83`) — so cherry passes the `CherryHostTransport`: `new BrowserAPI(cherryTransport)`.
- `joinUrl` source: standalone reads `localStorage[TRAY_JOIN_STORAGE_KEY]` (~2734). Cherry has no stored join URL — it comes from the host handshake captured on the transport (`transport.joinUrl`, added in Task 3), optionally after iframe-side provisioning (`resolveCherryJoinUrl` in `main-cherry.ts`, Step 3c of this task) when the host forwarded an IMS token (`transport.provisioningAuth`) instead of a ready join URL. The host SDK never calls `/api/cloud/*` (see Task 12 correction).
- Runtime tag: `startPageFollowerTray` → `startFollowerWithAutoReconnect` hardcodes `runtime: 'slicc-standalone'` (`page-follower-tray.ts:~242`). The spec mandates Cherry join as `runtime: 'slicc-cherry'` so leader selection can distinguish it — so `StartPageFollowerTrayOptions` must gain an optional `runtime` tag (default `'slicc-standalone'`) that is forwarded to `startFollowerWithAutoReconnect`.

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/ui/runtime-mode.test.ts`:

```ts
describe('cherry runtime mode', () => {
  it('detects cherry from ?cherry=1 in standalone (non-extension)', () => {
    expect(resolveUiRuntimeMode('https://app.example/?cherry=1', false)).toBe('cherry');
  });
  it('does not treat a bare URL as cherry', () => {
    expect(resolveUiRuntimeMode('https://app.example/', false)).not.toBe('cherry');
  });
  it('extension flag wins over ?cherry=1', () => {
    expect(resolveUiRuntimeMode('chrome-extension://abc/index.html?cherry=1', true)).toBe(
      'extension'
    );
  });
});
```

(`resolveUiRuntimeMode` and `UiRuntimeMode` are already imported at the top of this test file — reuse the existing import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @slicc/webapp -- runtime-mode`
Expected: FAIL — `resolveUiRuntimeMode('https://app.example/?cherry=1', false)` returns `'standalone'`, not `'cherry'`.

- [ ] **Step 3a: Detect `'cherry'` in `resolveUiRuntimeMode`**

In `ui/runtime-mode.ts`:

- Add `'cherry'` to the `UiRuntimeMode` union (between `'hosted-leader'` and the end is fine).
- In the **non-extension** branch of `resolveUiRuntimeMode` (after the `hosted-leader` check, before the electron/standalone return), add:

```ts
if (url.searchParams.get('cherry') === '1') {
  return 'cherry';
}
```

The extension branch returns early, so `?cherry=1` under the extension flag still resolves to `'extension'` (asserted by the test). This makes the test pass.

- [ ] **Step 3b: Thread a `runtime` tag through `startPageFollowerTray`**

In `ui/page-follower-tray.ts`:

- Add to `StartPageFollowerTrayOptions`: `/** Tray runtime tag (default 'slicc-standalone'). Cherry passes 'slicc-cherry' so leader selection can distinguish it. */ runtime?: string;`
- In the `startFollowerWithAutoReconnect({ ... })` call (~line 242), replace the hardcoded `runtime: 'slicc-standalone',` with `runtime: options.runtime ?? 'slicc-standalone',`.

(Existing standalone callers in `ui/main.ts` omit `runtime`, so they keep `'slicc-standalone'` — no behavior change.)

- [ ] **Step 3c: Cherry transport + joinUrl helper**

**Provisioning runs iframe-side (spec §"Provisioning happens iframe-side (kills CORS)").** The webapp iframe is same-origin with the worker, so it — not the host SDK — runs the `/api/cloud/*` orchestration. The host SDK (`packages/cherry/`, third-party origin) only forwards `{ token, coneName, createIfMissing }` into the iframe over the handshake; it must **not** call `/api/cloud/*` (that would be a cross-origin fetch with a third-party `Authorization` header — the exact CORS surface the spec avoids). So `resolveCherryJoinUrl` lives **here, webapp-side**, not in `@slicc/cherry`. The IMS token flows transiently through the handshake into memory only — never persisted, never re-emitted.

`packages/webapp/src/ui/main-cherry.ts`:

```ts
import { CherryHostTransport } from '../cdp/cherry-host-transport.js';
import { BrowserAPI } from '../cdp/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('cherry-boot');

/** Provisioning payload the host SDK forwards over the handshake (Task 3 captures it). */
export interface CherryProvisioningAuth {
  token: string;
  coneName?: string;
  createIfMissing?: boolean;
}

export interface CherryBootResult {
  /** Cherry transport, already connected (handshake complete). */
  transport: CherryHostTransport;
  /** Follower's local BrowserAPI wrapping the cherry transport. */
  browser: BrowserAPI;
  /** Tray join URL resolved from the handshake (or provisioned from an IMS token). */
  joinUrl: string;
}

/**
 * Iframe-side cloud provisioning (same-origin /api/cloud/*). Mirrors the spec's
 * 5-step flow: list → resume/use-running → start-if-missing. Returns a join URL.
 * The Bearer token never leaves this same-origin call and is not persisted.
 */
async function resolveCherryJoinUrl(auth: CherryProvisioningAuth): Promise<string> {
  const authHeader = { Authorization: `Bearer ${auth.token}` };
  const listRes = await fetch('/api/cloud/list?json=true', { headers: authHeader });
  if (!listRes.ok)
    throw new Error(`cherry provisioning: /api/cloud/list failed (${listRes.status})`);
  const cones = (await listRes.json()) as Array<{
    name: string;
    status: string;
    sandboxId?: string;
    joinUrl?: string;
  }>;
  const match = auth.coneName ? cones.find((c) => c.name === auth.coneName) : undefined;
  if (match) {
    if (match.status === 'running' && match.joinUrl) return match.joinUrl;
    if (match.status === 'paused' && match.sandboxId) {
      const resumed = await fetch('/api/cloud/resume?json=true', {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId: match.sandboxId }),
      });
      if (!resumed.ok) throw new Error(`cherry provisioning: resume failed (${resumed.status})`);
      const { joinUrl } = (await resumed.json()) as { joinUrl: string };
      return joinUrl;
    }
  }
  if (auth.createIfMissing) {
    const started = await fetch('/api/cloud/start?json=true', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: auth.coneName }),
    });
    if (!started.ok) throw new Error(`cherry provisioning: start failed (${started.status})`);
    const { joinUrl } = (await started.json()) as { joinUrl: string };
    return joinUrl;
  }
  throw new Error('cherry provisioning: no matching cone and createIfMissing is false');
}

/**
 * Build the cherry transport, complete the host handshake, resolve a join URL,
 * and wrap a BrowserAPI around the transport. Called from `mainStandaloneWorker`
 * when `runtimeMode === 'cherry'`, replacing the default
 * `new BrowserAPI()` / stored-join-URL path.
 */
export async function setupCherryFollower(): Promise<CherryBootResult> {
  const allowOrigins = [document.referrer ? new URL(document.referrer).origin : location.origin];
  const targetOrigin = allowOrigins[0]!;

  const transport = new CherryHostTransport({
    counterpart: window.parent,
    allowOrigins,
    targetOrigin,
  });
  await transport.connect(); // handshake: receives channelId + provisioning payload (joinUrl or auth)
  log.info('Cherry transport connected');

  // joinUrl arrives directly in the handshake, OR is provisioned iframe-side
  // from an IMS token. Both `transport.joinUrl` and `transport.provisioningAuth`
  // are captured in Task 3's handshake.welcome handler.
  let joinUrl = transport.joinUrl;
  if (!joinUrl && transport.provisioningAuth) {
    joinUrl = await resolveCherryJoinUrl(transport.provisioningAuth);
  }
  if (!joinUrl) {
    throw new Error('cherry boot: no joinUrl from handshake and no provisioning auth');
  }

  const browser = new BrowserAPI(transport);
  try {
    await browser.connect();
  } catch (err) {
    log.warn('Cherry CDP connect failed; will retry on demand', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { transport, browser, joinUrl };
}
```

> **Why provisioning lives here (iframe-side), not in the SDK:** The host SDK runs on the third-party origin and cannot make same-origin `/api/cloud/*` calls without CORS + leaking a third-party `Authorization` header — exactly what the spec avoids. So the orchestration belongs iframe-side, in this `main-cherry.ts`. Task 12 reflects this: the SDK forwards `{ token, coneName, createIfMissing }` over the `handshake.welcome` envelope (or hands a ready `joinUrl` when the host supplied a `joinToken`); it does **not** import or call a `/api/cloud/*` provisioner, and there is no `packages/cherry/src/provisioning.ts`.

- [ ] **Step 3d: Wire cherry into `mainStandaloneWorker`**

In `ui/main.ts`:

- In `main()` boot routing (~3357-3376), no new top-level branch is needed — `'cherry'` already falls through to `return mainStandaloneWorker(app, runtimeMode);`. (Verify the existing routing only special-cases `extension`/`extension-detached`; `'cherry'` must reach `mainStandaloneWorker`.)
- In `mainStandaloneWorker`, at the transport-construction site (~1861), branch:

```ts
let browser: BrowserAPI;
let cherryJoinUrl: string | undefined;
if (runtimeMode === 'cherry') {
  const { setupCherryFollower } = await import('./main-cherry.js');
  const cherry = await setupCherryFollower();
  browser = cherry.browser;
  cherryJoinUrl = cherry.joinUrl;
} else {
  browser = new BrowserAPI();
  try {
    await browser.connect();
  } catch (err) {
    log.warn(
      'Initial CDP connect failed; worker-forwarded commands will retry on demand',
      err instanceof Error ? err.message : String(err)
    );
  }
}
const realCdpTransport = browser.getTransport();
```

(The non-cherry branch preserves the existing `new BrowserAPI()` + `browser.connect()` logic verbatim — just moved inside the `else`.)

- In the follower/leader dispatch block (~2734-2842), make cherry use the resolved join URL and the `slicc-cherry` runtime tag. The cherry branch takes precedence over the stored-join-URL branch:

```ts
const storedJoinUrl = window.localStorage.getItem(TRAY_JOIN_STORAGE_KEY);
const storedWorkerBaseUrl = window.localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
if (runtimeMode === 'hosted-leader') {
  // ... unchanged ...
} else if (runtimeMode === 'cherry' && cherryJoinUrl) {
  pageFollowerTray = startPageFollowerTray({
    joinUrl: cherryJoinUrl,
    runtime: 'slicc-cherry',
    onSnapshot: (messages) => layout.panels.chat.loadMessages(messages),
    onUserMessage: (text, _messageId, _scoopJid, attachments) =>
      layout.panels.chat.addUserMessage(text, attachments),
    onStatus: (status) => layout.panels.chat.setProcessing(status === 'processing'),
    setChatAgent: (agent) => layout.panels.chat.setAgent(agent),
    browserAPI: browser,
    addSprinkle: (name, title, element, zone, options) =>
      layout.addSprinkle(name, title, element, zone as 'primary' | 'drawer' | undefined, options),
    removeSprinkle: (name) => layout.removeSprinkle(name),
  });
} else if (storedJoinUrl) {
  // ... unchanged standalone follower branch ...
} else if (storedWorkerBaseUrl) {
  // ... unchanged leader branch ...
}
```

This reuses the exact follower wiring the standalone path already uses (same `onSnapshot`/`onUserMessage`/`onStatus`/`setChatAgent`/sprinkle callbacks) — only `joinUrl` (from the handshake) and `runtime: 'slicc-cherry'` differ. The cherry target the follower advertises is the host page driven through `CherryHostTransport`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @slicc/webapp -- runtime-mode`
Expected: PASS. (Boot wiring is exercised end-to-end by Task 15's build + the cherry-host-transport suites from Task 3; `mainStandaloneWorker` is not unit-tested directly.)

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/ui/runtime-mode.ts packages/webapp/src/ui/main.ts packages/webapp/src/ui/main-cherry.ts packages/webapp/src/ui/page-follower-tray.ts packages/webapp/tests/ui/runtime-mode.test.ts
git add packages/webapp/src/ui/runtime-mode.ts packages/webapp/src/ui/main.ts packages/webapp/src/ui/main-cherry.ts packages/webapp/src/ui/page-follower-tray.ts packages/webapp/tests/ui/runtime-mode.test.ts
git commit -m "feat(cherry): add cherry boot mode and follower bootstrap"
```

---

### Task 14: Skill + documentation

**Files:**

- Create: `packages/vfs-root/workspace/skills/cherry/SKILL.md`
- Create: `packages/cherry/CLAUDE.md`
- Modify: root `CLAUDE.md`, `packages/webapp/CLAUDE.md`, `packages/cloudflare-worker/CLAUDE.md`, `packages/ios-app/CLAUDE.md`
- Modify: `docs/architecture.md`, `README.md`

Docs are part of the change, not a follow-up.

- [ ] **Step 1: Write the cherry skill**

`packages/vfs-root/workspace/skills/cherry/SKILL.md` — teach the cone what a cherry target is: a cooperative host page, capability-limited (navigate/screenshot/openUrl, never network), driven via the same `BrowserAPI`/teleport surface. Document `cherry-emit <name> [--detail <json>] [--runtime <id>]` for pushing host-page events, and that host page events arrive as `[cherry]` licks. Note that screenshots may be `html2canvas`-approximate or unavailable, and that `Network.*` is never available on a cherry target.

- [ ] **Step 2: Write `packages/cherry/CLAUDE.md`**

Package navigation: `mountSlicc` surface, the host-SDK ↔ iframe synthetic-CDP boundary, three-factor postMessage pinning, where provisioning runs (iframe-side, same-origin) and the IMS-token-never-leaves-browser invariant, and that `protocol.ts` mirrors `webapp/src/cdp/cherry-host-protocol.ts` (keep in sync).

- [ ] **Step 3: Update root + package + architecture docs**

- Root `CLAUDE.md`: add `packages/cherry/` to the Module Map; add Cherry to the Floats list (embedded follower garnish); link `packages/cherry/CLAUDE.md`.
- `packages/webapp/CLAUDE.md`: document `CherryHostTransport` as the third `CDPTransport`, the `?cherry=1` boot mode, and the `'cherry'` lick type.
- `packages/cloudflare-worker/CLAUDE.md`: document the `?cherry=1` `frame-ancestors` policy, `ALLOWED_CHERRY_HOST_ORIGINS`, and the cache-isolation discipline.
- `packages/ios-app/CLAUDE.md`: note the cherry target kind/capabilities mirror and the documented no-op slicc-event case.
- `docs/architecture.md`: add Cherry to the float topology and the synthetic-CDP session model; add the CDP translation matrix (which methods are synthesized in-transport, executed host-realm, or rejected `-32601`).
- `README.md`: a short Cherry section (what it is, how a host embeds it via `@slicc/cherry`).

- [ ] **Step 4: Verify docs render / links resolve**

Run: `npx prettier --check 'packages/**/CLAUDE.md' 'docs/**/*.md' README.md packages/vfs-root/workspace/skills/cherry/SKILL.md` (then `--write` any flagged).
Expected: clean after write.

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/vfs-root/workspace/skills/cherry/SKILL.md packages/cherry/CLAUDE.md CLAUDE.md packages/webapp/CLAUDE.md packages/cloudflare-worker/CLAUDE.md packages/ios-app/CLAUDE.md docs/architecture.md README.md
git add packages/vfs-root/workspace/skills/cherry/SKILL.md packages/cherry/CLAUDE.md CLAUDE.md packages/webapp/CLAUDE.md packages/cloudflare-worker/CLAUDE.md packages/ios-app/CLAUDE.md docs/architecture.md README.md
git commit -m "docs(cherry): add cherry skill and document the embedded follower across docs"
```

---

### Task 15: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Format check**

Run: `npx prettier --check .`
Expected: PASS (no unformatted files). If it fails, `npx prettier --write` the listed files and re-run.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (browser + node + worker + cherry tsconfigs).

- [ ] **Step 3: Tests**

Run: `npm run test`
Expected: PASS (all packages, including new cherry suites).

- [ ] **Step 4: Coverage gates**

Run: `npm run test:coverage`
Expected: PASS — every package at or above its floor, including `test:coverage:cherry` (50% lines/statements/functions, 40% branches).

- [ ] **Step 5: Builds**

Run: `npm run build` then `npm run build -w @slicc/chrome-extension`
Expected: both PASS.

- [ ] **Step 6: Swift tests (if toolchain present)**

Run: `swift test --package-path packages/ios-app/SliccFollower`
Expected: PASS. If the Swift toolchain is unavailable in this environment, note it explicitly rather than claiming success.

- [ ] **Step 7: Final commit (only if verification produced formatting/lockfile changes)**

```bash
git add -A
git commit -m "chore(cherry): verification pass — formatting and lockfile"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section                                                                           | Task(s)                                                                                                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Cherry boot mode + `?cherry=1`                                                         | Task 13                                                                                                                                       |
| Worker framing policy + cache discipline                                               | Task 11                                                                                                                                       |
| `CherryHostTransport` (third transport)                                                | Task 3                                                                                                                                        |
| Synthetic CDP session model (getTargets→attach→enable→getFrameTree→navigate lifecycle) | Task 3                                                                                                                                        |
| CDP translation matrix (synthesized / host-realm / rejected)                           | Task 3 (synth) + Task 4 (host-realm + `-32601`)                                                                                               |
| `@slicc/cherry` SDK (mount, auth forwarding, protocol)                                 | Tasks 1, 4, 12                                                                                                                                |
| Three-factor postMessage pinning                                                       | Tasks 2 (webapp) + 12 (SDK mirror)                                                                                                            |
| Capability-tagged federated targets                                                    | Tasks 5, 6                                                                                                                                    |
| Host→cone `'cherry'` lick                                                              | Task 7                                                                                                                                        |
| `cherry-emit` shell command                                                            | Task 9                                                                                                                                        |
| Canonical runtime identity                                                             | Task 8                                                                                                                                        |
| iOS mirror (tray protocol changed)                                                     | Task 10                                                                                                                                       |
| Skill compatibility + docs                                                             | Task 14                                                                                                                                       |
| Cloud provisioning iframe-side, IMS never leaves browser                               | Task 13 (`resolveCherryJoinUrl`, same-origin `/api/cloud/*`) + Task 3 (transient `provisioningAuth` capture) + Task 14 (documented invariant) |
| Security model (origin/source/channel, host CSP governs eval)                          | Tasks 2, 4, 12                                                                                                                                |
| Testing strategy                                                                       | every task is TDD; Task 15 gate                                                                                                               |

No spec section is left without a task.

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling" left as work-to-discover. Every code step shows complete code. Task 13's boot wiring is now concrete — it shows the exact `mainStandaloneWorker` injection points (transport branch at ~1861, follower-dispatch branch at ~2734-2842 with full callback wiring), `resolveCherryJoinUrl` in full, and the `runtime` threading through `startPageFollowerTray`. The only remaining "read the surrounding code" notes are line-anchored integration points (replace the hardcoded `runtime: 'slicc-standalone'` at ~line 242; thread `cherryRuntimeRegistry` into `createSupplementalCommands` in Task 9) where the contract is fully specified and the executor must locate the exact insertion line — not undesigned logic.

**3. Type consistency:** Two distinct capability shapes exist by design and must not be conflated:

- `RemoteTargetInfo.capabilities` = `{ navigate: boolean; network: boolean; screenshot: boolean }` (tray/federation view — booleans, includes `network` so the leader can exclude cherry from network-requiring teleports).
- `HostCapabilities` (SDK `mountSlicc`) = `{ navigate: boolean; screenshot: 'html2canvas' | 'none'; openUrl: boolean }` (host-author view — `screenshot` is a strategy enum, includes `openUrl`, no `network`).
  The mapping (Task 12/13): SDK `screenshot !== 'none'` → tray `screenshot: true`; tray `network` is always `false` for cherry. `CHERRY_PROTOCOL_VERSION` is `1` in both `cherry-host-protocol.ts` and the SDK `protocol.ts`. The unsupported-method code is `-32601` everywhere (transport synth gap, host handler, permission denial). Synthetic ids are stable strings: `cherry-target` / `cherry-session` / `cherry-frame` / `cherry-loader`.

Provisioning/handshake types are consistent across Tasks 3 and 13:

- `CherryHandshakeWelcome` (Task 3) carries `{ joinUrl?: string; auth?: { token: string; coneName?: string; createIfMissing?: boolean } }`. `CherryHostTransport` exposes `get joinUrl()` and `get provisioningAuth()`; the welcome handler stores both (`provisioningAuth` memory-only, never persisted/re-emitted).
- `CherryProvisioningAuth` (Task 13 `main-cherry.ts`) = `{ token: string; coneName?: string; createIfMissing?: boolean }` — structurally identical to the welcome `auth` shape; `resolveCherryJoinUrl` consumes `transport.provisioningAuth` directly.
- Boot precedence (Task 13): `transport.joinUrl` wins; else provision from `transport.provisioningAuth`; else throw. `setupCherryFollower()` returns `{ transport, browser, joinUrl }`, consumed by `mainStandaloneWorker` to feed `startPageFollowerTray({ joinUrl: cherryJoinUrl, runtime: 'slicc-cherry', ... })`.
- The `'cherry'` member is added to the `UiRuntimeMode` union (Task 13) and the `runtime: 'slicc-cherry'` tag flows through `StartPageFollowerTrayOptions.runtime` (default `'slicc-standalone'`) into `startFollowerWithAutoReconnect`.

**4. Test/build/CI infrastructure (corrected against actual repo conventions):** The first draft of Task 1 assumed a per-package vitest-config + build-matrix CI model that this repo does NOT use. Verified and fixed:

- **One root `vitest.config.ts` with a `projects[]` array; packages carry no own vitest config.** Cherry is registered as a `cherry` project (`environment: 'jsdom'`, `include: ['packages/cherry/tests/**/*.test.ts']`, `extends: true`) — not a standalone `packages/cherry/vitest.config.ts`. Verified against `packages/webapp/package.json` whose `test` is `vitest run --root ../.. --config vitest.config.ts --project webapp`; cherry mirrors it with `--project cherry`.
- **Coverage script fixed.** Was `vitest run --coverage -w @slicc/cherry` (the `-w` is npm's workspace flag, not a vitest flag — under `vitest run` it is parsed as watch and the command is wrong). Corrected to the root-script form `vitest run --project cherry --coverage`, mirroring `test:coverage:webapp`; the global 50/50/50/40 floor applies (no explicit threshold flags needed).
- **devDeps trimmed to repo reality.** `vitest` and `@vitest/coverage-v8` are hoisted root devDeps (webapp re-lists neither); cherry declares only `jsdom`/`@types/jsdom` (^29 / ^28, matching webapp) and `typescript` pinned at `6.0.3`.
- **CI is per-package jobs gated by a `changes` paths-filter, not a matrix.** Task 1 now specifies the three concrete `ci.yml` edits — a `cherry` output, a `cherry: - 'packages/cherry/**'` filter, and a discrete `cherry:` job (typecheck + `test:coverage:cherry` + build) gated on `needs.changes.outputs.cherry == 'true' || ...root-config == 'true'` — plus the optional `node-matrix-tests` `if:` widening. `node-matrix-tests` already runs the `cherry` project automatically (it calls root `npm run test`).
- **Step ordering fixed for the unified model.** Workspace + vitest-project registration are pre-test infrastructure (Step 1); the red test (Step 3) fails only because `src/index.ts` is absent, not because the project is unregistered.
- **Test-path drift corrected.** Task 5 Step 1 said `tests/core/tray-sync-protocol.test.ts` and Task 6 Step 1 said `tests/core/tray-leader-sync.test.ts`; both files actually live under `tests/scoops/` (verified on disk) — corrected to match each task's own Files list and commit step. All other referenced test paths (`tests/cdp/`, `tests/ui/`, `tests/shell/supplemental-commands/`, `cloudflare-worker/tests/`) were verified to map to real directories.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-29-cherry-embed.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
