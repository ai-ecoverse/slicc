# Sync FS in browser realms — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make synchronous fs APIs (`readFileSync`/`writeFileSync`/`existsSync`/…)
in the kernel-worker JS realm robust and unbounded by backing them with a
synchronous XHR that the controlling Service Worker answers from the calling
realm's own `ctx.fs`, while keeping the bounded in-memory snapshot as a
zero-cost fast path.

**Architecture:** A realm's sync fs call, on a cache miss / over-cap /
after-write, issues a **synchronous same-origin XHR** to a dedicated
`/__slicc/fs-sync/*` route. The controlling SW's fetch listener `respondWith`s
a promise that round-trips over a `slicc-sync-fs` BroadcastChannel to a
responder **running in the kernel worker** (co-located with the token registry
and `ctx.fs`). The responder resolves an unguessable **per-realm capability
token** → that realm's `{ fs, cwd }` and runs the same `ctx.fs` ops the async
path uses, so `RestrictedFS` + sudo-fs enforcement and errno fidelity are
preserved. No `SharedArrayBuffer`, no COOP/COEP, no header changes. Because the
responder lives in the kernel worker (the VFS owner, a different thread from
the blocked realm worker), there is no deadlock and the §5b page hop is
eliminated.

**Tech Stack:** TypeScript (webapp browser bundle), Vitest (`environment: node`,
`fake-indexeddb/auto`), Service Worker + BroadcastChannel, synchronous
`XMLHttpRequest` (`responseType='arraybuffer'`), the existing realm RPC /
`realm-host` / `SyncFsCache` machinery.

## Global Constraints

- **Dual-mode:** every layer MUST work in BOTH standalone (kernel worker on the
  page) AND the extension hosted-leader tab (kernel worker in the hosted
  `sliccy.ai` tab). Followers run no realms — out of scope.
- **ACL is load-bearing:** sync reads/writes MUST resolve to the CALLING realm's
  `ctx.fs` (`RestrictedFS` + sudo-fs), never the global VFS / preview reader.
  This is unvalidated by the spec's §5b (which ran in the cone) — it is a
  phase-1 acceptance gate, not a follow-up.
- **Fail closed:** any bridge error (no SW control, broker unavailable/timeout,
  unknown/expired token) surfaces a POSIX errno to the realm — never a hung
  realm worker and never a silent wrong/stale answer.
- **POSIX errno fidelity:** thrown `Error`s carry `.code` (`ENOENT`/`EACCES`/
  `EISDIR`/`ENOTDIR`/`ENOSYNC`) so ported Node code's `catch (e) { e.code }`
  works; the errno crosses the HTTP boundary via an `x-slicc-fs-errno` header.
- **#1488:** land new code as its own modules; do NOT grow the already-flagged
  2,128-line `js-realm-shared.ts` beyond the minimal shim wiring.
- **No COOP/COEP / no SAB.** SAB stays a documented future perf lever only.
- **Route is same-origin:** `llm-proxy-sw.ts:156` returns without `respondWith`
  for same-origin fetches, so the sync-fs route needs its OWN respondWith'ing
  fetch listener — it does not come for free from the `/`-scoped controller.

Spec: `docs/superpowers/specs/2026-07-15-sync-fs-browser-realm-design.md`.

---

## Binding corrections from external review (READ FIRST)

An external review (cursor/composer, verified against code) found gaps the
tasks below must honor. These are **binding** and override any conflicting
detail in the individual tasks:

1. **Token MUST be threaded into the realm child worker (blocker).** Minting
   in `attachRealmHost` is not enough — the realm runs in a **child**
   `DedicatedWorker` that never sees `RealmHostHandle`. Wiring (do this as part
   of Task 1, verify in Task 6):
   - Add `syncFsToken?: string` to `RealmInitMsg` (`realm-types.ts`).
   - In `realm-runner.ts`, `attachRealmHost` is called (around line 188)
     **before** the `init` object is built + posted (around lines 286–300);
     set `init.syncFsToken = host.syncFsToken` there.
   - `runJsRealm(init, port)` (`js-realm-shared.ts:143`) reads
     `init.syncFsToken` and builds the bridge from it (Task 6).
2. **Gate the bridge on SW control — never mint-and-hope (blocker, fail-closed).**
   A token without a controlling SW makes the sync XHR miss the SW and hit the
   network → hang / SPA-404. `navigator.serviceWorker` is not available in the
   realm/kernel worker, so the **page** decides: after
   `setup-sw-registration.ts` confirms control (its existing `controllerchange`
   wait), it passes `syncFsBridgeEnabled: true` to the kernel host at boot;
   `attachRealmHost` sets `init.syncFsToken` **only when enabled**. When
   disabled (node/in-process tests, boot-before-control), `init.syncFsToken` is
   `undefined` → no bridge → today's snapshot/`ENOSYNC` behavior (this is also
   why the existing in-process test realm keeps working untouched). In
   addition, `sync-fs-bridge.ts` (Task 5) MUST set a bounded `xhr.timeout` and
   map timeout/network error → `EIO` with `.code`, so even a stray misfire
   fails closed fast instead of hanging the realm worker.
   _Boot-chain plumbing:_ thread `syncFsBridgeEnabled` from the page into the
   kernel worker following the **existing kernel-init precedent** — the same
   `main.ts` → `spawn.ts` → `KernelWorkerInitMsg` path that already carries
   fields like `localApiBaseUrl` (grep `KernelWorkerInitMsg` / `localApiBaseUrl`
   for the wiring to copy); the kernel host then hands it to `attachRealmHost`.
   Do not invent a new transport.
3. **Phase-1 bridge is READ + WRITE only (resolves the undefined-wire gap).**
   The HTTP wire is defined only for raw-byte read (GET) and write (POST body).
   `existsSync`/`statSync`/`readdirSync`/`mkdirSync`/`rmSync`/`renameSync` stay
   **cache/snapshot-backed** in phase-1 — they already work for existing files
   (incl. over-cap `truncated` entries, which keep `exists`/`stat` correct) and
   need no content. `sync-fs-dispatch.ts` still implements all ops (for the
   responder + a future phase-2 JSON wire), but the **shim + `SyncFsXhrBridge`
   route only `read`/`write` through the bridge**. Document metadata-over-bridge
   (`?op=stat|readdir` + JSON) as an explicit phase-2 extension.
4. **Read fallback triggers on ENOENT _and_ ENOSYNC (Task 6).**
   `SyncFsCache.readFile` throws `ENOENT` for an absent snapshot entry
   (`sync-fs-cache.ts:253`) and `ENOSYNC` for over-cap (`:256`). Both, when a
   bridge is present, route to the bridge (a file created after the snapshot or
   over the cap must be readable). With no bridge, keep throwing as today.
   Write-through: `bridge.writeFile` + `syncFs.invalidate(path)` and do NOT also
   record a cache mutation that `flushSyncFsCache` would re-apply.
5. **Carry preview's ack + cold-start retry into Tasks 3/4.** Mirror
   `preview-vfs-responder.ts` (post an ack before the async dispatch) and
   `preview-sw-handler.ts` (re-post until ack or a bounded window), not just a
   single timeout — a first sync XHR that beats the responder's listener would
   otherwise stall for the full timeout.
6. **Tests: bridge integration/acceptance MUST use the real `DedicatedWorker`
   realm factory, NOT `createInProcessJsRealmFactory`.** The in-process factory
   runs `runJsRealm` on the kernel thread; a synchronous XHR + same-thread
   BroadcastChannel responder there **deadlocks**. In-process tests keep the
   bridge disabled (per correction 2) and exercise only the snapshot path.
7. **`dispatchSyncFs` does not bound the sudo broker wait** — the SW handler's
   timeout (Task 4) is the only bound, which is what produces the fail-closed
   `EACCES` on a hung/absent broker (Task 8). Document this explicitly.

---

## File Structure

**New modules**

- `packages/webapp/src/kernel/realm/sync-fs-token-registry.ts` — mint / resolve
  / revoke unguessable per-realm capability tokens → `{ fs, cwd }`.
- `packages/webapp/src/kernel/realm/sync-fs-dispatch.ts` — token-scoped fs op
  executor (read/write/exists/stat/readdir/mkdir/rm/rename) + `FsError`→errno
  mapping. Pure, testable, no BroadcastChannel.
- `packages/webapp/src/kernel/realm/sync-fs-responder.ts` — kernel-worker
  BroadcastChannel (`slicc-sync-fs`) responder that calls `sync-fs-dispatch`.
- `packages/webapp/src/ui/sync-fs-sw-handler.ts` — pure SW handler:
  channel round-trip → `Response` with raw bytes / errno headers. Sibling of
  `preview-sw-handler.ts`.
- `packages/webapp/src/kernel/realm/sync-fs-bridge.ts` — realm-side sync-XHR
  client (`readViaBridge` / `writeViaBridge`), errno reconstruction.

**Modified**

- `packages/webapp/src/kernel/realm/realm-host.ts` — mint token in
  `attachRealmHost`, revoke in the handle `dispose()`; expose token to the
  realm boot.
- `packages/webapp/src/kernel/realm/js-realm-shared.ts` — thread the token into
  the realm; pass a bridge into `createSyncFsBridge`; miss/ENOSYNC → bridge;
  write-through + cache invalidation; retire the now-redundant flush/re-snapshot
  where safe (Task 7).
- `packages/webapp/src/kernel/realm/sync-fs-cache.ts` — add
  `invalidate(path)` / `invalidateAll()` used by write-through + coherence.
- `packages/webapp/src/ui/llm-proxy-sw.ts` (or `preview-sw.ts`) — add the
  `/__slicc/fs-sync/*` fetch listener that `respondWith`s.
- `packages/webapp/src/kernel/host.ts` (or the kernel-worker boot) — install the
  `sync-fs-responder` alongside the other kernel-host wiring.
- Docs: `packages/webapp/CLAUDE.md` (Kernel Host / realm section),
  `docs/shell-reference.md`, `packages/vfs-root/shared/CLAUDE.md` if agent-facing
  behavior changes, `docs/kernel/process-model.md` (sync-fs paragraph).

**Tests** mirror under `packages/webapp/tests/kernel/realm/` and
`packages/webapp/tests/ui/`.

---

## Task 1: Per-realm capability token registry

**Files:**

- Create: `packages/webapp/src/kernel/realm/sync-fs-token-registry.ts`
- Test: `packages/webapp/tests/kernel/realm/sync-fs-token-registry.test.ts`
- Modify: `packages/webapp/src/kernel/realm/realm-host.ts` (mint/revoke)

**Interfaces:**

- Produces:
  - `mintSyncFsToken(entry: SyncFsTokenEntry): string`
  - `resolveSyncFsToken(token: string): SyncFsTokenEntry | null`
  - `revokeSyncFsToken(token: string): void`
  - `interface SyncFsTokenEntry { fs: CommandContext['fs']; cwd: string }`
- Consumes: nothing (module-level `Map`, `crypto.randomUUID()`).

- [ ] **Step 1: Write the failing test**

```ts
// sync-fs-token-registry.test.ts
import {
  mintSyncFsToken,
  resolveSyncFsToken,
  revokeSyncFsToken,
} from '../../../src/kernel/realm/sync-fs-token-registry.js';

const fakeFs = {} as never;

test('mint → resolve returns the same entry; unknown token is null', () => {
  const token = mintSyncFsToken({ fs: fakeFs, cwd: '/scoops/x' });
  expect(token).toMatch(/[0-9a-f-]{36}/);
  expect(resolveSyncFsToken(token)).toEqual({ fs: fakeFs, cwd: '/scoops/x' });
  expect(resolveSyncFsToken('nope')).toBeNull();
});

test('revoke makes the token unresolvable (no reuse)', () => {
  const token = mintSyncFsToken({ fs: fakeFs, cwd: '/' });
  revokeSyncFsToken(token);
  expect(resolveSyncFsToken(token)).toBeNull();
});

test('two mints are distinct and isolated', () => {
  const a = mintSyncFsToken({ fs: fakeFs, cwd: '/a' });
  const b = mintSyncFsToken({ fs: fakeFs, cwd: '/b' });
  expect(a).not.toBe(b);
  expect(resolveSyncFsToken(a)?.cwd).toBe('/a');
  expect(resolveSyncFsToken(b)?.cwd).toBe('/b');
});
```

- [ ] **Step 2: Run it, expect module-not-found / undefined failure**

Run: `npx vitest run packages/webapp/tests/kernel/realm/sync-fs-token-registry.test.ts`
Expected: FAIL (cannot find module).

- [ ] **Step 3: Implement the registry**

```ts
// sync-fs-token-registry.ts
import type { CommandContext } from 'just-bash';

export interface SyncFsTokenEntry {
  fs: CommandContext['fs'];
  cwd: string;
}

const registry = new Map<string, SyncFsTokenEntry>();

/** Mint an unguessable token bound to a realm's fs handle + cwd. */
export function mintSyncFsToken(entry: SyncFsTokenEntry): string {
  const token = crypto.randomUUID();
  registry.set(token, entry);
  return token;
}

export function resolveSyncFsToken(token: string): SyncFsTokenEntry | null {
  return registry.get(token) ?? null;
}

/** Revoke on realm dispose so a dead realm's token can never be reused. */
export function revokeSyncFsToken(token: string): void {
  registry.delete(token);
}
```

- [ ] **Step 4: Run the test, expect PASS**

Run: `npx vitest run packages/webapp/tests/kernel/realm/sync-fs-token-registry.test.ts`

- [ ] **Step 5: Wire mint/revoke into `attachRealmHost`**

In `realm-host.ts` `attachRealmHost(port, ctx, opts)`: mint a token from
`{ fs: ctx.fs, cwd: ctx.cwd }` at the top, expose it on the returned handle
(`RealmHostHandle` gains `syncFsToken: string`), and call
`revokeSyncFsToken(token)` inside the existing `dispose()` (alongside the
existing `execSpawns` cleanup). Import the registry.

- [ ] **Step 5b: Thread the token into the realm child worker (binding
      correction 1 + 2)**

  - Add `syncFsToken?: string` to `RealmInitMsg` in `realm-types.ts`.
  - In `realm-runner.ts`, after `attachRealmHost` (around line 188) and where
    the `init: RealmInitMsg` is built + posted (around lines 286–300), set
    `init.syncFsToken = host.syncFsToken` **only when the SW-bridge is enabled**
    (a `syncFsBridgeEnabled` flag on the kernel host, set by the page once
    `setup-sw-registration.ts` confirms SW control). When disabled, leave
    `init.syncFsToken` undefined so the realm falls back to the snapshot.
  - Add a unit/integration assertion that `init.syncFsToken` is set when
    enabled and absent when disabled (in-process factory → always absent).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`

```bash
git add packages/webapp/src/kernel/realm/sync-fs-token-registry.ts \
        packages/webapp/tests/kernel/realm/sync-fs-token-registry.test.ts \
        packages/webapp/src/kernel/realm/realm-host.ts
git commit -m "feat(realm): per-realm sync-fs capability token registry"
```

---

## Task 2: Token-scoped fs dispatch + errno mapping

**Files:**

- Create: `packages/webapp/src/kernel/realm/sync-fs-dispatch.ts`
- Test: `packages/webapp/tests/kernel/realm/sync-fs-dispatch.test.ts`

**Interfaces:**

- Consumes: `resolveSyncFsToken` (Task 1); `FsError` (**`fs/types.ts`** —
  `export class FsError extends Error` at `types.ts:73`, `new FsError(code,
message, path)` with `.code`; it is NOT exported from `virtual-fs.ts`).
- Produces:
  - `type SyncFsOp = 'read' | 'write' | 'exists' | 'stat' | 'readdir' | 'mkdir' | 'rm' | 'rename'`
  - `interface SyncFsRequest { token: string; op: SyncFsOp; path: string; body?: Uint8Array; arg2?: string }`
  - `type SyncFsResult = { ok: true; bytes?: Uint8Array; json?: unknown } | { ok: false; errno: string; message: string }`
  - `async function dispatchSyncFs(req: SyncFsRequest): Promise<SyncFsResult>`

The op set mirrors `realm-host.ts` `dispatchVfs` but keyed by token → its
`ctx.fs`, resolving every path with `entry.fs.resolvePath(entry.cwd, path)`.

- [ ] **Step 1: Write the failing tests (incl. the ACL guard)**

```ts
// sync-fs-dispatch.test.ts
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { RestrictedFS } from '../../../src/fs/restricted-fs.js';
import { mintSyncFsToken } from '../../../src/kernel/realm/sync-fs-token-registry.js';
import { dispatchSyncFs } from '../../../src/kernel/realm/sync-fs-dispatch.js';

async function scopedToken(scope: string) {
  const vfs = await VirtualFS.create({ dbName: `t-${Math.random()}`, wipe: true });
  await vfs.mkdir('/scoops/x', { recursive: true });
  await vfs.writeFile('/scoops/x/in.txt', 'hi');
  await vfs.writeFile('/secret.txt', 'nope');
  const rfs = new RestrictedFS(vfs, { writablePaths: [scope], visiblePaths: [scope] });
  return mintSyncFsToken({ fs: rfs, cwd: scope });
}

test('read returns bytes for an in-scope path', async () => {
  const token = await scopedToken('/scoops/x');
  const r = await dispatchSyncFs({ token, op: 'read', path: 'in.txt' });
  expect(r.ok).toBe(true);
  expect(new TextDecoder().decode((r as { bytes: Uint8Array }).bytes)).toBe('hi');
});

test('ESCALATION GUARD: out-of-sandbox read is denied like the async path', async () => {
  const token = await scopedToken('/scoops/x');
  const r = await dispatchSyncFs({ token, op: 'read', path: '/secret.txt' });
  expect(r.ok).toBe(false);
  expect((r as { errno: string }).errno).toMatch(/EACCES|ENOENT/);
});

test('read-after-write is coherent through one token', async () => {
  const token = await scopedToken('/scoops/x');
  await dispatchSyncFs({
    token,
    op: 'write',
    path: 'out.txt',
    body: new TextEncoder().encode('X'),
  });
  const r = await dispatchSyncFs({ token, op: 'read', path: 'out.txt' });
  expect(new TextDecoder().decode((r as { bytes: Uint8Array }).bytes)).toBe('X');
});

test('unknown token → EACCES (fail closed)', async () => {
  const r = await dispatchSyncFs({ token: 'bogus', op: 'read', path: 'x' });
  expect(r.ok).toBe(false);
  expect((r as { errno: string }).errno).toBe('EACCES');
});
```

- [ ] **Step 2: Run, expect FAIL (module missing)**

Run: `npx vitest run packages/webapp/tests/kernel/realm/sync-fs-dispatch.test.ts`

- [ ] **Step 3: Implement dispatch**

```ts
// sync-fs-dispatch.ts
import { FsError } from '../../fs/types.js';
import { resolveSyncFsToken } from './sync-fs-token-registry.js';

export type SyncFsOp = 'read' | 'write' | 'exists' | 'stat' | 'readdir' | 'mkdir' | 'rm' | 'rename';

export interface SyncFsRequest {
  token: string;
  op: SyncFsOp;
  path: string;
  body?: Uint8Array;
  arg2?: string;
}
export type SyncFsResult =
  { ok: true; bytes?: Uint8Array; json?: unknown } | { ok: false; errno: string; message: string };

function errno(err: unknown): SyncFsResult {
  if (err instanceof FsError) return { ok: false, errno: err.code, message: err.message };
  return { ok: false, errno: 'EIO', message: err instanceof Error ? err.message : String(err) };
}

export async function dispatchSyncFs(req: SyncFsRequest): Promise<SyncFsResult> {
  const entry = resolveSyncFsToken(req.token);
  if (!entry) return { ok: false, errno: 'EACCES', message: 'sync-fs: unknown or revoked token' };
  const { fs, cwd } = entry;
  const p = fs.resolvePath(cwd, req.path);
  try {
    switch (req.op) {
      case 'read':
        return { ok: true, bytes: await fs.readFileBuffer(p) };
      case 'write':
        await fs.writeFile(p, req.body!);
        return { ok: true };
      case 'exists':
        return { ok: true, json: await fs.exists(p) };
      case 'stat': {
        const s = await fs.stat(p);
        return { ok: true, json: { isDirectory: s.isDirectory, isFile: s.isFile, size: s.size } };
      }
      case 'readdir':
        return { ok: true, json: await fs.readdir(p) };
      case 'mkdir':
        await fs.mkdir(p, { recursive: true });
        return { ok: true };
      case 'rm':
        await fs.rm(p, { recursive: true });
        return { ok: true };
      case 'rename': {
        // Mirror realm-host.ts dispatchVfs: production `ctx.fs` is often
        // createSudoFs(VfsAdapter), which exposes `mv`, not `rename`.
        const dest = fs.resolvePath(cwd, req.arg2!);
        const maybe = fs as { rename?: (a: string, b: string) => Promise<void> };
        if (maybe.rename) {
          await maybe.rename(p, dest);
        } else {
          const content = await fs.readFileBuffer(p);
          await fs.writeFile(dest, content);
          await fs.rm(p, { recursive: true });
        }
        return { ok: true };
      }
    }
  } catch (err) {
    return errno(err);
  }
}
```

- [ ] **Step 4: Run, expect PASS (all four, incl. the escalation guard)**

Run: `npx vitest run packages/webapp/tests/kernel/realm/sync-fs-dispatch.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/kernel/realm/sync-fs-dispatch.ts \
        packages/webapp/tests/kernel/realm/sync-fs-dispatch.test.ts
git commit -m "feat(realm): token-scoped sync-fs dispatch with FsError→errno mapping"
```

---

## Task 3: Kernel-worker sync-fs responder

**Files:**

- Create: `packages/webapp/src/kernel/realm/sync-fs-responder.ts`
- Test: `packages/webapp/tests/kernel/realm/sync-fs-responder.test.ts`
- Modify: kernel-worker boot (`packages/webapp/src/kernel/host.ts` or the
  kernel-worker entry) to `installSyncFsResponder()` once per kernel.

**Interfaces:**

- Consumes: `dispatchSyncFs` (Task 2); a `BroadcastChannel`-like transport.
- Produces:
  - wire request `{ type: 'sync-fs-req'; id: string } & SyncFsRequest`
  - wire response `{ type: 'sync-fs-res'; id: string } & SyncFsResult`
  - `installSyncFsResponder(channel?: SyncFsChannelLike): { dispose(): void }`
    (defaults to `new BroadcastChannel('slicc-sync-fs')`).

Mirror `preview-vfs-responder.ts`'s structure (channel-like subset, correlation
id, dispose). Binary `bytes` post as a `Uint8Array` (BroadcastChannel structured
clone handles it).

- [ ] **Step 1: Failing test with an in-memory channel fake**

```ts
// sync-fs-responder.test.ts — uses a paired in-memory channel (post to A → B hears)
test('responds to a sync-fs-req by dispatching + posting sync-fs-res', async () => {
  // arrange: mint an in-scope token (as in Task 2), install responder on chanB,
  // post {type:'sync-fs-req', id:'1', token, op:'read', path:'in.txt'} on chanA
  // assert: chanA receives {type:'sync-fs-res', id:'1', ok:true, bytes:<'hi'>}
});
test('malformed / non-sync-fs messages are ignored (no throw, no post)', () => {
  /* … */
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement the responder** (listen for `sync-fs-req`, call
      `dispatchSyncFs`, post `sync-fs-res` with the same `id`; ignore other
      messages; `dispose()` removes the listener). Model on
      `installPreviewVfsResponder`.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Install in the kernel-worker boot** (once, next to the other
      `createKernelHost` wiring), and add its `dispose` to the host's `dispose()`.

- [ ] **Step 6: Typecheck + commit**

```bash
git commit -am "feat(realm): kernel-worker sync-fs BroadcastChannel responder"
```

---

## Task 4: Service-worker route + handler

**Files:**

- Create: `packages/webapp/src/ui/sync-fs-sw-handler.ts`
- Test: `packages/webapp/tests/ui/sync-fs-sw-handler.test.ts`
- Modify: `packages/webapp/src/ui/llm-proxy-sw.ts` (add the fetch listener) —
  because `llm-proxy-sw.ts:156` returns for same-origin, the sync-fs listener
  must `respondWith` on its own.

**Interfaces:**

- Consumes: a `BroadcastChannel`-like channel to the kernel responder; the
  request URL/method/headers/body.
- Produces:
  - `handleSyncFsRequest(channel, req: { token: string; op: SyncFsOp; path: string; body?: Uint8Array }): Promise<Response>`
  - route: `GET|POST /__slicc/fs-sync/<vfs-path>`, token in `x-slicc-fs-token`
    header, errno in `x-slicc-fs-errno` response header.

- [ ] **Step 1: Failing tests (round-trip + errno mapping)**

```ts
// sync-fs-sw-handler.test.ts
test('ok result → 200 with raw bytes body', async () => {
  // fake channel that replies {ok:true, bytes} → Response.status 200, arrayBuffer === bytes
});
test('errno result → status + x-slicc-fs-errno header (ENOENT→404, EACCES→403, else 400)', async () => {
  // fake channel replies {ok:false, errno:'ENOENT'} → res.status 404, header 'ENOENT'
});
test('channel timeout → 503 + x-slicc-fs-errno EIO (fail closed, never hangs)', async () => {
  // channel never replies → resolves a 503 within the budget
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** the handler (post `sync-fs-req` with a fresh id,
      await matching `sync-fs-res` with a timeout mirroring
      `preview-sw-handler.ts`'s `DEFAULT_TIMEOUT_MS`, build the `Response`; map
      errno→status: `ENOENT`→404, `EACCES`→403, `EISDIR`/`ENOTDIR`→400, else 500;
      always set `x-slicc-fs-errno`; timeout → 503 + `EIO`).

- [ ] **Step 4: Register the fetch listener** in `llm-proxy-sw.ts`:

```ts
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/__slicc/fs-sync/')) return;
  event.respondWith(handleSyncFsRequest(getSyncFsBroadcast(), parseSyncFsRequest(event.request)));
});
```

Add `getSyncFsBroadcast()` (lazy `new BroadcastChannel('slicc-sync-fs')`) and
`parseSyncFsRequest` (method→op for GET/POST, path from pathname, token from
header, body from the request when POST).

- [ ] **Step 5: Run handler tests, expect PASS; `npm run typecheck`**

- [ ] **Step 6: Commit**

```bash
git commit -am "feat(sw): /__slicc/fs-sync route + handler with errno headers"
```

---

## Task 5: Realm sync-XHR bridge module

**Files:**

- Create: `packages/webapp/src/kernel/realm/sync-fs-bridge.ts`
- Test: `packages/webapp/tests/kernel/realm/sync-fs-bridge.test.ts`

**Interfaces:**

- Produces:
  - `interface SyncFsXhrBridge { readFile(path: string): Uint8Array; writeFile(path: string, bytes: Uint8Array): void; exists(path): boolean; stat(path): {isFile:boolean;isDirectory:boolean;size:number}; readdir(path): string[] }`
  - `createSyncFsXhrBridge(token: string): SyncFsXhrBridge`
- Behavior: each method does a **synchronous** `XMLHttpRequest`
  (`xhr.open(method, '/__slicc/fs-sync' + path, false)`), sets
  `x-slicc-fs-token`, uses `responseType=''` is illegal for sync on main thread
  but this runs in a **worker** so `responseType='arraybuffer'` is allowed;
  reads `x-slicc-fs-errno` on non-2xx and throws
  `Object.assign(new Error(msg), { code: errno })`.

- [ ] **Step 1: Failing test with a stubbed `XMLHttpRequest`**

```ts
// sync-fs-bridge.test.ts — install a fake sync XHR on globalThis
test('readFile returns bytes on 200', () => {
  /* fake xhr → status 200, arraybuffer 'hi' */
});
test('readFile throws Error with .code=ENOENT on 404 + x-slicc-fs-errno', () => {
  expect(() => bridge.readFile('/missing')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
});
test('writeFile POSTs the body and throws EACCES on 403', () => {
  /* … */
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** using synchronous XHR; parse `x-slicc-fs-errno`;
      binary via `responseType='arraybuffer'`; encode write body as the POST body.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(realm): synchronous XHR sync-fs bridge client"
```

---

## Task 6: Wire the bridge into the realm shim (miss/over-cap/write-through)

**Files:**

- Modify: `packages/webapp/src/kernel/realm/js-realm-shared.ts`
  (`createSyncFsBridge` → accept a bridge; thread the token from realm boot)
- Modify: `packages/webapp/src/kernel/realm/sync-fs-cache.ts` (add `invalidate`)
- Test: `packages/webapp/tests/kernel/realm/js-realm-shared.sync-bridge.test.ts`

**Interfaces:**

- Consumes: `SyncFsXhrBridge` (Task 5), the realm's `syncFsToken` passed through
  the realm boot init message (add the field to the realm init payload;
  `js-realm-shared.ts` already receives an `init` with `cwd`).
- Produces: `createSyncFsBridge(syncFs, cwd, bridge?)` — same shim shape, now
  falling back to `bridge` and write-through.

- [ ] **Step 1: Failing tests**

```ts
test('readFileSync falls back to the bridge when the cache throws ENOSYNC', () => {
  // syncFs.readFile stubbed to throw ENOSYNC; bridge.readFile returns bytes;
  // shim returns the bridge bytes (not a throw)
});
test('readFileSync falls back to the bridge on a cache miss (ENOENT-in-cache but present live)', () => {
  /* … */
});
test('writeFileSync writes through the bridge AND invalidates the cache path', () => {
  // bridge.writeFile called; syncFs.invalidate(path) called; a subsequent
  // readFileSync re-fetches via bridge and sees the new bytes
});
test('with no bridge (boot-not-controlled) behavior is exactly today: ENOSYNC over-cap', () => {
  /* … */
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement** — in each shim method, `try { return syncFs.<op>(…) }
catch (e) { if (bridge && e.code === 'ENOSYNC') return bridgeOp(); throw e }`;
      add a cache-miss branch (a `truncated` entry, or absent) that consults the
      bridge; `writeFileSync` calls `bridge.writeFile` then `syncFs.invalidate(p)`
      (write-through) when the bridge is present, else the current cache write.
      Add `SyncFsCache.invalidate(path)` / `invalidateAll()`. Thread `syncFsToken`
      from the realm boot init → `createSyncFsXhrBridge(token)` → passed into
      `createSyncFsBridge`. When `token`/SW is absent, `bridge` is `undefined` and
      the shim is byte-for-byte today's behavior.

- [ ] **Step 4: Run unit tests; then the heavy integration test**

```ts
// integration: a realm script reads a >10 MB file and >500 files synchronously
// through the bridge path (over the caps) and gets correct bytes — gated behind
// the realm harness the existing realm tests use.
```

Run: `npx vitest run packages/webapp/tests/kernel/realm/js-realm-shared.sync-bridge.test.ts`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(realm): route sync fs misses/over-cap/writes through the SW bridge"
```

---

## Task 7: Coherence — exec boundary + external writers

**Files:**

- Modify: `packages/webapp/src/kernel/realm/js-realm-shared.ts`
  (`createExecBridge` flush/re-snapshot → invalidate under write-through)
- Modify: `packages/webapp/src/kernel/realm/sync-fs-cache.ts` (invalidation hooks)
- Test: `packages/webapp/tests/kernel/realm/sync-fs-coherence.test.ts`

**Interfaces:**

- Consumes: `SyncFsCache.invalidate*` (Task 6); the existing exec bridge
  (`js-realm-shared.ts:441-489`).

- [ ] **Step 1: Failing tests**

```ts
test('read after exec sees the subprocess write (cache invalidated across exec)', async () => {
  /* … */
});
test('read after an external async vfs write is NOT stale (bridge re-fetch or documented eviction)', async () => {
  /* … */
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement the committed coherence policy.** With writes going
      write-through to `ctx.fs`, replace the flush-before-exec diff with a cache
      **invalidate-across-exec** (the subprocess writes to the same `ctx.fs`, so the
      cache just needs busting, not diff/flush). For external writers choose ONE and
      wire/document it: (a) subscribe cache eviction to `FsWatcher` /
      `invalidatePaths` for affected paths, or (b) document exec-boundary-only
      coherence (matches today's snapshot semantics) and ensure any cached-but-stale
      path a live bridge could answer is re-fetched rather than served stale. Keep
      the `touched`/`wasUsed` perf gate so exec-only scripts pay nothing.

- [ ] **Step 4: Run tests; run the full realm suite for regressions**

Run: `npx vitest run packages/webapp/tests/kernel/realm/`

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(realm): sync-fs cache coherence across exec + external writers"
```

---

## Task 8: Phase-1 acceptance gates (security) + cross-float smoke

**Files:**

- Test: `packages/webapp/tests/kernel/realm/sync-fs-acceptance.test.ts`
- (Uses the sudo brokers `packages/webapp/src/sudo/*` + `createSudoFs`.)

These are GATES: the feature does not ship unless all pass.

- [ ] **Step 1: Escalation guard (end-to-end through the shim)** — a
      `RestrictedFS`+sudo-fs scoop realm doing `readFileSync`/`writeFileSync` on a
      path outside its sandbox is denied with the same errno the async path throws;
      the global VFS is never reachable.

- [ ] **Step 2: Sudo-gated sync write** — a write to a sudo-gated path triggers
      the broker prompt; **allow** → write succeeds; **deny** → the documented
      errno; **broker unavailable/timeout** → fail-closed `EACCES`, and the realm
      worker is NOT left hung (assert the sync XHR resolves to an error within the
      budget). Verify the reentrant page-services-sync-fs + prompt path does not
      deadlock (standalone panel-RPC broker).

- [ ] **Step 3: Token isolation** — two concurrent realms with different tokens
      each resolve to their own `ctx`; realm A's token cannot read/write through B's
      scope; an unknown / revoked (post-`dispose`) / forged token → `EACCES`.

- [ ] **Step 4: Cross-float smoke** — confirm a realm sync read/write works in
      the extension hosted-leader tab (SW control + kernel worker present), and, if
      feasible in the harness, an Electron-attach leader. Document the manual steps
      where automation isn't feasible.

- [ ] **Step 5: Commit**

```bash
git commit -am "test(realm): phase-1 acceptance gates — ACL escape, sudo, token isolation"
```

---

## Task 9: Binary confirmation + docs + coverage

**Files:**

- Test: extend Task 6/8 with a binary round-trip (`responseType='arraybuffer'`
  write + read of non-UTF8 bytes through the real bridge path).
- Modify docs: `packages/webapp/CLAUDE.md` (Kernel Host / realm sync-fs
  paragraph — note the SW bridge, token, ACL, no more sandbox mirror),
  `docs/kernel/process-model.md`, `docs/shell-reference.md` (if `node -e`/`.jsh`
  sync-fs limits change), and `packages/vfs-root/shared/CLAUDE.md` only if
  agent-facing behavior changes (unbounded sync reads).

- [ ] **Step 1: Binary round-trip test** — write `Uint8Array([0xde,0xad,0xbe,0xef])`
      via `writeFileSync`, read it back via `readFileSync` (no encoding) through the
      bridge, assert byte equality.

- [ ] **Step 2: Run it, expect PASS** (fix `arraybuffer` handling if not).

- [ ] **Step 3: Update the docs listed above** to match the shipped design.

- [ ] **Step 4: Coverage gate for the touched packages**

Run: `npm run test:coverage:webapp`
Expected: at or above the floor in `coverage-thresholds.json`.

- [ ] **Step 5: Full pre-PR verification**

Run: `npm run lint:ci && npm run typecheck && npm run test && npm run build && npm run build:extension`
(plus the boy-scout gate `node packages/dev-tools/tools/check-touched-exemptions.mjs` if any touched file is on a biome debt list.)

- [ ] **Step 6: Commit**

```bash
git commit -am "docs+test(realm): binary sync-fs round-trip + sync-fs bridge docs"
```

---

## Notes for the executor

- **Dual-mode check every task:** the responder + token registry live in the
  kernel worker, which is standalone-page-hosted OR extension-hosted-leader-tab.
  The SW handler is the same in both. Do not add an extension-realm branch —
  `isExtensionRealm()` is false in the hosted leader tab (see the extension
  thin-bridge notes).
- **Never route sync-fs through `RemoteVfsClient` / `VfsRpcHost` / the preview
  reader** — only through the token → `ctx.fs` dispatch, or the ACL guard breaks.
- **Follow `preview-vfs-responder.ts` / `preview-sw-handler.ts` patterns
  precisely** for the channel correlation-id + ack + timeout/retry cadence
  (cold-start listener race). Reuse their proven shapes rather than inventing.
- **Fail closed everywhere** (Global Constraints): a missing SW/token/broker is
  an errno, never a hang or a global-VFS read.
