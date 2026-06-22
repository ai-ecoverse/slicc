# External-Brain Shell Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external orchestrator (Claude Code) drive a running SLICC instance's shell + VFS + browser substrate over loopback HTTP, while SLICC runs with no cone (no second brain).

**Architecture:** A new `--substrate` launch mode boots the standalone webapp with `skipConeBootstrap: true` (the gate already exists), so the single `BrowserAPI` has exactly one CDP authority. Net-new code is small and routes through the **existing** `/licks-ws` request/response bridge and the **existing** node-server auth gate: new `shell-exec` / `vfs-*` / `lick-emit` / `targets` bridge message types, a dedicated session-keyed headless `AlmostBashShellHeadless` (reusing the panel-terminal exec primitive), a streaming (chunked-HTTP + NDJSON) variant of `sendLickRequest`, and thin HTTP routes mirroring `routes/lick-api.ts`.

**Tech Stack:** TypeScript, node-server (Express + `ws`), webapp kernel worker (`AlmostBashShellHeadless`, `TerminalSessionHost`, `ProcessManager`, `BrowserAPI`), Vitest. Spec: [`docs/superpowers/specs/2026-06-22-external-brain-shell-bridge-design.md`](../specs/2026-06-22-external-brain-shell-bridge-design.md).

## Global Constraints

- **Node >= 22** (repo runs on v24). Use pi-ai model **aliases**, never dated snapshots (not relevant here but repo-wide).
- **Dual-mode rule, but phase-1 is standalone-only.** The extension float has no node-server; every new HTTP route + bridge handler is standalone-only. Add an explicit **"N/A — extension has no node-server (spec §11)"** parity note in each PR/commit touching `node-server`. Do **not** attempt an extension equivalent in this plan.
- **Reuse the gate, don't invent one.** All routes sit behind the existing node-server gate: loopback-exempt, remote requires the per-process bridge token + origin allowlist (`packages/node-server/src/bridge-security.ts`). Never add a parallel auth path.
- **Two-brains invariant.** `--substrate` must produce **no cone scoop**. A regression test asserts this (Task 3).
- **Naming overload (must respect).** `substrate` is already used in `node-server` for the **e2b cloud sandbox** (`src/cloud/`, `createSubstrate`, `@slicc/cloud-core`). The new flag is unrelated. Keep the new code self-describing: prefer identifiers like `substrateMode` / `isSubstrate` / `shellBridge*` and **never** reuse the cloud `Substrate` type name. The user-facing flag stays `--substrate` and the script stays `npm run substrate` (decided in spec §15).
- **Mutual exclusion:** `--substrate` and `--hosted` cannot both be set (spec §4).
- **Session identity:** client-supplied `X-Slicc-Session: <uuid>`, create-on-first-use (spec §6, decision 2).
- **Streaming:** chunked HTTP + NDJSON frames `{"t":"stdout"|"stderr","d":"…"}` / `{"t":"exit","code":N,"pid":N}` — **not** SSE (spec §6, decision 3).
- **Verification before every commit** (the CI gates — run from repo root, which resolves to this worktree):
  ```bash
  npm run lint            # biome + prettier + lint:docs + lint:skills — MOST COMMON CI FAILURE; run first
  npm run typecheck       # 5 tsc targets
  npm run test
  npm run test:coverage   # keep each package at/above its floor in coverage-thresholds.json
  npm run build
  npm run build -w @slicc/chrome-extension
  ```
  For fast inner loops use the package-scoped runner, e.g. `npm run test -w @slicc/node-server -- <file>` and `npm run test -w @slicc/webapp -- <file>`.

## File Structure

**New files**

| Path                                                         | Responsibility                                                                                                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/webapp/src/kernel/substrate-session.ts`            | `SubstrateSessionRegistry`: session-keyed headless shells (create-on-first-use), `cwd`/`env`/handle persistence, bounded recent-output tail buffer, GC window, `runExec` / `streamExec` / `sessionStatus`.               |
| `packages/webapp/src/scoops/shell-bridge-handler.ts`         | Translates `shell-exec` / `shell-stream` / `vfs-*` / `lick-emit` / `targets` lick-bridge requests into `SubstrateSessionRegistry` / VFS / `LickManager` / `BrowserAPI` calls. Pure logic; injected deps for testability. |
| `packages/node-server/src/routes/substrate-api.ts`           | Express routes (`/api/shell/exec`, `/api/shell/session/:id`, `/api/vfs/*`, `/api/lick/emit`, `/api/targets`) behind the gate; non-streaming + chunked-NDJSON streaming.                                                  |
| `packages/vfs-root/workspace/skills/slicc-steering/SKILL.md` | The Claude-Code-facing steering skill (verb surface, one-time gesture, `ps`/`/api/targets` discovery, reconnect recipe).                                                                                                 |
| `packages/node-server/tests/routes/substrate-api.test.ts`    | Route auth (loopback vs token), exec round-trip, streaming chunk assembly, timeout/kill, VFS, targets.                                                                                                                   |
| `packages/webapp/tests/kernel/substrate-session.test.ts`     | Registry lifecycle: create-on-first-use, cwd/env persistence, tail buffer, GC.                                                                                                                                           |
| `packages/webapp/tests/scoops/shell-bridge-handler.test.ts`  | Handler dispatch for every message type, error mapping.                                                                                                                                                                  |
| `packages/webapp/tests/kernel/substrate-boot.test.ts`        | `?substrate=1` → `skipConeBootstrap: true` → **no cone scoop** (two-brains regression).                                                                                                                                  |

**Modified files**

| Path                                                                                             | Change                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/node-server/src/runtime-flags.ts`                                                      | Add `substrate: boolean`; parse `--substrate`; reject `--substrate` + `--hosted`.                                                                                       |
| `packages/node-server/src/index.ts`                                                              | Append `?substrate=1` to the Chrome launch URL (mirror line 645); register `substrate-api` routes; pass the lick bridge's new streaming sender.                         |
| `packages/node-server/src/routes/lick-bridge.ts`                                                 | Add `sendLickStream(type, data, onFrame, timeout)` + a longer default timeout for `shell-exec`.                                                                         |
| `packages/node-server/package.json` (root `package.json` scripts)                                | Add `"substrate": "node-server --dev --substrate"` (place where `dev` lives).                                                                                           |
| `packages/webapp/src/scoops/lick-ws-bridge.ts`                                                   | Route new request types to `shell-bridge-handler`; relay streaming frames as `shell-chunk` / `shell-done` WS messages.                                                  |
| `packages/webapp/src/kernel/kernel-worker.ts`                                                    | Read `substrate` from boot config; construct `SubstrateSessionRegistry` + `shell-bridge-handler` and hand them to the lick-ws bridge; pass `skipConeBootstrap` through. |
| `packages/webapp/src/ui/wc/wc-live.ts` (or the worker-boot config site)                          | Read `?substrate=1` from `location.search`; thread `substrate: true` into the worker boot message.                                                                      |
| `docs/shell-reference.md`, `docs/architecture.md`, `packages/node-server/CLAUDE.md`, `README.md` | Document substrate mode + the routes + the steering skill.                                                                                                              |

---

## Milestone A — The `--substrate` two-brains gate

### Task 1: `--substrate` flag in `CliRuntimeFlags`

**Files:**

- Modify: `packages/node-server/src/runtime-flags.ts`
- Test: `packages/node-server/tests/runtime-flags.test.ts` (add cases; create if absent)

**Interfaces:**

- Produces: `CliRuntimeFlags.substrate: boolean`; `parseCliRuntimeFlags(argv)` sets it from `--substrate` and **throws** an `Error` containing `"--substrate cannot be combined with --hosted"` when both are present.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseCliRuntimeFlags } from '../src/runtime-flags.js';

describe('parseCliRuntimeFlags --substrate', () => {
  it('defaults substrate to false', () => {
    expect(parseCliRuntimeFlags([]).substrate).toBe(false);
  });
  it('parses --substrate', () => {
    expect(parseCliRuntimeFlags(['--substrate']).substrate).toBe(true);
  });
  it('rejects --substrate with --hosted', () => {
    expect(() => parseCliRuntimeFlags(['--substrate', '--hosted'])).toThrow(
      /--substrate cannot be combined with --hosted/
    );
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`substrate` undefined). `npm run test -w @slicc/node-server -- runtime-flags`
- [ ] **Step 3: Implement** — add `substrate: boolean` to the interface, a `let substrate = false;`, a `if (arg === '--substrate') { substrate = true; continue; }` branch, include `substrate` in the returned object, and after the parse loop add: `if (substrate && hosted) throw new Error('--substrate cannot be combined with --hosted');`
- [ ] **Step 4: Run it — expect PASS.**
- [ ] **Step 5: Commit** — `feat(node-server): add --substrate runtime flag (steering mode)`

### Task 2: Launch-URL param + `npm run substrate`

**Files:**

- Modify: `packages/node-server/src/index.ts` (~line 645, the `runtime=hosted-leader` append site)
- Modify: root `package.json` scripts
- Test: extend `packages/node-server/tests/` for the URL-builder if the append logic is extracted; otherwise assert via the smallest pure helper.

**Interfaces:**

- Consumes: `CliRuntimeFlags.substrate` (Task 1).
- Produces: when `flags.substrate`, the Chrome launch URL carries `substrate=1`.

- [ ] **Step 1: Write the failing test.** If the URL assembly is inline, first extract a pure helper `appendSubstrateParam(url: string, substrate: boolean): string` into `index.ts` (exported) and test it:

```ts
import { appendSubstrateParam } from '../src/index.js';
it('appends substrate=1 only when enabled', () => {
  expect(appendSubstrateParam('http://localhost:5710/', true)).toBe(
    'http://localhost:5710/?substrate=1'
  );
  expect(appendSubstrateParam('http://localhost:5710/?x=1', true)).toBe(
    'http://localhost:5710/?x=1&substrate=1'
  );
  expect(appendSubstrateParam('http://localhost:5710/', false)).toBe('http://localhost:5710/');
});
```

- [ ] **Step 2: Run it — expect FAIL.**
- [ ] **Step 3: Implement** the helper using the same `url.includes('?') ? '&' : '?'` idiom as line 645, call it at the launch-URL assembly site, and add to root `package.json`: `"substrate": "npm run dev -- --substrate"` (verify the exact `dev` script form first and mirror it; the goal is a standalone steering entrypoint).
- [ ] **Step 4: Run it — expect PASS.** Also smoke-check `npm run substrate` boots and the launched URL has `?substrate=1` (manual, document the observation).
- [ ] **Step 5: Commit** — `feat(node-server): launch ?substrate=1 + npm run substrate entrypoint`

### Task 3: Boot honors `?substrate=1` → no cone (two-brains regression)

**Files:**

- Modify: `packages/webapp/src/ui/wc/wc-live.ts` (read `location.search`, thread into worker boot config) and `packages/webapp/src/kernel/kernel-worker.ts` (boot config → `createKernelHost({ skipConeBootstrap })`)
- Test: `packages/webapp/tests/kernel/substrate-boot.test.ts`

**Interfaces:**

- Consumes: `createKernelHost({ skipConeBootstrap })` — already exists ([host.ts:129](../../packages/webapp/src/kernel/host.ts#L129), gate at line 847).
- Produces: a boot path where `substrate: true` in the worker boot message resolves to `skipConeBootstrap: true`; the returned host's orchestrator has **no cone scoop**.

- [ ] **Step 1: Write the failing test** — boot a kernel host with the substrate flag and assert no cone is registered. Mirror the existing host/kernel-worker test setup (use `fake-indexeddb/auto`, a fresh `VirtualFS`). Pattern:

```ts
// Verify the boot wiring maps substrate → skipConeBootstrap and produces no cone.
import { createKernelHost } from '../../src/kernel/host.js';
it('substrate boot creates no cone scoop', async () => {
  const host = await createKernelHost({ /* minimal deps as in host.test.ts */, skipConeBootstrap: true });
  const cones = host.orchestrator.listScoops().filter((s) => s.isCone);
  expect(cones).toHaveLength(0);
  await host.dispose();
});
```

(Check the exact `createKernelHost` test harness in `packages/webapp/tests/kernel/` and reuse it; confirm the scoop-listing accessor name — `listScoops()` / `getScoops()` — against `orchestrator.ts` and use the real one.)

- [ ] **Step 2: Run it — expect FAIL** until the boot threading exists (or PASS for the host-level assertion if `skipConeBootstrap` already suppresses the cone — in that case ADD the wiring assertion below).
- [ ] **Step 3: Implement the threading** — in `wc-live.ts` read `new URLSearchParams(location.search).get('substrate') === '1'` and include `substrate` in the worker boot message; in `kernel-worker.ts` map `bootConfig.substrate` → `skipConeBootstrap` in the `createKernelHost({...})` call (line ~282). Keep the name `skipConeBootstrap` at the host boundary.
- [ ] **Step 4: Run it — expect PASS.**
- [ ] **Step 5: Commit** — `feat(webapp): substrate boot skips cone bootstrap (two-brains gate)`

---

## Milestone B — Exec channel: session registry + bridge handler + route

### Task 4: `SubstrateSessionRegistry`

**Files:**

- Create: `packages/webapp/src/kernel/substrate-session.ts`
- Test: `packages/webapp/tests/kernel/substrate-session.test.ts`

**Interfaces:**

- Consumes: a `TerminalShellFactory`-shaped builder `(sid, {cwd,env}) => HeadlessShellLike & {dispose?}` (reuse `createAlmostBashShellTerminalFactory` from [terminal-session-host.ts:451](../../packages/webapp/src/kernel/terminal-session-host.ts#L451)); optional `ProcessManager`; a clock injectable for GC tests.
- Produces:

```ts
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid: number | null;
}
export interface SessionStatus {
  alive: boolean;
  cwd: string;
  runningPids: number[];
  bufferedTail: string;
}
export interface SubstrateSessionRegistry {
  runExec(sessionId: string, command: string, opts?: { signal?: AbortSignal }): Promise<ExecResult>;
  streamExec(
    sessionId: string,
    command: string,
    onFrame: (f: ExecFrame) => void,
    opts?: { signal?: AbortSignal }
  ): Promise<void>;
  sessionStatus(sessionId: string): SessionStatus;
  sweepIdle(now: number): void; // GC sessions past the retain window
  dispose(): void;
}
export type ExecFrame =
  | { t: 'stdout' | 'stderr'; d: string }
  | { t: 'exit'; code: number; pid: number | null };
```

- Behavior: `runExec` creates the session on first use, runs the command via the headless shell (preserving `cwd`/`env`/device-handle state on the shell instance across calls), appends stdout/stderr to a **bounded** recent-output tail (cap e.g. 64 KB — reuse the `transcript-limits.ts` style cap), and records the running pid in the ProcessManager. On `streamExec`, push `stdout`/`stderr`/`exit` frames to `onFrame`. After the last exec, mark `lastActiveAt`; `sweepIdle` disposes sessions idle past a retain window (e.g. 5 min) but keeps the tail until disposed.

- [ ] **Step 1: Write failing tests** — with a stub shell factory returning canned `{stdout,stderr,exitCode}`:

```ts
it('creates a session on first exec and preserves it', async () => {
  /* same sessionId reused → factory called once */
});
it('returns stdout/stderr/exitCode', async () => {
  /* runExec resolves ExecResult */
});
it('buffers a bounded recent tail', async () => {
  /* long output → bufferedTail length <= cap, contains the latest bytes */
});
it('streamExec emits stdout then exit frames', async () => {
  /* onFrame receives {t:'stdout'} then {t:'exit',code} */
});
it('sweepIdle disposes sessions past the retain window', async () => {
  /* advance clock → factory.dispose called, sessionStatus.alive false */
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).
- [ ] **Step 3: Implement** `substrate-session.ts`. Keep one `Map<string, { shell, lastActiveAt, tail, pids }>`. Reuse the abort/ProcessManager pattern from `TerminalSessionHost.handleExec` (spawn a `kind:'shell'` process so `ps`/`kill` see it). For streaming, emit block-level frames after `executeCommand` returns (one `stdout`, one `stderr`, then `exit`) **and** add a `// TODO(streaming)` noting that incremental output requires an `executeCommand` output callback in `AlmostBashShellHeadless` — check whether one exists; if so, wire it for real incremental frames, else block-level is the phase-1 deliverable (the wire envelope is unchanged either way — spec §6).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(webapp): SubstrateSessionRegistry — session-keyed headless shells`

### Task 5: `shell-bridge-handler` + lick-ws routing

**Files:**

- Create: `packages/webapp/src/scoops/shell-bridge-handler.ts`
- Modify: `packages/webapp/src/scoops/lick-ws-bridge.ts` (add request cases + streaming relay)
- Modify: `packages/webapp/src/kernel/kernel-worker.ts` (construct registry+handler under substrate mode, inject into the bridge)
- Test: `packages/webapp/tests/scoops/shell-bridge-handler.test.ts`

**Interfaces:**

- Consumes: `SubstrateSessionRegistry` (Task 4), `LickManager`, `BrowserAPI`, the shared `VirtualFS`.
- Produces:

```ts
export interface ShellBridgeDeps {
  registry: SubstrateSessionRegistry;
  lickManager: LickManager;
  browser: BrowserAPI;
  fs: VirtualFS;
}
export function createShellBridgeHandler(deps: ShellBridgeDeps): {
  handleRequest(type: string, data: Record<string, unknown>): Promise<unknown>; // shell-exec(non-stream), vfs-read/write/stat/list, lick-emit, targets, shell-session-status
  handleStream(
    type: string,
    data: Record<string, unknown>,
    onFrame: (f: ExecFrame) => void
  ): Promise<void>; // shell-exec(stream)
  canHandle(type: string): boolean;
};
```

- Wire into `lick-ws-bridge.ts`: in `handleLickRequest`, before the `default`, delegate to the handler when `shellBridge?.canHandle(data.type)`; for streaming, a new branch in `processLickMessage` recognizes `data.stream === true` requests and calls `handleStream`, sending each frame as a `{ type: 'shell-chunk', requestId, frame }` WS message and a terminal `{ type: 'shell-done', requestId }` (no `type:'response'` for the streaming path).

- [ ] **Step 1: Write failing tests** — inject fakes; assert each `type` routes to the right dep and maps results/errors. E.g. `shell-exec` → `registry.runExec`; `targets` → `browser.listAllTargets`; `vfs-read` → `fs.readFile`; `lick-emit` → `lickManager.emitEvent`; unknown → `canHandle` false. Assert `handleStream` forwards frames in order.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the handler (a `switch` on `type`) and the lick-ws-bridge routing. Keep `lick-ws-bridge.ts` functions under the size cap (extract helpers as the file already does). The handler stays standalone-only — it is only constructed when `kernel-worker.ts` is in substrate mode.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(webapp): shell-bridge handler + lick-ws routing for substrate`

### Task 6: `POST /api/shell/exec` (non-streaming) + long-timeout bridge send

**Files:**

- Create: `packages/node-server/src/routes/substrate-api.ts`
- Modify: `packages/node-server/src/routes/lick-bridge.ts` (longer default timeout for shell-exec; keep `sendLickRequest` signature)
- Modify: `packages/node-server/src/index.ts` (register routes; gate them like `/api/fetch-proxy`)
- Test: `packages/node-server/tests/routes/substrate-api.test.ts`

**Interfaces:**

- Consumes: `LickBridge.sendLickRequest` ([lick-bridge.ts:13](../../packages/node-server/src/routes/lick-bridge.ts#L13)); gate helpers `isLoopbackBridgeOrigin` / `validateBridgeToken` / `buildCorsHeaders` ([bridge-security.ts](../../packages/node-server/src/bridge-security.ts)).
- Produces: `registerSubstrateApiRoutes(app, { sendLickRequest, sendLickStream, requireGate })`. `POST /api/shell/exec` body `{ command, cwd?, timeoutMs?, stream? }`, header `X-Slicc-Session`; non-stream returns `{ stdout, stderr, exitCode, pid }`.

- [ ] **Step 1: Write failing tests** with a stub `sendLickRequest` and `supertest` (match how `lick-api`/other routes are tested in `packages/node-server/tests/routes/`):

```ts
it('rejects a non-loopback request with no bridge token (403)', async () => {
  /* Origin: https://evil.example, no X-Bridge-Token → 403 */
});
it('allows loopback without a token and returns exec output', async () => {
  /* stub resolves {stdout:'hi\n',stderr:'',exitCode:0,pid:1} → 200 body matches */
});
it('passes X-Slicc-Session through to the bridge', async () => {
  /* assert stub received sessionId */
});
it('maps a bridge timeout to 504', async () => {
  /* stub rejects Error('Request timeout') → 504 */
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the route module + register it in `index.ts` behind the same gate used by `/api/fetch-proxy` (reuse the existing middleware/helper — find it next to the fetch-proxy registration and apply identically). In `lick-bridge.ts`, give `shell-exec` a long timeout (e.g. accept a per-call `timeout` already supported by `sendLickRequest`; default the route to e.g. 10 min, overridable by `timeoutMs`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(node-server): POST /api/shell/exec over the lick bridge (gated)` _(parity: N/A — extension has no node-server, spec §11)_

### Task 7: Session re-attach + GC window

**Files:**

- Modify: `packages/node-server/src/routes/substrate-api.ts` (`GET /api/shell/session/:id`)
- Modify: `packages/webapp/src/scoops/shell-bridge-handler.ts` (`shell-session-status` → `registry.sessionStatus`)
- Modify: `packages/webapp/src/kernel/kernel-worker.ts` (drive `registry.sweepIdle` on an interval, or on each exec)
- Test: extend both test files.

**Interfaces:**

- Consumes: `SubstrateSessionRegistry.sessionStatus` / `sweepIdle` (Task 4).
- Produces: `GET /api/shell/session/:id` → `{ alive, cwd, runningPids, bufferedTail }`.

- [ ] **Step 1: Write failing tests** — route returns the status shape; after the GC window a previously-live session reports `alive:false`; a fresh `exec` on a GC'd id transparently creates a new session with a reset `cwd` (assert `cwd` returns to the default).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the route + handler case + the sweep trigger (a `setInterval` in substrate mode, cleared on `dispose`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat: substrate shell session re-attach probe + GC window`

---

## Milestone C — Streaming output (chunked HTTP + NDJSON)

### Task 8: `sendLickStream` + streaming WS relay

**Files:**

- Modify: `packages/node-server/src/routes/lick-bridge.ts` (`sendLickStream`)
- Modify: `packages/webapp/src/scoops/lick-ws-bridge.ts` (emit `shell-chunk` / `shell-done`, already added in Task 5 — finalize the wire here)
- Test: `packages/node-server/tests/routes/lick-bridge.test.ts` (create/extend)

**Interfaces:**

- Produces on `LickBridge`:

```ts
sendLickStream(type: string, data: unknown, onFrame: (f: unknown) => void, timeout?: number): Promise<void>;
```

Registers a per-`requestId` frame sink: incoming `{ type:'shell-chunk', requestId, frame }` → `onFrame(frame)`; `{ type:'shell-done', requestId }` → resolve; timeout rejects and clears the sink. Extend the existing `ws.on('message')` switch in `createLickBridge` (currently only handles `type:'response'`) to also dispatch `shell-chunk` / `shell-done` to the pending stream sinks.

- [ ] **Step 1: Write failing tests** — drive a fake WS that emits two `shell-chunk` frames then `shell-done`; assert `onFrame` called in order and the promise resolves; a no-`shell-done` case rejects on timeout.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `sendLickStream` + the message-dispatch extension. Keep `pendingRequests` (request/response) and a new `pendingStreams` map separate.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(node-server): streaming sendLickStream over /licks-ws`

### Task 9: Chunked `POST /api/shell/exec` (`stream:true`) + process control

**Files:**

- Modify: `packages/node-server/src/routes/substrate-api.ts`
- Test: extend `packages/node-server/tests/routes/substrate-api.test.ts`

**Interfaces:**

- Consumes: `sendLickStream` (Task 8).
- Produces: when `stream:true`, the response is `Transfer-Encoding: chunked`, `Content-Type: application/x-ndjson`; each `ExecFrame` is written as a JSON line: `{"t":"stdout","d":"…"}\n`, `{"t":"exit","code":0,"pid":123}\n`.

- [ ] **Step 1: Write failing tests** — `stream:true` request: stub `sendLickStream` pushes two stdout frames + an exit frame; assert the HTTP body is exactly those three NDJSON lines and the connection ends after `exit`. Assert a long run does **not** hit the old 5s timeout (use a stub that delays beyond 5s and still completes). Assert killability: a parallel `bash -c 'kill <pid>'` path is documented (test the route forwards `ps`/`kill` as ordinary `shell-exec` commands — no special route needed).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the streaming branch: set headers, `res.write(JSON.stringify(frame) + '\n')` per frame via the `onFrame` callback, `res.end()` after the terminal `exit` frame; on client abort, propagate to the bridge (best-effort) and end.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(node-server): chunked NDJSON streaming for /api/shell/exec` _(parity: N/A — extension, spec §11)_

---

## Milestone D — VFS, lick-emit, targets routes

### Task 10: VFS routes

**Files:**

- Modify: `packages/node-server/src/routes/substrate-api.ts` (`GET /api/vfs/read`, `POST /api/vfs/write`, `GET /api/vfs/stat`, `POST /api/vfs/list`)
- Modify: `packages/webapp/src/scoops/shell-bridge-handler.ts` (`vfs-read/write/stat/list` cases)
- Test: extend both test files.

**Interfaces:**

- Consumes: the shared `VirtualFS` (read/write/stat/readdir) via the handler.
- Produces: read returns file bytes (base64 when binary, flagged by an `encoding` field); write accepts `{ path, content, encoding? }`; stat returns `{ type, size, mtime }`; list returns `[{ name, type }]`.

- [ ] **Step 1: Write failing tests** — round-trip a text file (write then read), stat a known path, list a dir; binary content survives base64 round-trip; a path-escape attempt (`../`) is rejected by the VFS layer (assert the error surfaces as 4xx, not a crash).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the four routes + handler cases. Lean on `VirtualFS` normalization (`path-utils.ts`) for the escape guard — don't reinvent it.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(node-server): VFS read/write/stat/list routes for substrate`

### Task 11: `POST /api/lick/emit` + `GET /api/targets`

**Files:**

- Modify: `packages/node-server/src/routes/substrate-api.ts`
- Modify: `packages/webapp/src/scoops/shell-bridge-handler.ts` (`lick-emit`, `targets`)
- Test: extend both.

**Interfaces:**

- Consumes: `LickManager.emitEvent` / the existing webhook injection path; `BrowserAPI.listAllTargets()` ([browser-api.ts:180](../../packages/webapp/src/cdp/browser-api.ts#L180)).
- Produces: `POST /api/lick/emit` body `{ type, data }` → `{ ok: true }`; `GET /api/targets` → `PageInfo[]` (local + federated fleet).

- [ ] **Step 1: Write failing tests** — `lick-emit` with `{type:'navigate', data:{…}}` calls `lickManager.emitEvent` with a navigate event; `targets` returns the `listAllTargets` array; malformed `lick-emit` (missing `type`) → 400.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** both routes + handler cases. For `lick-emit`, validate `type` against the known lick channels (reuse the validation shape from `dispatchNavigateEvent` in `lick-ws-bridge.ts`).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `feat(node-server): /api/lick/emit + /api/targets for substrate`

---

## Milestone E — The Claude-facing steering skill + docs

### Task 12: `slicc-steering` skill + reference docs

**Files:**

- Create: `packages/vfs-root/workspace/skills/slicc-steering/SKILL.md`
- Modify: `docs/shell-reference.md` (substrate section), `docs/architecture.md` (substrate boot path + the bridge), `packages/node-server/CLAUDE.md` (runtime modes table: add substrate), `README.md` (user-facing: `npm run substrate`)
- Test: `npm run lint` covers `lint:skills` + `lint:docs` (the skill frontmatter + doc links are gated in CI).

**Interfaces:**

- Produces: an install-managed native skill documenting the verb surface (`/api/shell/exec` driving `playwright …`, `open`, `mount`, `git`, devices), the **one-time human gesture** for `usb/serial/hid request` + local `mount` (spec §8), state discovery (`ps`, `GET /api/targets`, `GET /api/shell/session/:id`), and the **reconnect/resume recipe** (hold one `X-Slicc-Session` uuid; on a dropped WS, re-probe the session and read `bufferedTail`; if GC'd, `cwd` resets and you start fresh — spec §10).

- [ ] **Step 1:** Write `SKILL.md` with valid frontmatter (`name`, `description`) matching the repo's skill schema (copy the shape from an existing `packages/vfs-root/workspace/skills/*/SKILL.md`). Cover: when to use, the session-uuid discipline, the verb surface with concrete `curl` examples against loopback, the gesture caveat, and the reconnect recipe.
- [ ] **Step 2:** Add the substrate section to `docs/shell-reference.md` + `docs/architecture.md`, the runtime-mode row to `packages/node-server/CLAUDE.md`, and the `npm run substrate` note to `README.md`.
- [ ] **Step 3:** Run `npm run lint` — expect PASS (fix frontmatter/link issues).
- [ ] **Step 4: Commit** — `docs: slicc-steering skill + substrate-mode reference`

---

## Final verification (before finishing the branch)

- [ ] Full gate from the worktree root: `npm run lint && npm run typecheck && npm run test && npm run test:coverage && npm run build && npm run build -w @slicc/chrome-extension`.
- [ ] Confirm coverage for `@slicc/node-server` and `@slicc/webapp` is **at or above** the floors in `coverage-thresholds.json` (the new code must not drop them).
- [ ] Manual smoke: `npm run substrate`, then from another shell `curl -s -X POST localhost:5710/api/shell/exec -H 'X-Slicc-Session: 11111111-1111-1111-1111-111111111111' -H 'content-type: application/json' -d '{"command":"echo hi"}'` → `{"stdout":"hi\n",...,"exitCode":0}`; then `-d '{"command":"playwright navigate https://example.com && playwright screenshot /tmp/x.png"}'` exercises the single CDP authority; then `-d '{"command":"sleep 20 && echo done","stream":true}'` to confirm the long-timeout + NDJSON path.
- [ ] Confirm **no cone scoop** exists in substrate mode (the Task 3 regression test is green) — the two-brains guarantee.

## Out of scope (do not implement here)

- **Phase 2 — MCP skin** (spec §12): `slicc_shell` / `slicc_read` / `slicc_write` / `slicc_targets` / `slicc_screenshot` wrapping these routes. Separate plan.
- **Command-prefix allowlist hardening** (spec §9, "future").
- **Extension-float equivalent** (spec §11) and **Shape C** multi-browser teleport.
- **True incremental (token-level) shell streaming** if `AlmostBashShellHeadless` has no output callback — block-level frames + the long-timeout path are the phase-1 deliverable; file a follow-up.

## Self-review notes

- **Spec coverage:** §4 flag/gate → Tasks 1–3; §6 exec channel + session identity + streaming → Tasks 4–9; §5 HTTP routes → Tasks 6,7,9,10,11; §8 device/mount gesture → documented in Task 12 (no code — already gesture-gated today); §9 security gate reuse → Tasks 6–11 (gate reuse, no new boundary); §10 reconnect + skill → Tasks 7,12; §11 parity → Global Constraints + per-task N/A notes; §14 testing incl. the no-cone regression → Task 3 + every task's tests. §12 MCP and §13 "later" are explicitly out of scope.
- **Naming:** new code uses `substrate-session` / `shell-bridge-handler` / `substrate-api` and the `substrateMode`/`isSubstrate` identifier convention; the cloud-`Substrate` type is never reused.
- **Type consistency:** `ExecResult` / `ExecFrame` / `SessionStatus` / `SubstrateSessionRegistry` / `ShellBridgeDeps` are defined in Tasks 4–5 and consumed unchanged in Tasks 6–11.
