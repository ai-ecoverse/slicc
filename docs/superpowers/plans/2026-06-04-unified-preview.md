# Unified Preview — Implementation Plan (Phase 1 + Phase 1b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`docs/superpowers/specs/2026-06-04-unified-preview-design.md`](../specs/2026-06-04-unified-preview-design.md)

**Goal:** Ship a unified preview mechanism where every `serve`/`preview`/`open` invocation renders content at `https://<previewToken>.preview.<env>.sliccy.ai/<path>` — the Cloudflare worker fetches each file from the leader over the controller WebSocket, streams it back, and previews work uniformly across desktop / extension / cloud / Cherry / iOS / shareable links.

**Architecture:** A wildcard subdomain per-preview-token (env-mapped via lookup table) backed by a per-tray Durable Object record. New `preview.request`/`preview.response`/`preview.revoked` control messages on the existing controller WS. Leader-side `preview-request-handler.ts` applies the security gate (ported from federated branch) and reads its VFS. Extension has three invocation contexts (standalone panel-RPC / offscreen-agent in-realm hook mirroring `setCherryEmitter` / panel-terminal envelope). `serve` auto-enables a tray on first use. iOS gets a small Swift `preview.open` case. Phase 1b migrates `open`/dips/docs/e2e off the local SW so Phase 3 can delete it later.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, vitest (worker + webapp), Swift (iOS), `wrangler` for deploy.

**Out of scope for this plan:** Phase 2 (bridge channel + `eval`/inject command surface + injected `<script>`) and Phase 3 (deletion of `preview-sw.ts` and `toPreviewUrl` from main). Each gets its own plan once gating is met (Phase 2 after Phase 1 ships; Phase 3 after prod soak + Phase 1b consumer migration complete).

---

## Pre-flight (gates this plan against external dependencies)

These are **NOT plan tasks** — they're prerequisites the human owner confirms before implementation starts. Without them, Phase 1 cannot succeed in any deployed env:

1. **DNS + wildcard TLS cert** on the `sliccy.ai` zone for both `*.preview.sliccy.ai` and `*.preview.staging.sliccy.ai`. Confirmed with whoever owns the zone.
2. **Staging worker dual-zone route binding** — the staging worker at `slicc-tray-hub-staging.minivelos.workers.dev` must also hold a route binding on the `sliccy.ai` zone for `*.preview.staging.sliccy.ai/*`. Both bindings dispatch to the same worker deployment / DurableObject namespace.
3. **Federated-branch artifact for the security-gate test port** — the federated worktree at `/Users/kpauls/projects/adobe/github/slicc/.claude/worktrees/federated-preview` (commit `f950bd7f`) is the source for the 13-test security suite ported in **Task 8** (`isPathWithinServedRoot` + tests). If that worktree is gone, use `git show worktree-federated-preview:packages/webapp/tests/scoops/leader-preview-reader.test.ts`.

If any prerequisite isn't ready, **stop and escalate**. Don't try to fudge the staging URL or skip the cert.

---

## Conventions for every task

- Paths are repo-relative under `/Users/kpauls/projects/adobe/github/slicc/.claude/worktrees/unified-preview`.
- Single-file vitest: `npm run test -w @slicc/webapp -- <relative-test-path>` (webapp) or `npm run test -w @slicc/cloudflare-worker -- <relative-test-path>` (worker) or `npm run test -w @slicc/shared-ts -- <relative-test-path>` (shared).
- Format every touched file before commit: `npx prettier --write <files>` (CI fails on unformatted code).
- Commit messages: imperative subject; Co-Authored-By trailer as the repo uses.
- Tests mirror `src/` structure under the package's `tests/` directory.

---

## File structure (what each unit owns)

**New files (Phase 1):**

- `packages/shared-ts/src/preview-url.ts` — `PREVIEW_BASE_BY_WORKER` lookup table + `previewBaseHost()` + `buildPreviewUrl()` helpers. Pure, both worker and webapp import from here.
- `packages/cloudflare-worker/src/preview-host.ts` — `previewTokenFromHost()` regex parser (suffix-strip, NOT `host.split('.')[0]`).
- `packages/cloudflare-worker/src/preview-handler.ts` — HTTP handler for `*.preview.<env>.sliccy.ai/<path>` requests: look up DO record, send `preview.request` over controller WS, reassemble chunked `preview.response`, stream HTTP body back, inject bridge script in Phase 2.
- `packages/cloudflare-worker/src/preview-routes.ts` — `POST /api/tray/:trayId/preview` (mint), `POST /api/tray/:trayId/preview/stop` (revoke), `GET /api/tray/:trayId/previews` (list). All `Authorization: Bearer <controllerToken>`.
- `packages/webapp/src/scoops/preview-security.ts` — `isPathWithinServedRoot(vfsPath, servedRoot)`: rename + single-scope rewrite of federated branch's `isWithinAllowedRoots`.
- `packages/webapp/src/scoops/preview-request-handler.ts` — leader-side handler: gate, dir→index.html, read VFS, chunk, send `preview.response`.
- `packages/webapp/src/scoops/preview-minter.ts` — `setPreviewMinter` / `getPreviewMinter` module-level hook (mirrors `cherry-emit-command.ts:42` `setCherryEmitter`).
- `packages/webapp/src/shell/supplemental-commands/preview-mint-client.ts` — webapp-side client that POSTs to the worker mint API; returns `{ previewToken, url }`.
- `packages/ios-app/SliccFollower/Models/SyncProtocol.swift` — new `case previewOpen(requestId, url)`; decode `"preview.open"`.
- `packages/ios-app/SliccFollower/App/AppState.swift` — dispatch `.previewOpen` → open URL in WKWebView (reuse the existing `.tabOpen` open-URL path).

**Modified files (Phase 1):**

- `packages/cloudflare-worker/src/shared.ts` — add `PreviewRecord` type.
- `packages/cloudflare-worker/src/tray-signaling.ts` — extend both `LeaderToWorkerControlMessage` (`preview.response`) and `WorkerToLeaderControlMessage` (`preview.request`, `preview.revoked`).
- `packages/cloudflare-worker/src/session-tray.ts` — DO `previews` storage map; `mintPreview`/`resolvePreview`/`revokePreview` methods; `handleLeaderMessage` routes `preview.response` to pending-request assemblers; controller-WS `sendToLeader(preview.request | preview.revoked)`.
- `packages/cloudflare-worker/src/index.ts` — preview-subdomain dispatch + mint/revoke/list route wiring.
- `packages/cloudflare-worker/wrangler.jsonc` — wildcard routes for prod + staging.
- `packages/cloudflare-worker/tests/index.test.ts` + `tests/deployed.test.ts` — routes-mirror parity for the 3 new mint routes.
- `packages/webapp/src/scoops/tray-leader-sync.ts` — extend `LeaderToFollowerMessage` union with `preview.open { requestId, url }`; add `broadcastPreviewOpen(url)` method.
- `packages/webapp/src/scoops/tray-follower-sync.ts` — add `case 'preview.open':` follower dispatch (mirrors `tab.open` at `:617` → `executeLocalTabOpen`).
- `packages/webapp/src/ui/page-leader-tray.ts` — `currentLeaderSync` getter (port from federated); wire `preview.request` AND `preview.revoked` handlers on the controller WS (NOT in `tray-leader-sync.ts` — the controller-WS listener lives in the page/extension tray manager, not in `LeaderSyncManager`).
- `packages/chrome-extension/src/extension-leader-tray.ts` — register `setPreviewMinter` (mirrors `setCherryEmitter` at `:29,389,493`); add `tray-open-preview` `chrome.runtime` envelope listener for panel-terminal path; wire `preview.request` AND `preview.revoked` handlers.
- `packages/chrome-extension/src/leader-sync-bridge.ts` — extension panel terminal posts the `tray-open-preview` envelope to offscreen (mirrors `leader-tray-reset` precedent).
- `packages/webapp/src/kernel/panel-rpc.ts` — add `tray-open-preview` op type + result entry.
- `packages/webapp/src/ui/panel-rpc-handlers.ts` — implement `tray-open-preview` standalone page handler.
- `packages/webapp/src/shell/supplemental-commands/serve-command.ts` — three-context decision; auto-enable tray; mint via worker; `--bridge`/`--stop`/`--list`/`--project` flags.

**Modified files (Phase 1b):**

- `packages/webapp/src/shell/supplemental-commands/open-command.ts` — VFS files no longer go through `toPreviewUrl`; read content + open inline view / srcdoc.
- `packages/webapp/src/ui/dip.ts` — verify no remaining `/preview/*` dependency.
- `docs/pitfalls.md` — tab-hygiene exclude list update.
- `packages/webapp/tests/e2e/preview-serve.test.ts` — replace with worker-driven e2e (Miniflare-stub variant).
- `docs/shell-reference.md`, `README.md`, `docs/architecture.md`, `docs/urls.md`, `docs/adding-features.md`, `packages/webapp/CLAUDE.md`, `packages/chrome-extension/CLAUDE.md`, `packages/cloudflare-worker/CLAUDE.md`, `packages/ios-app/CLAUDE.md`, root `CLAUDE.md` — content + structural updates.

---

# PHASE 1 — wire delivery + revocation

## Task 1: Shared URL helper (`packages/shared-ts/src/preview-url.ts`)

**Files:**

- Create: `packages/shared-ts/src/preview-url.ts`
- Test: `packages/shared-ts/tests/preview-url.test.ts`
- Modify: `packages/shared-ts/src/index.ts` (re-export)

- [ ] **Step 1: Write the failing test** at `packages/shared-ts/tests/preview-url.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { previewBaseHost, buildPreviewUrl } from '../src/preview-url.js';

describe('previewBaseHost', () => {
  it('maps production worker hosts to preview.sliccy.ai', () => {
    expect(previewBaseHost('https://www.sliccy.ai')).toBe('preview.sliccy.ai');
    expect(previewBaseHost('https://sliccy.ai')).toBe('preview.sliccy.ai');
    expect(previewBaseHost('https://www.sliccy.ai/anything')).toBe('preview.sliccy.ai');
  });

  it('maps the staging workers.dev host to preview.staging.sliccy.ai', () => {
    expect(previewBaseHost('https://slicc-tray-hub-staging.minivelos.workers.dev')).toBe(
      'preview.staging.sliccy.ai'
    );
  });

  it('is case-insensitive on host', () => {
    expect(previewBaseHost('https://WWW.SLICCY.AI')).toBe('preview.sliccy.ai');
  });

  it('throws on an unmapped worker host (no silent fallback)', () => {
    expect(() => previewBaseHost('https://something-else.example.com')).toThrow(
      /No preview base configured/
    );
  });
});

describe('buildPreviewUrl', () => {
  it('builds the canonical URL for prod', () => {
    // Note: the path argument is a URL path on the preview origin, NOT a VFS
    // path. The mint URL has `/` (DO record carries entryPath separately);
    // subsequent asset fetches use root-relative paths like `/app.js`.
    expect(buildPreviewUrl('https://www.sliccy.ai', 'tray1.abc', '/')).toBe(
      'https://tray1.abc.preview.sliccy.ai/'
    );
    expect(buildPreviewUrl('https://www.sliccy.ai', 'tray1.abc', '/app.js')).toBe(
      'https://tray1.abc.preview.sliccy.ai/app.js'
    );
  });

  it('builds the staging URL even though the worker host is on workers.dev', () => {
    expect(
      buildPreviewUrl(
        'https://slicc-tray-hub-staging.minivelos.workers.dev',
        'tray2.def',
        '/app.js'
      )
    ).toBe('https://tray2.def.preview.staging.sliccy.ai/app.js');
  });

  it('defaults path to "/" when omitted', () => {
    expect(buildPreviewUrl('https://www.sliccy.ai', 'tray3.xyz')).toBe(
      'https://tray3.xyz.preview.sliccy.ai/'
    );
  });

  it('prepends "/" to path if missing', () => {
    expect(buildPreviewUrl('https://www.sliccy.ai', 'tray4.qrs', 'foo.html')).toBe(
      'https://tray4.qrs.preview.sliccy.ai/foo.html'
    );
  });
});
```

- [ ] **Step 2: Run, confirm FAIL** (module not found):

```
npm run test -w @slicc/shared-ts -- tests/preview-url.test.ts
```

- [ ] **Step 3: Implement** at `packages/shared-ts/src/preview-url.ts`:

```ts
/**
 * Maps a tray's worker base URL to its preview-subdomain base host.
 *
 * Critical: this is a LOOKUP TABLE, not a hostname suffix-strip. The staging
 * worker lives on `slicc-tray-hub-staging.minivelos.workers.dev` (per
 * `packages/webapp/src/scoops/tray-runtime-config.ts:4-5`), which has no string
 * relationship to `preview.staging.sliccy.ai`. Adding a new env means adding
 * a row here AND ensuring infra has both routes bound to the same worker /
 * DurableObject namespace.
 */
const PREVIEW_BASE_BY_WORKER: Record<string, string> = {
  // Production
  'www.sliccy.ai': 'preview.sliccy.ai',
  'sliccy.ai': 'preview.sliccy.ai',
  // Staging — mint API on workers.dev, preview on sliccy.ai zone (same worker)
  'slicc-tray-hub-staging.minivelos.workers.dev': 'preview.staging.sliccy.ai',
};

export function previewBaseHost(workerBaseUrl: string): string {
  const host = new URL(workerBaseUrl).host.toLowerCase();
  const mapped = PREVIEW_BASE_BY_WORKER[host];
  if (!mapped) {
    throw new Error(`No preview base configured for worker host ${host}`);
  }
  return mapped;
}

export function buildPreviewUrl(workerBaseUrl: string, previewToken: string, path = '/'): string {
  const base = previewBaseHost(workerBaseUrl);
  const p = path.startsWith('/') ? path : '/' + path;
  return `https://${previewToken}.${base}${p}`;
}
```

- [ ] **Step 4: Re-export from package** — append to `packages/shared-ts/src/index.ts`:

```ts
export { previewBaseHost, buildPreviewUrl } from './preview-url.js';
```

- [ ] **Step 4b: Add worker dependency on `@slicc/shared-ts`** — the worker imports `buildPreviewUrl` starting in Task 4 but `packages/cloudflare-worker/package.json` currently only has `@slicc/cloud-core` + `jose` as dependencies. Add:

```jsonc
// packages/cloudflare-worker/package.json
"dependencies": {
  "@slicc/cloud-core": "*",
  "@slicc/shared-ts": "*",
  "jose": "^6.2.3"
}
```

Run `npm install` from the repo root after this edit so the workspace symlink is in place.

Verify the worker bundles still resolve it:

```
npm run typecheck -w @slicc/cloudflare-worker
```

(Same pattern `@slicc/cloud-core` already follows.)

- [ ] **Step 5: Run, confirm PASS** (all 8 tests):

```
npm run test -w @slicc/shared-ts -- tests/preview-url.test.ts
```

- [ ] **Step 6: Format + commit**

```
npx prettier --write packages/shared-ts/src/preview-url.ts packages/shared-ts/src/index.ts packages/shared-ts/tests/preview-url.test.ts packages/cloudflare-worker/package.json
git add packages/shared-ts/ packages/cloudflare-worker/package.json
git commit -m "feat(preview): shared previewBaseHost + buildPreviewUrl lookup helper

Also adds @slicc/shared-ts to packages/cloudflare-worker/package.json so
Task 4's buildPreviewUrl import will resolve.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Worker host parser (`packages/cloudflare-worker/src/preview-host.ts`)

**Files:**

- Create: `packages/cloudflare-worker/src/preview-host.ts`
- Test: `packages/cloudflare-worker/tests/preview-host.test.ts`

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { previewTokenFromHost } from '../src/preview-host.js';

describe('previewTokenFromHost', () => {
  it('extracts the full token from a prod preview host (including embedded dot)', () => {
    expect(
      previewTokenFromHost('550e8400-e29b-41d4-a716-446655440000.deadbeef.preview.sliccy.ai')
    ).toBe('550e8400-e29b-41d4-a716-446655440000.deadbeef');
  });

  it('extracts the full token from a staging preview host', () => {
    expect(previewTokenFromHost('tray1.secret123.preview.staging.sliccy.ai')).toBe(
      'tray1.secret123'
    );
  });

  it('is case-insensitive on the suffix', () => {
    expect(previewTokenFromHost('tray.hex.preview.SLICCY.AI')).toBe('tray.hex');
  });

  it('returns null for non-preview hosts', () => {
    expect(previewTokenFromHost('www.sliccy.ai')).toBeNull();
    expect(previewTokenFromHost('example.com')).toBeNull();
    expect(previewTokenFromHost('preview.sliccy.ai')).toBeNull(); // no token prefix
  });

  it('returns null for malformed hosts', () => {
    expect(previewTokenFromHost('')).toBeNull();
    expect(previewTokenFromHost('.preview.sliccy.ai')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** at `packages/cloudflare-worker/src/preview-host.ts`:

```ts
/**
 * Extract a preview capability token from a request host.
 *
 * Token format is `trayId.<18-byte-hex>` (per `shared.ts:127-132`
 * createCapabilityToken), so the host has TWO dots before `.preview` and a
 * naive `host.split('.')[0]` would drop the secret half. We suffix-strip the
 * known `.preview.<env>.sliccy.ai` base instead, then leave token validation
 * to `parseCapabilityToken(token)` at the call site.
 *
 * Returns null when the host doesn't end in a known preview suffix or the
 * token portion is empty.
 */
const PREVIEW_HOST_RE = /^(.+)\.preview\.(staging\.)?sliccy\.ai$/i;

export function previewTokenFromHost(host: string): string | null {
  if (!host) return null;
  const m = host.match(PREVIEW_HOST_RE);
  if (!m) return null;
  const token = m[1];
  if (!token) return null;
  return token;
}
```

- [ ] **Step 4: Run, confirm PASS** (5 tests).

- [ ] **Step 5: Format + commit**

```
npx prettier --write packages/cloudflare-worker/src/preview-host.ts packages/cloudflare-worker/tests/preview-host.test.ts
git add packages/cloudflare-worker/
git commit -m "feat(preview): worker previewTokenFromHost regex parser

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `PreviewRecord` type + WS protocol extensions

**Files:**

- Modify: `packages/cloudflare-worker/src/shared.ts` (add `PreviewRecord`)
- Modify: `packages/cloudflare-worker/src/tray-signaling.ts` (extend both unions)

- [ ] **Step 1: Add `PreviewRecord` to `shared.ts` AND extend `TrayRecord`** — insert after the existing `TrayRecord` type:

```ts
/**
 * One record per active `serve` invocation (many per tray). Stored in the
 * SessionTrayDurableObject's `tray.previews` map (added to TrayRecord below).
 * Deleted on tray expiry OR on explicit `serve --stop` revoke.
 */
export interface PreviewRecord {
  previewToken: string; // unguessable: trayId.<18-byte-hex> per createCapabilityToken
  trayId: string;
  servedRoot: string; // VFS path: the security scope passed to the leader on every preview.request
  entryPath: string; // VFS path of the entry file (path === '/' resolves here)
  allowLive: boolean; // Phase 2 bridge-channel injection opt-in (Phase 1 ignores this)
  createdAt: string; // ISO timestamp
}
```

ALSO extend `TrayRecord` (find the existing interface in `shared.ts`) with a `previews?` field:

```ts
export interface TrayRecord {
  // … existing fields (trayId, controllerToken, joinToken, webhookToken, expiredAt, …) …
  previews?: Record<string, PreviewRecord>;
}
```

The `?` keeps existing serialized trays from breaking when the field isn't present yet — the DO defaults to `{}` on first mint.

- [ ] **Step 2: Extend `LeaderToWorkerControlMessage` in `tray-signaling.ts`** — find the existing union (after `LeaderBootstrapFailedMessage`), add the `preview.response` variant:

```ts
// Add these two new types above the existing union:
export type LeaderPreviewResponseOk = {
  type: 'preview.response';
  reqId: string;
  ok: true;
  mime: string;
  chunkIndex: number;
  totalChunks: number;
  content: string; // utf-8 text OR base64-encoded binary
  encoding: 'utf-8' | 'base64';
};

export type LeaderPreviewResponseError = {
  type: 'preview.response';
  reqId: string;
  ok: false;
  status: 404 | 403 | 500;
  reason?: string;
};

// Then add them to the union (after LeaderBootstrapFailedMessage):
export type LeaderToWorkerControlMessage =
  | { type: 'ping' }
  | LeaderBootstrapOfferMessage
  | LeaderBootstrapIceCandidateMessage
  | LeaderBootstrapFailedMessage
  | LeaderPreviewResponseOk
  | LeaderPreviewResponseError;
```

- [ ] **Step 3: Extend `WorkerToLeaderControlMessage` in `tray-signaling.ts`** — find the existing union (currently `webhook.event` + bootstrap pushes), add the `preview.request` and `preview.revoked` variants:

```ts
// Add new types:
export type WorkerPreviewRequest = {
  type: 'preview.request';
  reqId: string;
  servedRoot: string;
  vfsPath: string;
  asText: boolean;
};

export type WorkerPreviewRevoked = {
  type: 'preview.revoked';
  previewToken: string;
};

// Extend the existing WorkerToLeaderControlMessage union with these two variants.
```

(Don't forget to update any exhaustive `switch` on these unions — TypeScript will tell you which call sites broke.)

- [ ] **Step 4: Typecheck** to catch any consumer that needs a `default:` arm:

```
npm run typecheck
```

If a switch breaks, add a `default: break;` (the new types only matter to the new preview code paths added in later tasks).

- [ ] **Step 5: Format + commit**

```
npx prettier --write packages/cloudflare-worker/src/shared.ts packages/cloudflare-worker/src/tray-signaling.ts
git add packages/cloudflare-worker/
git commit -m "feat(preview): PreviewRecord type + WS protocol extensions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: DO `previews` storage + `mintPreview` / `resolvePreview` / `revokePreview`

**Files:**

- Modify: `packages/cloudflare-worker/src/session-tray.ts`
- Test: `packages/cloudflare-worker/tests/session-tray-preview.test.ts`

The DO needs:

- A `previews: Record<previewToken, PreviewRecord>` field on the persisted tray record (already added to `TrayRecord` in Task 3).
- `mintPreview(opts) -> { previewToken, url }`: validates controllerToken, generates token via `createCapabilityToken(trayId)`, stores the record, returns the URL via `buildPreviewUrl(workerBaseUrl, token, '/')`.
- `resolvePreview(previewToken) -> PreviewRecord | null`: lookup (also expire-checked against tray's `expiredAt`).
- `revokePreview(previewToken) -> { revoked: boolean }`: deletes the record AND sends `preview.revoked` to the leader over the controller WS.
- `listPreviews() -> Array<PreviewRecord>`: returns every current preview record (used by `GET /api/tray/:trayId/previews` in Task 5).

**Harness pointer (no `createTestTray()` helper exists today).** `packages/cloudflare-worker/tests/index.test.ts` uses inline DO setup — read the webhook tests at `:918` and `:983` (POST `/webhook/:token/:webhookId`) for the exact pattern: how they create a tray via `POST /tray`, how they mint capability tokens, how they validate. Mirror that in `session-tray-preview.test.ts`; do NOT import a `createTestTray()` helper (it doesn't exist).

- [ ] **Step 1: Write failing test** at `packages/cloudflare-worker/tests/session-tray-preview.test.ts` — see harness pointer above; the snippet below uses placeholder names but the implementer should replace them with real inline setup:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
// `setupTrayForTest()` below is a PLACEHOLDER — replace it with the inline setup
// pattern used by the webhook tests at `packages/cloudflare-worker/tests/index.test.ts:918+`
// (POST /tray to mint, capture controllerToken from the response, attach a fake
// controller WS). Do NOT import a `createTestTray` helper — it doesn't exist.

describe('SessionTrayDurableObject preview methods', () => {
  it('mintPreview stores a record and returns a token + URL', async () => {
    const tray = await setupTrayForTest(); // placeholder — see comment above
    const { previewToken, url } = await tray.mintPreview({
      controllerToken: tray.controllerToken,
      servedRoot: '/workspace/dist',
      entryPath: '/workspace/dist/index.html',
      allowLive: false,
      workerBaseUrl: 'https://www.sliccy.ai',
    });
    expect(previewToken).toMatch(/^[^.]+\.[0-9a-f]+$/); // trayId.hex
    expect(url).toMatch(/^https:\/\/[^.]+\.[0-9a-f]+\.preview\.sliccy\.ai\/$/);
    const record = await tray.resolvePreview(previewToken);
    expect(record).toMatchObject({
      servedRoot: '/workspace/dist',
      entryPath: '/workspace/dist/index.html',
      allowLive: false,
    });
  });

  it('mintPreview rejects when controllerToken is wrong', async () => {
    const tray = await setupTrayForTest();
    await expect(
      tray.mintPreview({
        controllerToken: 'wrong.token',
        servedRoot: '/x',
        entryPath: '/x/i.html',
        allowLive: false,
        workerBaseUrl: 'https://www.sliccy.ai',
      })
    ).rejects.toThrow(/invalid|forbidden/i);
  });

  it('resolvePreview returns null for unknown tokens', async () => {
    const tray = await setupTrayForTest();
    expect(await tray.resolvePreview('bogus.abc')).toBeNull();
  });

  it('revokePreview deletes the record and returns { revoked: true }', async () => {
    const tray = await setupTrayForTest();
    const { previewToken } = await tray.mintPreview({
      controllerToken: tray.controllerToken,
      servedRoot: '/w',
      entryPath: '/w/i.html',
      allowLive: false,
      workerBaseUrl: 'https://www.sliccy.ai',
    });
    expect(await tray.revokePreview(previewToken)).toEqual({ revoked: true });
    expect(await tray.resolvePreview(previewToken)).toBeNull();
  });

  it('revokePreview on unknown token returns { revoked: false }', async () => {
    const tray = await setupTrayForTest();
    expect(await tray.revokePreview('nope.0')).toEqual({ revoked: false });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL** (methods don't exist yet).

- [ ] **Step 3: Implement** in `packages/cloudflare-worker/src/session-tray.ts` — add `previews` field to whatever interface defines the persisted record (mirror the existing `joinToken`/`controllerToken`/`webhookToken` fields shape), then add the methods:

```ts
async mintPreview(req: {
  controllerToken: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
  workerBaseUrl: string;
}): Promise<{ previewToken: string; url: string }> {
  if (!this.matchesToken(req.controllerToken, this.requireTray().controllerToken)) {
    throw new Error('Invalid controller capability');
  }
  const tray = this.requireTray();
  const previewToken = createCapabilityToken(tray.trayId);
  const record: PreviewRecord = {
    previewToken,
    trayId: tray.trayId,
    servedRoot: req.servedRoot,
    entryPath: req.entryPath,
    allowLive: req.allowLive,
    createdAt: this.isoNow(),
  };
  tray.previews ??= {};
  tray.previews[previewToken] = record;
  await this.persistTray(tray); // use whatever name the DO uses for persistence
  const url = buildPreviewUrl(req.workerBaseUrl, previewToken, '/');
  return { previewToken, url };
}

async resolvePreview(previewToken: string): Promise<PreviewRecord | null> {
  const tray = await this.loadTray();
  if (!tray || tray.expiredAt) return null;
  return tray.previews?.[previewToken] ?? null;
}

async revokePreview(previewToken: string): Promise<{ revoked: boolean }> {
  const tray = this.requireTray();
  if (!tray.previews?.[previewToken]) return { revoked: false };
  delete tray.previews[previewToken];
  await this.persistTray(tray);
  // Phase 1: best-effort controller-WS notice to the leader. Bridge invalidation
  // is Phase 2; in Phase 1 the URL stops working immediately and open tabs
  // degrade on next asset fetch.
  this.sendToLeader({ type: 'preview.revoked', previewToken });
  return { revoked: true };
}

async listPreviews(): Promise<PreviewRecord[]> {
  const tray = await this.loadTray();
  if (!tray || tray.expiredAt) return [];
  return Object.values(tray.previews ?? {});
}
```

(`buildPreviewUrl` is imported from `@slicc/shared-ts`.)

- [ ] **Step 4: Run, confirm PASS** (5 tests).

- [ ] **Step 5: Format + commit**

```
npx prettier --write packages/cloudflare-worker/src/session-tray.ts packages/cloudflare-worker/tests/session-tray-preview.test.ts
git add packages/cloudflare-worker/
git commit -m "feat(preview): DO previews storage + mintPreview/resolvePreview/revokePreview

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Worker mint / revoke / list HTTP routes

**Files:**

- Create: `packages/cloudflare-worker/src/preview-routes.ts`
- Modify: `packages/cloudflare-worker/src/index.ts` (wire the routes)
- Modify: `packages/cloudflare-worker/tests/index.test.ts` AND `tests/deployed.test.ts` (routes-mirror)

Three routes, all on the main worker host (NOT on the preview subdomain):

- `POST /api/tray/:trayId/preview` — mint (auth: controllerToken)
- `POST /api/tray/:trayId/preview/stop` — revoke (auth: controllerToken)
- `GET /api/tray/:trayId/previews` — list (auth: controllerToken)

- [ ] **Step 1: Write failing test** in `packages/cloudflare-worker/tests/index.test.ts` — mirror how the existing webhook routes are tested. Add a `describe('preview mint API', ...)` block:

```ts
describe('preview mint API', () => {
  it('mints a preview token and returns a URL when authorized', async () => {
    const { trayId, controllerToken } = await createTrayUnderTest();
    const res = await handleWorkerRequest({
      method: 'POST',
      url: `https://www.sliccy.ai/api/tray/${trayId}/preview`,
      headers: { Authorization: `Bearer ${controllerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        servedRoot: '/workspace/dist',
        entryPath: '/workspace/dist/index.html',
        allowLive: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      previewToken: expect.stringMatching(/\./),
      url: expect.stringMatching(/^https:\/\/[^.]+\.[^.]+\.preview\.sliccy\.ai\/$/),
    });
  });

  it('rejects with 403 on missing/wrong controllerToken', async () => {
    const { trayId } = await createTrayUnderTest();
    const res = await handleWorkerRequest({
      method: 'POST',
      url: `https://www.sliccy.ai/api/tray/${trayId}/preview`,
      headers: { Authorization: 'Bearer wrong.token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ servedRoot: '/x', entryPath: '/x/i.html', allowLive: false }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /previews lists all active previews', async () => {
    const { trayId, controllerToken } = await createTrayUnderTest();
    // mint two
    for (const dir of ['/workspace/a', '/workspace/b']) {
      await handleWorkerRequest({
        method: 'POST',
        url: `https://www.sliccy.ai/api/tray/${trayId}/preview`,
        headers: { Authorization: `Bearer ${controllerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ servedRoot: dir, entryPath: `${dir}/i.html`, allowLive: false }),
      });
    }
    const list = await handleWorkerRequest({
      method: 'GET',
      url: `https://www.sliccy.ai/api/tray/${trayId}/previews`,
      headers: { Authorization: `Bearer ${controllerToken}` },
    });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.previews).toHaveLength(2);
  });

  it('POST /preview/stop revokes', async () => {
    const { trayId, controllerToken } = await createTrayUnderTest();
    const mint = await handleWorkerRequest({
      method: 'POST',
      url: `https://www.sliccy.ai/api/tray/${trayId}/preview`,
      headers: { Authorization: `Bearer ${controllerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ servedRoot: '/x', entryPath: '/x/i.html', allowLive: false }),
    });
    const { previewToken } = await mint.json();
    const stop = await handleWorkerRequest({
      method: 'POST',
      url: `https://www.sliccy.ai/api/tray/${trayId}/preview/stop`,
      headers: { Authorization: `Bearer ${controllerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewToken }),
    });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ revoked: true });
  });

  it('returns 404 when tray not found', async () => {
    const res = await handleWorkerRequest({
      method: 'POST',
      url: `https://www.sliccy.ai/api/tray/nonexistent/preview`,
      headers: { Authorization: 'Bearer x.y', 'Content-Type': 'application/json' },
      body: JSON.stringify({ servedRoot: '/x', entryPath: '/x/i.html', allowLive: false }),
    });
    expect(res.status).toBe(404);
  });
});
```

(`createTrayUnderTest`, `handleWorkerRequest` are existing test helpers — see e.g. the webhook-route tests in the same file for the exact harness.)

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement route handlers** in `packages/cloudflare-worker/src/preview-routes.ts`:

```ts
import type { Env } from './types.js'; // adapt to actual location
import { jsonResponse } from './shared.js'; // adapt
// Get a DO stub for the given trayId via env.SESSION_TRAY_DO.idFromName(trayId) etc.

export async function handlePreviewMint(
  request: Request,
  env: Env,
  trayId: string
): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  const controllerToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!controllerToken) return jsonResponse({ error: 'unauthorized' }, 401);
  const body = (await request.json()) as {
    servedRoot: string;
    entryPath: string;
    allowLive: boolean;
  };
  // Delegate to the DO stub (mirror existing webhook-call pattern):
  const stub = trayStub(env, trayId);
  const url = new URL(request.url);
  const workerBaseUrl = `${url.protocol}//${url.host}`;
  const doRes = await stub.fetch(
    new Request(`https://internal/mintPreview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ controllerToken, ...body, workerBaseUrl }),
    })
  );
  return doRes; // DO returns 200 / 403 / 404 / 400
}

export async function handlePreviewStop(
  request: Request,
  env: Env,
  trayId: string
): Promise<Response> {
  /* same shape: extract bearer, parse { previewToken }, delegate to DO */
}

export async function handlePreviewList(
  request: Request,
  env: Env,
  trayId: string
): Promise<Response> {
  /* same shape: auth, delegate to DO list method */
}

function trayStub(env: Env, trayId: string) {
  /* mirror the existing webhook trayStub pattern */
}
```

(Look at the existing webhook handler in `session-tray.ts:507-591` or `index.ts:329` for the DO-stub pattern.)

- [ ] **Step 4: Wire routes in `index.ts`** — add a match for `POST /api/tray/:trayId/preview`, `POST /api/tray/:trayId/preview/stop`, `GET /api/tray/:trayId/previews` before the existing SPA fallback:

```ts
const trayMintMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/preview$/);
if (trayMintMatch && request.method === 'POST') {
  return handlePreviewMint(request, env, trayMintMatch[1]);
}
const trayStopMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/preview\/stop$/);
if (trayStopMatch && request.method === 'POST') {
  return handlePreviewStop(request, env, trayStopMatch[1]);
}
const trayListMatch = url.pathname.match(/^\/api\/tray\/([^/]+)\/previews$/);
if (trayListMatch && request.method === 'GET') {
  return handlePreviewList(request, env, trayListMatch[1]);
}
```

Also add the DO-side handlers for `/mintPreview`, `/stopPreview`, `/listPreviews` internal endpoints inside `session-tray.ts`'s `fetch` handler if that's the pattern the worker uses.

- [ ] **Step 5: Routes-mirror — update `tests/index.test.ts` AND `tests/deployed.test.ts`** with the same 3 routes' presence checks (whatever pattern the existing webhook routes use in those two test files).

- [ ] **Step 6: Run, confirm all PASS.** Run worker coverage gate:

```
npm run test:coverage:cloudflare-worker
```

Coverage must remain at 75/85/65 floors (lines/functions/branches).

- [ ] **Step 7: Format + commit**

```
npx prettier --write packages/cloudflare-worker/
git add packages/cloudflare-worker/
git commit -m "feat(preview): worker mint/revoke/list HTTP routes (controllerToken auth)

Routes-mirror: index.ts routes + tests/index.test.ts + tests/deployed.test.ts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Worker preview HTTP handler (the request/response pipe)

**Files:**

- Create: `packages/cloudflare-worker/src/preview-handler.ts`
- Modify: `packages/cloudflare-worker/src/index.ts` (dispatch preview-subdomain hosts here)
- Modify: `packages/cloudflare-worker/src/session-tray.ts` (extend `handleLeaderMessage` to route `preview.response` chunks to pending assemblers)
- Test: extend `packages/cloudflare-worker/tests/session-tray-preview.test.ts` with HTTP round-trip cases

This is the heart of Phase 1. When a request comes in on `<token>.preview.<env>.sliccy.ai/<path>`:

1. Parse `previewToken` via `previewTokenFromHost(host)`.
2. Validate token shape via `parseCapabilityToken(token)`.
3. Resolve `PreviewRecord` via DO `resolvePreview(token)`. If missing → 404 (or session-ended HTML if tray expired).
4. Resolve VFS path: `path === '/' → servedRoot+entryPath` (wait — the entryPath IS the full path; just use entryPath); else `servedRoot + path`.
5. Send `preview.request{reqId, servedRoot, vfsPath, asText}` to the leader via `sendToLeader`.
6. Wait for `preview.response` chunks (30s timeout). On no leader connected → 502. On chunks → reassemble (handle binary base64 → bytes), set `Content-Type` from response's `mime`, stream body back.
7. On security-gate 403 from leader → 403.
8. On 404 from leader → 404.

The DO's `handleLeaderMessage` needs to be extended: when it receives `preview.response` from the leader's controller WS, look up the pending request by `reqId` and feed the chunk to its assembler.

- [ ] **Step 1: Write failing test** — add to `tests/session-tray-preview.test.ts`:

```ts
describe('preview HTTP handler', () => {
  it('end-to-end: mint → GET preview URL → leader fakes preview.response → bytes returned', async () => {
    const { trayId, controllerToken } = await createTrayUnderTest();
    // Pre-register a fake leader controller WS that responds to preview.request.
    const fakeLeaderWS = attachFakeLeader(trayId, {
      onPreviewRequest: (req) => ({
        type: 'preview.response',
        reqId: req.reqId,
        ok: true,
        mime: 'text/html',
        chunkIndex: 0,
        totalChunks: 1,
        content: '<h1>hello</h1>',
        encoding: 'utf-8',
      }),
    });
    const mint = await handleWorkerRequest({
      method: 'POST',
      url: `https://www.sliccy.ai/api/tray/${trayId}/preview`,
      headers: { Authorization: `Bearer ${controllerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        servedRoot: '/workspace/dist',
        entryPath: '/workspace/dist/index.html',
        allowLive: false,
      }),
    });
    const { previewToken, url } = await mint.json();
    const res = await handleWorkerRequest({
      method: 'GET',
      url,
      headers: { Host: new URL(url).host },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<h1>hello</h1>');
  });

  it('returns 404 for unknown token host', async () => {
    const res = await handleWorkerRequest({
      method: 'GET',
      url: 'https://nope.bogus.preview.sliccy.ai/',
    });
    expect(res.status).toBe(404);
  });

  it('returns 502 when leader is disconnected', async () => {
    const { trayId, controllerToken } = await createTrayUnderTest();
    // Note: no attachFakeLeader — leader is not connected.
    const mint = await mintPreview(trayId, controllerToken);
    const res = await handleWorkerRequest({
      method: 'GET',
      url: mint.url,
      headers: { Host: new URL(mint.url).host },
    });
    expect(res.status).toBe(502);
  });

  it('returns 403 when leader sends ok:false status:403', async () => {
    /* exfil-attempt path */
  });

  it('omits Access-Control-Allow-Origin between preview subdomains', async () => {
    /* cross-preview defense */
  });

  it('returns session-ended HTML when tray is expired', async () => {
    /* simulate TRAY_EXPIRED */
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** `packages/cloudflare-worker/src/preview-handler.ts`:

```ts
import { previewTokenFromHost } from './preview-host.js';
import { parseCapabilityToken } from './shared.js';
import type { Env } from './types.js';

const PREVIEW_REQUEST_TIMEOUT_MS = 30_000;

export async function handlePreviewRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const previewToken = previewTokenFromHost(url.host);
  if (!previewToken) return new Response('Not found', { status: 404 });
  const parsed = parseCapabilityToken(previewToken);
  if (!parsed) return new Response('Not found', { status: 404 });

  // Look up DO record via the tray DO.
  const stub = trayStub(env, parsed.trayId);
  const recordRes = await stub.fetch(
    new Request(`https://internal/resolvePreview?token=${encodeURIComponent(previewToken)}`)
  );
  if (recordRes.status === 410) {
    return new Response(sessionEndedHtml(), {
      status: 410,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  if (recordRes.status !== 200) return new Response('Not found', { status: 404 });
  const record = (await recordRes.json()) as PreviewRecord;

  // Resolve VFS path.
  const path = url.pathname;
  const vfsPath = path === '/' ? record.entryPath : record.servedRoot + path;
  // (For root-absolute /foo.js when servedRoot=/workspace/dist, vfsPath = /workspace/dist/foo.js.)
  const asText = isTextLikeByExtension(vfsPath);

  // Round-trip preview.request → preview.response via DO.
  const requestBody = {
    reqId: crypto.randomUUID(),
    servedRoot: record.servedRoot,
    vfsPath,
    asText,
  };
  const fetchRes = await stub.fetch(
    new Request(`https://internal/fetchPreviewFromLeader`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: { 'content-type': 'application/json' },
    })
  );
  // The DO returns the assembled HTTP response or an error status.
  return passThrough(fetchRes);
}

function sessionEndedHtml(): string {
  return `<!doctype html><html><head><title>Preview ended</title></head>
  <body><h1>Preview session ended</h1>
  <p>The leader has disconnected. Ask the agent to <code>serve</code> again.</p></body></html>`;
}

function isTextLikeByExtension(path: string): boolean {
  return /\.(html?|css|js|mjs|json|svg|txt|xml|md)$/i.test(path);
}
```

- [ ] **Step 4: Implement DO `/fetchPreviewFromLeader`** in `session-tray.ts` — this is the DO-internal route that sends `preview.request` to the leader, waits up to 30s for the matching `preview.response` chunks, reassembles, and returns the HTTP response. Pseudocode shape:

```ts
async handleFetchPreviewFromLeader(body: { reqId; servedRoot; vfsPath; asText }): Promise<Response> {
  if (!this.hasLiveLeader()) return new Response('Bad gateway: leader disconnected', { status: 502 });
  const assembler = new ResponseAssembler();
  this.pendingPreviews.set(body.reqId, assembler);
  this.sendToLeader({ type: 'preview.request', ...body });
  const result = await Promise.race([
    assembler.complete(),
    timeoutAfter(PREVIEW_REQUEST_TIMEOUT_MS, () => 'timeout'),
  ]);
  this.pendingPreviews.delete(body.reqId);
  if (result === 'timeout') return new Response('Bad gateway: leader timeout', { status: 502 });
  if (!result.ok) return new Response('Forbidden', { status: result.status }); // 404 / 403 / 500
  const body =
    result.encoding === 'utf-8' ? result.content : Uint8Array.from(atob(result.content), (c) => c.charCodeAt(0));
  return new Response(body, {
    status: 200,
    headers: { 'content-type': result.mime, 'cache-control': 'no-cache' },
  });
}
```

`ResponseAssembler` collects `preview.response` chunks until `chunkIndex+1 === totalChunks` and resolves to either the full concatenated content or an error variant.

- [ ] **Step 5: Extend `handleLeaderMessage`** in `session-tray.ts` to route `preview.response` chunks:

```ts
if (msg.type === 'preview.response') {
  const assembler = this.pendingPreviews.get(msg.reqId);
  if (assembler) assembler.push(msg);
  return;
}
```

- [ ] **Step 6: Wire host dispatch in `index.ts`** — before the existing route table, check if the host matches a preview subdomain:

```ts
import { previewTokenFromHost } from './preview-host.js';
// inside fetch handler, very early:
if (previewTokenFromHost(url.host)) {
  return handlePreviewRequest(request, env);
}
```

- [ ] **Step 7: Run, confirm all 6 cases PASS.** Run worker coverage gate.

- [ ] **Step 8: Format + commit**

```
npx prettier --write packages/cloudflare-worker/
git add packages/cloudflare-worker/
git commit -m "feat(preview): worker preview HTTP handler (request/response pipe over controller WS)

Subdomain dispatch via previewTokenFromHost; ResponseAssembler with 30s timeout;
session-ended HTML on TRAY_EXPIRED; 502 on disconnected leader / timeout; 403/404
from leader passed through.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Wildcard routes in `wrangler.jsonc`

**Files:**

- Modify: `packages/cloudflare-worker/wrangler.jsonc`

- [ ] **Step 1: Add prod wildcard** — in the top-level `routes` array (currently lines 14-17), append:

```jsonc
{ "pattern": "*.preview.sliccy.ai/*", "zone_name": "sliccy.ai" }
```

- [ ] **Step 2: Add staging wildcard** — in `env.staging.routes` (currently `[]` at line 72), add:

```jsonc
"routes": [
  { "pattern": "*.preview.staging.sliccy.ai/*", "zone_name": "sliccy.ai" }
]
```

Note: the staging worker is on `slicc-tray-hub-staging.minivelos.workers.dev`, but its preview wildcard lives on the `sliccy.ai` zone. Both must dispatch to the same DO namespace — confirm infra has the zone-routing in place per the spec's pre-flight gate.

- [ ] **Step 3: Verify with `wrangler` dry-run** (CI also runs this; mirror locally):

```
cd packages/cloudflare-worker && npx wrangler deploy --dry-run --env=staging
cd packages/cloudflare-worker && npx wrangler deploy --dry-run
```

Both should succeed (or fail with a clear message about wildcard certs that the human owner can take to infra).

- [ ] **Step 4: Format + commit**

```
npx prettier --write packages/cloudflare-worker/wrangler.jsonc
git add packages/cloudflare-worker/wrangler.jsonc
git commit -m "feat(preview): wildcard routes for *.preview.(staging.)sliccy.ai

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Leader-side security gate (`isPathWithinServedRoot`) + ported tests

**Files:**

- Create: `packages/webapp/src/scoops/preview-security.ts`
- Create: `packages/webapp/tests/scoops/preview-security.test.ts` (port from federated branch)

- [ ] **Step 1: Grab the federated-branch test source** for reference:

```
git show worktree-federated-preview:packages/webapp/tests/scoops/leader-preview-reader.test.ts > /tmp/federated-security-tests.ts
```

Read it. There are 13 test cases covering: traversal (`..`), trailing-dot segment (`.`), sibling-prefix (`/workspace/dist-secret` vs `/workspace/dist`), trailing-slash normalization, root-`/` fail-closed, empty-real-file vs no-file distinction.

- [ ] **Step 2: Write the ported test file** at `packages/webapp/tests/scoops/preview-security.test.ts`. Single-scope rewrite — the federated version had a multi-root `Set`; this is single `servedRoot`:

```ts
import { describe, it, expect } from 'vitest';
import { isPathWithinServedRoot } from '../../src/scoops/preview-security.js';

describe('isPathWithinServedRoot', () => {
  it('accepts a path equal to the root', () => {
    expect(isPathWithinServedRoot('/workspace/dist', '/workspace/dist')).toBe(true);
  });

  it('accepts paths strictly under the root', () => {
    expect(isPathWithinServedRoot('/workspace/dist/index.html', '/workspace/dist')).toBe(true);
    expect(isPathWithinServedRoot('/workspace/dist/sub/asset.js', '/workspace/dist')).toBe(true);
  });

  it('rejects sibling-prefix paths (the "dist-secret" trick)', () => {
    expect(isPathWithinServedRoot('/workspace/dist-secret', '/workspace/dist')).toBe(false);
    expect(isPathWithinServedRoot('/workspace/dist-secret/foo.js', '/workspace/dist')).toBe(false);
  });

  it('rejects parent-traversal segments', () => {
    expect(isPathWithinServedRoot('/workspace/dist/../etc/passwd', '/workspace/dist')).toBe(false);
    expect(isPathWithinServedRoot('/workspace/dist/foo/../../etc', '/workspace/dist')).toBe(false);
  });

  it('rejects trailing-dot segments', () => {
    expect(isPathWithinServedRoot('/workspace/dist/./.', '/workspace/dist')).toBe(false);
  });

  it('rejects paths above the root', () => {
    expect(isPathWithinServedRoot('/workspace', '/workspace/dist')).toBe(false);
    expect(isPathWithinServedRoot('/etc/passwd', '/workspace/dist')).toBe(false);
  });

  it('normalizes trailing slashes on the root', () => {
    expect(isPathWithinServedRoot('/workspace/dist/x', '/workspace/dist/')).toBe(true);
  });

  it('is fail-closed when the root is `/` (defense against an over-broad serve)', () => {
    expect(isPathWithinServedRoot('/anything', '/')).toBe(false);
  });

  it('rejects empty paths', () => {
    expect(isPathWithinServedRoot('', '/workspace/dist')).toBe(false);
  });

  it('rejects non-absolute paths', () => {
    expect(isPathWithinServedRoot('workspace/dist/x', '/workspace/dist')).toBe(false);
  });

  it('rejects URL-encoded traversal', () => {
    expect(isPathWithinServedRoot('/workspace/dist/%2E%2E/etc', '/workspace/dist')).toBe(false);
  });

  it('accepts deep nesting', () => {
    expect(isPathWithinServedRoot('/workspace/dist/a/b/c/d/e/f/g.js', '/workspace/dist')).toBe(
      true
    );
  });

  it('rejects empty servedRoot', () => {
    expect(isPathWithinServedRoot('/anything', '')).toBe(false);
  });
});
```

- [ ] **Step 3: Run, confirm FAIL.**

- [ ] **Step 4: Implement** at `packages/webapp/src/scoops/preview-security.ts`:

```ts
/**
 * Phase-1 security gate for leader-side preview.request handling.
 *
 * Returns `true` only when `vfsPath` is strictly inside `servedRoot`.
 * Rejects any path containing `..`, `.`, or URL-encoded variants of those
 * (anything an attacker could use to escape the served subtree). Fail-closed
 * when `servedRoot` is `/` so an over-broad `serve /` doesn't grant whole-VFS
 * read access.
 *
 * Renamed + single-scope rewrite of the federated branch's
 * `isWithinAllowedRoots` (which held a Set<root>). Each preview.request carries
 * exactly one `servedRoot` from the DO, so the multi-root variant isn't needed.
 */
export function isPathWithinServedRoot(vfsPath: string, servedRoot: string): boolean {
  if (!vfsPath || !servedRoot) return false;
  if (!vfsPath.startsWith('/')) return false;
  if (servedRoot === '/') return false; // fail-closed against over-broad serves
  // Reject URL-encoded traversal before any other check
  if (/%2[eE]/.test(vfsPath)) return false;
  // Reject any path segment equal to '.' or '..'
  const segments = vfsPath.split('/');
  if (segments.some((s) => s === '.' || s === '..')) return false;
  // Normalize root trailing slash for prefix-check
  const root = servedRoot.endsWith('/') ? servedRoot.slice(0, -1) : servedRoot;
  if (vfsPath === root) return true;
  return vfsPath.startsWith(root + '/');
}
```

- [ ] **Step 5: Run, confirm 13 cases PASS:**

```
npm run test -w @slicc/webapp -- tests/scoops/preview-security.test.ts
```

- [ ] **Step 6: Format + commit**

```
npx prettier --write packages/webapp/src/scoops/preview-security.ts packages/webapp/tests/scoops/preview-security.test.ts
git add packages/webapp/
git commit -m "feat(preview): security gate isPathWithinServedRoot (port from federated)

Ports the 13-test security suite from worktree-federated-preview @ f950bd7f;
single-scope rewrite (each preview.request carries one servedRoot from the DO,
so the multi-root Set isn't needed).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Leader-side `preview-request-handler.ts`

**Files:**

- Create: `packages/webapp/src/scoops/preview-request-handler.ts`
- Test: `packages/webapp/tests/scoops/preview-request-handler.test.ts`

This module is called by the controller-WS listener (in `page-leader-tray.ts` and `extension-leader-tray.ts` — wired in the next tasks) when a `preview.request` arrives. It applies the gate, optionally resolves directory→index.html, reads the file from `VirtualFS`, chunks the response, and emits `preview.response` messages back.

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { handlePreviewRequest } from '../../src/scoops/preview-request-handler.js';

function fakeVfs(files: Record<string, string | Uint8Array>) {
  return {
    async readFile(path: string, opts: { encoding: 'utf-8' | 'binary' }) {
      const content = files[path];
      if (content === undefined) {
        const err: NodeJS.ErrnoException = new Error(`ENOENT: ${path}`);
        err.code = 'ENOENT';
        throw err;
      }
      return opts.encoding === 'utf-8' ? String(content) : (content as Uint8Array);
    },
    async stat(path: string) {
      if (files[path] !== undefined) return { isDirectory: false } as const;
      const hasChildren = Object.keys(files).some((k) => k.startsWith(path + '/'));
      if (hasChildren) return { isDirectory: true } as const;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  } as never;
}

describe('handlePreviewRequest', () => {
  it('reads a text file and sends a single chunk', async () => {
    const sent: unknown[] = [];
    const ws = { send: (m: unknown) => sent.push(m) };
    const vfs = fakeVfs({ '/workspace/dist/index.html': '<h1>hi</h1>' });
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r1',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/index.html',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent).toEqual([
      {
        type: 'preview.response',
        reqId: 'r1',
        ok: true,
        mime: 'text/html',
        chunkIndex: 0,
        totalChunks: 1,
        content: '<h1>hi</h1>',
        encoding: 'utf-8',
      },
    ]);
  });

  it('rejects out-of-root paths with status 403 before any VFS read', async () => {
    const sent: unknown[] = [];
    const ws = { send: (m: unknown) => sent.push(m) };
    const vfs = {
      readFile: vi.fn(),
      stat: vi.fn(),
    };
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r2',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/.git/github-token',
        asText: true,
      },
      ws,
      vfs as never
    );
    expect(sent).toEqual([{ type: 'preview.response', reqId: 'r2', ok: false, status: 403 }]);
    expect(vfs.readFile).not.toHaveBeenCalled();
  });

  it('returns 404 on ENOENT', async () => {
    const sent: unknown[] = [];
    const ws = { send: (m: unknown) => sent.push(m) };
    const vfs = fakeVfs({});
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r3',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/missing.html',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent[0]).toMatchObject({ ok: false, status: 404 });
  });

  it('chunks large content at 64 KB boundaries', async () => {
    const big = 'x'.repeat(70_000);
    const sent: any[] = [];
    const ws = { send: (m: any) => sent.push(m) };
    const vfs = fakeVfs({ '/workspace/dist/big.js': big });
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r4',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/big.js',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[0].totalChunks).toBe(sent.length);
    expect(sent.map((s) => s.content).join('')).toBe(big);
  });

  it('encodes binary content as base64', async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x10, 0x20]);
    const sent: any[] = [];
    const ws = { send: (m: any) => sent.push(m) };
    const vfs = fakeVfs({ '/workspace/dist/x.png': bytes });
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r5',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/x.png',
        asText: false,
      },
      ws,
      vfs
    );
    expect(sent[0]).toMatchObject({ encoding: 'base64', mime: 'image/png' });
    // Re-decode: atob(base64) gives back the original bytes
    expect(atob(sent[0].content)).toBe(String.fromCharCode(0xff, 0x00, 0x10, 0x20));
  });

  it('resolves a directory request to index.html (re-gating the rewritten path)', async () => {
    const sent: any[] = [];
    const ws = { send: (m: any) => sent.push(m) };
    const vfs = fakeVfs({ '/workspace/dist/sub/index.html': 'inner' });
    await handlePreviewRequest(
      {
        type: 'preview.request',
        reqId: 'r6',
        servedRoot: '/workspace/dist',
        vfsPath: '/workspace/dist/sub',
        asText: true,
      },
      ws,
      vfs
    );
    expect(sent[0]).toMatchObject({ ok: true, content: 'inner', mime: 'text/html' });
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** `packages/webapp/src/scoops/preview-request-handler.ts`:

```ts
import { isPathWithinServedRoot } from './preview-security.js';
import { chunkContent, encodeBase64 } from './tray-fs-handler.js'; // reuse existing chunker

const CHUNK_THRESHOLD = 64 * 1024;

interface PreviewRequest {
  type: 'preview.request';
  reqId: string;
  servedRoot: string;
  vfsPath: string;
  asText: boolean;
}

interface MinimalVfs {
  readFile(path: string, opts: { encoding: 'utf-8' | 'binary' }): Promise<string | Uint8Array>;
  stat(path: string): Promise<{ isDirectory: boolean }>;
}

interface MinimalWs {
  send(msg: unknown): void;
}

export async function handlePreviewRequest(
  msg: PreviewRequest,
  ws: MinimalWs,
  vfs: MinimalVfs
): Promise<void> {
  let { reqId, servedRoot, vfsPath, asText } = msg;

  // Security gate FIRST
  if (!isPathWithinServedRoot(vfsPath, servedRoot)) {
    ws.send({ type: 'preview.response', reqId, ok: false, status: 403 });
    return;
  }

  // Directory → index.html (re-gate the rewritten path)
  try {
    const st = await vfs.stat(vfsPath);
    if (st.isDirectory) {
      vfsPath = vfsPath.replace(/\/?$/, '/') + 'index.html';
      if (!isPathWithinServedRoot(vfsPath, servedRoot)) {
        ws.send({ type: 'preview.response', reqId, ok: false, status: 403 });
        return;
      }
    }
  } catch {
    /* not a directory; fall through to read */
  }

  // Read file
  let content: string;
  let encoding: 'utf-8' | 'base64';
  try {
    if (asText) {
      content = (await vfs.readFile(vfsPath, { encoding: 'utf-8' })) as string;
      encoding = 'utf-8';
    } else {
      const bytes = (await vfs.readFile(vfsPath, { encoding: 'binary' })) as Uint8Array;
      content = encodeBase64(bytes); // reuse helper
      encoding = 'base64';
    }
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      ws.send({ type: 'preview.response', reqId, ok: false, status: 404 });
    } else {
      ws.send({
        type: 'preview.response',
        reqId,
        ok: false,
        status: 500,
        reason: String(e?.message ?? e),
      });
    }
    return;
  }

  const mime = mimeForPath(vfsPath);
  const chunks = chunkBy(content, CHUNK_THRESHOLD);
  for (let i = 0; i < chunks.length; i++) {
    ws.send({
      type: 'preview.response',
      reqId,
      ok: true,
      mime,
      chunkIndex: i,
      totalChunks: chunks.length,
      content: chunks[i],
      encoding,
    });
  }
}

function chunkBy(content: string, size: number): string[] {
  if (content.length <= size) return [content];
  const out: string[] = [];
  for (let i = 0; i < content.length; i += size) out.push(content.slice(i, i + size));
  return out;
}

function mimeForPath(path: string): string {
  if (/\.html?$/i.test(path)) return 'text/html';
  if (/\.css$/i.test(path)) return 'text/css';
  if (/\.m?js$/i.test(path)) return 'application/javascript';
  if (/\.json$/i.test(path)) return 'application/json';
  if (/\.svg$/i.test(path)) return 'image/svg+xml';
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.gif$/i.test(path)) return 'image/gif';
  if (/\.webp$/i.test(path)) return 'image/webp';
  if (/\.ico$/i.test(path)) return 'image/x-icon';
  if (/\.woff2?$/i.test(path)) return 'font/woff2';
  return 'application/octet-stream';
}
```

(`encodeBase64` may need to be added to `tray-fs-handler.ts` if not already exported — check the file; it has chunking but binary encoding may inline.)

- [ ] **Step 4: Run, confirm 6 cases PASS.**

- [ ] **Step 5: Format + commit**

```
npx prettier --write packages/webapp/src/scoops/preview-request-handler.ts packages/webapp/tests/scoops/preview-request-handler.test.ts
git add packages/webapp/
git commit -m "feat(preview): leader-side preview-request-handler

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Wire `preview.request` listener into `page-leader-tray.ts` (standalone)

**Files:**

- Modify: `packages/webapp/src/ui/page-leader-tray.ts`

The standalone leader holds the controller WS via `LeaderTrayManager` (look at the existing webhook handler at `:207` for the precedent — when `message.type === 'webhook.event'` it dispatches to a callback). Add the parallel for `preview.request`.

- [ ] **Step 1: Grep for the existing webhook handler:**

```
rg -n "webhook.event\|message.type ===" packages/webapp/src/ui/page-leader-tray.ts
```

- [ ] **Step 2: Add `preview.request` AND `preview.revoked` dispatch** — after the existing webhook-event branch, add:

```ts
if (message.type === 'preview.request') {
  handlePreviewRequest(message, this.controllerSocket, vfs);
  return;
}
if (message.type === 'preview.revoked') {
  // Phase 1: log only (Phase 2's bridge channel will use this to push a
  // preview-stopped event to open tabs). Optional follow-up: emit a cone-side
  // `cherry`-style lick so the agent sees the user-initiated revoke.
  log.info('Preview revoked by worker', { previewToken: message.previewToken });
  return;
}
```

…where `vfs` is the leader's `VirtualFS` instance (already in scope at this layer — find it the same way the federated branch did, via the `options.vfs` field of `LeaderSyncManagerOptions` if applicable).

Imports:

```ts
import { handlePreviewRequest } from '../scoops/preview-request-handler.js';
// (`log` already exists at this file's top via createLogger; reuse it.)
```

- [ ] **Step 3: Typecheck**

```
npm run typecheck
```

- [ ] **Step 4: Format + commit**

```
npx prettier --write packages/webapp/src/ui/page-leader-tray.ts
git add packages/webapp/src/ui/page-leader-tray.ts
git commit -m "feat(preview): wire preview.request + preview.revoked handlers on standalone controller WS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Wire `preview.request` listener into `extension-leader-tray.ts` (extension)

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts`

Same mechanism as Task 10, but in the offscreen leader. Look for the existing webhook handler in `extension-leader-tray.ts` for the precedent (search `webhook.event`).

- [ ] **Step 1: Add BOTH the `preview.request` AND the `preview.revoked` dispatch** alongside the webhook handler. Imports + same bodies as Task 10 (the revoked branch is log-only in Phase 1).

- [ ] **Step 2: Typecheck.**

- [ ] **Step 3: Build extension to confirm:**

```
npm run build -w @slicc/chrome-extension
```

- [ ] **Step 4: Format + commit**

```
npx prettier --write packages/chrome-extension/src/extension-leader-tray.ts
git add packages/chrome-extension/src/extension-leader-tray.ts
git commit -m "feat(preview): wire preview.request handler on extension offscreen controller WS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: `LeaderSyncManager.broadcastPreviewOpen(url)` + `currentLeaderSync` getter

**Files:**

- Modify: `packages/webapp/src/scoops/tray-leader-sync.ts` (add `broadcastPreviewOpen`)
- Modify: `packages/webapp/src/ui/page-leader-tray.ts` (add `currentLeaderSync` getter)
- Test: `packages/webapp/tests/scoops/tray-leader-sync-preview-open.test.ts`

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { LeaderSyncManager } from '../../src/scoops/tray-leader-sync.js';

describe('LeaderSyncManager.broadcastPreviewOpen', () => {
  it('broadcasts a preview.open envelope to every connected follower', async () => {
    /* Construct a LeaderSyncManager with two fake follower channels
       (look at existing LeaderSyncManager tests for the test harness pattern —
       there are several broadcast* method tests already). Then call
       sync.broadcastPreviewOpen('https://t.preview.sliccy.ai/index.html') and
       assert both followers received { type: 'preview.open', url: 'https://...' } */
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 2b: Extend `LeaderToFollowerMessage` union** in `packages/webapp/src/scoops/tray-sync-protocol.ts` — find the existing union (`tab.open` etc., around `:46`) and add:

```ts
| { type: 'preview.open'; requestId: string; url: string }
```

`requestId` matches the existing `tab.open`/`tab.opened` request/reply convention (iOS test in Task 18 expects it on the wire even though Phase 1 doesn't ack).

- [ ] **Step 3: Implement `broadcastPreviewOpen` in `tray-leader-sync.ts`** — use the existing private `broadcastToAllFollowers` API (`:357`) instead of iterating `this.followers` directly. Mirror `broadcastEvent` / `broadcastSprinkleUpdate` patterns:

```ts
/**
 * Tell every connected follower to open the worker-served preview URL.
 * Phase 1: fire-and-forget; followers don't ack (no preview.opened reply).
 */
broadcastPreviewOpen(url: string): void {
  const requestId = `prv-${crypto.randomUUID()}`;
  this.broadcastToAllFollowers({ type: 'preview.open', requestId, url });
}
```

- [ ] **Step 4: Add `currentLeaderSync` getter to `page-leader-tray.ts`** — port from federated branch. It exposes the live `LeaderSyncManager` instance the manager currently holds, or `null` if disconnected. Mirror the federated implementation pattern: the page tray-manager closure already has a `currentSync: LeaderSyncManager | null` private; expose it as a getter.

- [ ] **Step 5: Run, confirm test PASSES.**

- [ ] **Step 6: Format + commit**

```
npx prettier --write packages/webapp/src/scoops/tray-sync-protocol.ts packages/webapp/src/scoops/tray-leader-sync.ts packages/webapp/src/ui/page-leader-tray.ts packages/webapp/tests/scoops/tray-leader-sync-preview-open.test.ts
git add packages/webapp/
git commit -m "feat(preview): LeaderSyncManager.broadcastPreviewOpen + currentLeaderSync getter

Ports from worktree-federated-preview @ f950bd7f.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12b: Follower-side `preview.open` dispatch

**Files:**

- Modify: `packages/webapp/src/scoops/tray-follower-sync.ts` (add `case 'preview.open':` arm)
- Test: `packages/webapp/tests/scoops/tray-follower-sync-preview-open.test.ts`

Without this task, mint + broadcast succeed but standalone/extension/electron followers never **open** the preview tab (only iOS gets it via Task 18; the TS follower path is silent). The existing `tab.open` case at `tray-follower-sync.ts:617` is the template — both messages do "create a tab pointing at this URL" semantically. Reuse `executeLocalTabOpen` rather than duplicating its body.

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { FollowerSyncManager } from '../../src/scoops/tray-follower-sync.js';

describe('FollowerSyncManager preview.open dispatch', () => {
  it('opens a tab at the URL via executeLocalTabOpen', async () => {
    /* Read the existing tab.open test for the harness. Construct a
       FollowerSyncManager with a stub browserAPI; deliver a fake
       { type: 'preview.open', requestId: 'r1', url: 'https://t.x.preview.sliccy.ai/' }
       message via the same channel mechanism the tab.open test uses; assert
       browserAPI.createPage was called with that URL (matching the existing
       executeLocalTabOpen behavior — background:true on extension, etc.). */
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Add the dispatch case** in `packages/webapp/src/scoops/tray-follower-sync.ts` — find the existing `case 'tab.open':` at `:617`:

```ts
case 'tab.open': {
  this.executeLocalTabOpen(message.requestId, message.url);
  break;
}
// ADD THIS RIGHT AFTER:
case 'preview.open': {
  // Same semantics as tab.open: open the URL in a new tab. The preview-vs-tab
  // distinction is purely informational here (it lets us add preview-specific
  // semantics in Phase 2 if needed without re-routing through tab.open).
  this.executeLocalTabOpen(message.requestId, message.url);
  break;
}
```

(No new `executePreviewOpen` method needed — `executeLocalTabOpen` already does exactly what we need: `chrome.tabs.create` in extension, `browserAPI.createPage` in standalone, `window.open` fallback. If Phase 2 needs preview-specific tab semantics we can introduce a separate method then.)

- [ ] **Step 4: Run, confirm PASS.**

- [ ] **Step 5: Format + commit**

```
npx prettier --write packages/webapp/src/scoops/tray-follower-sync.ts packages/webapp/tests/scoops/tray-follower-sync-preview-open.test.ts
git add packages/webapp/
git commit -m "feat(preview): follower-side preview.open dispatch (reuses executeLocalTabOpen)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: `setPreviewMinter` module-level hook (mirror `setCherryEmitter`)

**Files:**

- Create: `packages/webapp/src/scoops/preview-minter.ts`
- Test: `packages/webapp/tests/scoops/preview-minter.test.ts`
- Modify: `packages/chrome-extension/src/extension-leader-tray.ts` (register the minter on leader-tray startup; clear on stop)

This is the extension-offscreen-agent path — the agent's kernel-worker shell calls `getPreviewMinter()?.(...)` to mint in-realm without a panel-RPC round-trip. Mirrors `setCherryEmitter` precedent at `cherry-emit-command.ts:42`.

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPreviewMinter,
  getPreviewMinter,
  type PreviewMinter,
} from '../../src/scoops/preview-minter.js';

beforeEach(() => setPreviewMinter(null));

describe('preview-minter hook', () => {
  it('returns null when no minter is registered', () => {
    expect(getPreviewMinter()).toBeNull();
  });

  it('returns the registered minter', () => {
    const minter: PreviewMinter = async (opts) => ({ url: 'x', pushed: 0 });
    setPreviewMinter(minter);
    expect(getPreviewMinter()).toBe(minter);
  });

  it('clears on null', () => {
    setPreviewMinter(async () => ({ url: 'x', pushed: 0 }));
    setPreviewMinter(null);
    expect(getPreviewMinter()).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** at `packages/webapp/src/scoops/preview-minter.ts`:

```ts
/**
 * Module-level hook for the extension offscreen agent path to mint previews
 * in-realm. Mirrors `setCherryEmitter` precedent at
 * `packages/webapp/src/shell/supplemental-commands/cherry-emit-command.ts:42`.
 *
 * The offscreen `extension-leader-tray.ts` calls `setPreviewMinter(...)` during
 * `startExtensionLeaderTray()` and `setPreviewMinter(null)` on stop. The
 * `serve` shell command (running inside the offscreen kernel worker) calls
 * `getPreviewMinter()?.(...)` as its primary mint path.
 *
 * Standalone (where `serve` lives in a different realm from `LeaderSyncManager`)
 * does NOT use this hook — it uses the `tray-open-preview` panel-RPC op
 * instead. See Task 14.
 */

export interface MintPreviewOpts {
  entryPath: string;
  servedRoot: string;
  allowLive: boolean;
}

export interface MintPreviewResult {
  url: string;
  pushed: number;
}

export type PreviewMinter = (opts: MintPreviewOpts) => Promise<MintPreviewResult>;

let directMinter: PreviewMinter | null = null;

export function setPreviewMinter(minter: PreviewMinter | null): void {
  directMinter = minter;
}

export function getPreviewMinter(): PreviewMinter | null {
  return directMinter;
}
```

- [ ] **Step 4: Register in `extension-leader-tray.ts`** — find where `setCherryEmitter` is called (line ~389) and add a parallel `setPreviewMinter(...)` call right next to it. The minter closure: mint via the worker mint API client (Task 15), then call `sync.broadcastPreviewOpen(url)` and return `{ url, pushed: sync.getConnectedFollowers().length }`. Likewise clear with `setPreviewMinter(null)` next to `setCherryEmitter(null)` at line ~493.

```ts
// near line 389:
setPreviewMinter(async ({ entryPath, servedRoot, allowLive }) => {
  const { url } = await mintPreviewViaWorker({
    workerBaseUrl: this.options.workerBaseUrl,
    trayId: this.options.trayId,
    controllerToken: this.options.controllerToken,
    servedRoot,
    entryPath,
    allowLive,
  });
  sync.broadcastPreviewOpen(url);
  return { url, pushed: sync.getConnectedFollowers().length };
});

// near line 493 (stop / cleanup):
setPreviewMinter(null);
```

(`mintPreviewViaWorker` lands in Task 15 — a placeholder import is fine here; the file won't compile until Task 15 lands, so commit those together or stub now and complete in Task 15.)

- [ ] **Step 5: Run, confirm 3 tests PASS:**

```
npm run test -w @slicc/webapp -- tests/scoops/preview-minter.test.ts
```

- [ ] **Step 6: Format + commit**

```
npx prettier --write packages/webapp/src/scoops/preview-minter.ts packages/webapp/tests/scoops/preview-minter.test.ts packages/chrome-extension/src/extension-leader-tray.ts
git add packages/webapp/ packages/chrome-extension/
git commit -m "feat(preview): setPreviewMinter hook (mirror setCherryEmitter) for extension agent path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 14: `tray-open-preview` panel-RPC op (standalone path)

**Files:**

- Modify: `packages/webapp/src/kernel/panel-rpc.ts` (add op type + result entry)
- Modify: `packages/webapp/src/ui/panel-rpc-handlers.ts` (implement standalone handler)
- Test: `packages/webapp/tests/ui/panel-rpc-handlers-tray-open-preview.test.ts`

- [ ] **Step 1: Add op to `panel-rpc.ts`** — find the existing `tray-reset` op (around line 137) and add a sibling:

```ts
| {
    // Mint a preview URL for the given entry under servedRoot, broadcast it
    // to followers, and return the URL + follower count. Standalone path
    // ONLY (extension agent uses setPreviewMinter direct hook, NOT this).
    // See spec § Extension float — tray-open-preview wiring (three contexts).
    op: 'tray-open-preview';
    payload: { entryPath: string; servedRoot: string; bridge: boolean; noBridge: boolean };
  }
```

And in `PanelRpcResults` (around line 268):

```ts
'tray-open-preview': { url: string; pushed: number };
```

- [ ] **Step 2: Implement the handler in `panel-rpc-handlers.ts`** — find where `tray-reset` is implemented and add a sibling case:

```ts
case 'tray-open-preview': {
  const sync = pageLeaderTray.currentLeaderSync;
  if (!sync) throw new Error('No active leader tray; cannot mint preview');
  const { url } = await mintPreviewViaWorker({
    workerBaseUrl: trayConfig.workerBaseUrl,
    trayId: trayConfig.trayId,
    controllerToken: trayConfig.controllerToken,
    ...req.payload,
  });
  sync.broadcastPreviewOpen(url);
  return { url, pushed: sync.getConnectedFollowers().length };
}
```

- [ ] **Step 3: Write a test** that drives the panel-RPC handler with a stub `currentLeaderSync` and `mintPreviewViaWorker` and asserts the URL is broadcast + returned. Mirror existing `panel-rpc-handlers.test.ts` patterns.

- [ ] **Step 4: Run, confirm PASS.** Typecheck.

- [ ] **Step 5: Format + commit**

```
npx prettier --write packages/webapp/src/kernel/panel-rpc.ts packages/webapp/src/ui/panel-rpc-handlers.ts packages/webapp/tests/ui/
git add packages/webapp/
git commit -m "feat(preview): tray-open-preview panel-RPC op (standalone path)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 15: `mintPreviewViaWorker` client helper

**Files:**

- Create: `packages/webapp/src/shell/supplemental-commands/preview-mint-client.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/preview-mint-client.test.ts`

A small fetch wrapper that hits the worker's mint API and parses the response.

- [ ] **Step 1: Write failing test** with a stubbed `fetch`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  mintPreviewViaWorker,
  revokePreviewViaWorker,
  listPreviewsViaWorker,
} from '../../../src/shell/supplemental-commands/preview-mint-client.js';

describe('mintPreviewViaWorker', () => {
  it('POSTs to /api/tray/:trayId/preview with controllerToken auth + body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ previewToken: 'abc.def', url: 'https://abc.def.preview.sliccy.ai/' }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    const result = await mintPreviewViaWorker(
      {
        workerBaseUrl: 'https://www.sliccy.ai',
        trayId: 'tray1',
        controllerToken: 'tray1.secret',
        servedRoot: '/workspace/dist',
        entryPath: '/workspace/dist/index.html',
        allowLive: false,
      },
      fetchMock
    );
    expect(result).toEqual({ previewToken: 'abc.def', url: 'https://abc.def.preview.sliccy.ai/' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.sliccy.ai/api/tray/tray1/preview',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer tray1.secret',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          servedRoot: '/workspace/dist',
          entryPath: '/workspace/dist/index.html',
          allowLive: false,
        }),
      })
    );
  });

  it('throws on non-200 with the status code in the message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(
      mintPreviewViaWorker(
        {
          workerBaseUrl: 'x',
          trayId: 'y',
          controllerToken: 'z',
          servedRoot: '/a',
          entryPath: '/a/i.html',
          allowLive: false,
        },
        fetchMock
      )
    ).rejects.toThrow(/403/);
  });
});

// Similar tests for revokePreviewViaWorker and listPreviewsViaWorker.
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** `preview-mint-client.ts`:

```ts
// NOTE: don't import PreviewRecord from @slicc/cloudflare-worker — webapp has no
// dependency on the worker package. Define the list-response item locally;
// the wire shape is small and we control both sides of the contract.

interface PreviewListItem {
  previewToken: string;
  url: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
  createdAt: string;
}

export interface MintArgs {
  workerBaseUrl: string;
  trayId: string;
  controllerToken: string;
  servedRoot: string;
  entryPath: string;
  allowLive: boolean;
}

export async function mintPreviewViaWorker(
  args: MintArgs,
  fetchImpl: typeof fetch = fetch
): Promise<{ previewToken: string; url: string }> {
  const url = `${args.workerBaseUrl}/api/tray/${encodeURIComponent(args.trayId)}/preview`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.controllerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      servedRoot: args.servedRoot,
      entryPath: args.entryPath,
      allowLive: args.allowLive,
    }),
  });
  if (!res.ok) throw new Error(`Preview mint failed: ${res.status}`);
  return res.json();
}

export async function revokePreviewViaWorker(
  args: { workerBaseUrl: string; trayId: string; controllerToken: string; previewToken: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ revoked: boolean }> {
  const url = `${args.workerBaseUrl}/api/tray/${encodeURIComponent(args.trayId)}/preview/stop`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.controllerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ previewToken: args.previewToken }),
  });
  if (!res.ok) throw new Error(`Preview revoke failed: ${res.status}`);
  return res.json();
}

export async function listPreviewsViaWorker(
  args: { workerBaseUrl: string; trayId: string; controllerToken: string },
  fetchImpl: typeof fetch = fetch
): Promise<{ previews: PreviewListItem[] }> {
  const url = `${args.workerBaseUrl}/api/tray/${encodeURIComponent(args.trayId)}/previews`;
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${args.controllerToken}` },
  });
  if (!res.ok) throw new Error(`Preview list failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 4: Run, confirm PASS.**

- [ ] **Step 5: Format + commit**

```
npx prettier --write packages/webapp/src/shell/supplemental-commands/preview-mint-client.ts packages/webapp/tests/shell/supplemental-commands/preview-mint-client.test.ts
git add packages/webapp/
git commit -m "feat(preview): mintPreviewViaWorker / revoke / list client helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 16: `serve` three-context decision + auto-enable tray + `--bridge`/`--stop`/`--list`/`--project`

**Depends on Task 15** (`mintPreviewViaWorker`) and **Task 19** (`requestTrayOpenPreview` from `leader-sync-bridge.ts`) at compile time. If executing strictly task-by-task, land Tasks 13 + 15 + 19 before this task's Step 4 — or treat 13/15/16/19 as a single coherent slice.

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/serve-command.ts`
- Test: `packages/webapp/tests/shell/supplemental-commands/serve-command-unified.test.ts`

This is the biggest leader-side change. The `serve` command now:

1. Parses flags: `--bridge` (opt-in user intent), `--no-bridge` (force-off override), `--stop <token>` (revoke), `--list` (list active previews), `--project` (no-op alias — prints obsolete warning and ignores).
2. On a normal serve: picks the active mint surface across **three** contexts (extension agent in-realm `getPreviewMinter()` → extension panel terminal `requestTrayOpenPreview()` envelope → standalone panel-RPC → otherwise fail). Auto-enables tray if no `LeaderSyncManager` is active.
3. Passes the raw `bridge` / `noBridge` intent flags through to the mint site (panel-RPC handler / envelope listener / in-realm minter) — the mint site computes `effectiveAllowLive` per Task 17, since the Cherry-follower check is leader-side state the worker can't see.
4. Mints (via the chosen surface), broadcasts `preview.open` to followers (handled inside the mint path), opens the leader's own tab at the worker URL, reports the URL.

This task is large. Break the implementation into sub-steps but commit at the end.

- [ ] **Step 1: Read the existing `serve-command.ts`** to understand the current shape (Currently uses `toPreviewUrl` + `browserAPI.createPage`).

- [ ] **Step 2: Write tests** for the new behavior. Use stubbed `getPreviewMinter`, `getPanelRpcClient`, `leaveTray`, and `__slicc_setTrayRuntime` to exercise each path. Sample:

```ts
describe('serve unified', () => {
  it('uses the in-realm minter when getPreviewMinter() is set (extension agent path)', async () => {
    const mintCalls: any[] = [];
    setPreviewMinter(async (opts) => {
      mintCalls.push(opts);
      return { url: 'https://t.x.preview.sliccy.ai/', pushed: 1 };
    });
    const res = await runServe(['serve', '/workspace/dist']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('https://t.x.preview.sliccy.ai/');
    expect(mintCalls).toEqual([
      { entryPath: '/workspace/dist/index.html', servedRoot: '/workspace/dist', allowLive: false },
    ]);
  });

  it('falls back to panel-RPC when no in-realm minter (standalone path)', async () => {
    /* set getPanelRpcClient stub; assert panel-RPC `tray-open-preview` was called */
  });

  it('auto-enables tray when no LeaderSyncManager active (standalone via leaveTray)', async () => {
    /* stub leaveTray; on missing currentLeaderSync, expect it to be called with workerBaseUrl */
  });

  it('opt-in --bridge sets allowLive:true at mint', async () => {
    /* same as #1 but command line includes --bridge; assert mintCall.allowLive === true */
  });

  it('--stop <token> calls revokePreviewViaWorker', async () => {
    /* stub revoke client; assert it was called with the right args */
  });

  it('--list calls listPreviewsViaWorker and prints results', async () => {
    /* stub list client; assert stdout includes each URL */
  });

  it('--project prints obsolete warning to stderr and proceeds with mint (no-op alias)', async () => {
    /* run serve --project /workspace/dist; assert stderr includes "obsolete"; assert mint still happened */
  });

  it('extension panel terminal posts requestTrayOpenPreview envelope (has DOM, no panel-RPC, no in-realm minter)', async () => {
    /* stub isExtensionRuntime() → true; ensure no getPreviewMinter / getPanelRpcClient;
       stub requestTrayOpenPreview to capture its call; run serve and assert it was
       invoked with { entryPath, servedRoot, allowLive } */
  });

  it("opens the leader's own tab at the minted URL via browserAPI.createPage", async () => {
    setPreviewMinter(async () => ({ url: 'https://leader-tab.preview.sliccy.ai/', pushed: 0 }));
    const createPageMock = vi.fn().mockResolvedValue(undefined);
    const browserAPI = { createPage: createPageMock } as never;
    await runServe(['serve', '/workspace/dist'], { browserAPI });
    expect(createPageMock).toHaveBeenCalledWith('https://leader-tab.preview.sliccy.ai/');
  });

  it('falls back to window.open when no browserAPI is supplied', async () => {
    setPreviewMinter(async () => ({ url: 'https://x.y.preview.sliccy.ai/', pushed: 0 }));
    const openSpy = vi.fn().mockReturnValue(null); // null is fine — fire-and-forget
    vi.stubGlobal('window', { open: openSpy });
    await runServe(['serve', '/workspace/dist']);
    expect(openSpy).toHaveBeenCalledWith(
      'https://x.y.preview.sliccy.ai/',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
```

- [ ] **Step 3: Run, confirm FAIL.**

- [ ] **Step 4: Rewrite `serve-command.ts`** with the new logic:

```ts
// (Pseudocode shape — fill in by referring to the existing file's structure.)
import { getPreviewMinter, type MintPreviewResult } from '../../scoops/preview-minter.js';
import { getPanelRpcClient } from '../../kernel/panel-rpc.js';
import {
  mintPreviewViaWorker,
  revokePreviewViaWorker,
  listPreviewsViaWorker,
} from './preview-mint-client.js';
import { leaveTray, OFFSCREEN_SET_TRAY_RUNTIME_HOOK } from '../../scoops/tray-leave.js';
import { resolveTrayWorkerBaseUrl } from '../../scoops/tray-runtime-config.js';

export async function serveCommand(args: string[], context: ShellContext): Promise<ShellResult> {
  const flags = parseFlags(args); // see below for flag parsing

  if (flags.stop) {
    return await handleStop(flags.stop, context);
  }
  if (flags.list) {
    return await handleList(context);
  }

  if (flags.project) {
    context.stderr.write(
      '--project: obsolete; no longer needed (root-absolute paths work natively under unified preview)\n'
    );
    // Continue with mint anyway (no-op alias).
  }

  // Imports needed at the top of serve-command.ts:
  //   import { isExtensionRuntime } from './shared.js';                        // shared.ts:135
  //   import { requestTrayOpenPreview } from '@slicc/chrome-extension/leader-sync-bridge.js';
  //     // (or a webapp-side re-export — match the existing extension-only
  //     // import pattern, e.g. dynamic import guarded by isExtensionRuntime().)

  const { entryPath, servedRoot } = resolveEntry(flags.positional, context);
  // Raw INTENT flags — NOT pre-computed allowLive. The Cherry-follower check
  // is leader-side state the worker can't see, so each mint site computes
  // `effectiveAllowLive` itself (Task 17). serve-command's job is just to
  // forward the user's `--bridge` / `--no-bridge` intent unchanged.
  const bridge = !!flags.bridge;
  const noBridge = !!flags.noBridge;

  // Auto-enable tray if no active leader sync.
  if (!hasActiveLeaderSync(context)) {
    await autoEnableTray(context);
  }

  // Three-context mint — check from most-specific to most-generic:
  let result: MintPreviewResult;
  const inRealmMinter = getPreviewMinter();
  if (inRealmMinter) {
    // 1) Extension AGENT (offscreen kernel worker) — in-realm setPreviewMinter hook.
    result = await inRealmMinter({ entryPath, servedRoot, bridge, noBridge });
  } else if (isExtensionRuntime() && typeof window !== 'undefined') {
    // 2) Extension PANEL TERMINAL (side panel WasmShell — has DOM, no panel-RPC,
    //    no in-realm minter). Posts a chrome.runtime envelope to the offscreen
    //    via leader-sync-bridge.ts's `requestTrayOpenPreview` (mirrors the
    //    `requestLeaderTrayReset` precedent at leader-sync-bridge.ts:76,88,142,145).
    result = await requestTrayOpenPreview({ entryPath, servedRoot, bridge, noBridge });
  } else {
    // 3) Standalone kernel worker — panel-RPC into the page-side handler.
    const rpc = getPanelRpcClient();
    if (!rpc) {
      return errorResult(
        'serve: no leader tray available. Enable multi-browser sync via `host enable` or the avatar popover.'
      );
    }
    result = await rpc.call('tray-open-preview', { entryPath, servedRoot, bridge, noBridge });
  }

  // Open the leader's OWN tab at the worker URL (preserves today's `serve`
  // UX of seeing the preview immediately on the leader's browser; also pushes
  // to followers via the mint path). The leader-side open is independent of
  // the broadcast — both targets see the same URL.
  if (browserAPI) {
    await browserAPI.createPage(result.url);
  } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
    // window.open() returns null in extension offscreen/side-panel contexts even
    // when the tab opens — fire-and-forget, never treat null as failure.
    window.open(result.url, '_blank', 'noopener,noreferrer');
  }

  context.stdout.write(`Preview URL: ${result.url}\n`);
  context.stdout.write(`Pushed to ${result.pushed} follower${result.pushed === 1 ? '' : 's'}\n`);
  return { exitCode: 0 };
}

async function autoEnableTray(context: ShellContext): Promise<void> {
  const workerBaseUrl = resolveTrayWorkerBaseUrl();
  // In the extension offscreen, use the direct hook; elsewhere use leaveTray which routes via panel-RPC.
  const setRuntimeHook = (globalThis as any)[OFFSCREEN_SET_TRAY_RUNTIME_HOOK];
  if (typeof setRuntimeHook === 'function') {
    await setRuntimeHook(null, workerBaseUrl);
  } else {
    await leaveTray({ workerBaseUrl });
  }
}

function parseFlags(args: string[]) {
  // Parse --bridge (boolean), --stop <token>, --list (boolean), --project (boolean no-op),
  // and leftover positional (the directory to serve).
  /* see existing serve-command's flag parser for the style */
}
```

- [ ] **Step 5: Run, confirm tests PASS** (10 cases).

- [ ] **Step 6: Format + commit**

```
npx prettier --write packages/webapp/src/shell/supplemental-commands/serve-command.ts packages/webapp/tests/shell/supplemental-commands/serve-command-unified.test.ts
git add packages/webapp/
git commit -m "feat(preview): serve unified — three-context mint, auto-enable tray, --bridge/--stop/--list, --project no-op

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 17: Cherry default-on at mint time

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/serve-command.ts` (or the mint sites in panel-rpc-handlers / extension-leader-tray, depending on shape)

Per Decision #3: at mint time, if any connected follower advertises `CHERRY_RUNTIME_TAG`, upgrade `allowLive: true` unless the user passed `--no-bridge`.

- [ ] **Step 1: Add `--no-bridge` flag** to `serve-command.ts`'s parser (parallel to `--bridge`).

- [ ] **Step 2: At every mint site, inspect connected followers right before mint and compute `effectiveAllowLive`.** "Every mint site" is **three** places (matching the three contexts from Tasks 13-19):
  - **Standalone path** — `packages/webapp/src/ui/panel-rpc-handlers.ts` `tray-open-preview` handler (Task 14).
  - **Extension agent path** — `packages/chrome-extension/src/extension-leader-tray.ts` `setPreviewMinter` closure (Task 13).
  - **Extension panel terminal path** — `packages/chrome-extension/src/extension-leader-tray.ts` `chrome.runtime` envelope listener (Task 19).

`serve-command.ts` doesn't compute `effectiveAllowLive` itself — it just passes the raw `--bridge` / `--no-bridge` user intent through. The mint sites combine that with the follower runtime check:

```ts
import { CHERRY_RUNTIME_TAG } from '../scoops/tray-sync-protocol.js';

const hasCherryFollower = sync
  .getConnectedFollowers()
  .some((f) => f.runtime === CHERRY_RUNTIME_TAG);
const effectiveAllowLive = !payload.noBridge && (payload.bridge || hasCherryFollower);
```

Pass `effectiveAllowLive` into the `mintPreviewViaWorker` call's `allowLive` argument.

- [ ] **Step 3: Add a test** that with a Cherry follower connected, mint payload has `allowLive: true` even without `--bridge`; and with `--no-bridge`, `allowLive: false` regardless.

- [ ] **Step 4: Format + commit** — Cherry inspection lands at three mint sites across two packages, so the commit scope is webapp + chrome-extension:

```
npx prettier --write packages/webapp/src/ packages/chrome-extension/src/
git add packages/webapp/ packages/chrome-extension/
git commit -m "feat(preview): Cherry-tagged followers default --bridge:true at mint (override with --no-bridge)

Cherry inspection + effectiveAllowLive computation lands at the three
mint sites: panel-rpc-handlers.ts (standalone), extension-leader-tray.ts
setPreviewMinter closure (extension agent), and extension-leader-tray.ts
chrome.runtime envelope listener (extension panel terminal). Each
inspects its in-realm LeaderSyncManager.getConnectedFollowers() for
CHERRY_RUNTIME_TAG before calling mintPreviewViaWorker.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 18: iOS `preview.open` protocol case

**Files:**

- Modify: `packages/ios-app/SliccFollower/Models/SyncProtocol.swift`
- Modify: `packages/ios-app/SliccFollower/App/AppState.swift`
- Update: `packages/ios-app/CLAUDE.md` (note the new message)

This is the smallest task code-wise but follows the 5-step iOS protocol checklist.

- [ ] **Step 1: Add enum case to `SyncProtocol.swift`** — find the existing `case tabOpen(requestId: String, url: String)` at `:190` and add a parallel `case previewOpen(requestId: String, url: String)` right after it.

- [ ] **Step 2: Extend the `Codable` decode** — find the `switch type` block at `:267` and add a case for `"preview.open"`:

```swift
case "preview.open":
    self = .previewOpen(
        requestId: try container.decode(String.self, forKey: .requestId),
        url: try container.decode(String.self, forKey: .url)
    )
```

- [ ] **Step 3: Extend the dispatcher in `AppState.swift`** — find the `tabOpen` dispatch at `:683` and add a parallel case. Open the URL in the same WKWebView path. Mirror the `tabOpen` implementation exactly.

```swift
case let .previewOpen(_, url):
    // Open in WKWebView — same path as tabOpen.
    self.openInWebView(url)
```

- [ ] **Step 4: Update `packages/ios-app/CLAUDE.md`** — add `preview.open` to the supported-message-types list. Note it dispatches to a WKWebView same as `tab.open`.

- [ ] **Step 5: Commit. Swift build/test if a Swift toolchain is available locally; otherwise mark for CI.**

```
git add packages/ios-app/
git commit -m "feat(preview): iOS preview.open Swift case + dispatch to WKWebView

Mirrors tab.open path. Phase 1 of the unified-preview spec.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 19: `tray-open-preview` `chrome.runtime` envelope (extension panel terminal)

**Files:**

- Modify: `packages/chrome-extension/src/extension-leader-tray.ts` (add a listener for the envelope, mirroring `leader-tray-reset` at `~:423`)
- Modify: `packages/chrome-extension/src/messages.ts` (or wherever envelope types live) — add the envelope shape

This is the third extension context: side-panel terminal posts an envelope to the offscreen, offscreen replies. The side-panel terminal `serve` command uses this; the agent's offscreen-kernel-worker `serve` uses `setPreviewMinter` directly (Task 13).

- [ ] **Step 1: Add the envelope type** alongside `leader-tray-reset` in whatever messages file types those:

```ts
| { source: 'panel'; payload: { type: 'tray-open-preview'; requestId: string; entryPath: string; servedRoot: string; bridge: boolean; noBridge: boolean } }
| { source: 'offscreen'; payload: { type: 'tray-open-preview-response'; requestId: string; url: string; pushed: number } }
| { source: 'offscreen'; payload: { type: 'tray-open-preview-error'; requestId: string; error: string } }
```

Note the envelope carries **intent flags** (`bridge` / `noBridge`), not a precomputed `allowLive`. The envelope LISTENER in `extension-leader-tray.ts` runs the same Cherry-follower inspection + `effectiveAllowLive` computation as the other two mint sites per Task 17. The worker only ever sees the final `allowLive` on the mint API call.

- [ ] **Step 2: Add the listener** in `extension-leader-tray.ts` near `:423` (the leader-tray-reset listener) — on receiving `tray-open-preview` envelope, call `getPreviewMinter()?.(...)` (or mint directly via `mintPreviewViaWorker` + `sync.broadcastPreviewOpen`) and respond.

- [ ] **Step 3: Add the side-panel sender in `packages/chrome-extension/src/leader-sync-bridge.ts`** — this is the panel→offscreen bridge module that already hosts `leader-tray-reset`'s send-side. Add a `requestTrayOpenPreview(opts)` function that posts the envelope and awaits the reply (mirror the existing `requestLeaderTrayReset()` shape). The side-panel `serve` command (the panel-terminal shell, not the agent) calls this when running in extension panel context.

- [ ] **Step 4: Build extension**

```
npm run build -w @slicc/chrome-extension
```

- [ ] **Step 5: Format + commit**

```
npx prettier --write packages/chrome-extension/
git add packages/chrome-extension/
git commit -m "feat(preview): chrome.runtime envelope for tray-open-preview (extension panel terminal)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# PHASE 1b — Non-serve preview-consumer migration

These tasks can run in parallel with Phase 1. They prepare main for Phase 3 (deletion of `preview-sw.ts`) by removing every non-serve dependency on the local SW path.

## Task 20: `open` command — VFS read for VFS paths

**Files:**

- Modify: `packages/webapp/src/shell/supplemental-commands/open-command.ts` (lines 298 + 517 use `toPreviewUrl`)
- Test: extend `packages/webapp/tests/shell/supplemental-commands/open-command.test.ts`

`open <vfs-path>` today calls `toPreviewUrl(fullPath)` and opens the URL via the local SW. Under unified preview the SW is gone (eventually), so `open` should read the VFS directly and render inline.

- [ ] **Step 1: Write a test** that drives `open /workspace/dist/index.html` and asserts that the file is read from VFS and rendered as a srcdoc iframe (or whatever the local-render path becomes).

- [ ] **Step 2: Replace the `toPreviewUrl(fullPath)` calls** with a VFS read + srcdoc render for HTML, or a chat-image-attachment for images, etc.

- [ ] **Step 3: Run all tests; confirm pass.**

- [ ] **Step 4: Format + commit**

```
git commit -m "refactor(open): VFS read for VFS paths (Phase 1b migration off preview-sw)"
```

---

## Task 21: Dips — verify no `/preview/*` dependency

**Files:**

- Review only: `packages/webapp/src/ui/dip.ts`

- [ ] **Step 1: Grep dip.ts for any `/preview/` references:**

```
grep -n '/preview/' packages/webapp/src/ui/dip.ts
```

- [ ] **Step 2: If references exist**, replace them with `readShtmlFromVFS`-style direct VFS reads. (Per the spec, dips today are rendered inline as srcdoc and shouldn't depend on the SW; verify this and fix any remaining bits.)

- [ ] **Step 3: If no references**, this is a no-op task — just document in the commit. Move on.

- [ ] **Step 4: Format + commit if anything changed.**

---

## Task 22: `docs/pitfalls.md` tab-hygiene update

**Files:**

- Modify: `docs/pitfalls.md` (the "Exclude /preview/ URLs" rule at `:636-639`)

- [ ] **Step 1: Update the exclude rule** to include `*.preview.<env>.sliccy.ai` URLs alongside (or instead of, post-Phase-3) `/preview/`:

```md
| **Exclude preview URLs** | Preview tabs (served by the worker on `*.preview.<env>.sliccy.ai`, or by the local SW at `/preview/*` pre-Phase-3) must not be identified as the SLICC app tab. |

**Code**: BrowserAPI excludes preview URLs when searching for the app tab.
```

- [ ] **Step 2: Update the `BrowserAPI` app-tab filter** in `packages/webapp/src/cdp/` (wherever the `/preview/` exclude lives) to also match `<env>.preview.sliccy.ai`-shaped URLs. Add a single helper:

```ts
function isPreviewUrl(url: string): boolean {
  if (url.includes('/preview/')) return true;
  try {
    const host = new URL(url).host;
    return /^[^.]+\.[^.]+\.preview\.(staging\.)?sliccy\.ai$/i.test(host);
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Add a unit test** for `isPreviewUrl` covering both URL forms.

- [ ] **Step 4: Format + commit.**

---

## Task 23: `preview-serve.test.ts` e2e replacement

**Files:**

- Modify (or replace): `packages/webapp/tests/e2e/preview-serve.test.ts`

The existing e2e assumes the local SW. Replace with a worker-driven e2e (Miniflare stub variant — cheaper than staging deploy).

- [ ] **Step 1: Read the current test** to understand what it asserts (serving an asset, navigation, etc.).

- [ ] **Step 2: Rewrite** to spin up a Miniflare-stub worker that mounts the unified preview handler, drives the same scenarios against `<token>.preview.local` (or similar).

- [ ] **Step 3: Run, confirm pass.** Document the e2e in the commit message.

- [ ] **Step 4: Format + commit.**

---

## Task 24: `--project` reference scrub across docs/skills/examples

**Files:**

- Modify: many — wherever `--project` is referenced

- [ ] **Step 1: Find all references:**

```
rg -l -- '--project' packages/ docs/
```

- [ ] **Step 2: For each non-source file** (docs, skills, examples) — remove or update the reference. Add a one-line note that the flag is now obsolete (where appropriate). Source code keeps the no-op alias from Task 16.

- [ ] **Step 3: Format + commit.**

---

## Task 25: Documentation updates

**Files:**

- Modify: `docs/shell-reference.md`, `README.md`, `docs/architecture.md`, `docs/urls.md`, `docs/adding-features.md`, `packages/webapp/CLAUDE.md`, `packages/chrome-extension/CLAUDE.md`, `packages/cloudflare-worker/CLAUDE.md`, `packages/ios-app/CLAUDE.md`, root `CLAUDE.md`

Per the spec § Documentation updates. Each file gets its own commit so the diffs stay reviewable.

- [ ] **Step 1: `docs/shell-reference.md`** — rewrite `serve`/`preview`/`open` sections for the worker URL model; document `--bridge`, `--stop`, `--list`; mark `--project` obsolete.

- [ ] **Step 2: `README.md`** — note that previews are served from `sliccy.ai` subdomains and that `serve` auto-enables multi-browser sync on first use.

- [ ] **Step 3: `docs/architecture.md`** — replace the federated-preview tray-addendum with the unified mechanism; per-environment matrix; iOS row updated for `preview.open`.

- [ ] **Step 4: `docs/urls.md`** — add `*.preview.sliccy.ai` (prod) + `*.preview.staging.sliccy.ai` (staging).

- [ ] **Step 5: `docs/adding-features.md`** — if it references the preview SW build, retarget at the worker preview handler.

- [ ] **Step 6: `packages/cloudflare-worker/CLAUDE.md`** — new wildcard route, mint/revoke/list API, preview WS messages, DO `PreviewRecord` schema.

- [ ] **Step 7: `packages/webapp/CLAUDE.md`** — Tray Sync section updated; note that preview-sw is being phased out (Phase 3); document `preview-request-handler.ts`, `preview-security.ts`, `preview-minter.ts`, `mintPreviewViaWorker`.

- [ ] **Step 8: `packages/chrome-extension/CLAUDE.md`** — note the offscreen three-context wiring (`setPreviewMinter` in-realm + `chrome.runtime` envelope + panel-RPC dispatch from standalone).

- [ ] **Step 9: `packages/ios-app/CLAUDE.md`** — note `preview.open` is now part of the iOS-handled subset; update the protocol matrix.

- [ ] **Step 10: root `CLAUDE.md`** — small reference to the unified preview if the navigation hub mentions preview-sw.

- [ ] **Step 11: Format + commit** (one commit per file, or one omnibus commit — either works).

---

# Verification (post-Phase-1 / Phase-1b)

## Task 26: Full verification pass

- [ ] **Step 1: Full lint (CI-equivalent — biome + prettier + docs/skills):**

```
npm run lint:ci
```

(CI runs `biome check . && prettier --check . && lint:docs && lint:skills --strict`. The simpler `prettier --check` only catches formatting; biome catches a broader class of issues. Use `npm run lint` to auto-fix biome + prettier locally if needed.)

- [ ] **Step 2: Typecheck:**

```
npm run typecheck
```

- [ ] **Step 3: All tests + coverage (CI-equivalent):**

```
npm run test
npm run test:coverage
```

Worker coverage must remain 75/85/65. Webapp + chrome-extension coverage above their floors.

- [ ] **Step 4: Build everything that ships:**

```
npm run build -w @slicc/webapp
npm run build -w @slicc/chrome-extension
npm run build -w @slicc/cloudflare-worker
cd packages/cloudflare-worker && npx wrangler deploy --dry-run --env=staging
cd packages/cloudflare-worker && npx wrangler deploy --dry-run
```

- [ ] **Step 5: Manual checklist** (per spec § Manual (post-implementation)) — list these in the PR description for a reviewer to run live:

1. Multi-asset SPA with `<script src="./app.js">`, `<link rel="stylesheet" href="/styles.css">` (root-absolute), `import('./chunks/lazy.js')` — all three load on every follower type.
2. Cherry-host harness opens preview URL in an iframe (Phase 2 once bridge ships — note "static-render only" for Phase 1 manual check).
3. iOS follower receives `preview.open`, opens URL in WKWebView, renders multi-asset SPA.
4. Reload the leader page mid-preview; new requests resume after auto-recover.
5. Tray expiry: wait past `TRAY_RECLAIM_TTL_MS`; subsequent request returns "session ended" page.
6. Security: from a served page, `fetch('/workspace/.git/github-token')` → 403; the leader is never asked.
7. Concurrent serves: open two `serve`s under different roots; verify origin isolation (cross-preview fetch denied).
8. Mounted VFS: `serve` a directory under a local FS-Access mount AND an S3/R2 mount; verify both render.
9. Shareable: copy URL to a different browser (no SLICC running) — bytes render (bridge: Phase 2).
10. `serve --stop`: revoke an active token; existing tabs see 404 on next asset; new tabs see session-ended.
11. Auto-enable failure: force the offscreen `activeHandle.leader.start()` to reject; verify `serve` surfaces an error.

- [ ] **Step 6: Final commit if any fixups were needed** during verification.

---

# Self-review notes (author)

**Spec coverage (27 tasks total — Task 12b added after second plan review):**

- Worker preview handler, DO mint/revoke/list (incl. `listPreviews()` method), WS protocol extensions (both directions: `preview.request`/`preview.revoked` worker→leader, `preview.response` leader→worker), wildcard routes: Tasks 2-7.
- Shared-ts URL helper + worker dependency on `@slicc/shared-ts`: Task 1 (incl. Step 4b which adds the package.json dep).
- Leader-side security gate + handler + dispatch wiring (incl. `preview.revoked` log-only branch): Tasks 8-11.
- `LeaderToFollowerMessage.preview.open { requestId, url }` + `LeaderSyncManager.broadcastPreviewOpen` via the existing `broadcastToAllFollowers` API: Task 12.
- **Follower-side `preview.open` dispatch** (reuses `executeLocalTabOpen` from the existing `tab.open` template at `:617`): **Task 12b** (added in second plan review).
- `tray-open-preview` three-context wiring (standalone panel-RPC / extension agent in-realm `setPreviewMinter` / extension panel terminal `chrome.runtime` envelope via `leader-sync-bridge.ts`): Tasks 13-15, 19.
- `currentLeaderSync` + extension `leader-sync-bridge.ts` sender: Tasks 12, 19.
- `serve` unified command — auto-enable tray, three contexts, `--bridge`/`--stop`/`--list`/`--project`, **leader-tab open via `browserAPI.createPage` / `window.open` after mint** (preserves today's UX): Tasks 16-17.
- Cherry default-on at **every mint site** (panel-RPC handler + extension agent minter + extension envelope listener — three places, not just `serve-command.ts`): Task 17.
- iOS `preview.open`: Task 18.
- Phase 1b consumer migration: Tasks 20-23.
- `--project` scrub + docs: Tasks 24-25.
- Full lint (`npm run lint:ci` = biome + prettier + docs + skills, not just prettier --check): Task 26.

**Type consistency** — names used across tasks:

- `PreviewRecord { previewToken, trayId, servedRoot, entryPath, allowLive, createdAt }` (Task 3 → Tasks 4, 6, 15). `TrayRecord.previews?: Record<string, PreviewRecord>` added to the existing tray type (Task 3 Step 1).
- `preview.request { reqId, servedRoot, vfsPath, asText }` (Tasks 3, 9).
- `preview.response { reqId, ok, mime?, chunkIndex, totalChunks, content, encoding } | { reqId, ok:false, status, reason? }` (Tasks 3, 6, 9).
- `preview.revoked { previewToken }` (Tasks 3, 4, 10/11).
- `preview.open { requestId: string; url: string }` (TS protocol union + Swift; Tasks 12, 12b, 18). `requestId` is on the wire even though Phase 1 doesn't ack — matches the `tab.open`/`tab.opened` convention iOS already follows.
- `setPreviewMinter` / `getPreviewMinter` / `PreviewMinter` (Tasks 13, 16, 17).
- `isPathWithinServedRoot(vfsPath, servedRoot)` (Tasks 8, 9).
- `mintPreviewViaWorker` / `revokePreviewViaWorker` / `listPreviewsViaWorker` (Tasks 15, 16). `PreviewListItem` defined locally in `preview-mint-client.ts` (webapp has no dependency on the worker package; the wire shape is small and we control both sides).
- `previewBaseHost` / `buildPreviewUrl` from `@slicc/shared-ts/preview-url` (Tasks 1, 4, 12). Worker pulls them in via the new `@slicc/shared-ts` dependency added in Task 1 Step 4b.
- `previewTokenFromHost` from `cloudflare-worker/preview-host` (Tasks 2, 6).

**Placeholder scan:**

- One genuine deferred-decision (the `attachFakeLeader` harness pattern in Task 6's test) is flagged as "see existing webhook tests for the harness pattern" — the engineer should read the existing test infrastructure before implementing. Not a placeholder for design; a placeholder for "look at existing code first." Acceptable.
- Manual verification checklist names specific scenarios but doesn't show automated test code — by design (those are live integration tests). Acceptable.

**Honest residual risks** the engineer should be aware of:

- The DO `pendingPreviews` Map (Task 6) needs careful cleanup on tray expiry / leader disconnect to avoid stale entries holding promises forever.
- The `--project` no-op alias has to NOT break any existing scripts that rely on `--project` silently. Test that `serve --project /dir` works identically to `serve /dir`.
- The staging dual-zone binding (pre-Phase-1 prerequisite #2) is not under the engineer's control — if infra hasn't landed it, Phase 1 staging tests will fail without that being a code issue.
