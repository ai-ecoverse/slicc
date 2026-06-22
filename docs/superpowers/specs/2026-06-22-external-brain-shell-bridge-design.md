# External-Brain Shell Bridge — Design

- **Status:** Draft (design only; no code yet)
- **Date:** 2026-06-22
- **Branch:** `design/external-brain-shell-bridge` (local, not pushed)
- **Shape:** "D" from the Claude-Code-steers / SLICC-controls-targets exploration

## 1. Problem & goal

SLICC bundles two separable systems into one browser runtime:

- **The brain** — the agent loop (`pi-agent-core`), context compaction, session
  persistence (IndexedDB/OPFS), the orchestrator. This is the source of the
  session-orchestration instability (uncoordinated IndexedDB writes, lossy
  in-place compaction, scoop-teardown races, hosted-resume hangs, transcript
  OOM).
- **The browser-target substrate** — `BrowserAPI` over a four-transport
  `CDPTransport` interface (local Chrome, `chrome.debugger`, Cherry synthetic
  targets, federated tray targets), plus teleport, mounts, the device bridge,
  secret-masking, and the ~50-command shell. This is the differentiated value.

**Goal:** let an external, stable orchestrator (Claude Code) be the brain while
SLICC remains the substrate. Claude Code owns the conversation/session; SLICC
executes browser + shell work on its fleet of targets.

This eliminates 8 of 9 audited orchestration failure modes by simply not running
that code path, and reframes substrate flakiness (CDP loss, Chrome crash,
reconnect) as isolated, retryable tool-call errors to a robust external brain.

### Why D (not the alternatives)

- **B (raw CDP to Chrome):** works today but reaches only the local Chrome,
  bypasses shell/secrets/approvals, and — proven empirically on 2026-06-22 —
  introduces a _second_ CDP authority. SLICC's `NavigationWatcher` attaches to
  every page target ([navigation-watcher.ts:212](../../../packages/webapp/src/cdp/navigation-watcher.ts)),
  so it cross-attaches to Claude Code's tabs and fires stray `navigate` licks.
- **C (Claude Code as tray leader):** needs a hand-mirrored, version-locked
  tray-sync protocol + WebRTC in Node. Heavy. Defer until multi-browser teleport
  from Claude Code is a real need.
- **E (headless SLICC as a Node library):** `@slicc/webapp` is browser-only
  end-to-end; this is a 4-8 week rewrite. Rejected.

D keeps **one** CDP authority (SLICC's `BrowserAPI`, governed by its tab-lock
mutex), so neither the B contention nor the #1096 proxy-eviction war can occur.

## 2. Non-goals

- No multi-tenant server. Single user, one Claude Code ↔ one SLICC instance.
- No extension-float support in phase 1 (the extension has no node-server;
  see §11 for the parity note).
- No tray-leader (C) or library-port (E) work.
- No new browser-control protocol — everything routes through the existing shell
  and `BrowserAPI`.

## 3. Architecture overview

```
  Claude Code            node-server (already owns Chrome)          browser (webapp, cone idle)
 +-----------+   HTTP   +-------------------------------+   WS    +---------------------------+
 |  brain    |--------->| POST /api/shell/exec          |-------->| kernel worker             |
 | (session, |          | GET/POST /api/vfs/*           | /licks- | TerminalSessionHost       |
 |  retry,   |<---------| POST /api/lick/emit           |  ws*    |   -> AlmostBashShell       |
 |  context) |  result  | GET  /api/targets             |<--------|   -> playwright-cli/mount  |
 +-----------+          +-------------------------------+         |   -> BrowserAPI (1 lock)  |
       ^                         (loopback / bridge-token gated)   +---------------------------+
       |                                                                     |
       +------ optional MCP skin (phase 2): claude mcp add ------------------+

  * WS = WebSocket: a persistent two-way connection. SLICC already runs one at
    /licks-ws (lick-bridge.ts <-> lick-ws-bridge.ts). Phase 1 reuses it; a
    streaming variant is added for long-running output (see §6).
```

**What already exists (why D is thin):**

1. The node-server↔browser request/response bridge:
   [`lick-bridge.ts`](../../../packages/node-server/src/routes/lick-bridge.ts)
   (`sendLickRequest(type, data)` over `/licks-ws`) and its browser side
   [`lick-ws-bridge.ts`](../../../packages/webapp/src/scoops/lick-ws-bridge.ts).
   This is how `/api/webhooks` already reaches in-browser logic.
2. A headless shell-exec primitive:
   [`TerminalSessionHost`](../../../packages/webapp/src/kernel/terminal-session-host.ts#L286)
   spawns a `kind:'shell'` ProcessManager pid and calls
   `shell.executeCommand(cmd, signal)` returning `{stdout, stderr, exitCode}` —
   exactly what the panel terminal uses.
3. A cone-bootstrap gate: `createKernelHost({ skipConeBootstrap })`
   ([host.ts:125, 846](../../../packages/webapp/src/kernel/host.ts#L846)).

**Net-new code is small:** the HTTP routes, a streaming exec message type on the
bridge, a dedicated headless shell session, and the `--substrate` flag wiring.

## 4. Two-brains discipline: the `--substrate` flag

The risk: there is a **single** `BrowserAPI` per webapp instance with one
`attachedTargetId` at a time. If SLICC's cone _and_ Claude Code both drive, both
call `withTab` and thrash the single attached target. We avoid this by not
running a cone in substrate mode.

The gate already exists — we only wire a flag to it. Plumbing mirrors the
existing `?runtime=hosted-leader` path exactly:

1. **CLI flag.** Add `substrate: boolean` to `CliRuntimeFlags`
   ([runtime-flags.ts](../../../packages/node-server/src/runtime-flags.ts)),
   parsed from `--substrate`. Mutually exclusive with `--hosted`.
2. **Launch-URL param.** node-server appends `?substrate=1` to the Chrome launch
   URL (same place it appends `runtime=hosted-leader`,
   [index.ts:645](../../../packages/node-server/src/index.ts#L645)).
3. **Boot honors it.** `main.ts` reads `?substrate=1` and passes
   `skipConeBootstrap: true` into `createKernelHost`. No cone scoop is created →
   no second brain. The shell-exec channel and `BrowserAPI` do not depend on a
   cone, so they work unchanged.

Substrate mode is a _modifier on standalone_, **not** a new `UiRuntimeMode` — the
full standalone UI (and crucially the **panel terminal**) must stay available so
a human can perform device/mount gestures (§9). The chat simply has no cone
selected.

**Off by default — no default flip (DECIDED).** `--substrate` is opt-in and
defaults off everywhere; `npm run dev` is unchanged (a cone bootstraps as today),
so this is non-breaking. There is no "auto-detect a steering launch" — the flag
**is** the qualifier, and it must be set at launch because the cone is
bootstrapped at browser boot, before any external client connects (you can't
cleanly un-bootstrap retroactively). Steering is therefore a distinct entrypoint:
a new `npm run substrate` script (`node-server --dev --substrate`), and the
MCP/steering harness launches node-server with `--substrate` explicitly. `npm run
dev -- --substrate` also works for ad-hoc use.

## 5. HTTP API surface (phase 1, raw)

All routes sit behind the **existing** node-server auth gate (loopback-exempt;
remote requires the per-process thin-bridge token — see §10).

| Route                  | Body / params                            | Returns                                                                      |
| ---------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `POST /api/shell/exec` | `{ command, cwd?, timeoutMs?, stream? }` | `{ stdout, stderr, exitCode, pid }` (or a chunked stream when `stream:true`) |
| `GET  /api/vfs/read`   | `?path=`                                 | file bytes (base64 for binary)                                               |
| `POST /api/vfs/write`  | `{ path, content, encoding? }`           | `{ ok }`                                                                     |
| `GET  /api/vfs/stat`   | `?path=`                                 | `{ type, size, mtime }`                                                      |
| `POST /api/vfs/list`   | `{ path }`                               | `[{ name, type }]`                                                           |
| `POST /api/lick/emit`  | `{ type, data }`                         | `{ ok }` — inject navigate/webhook licks                                     |
| `GET  /api/targets`    | —                                        | `BrowserAPI.listAllTargets()` (local + federated fleet)                      |

`shell/exec` is the workhorse — one verb gives Claude Code the entire substrate
because SLICC is shell-first (`playwright`, `teleport`, `mount`, `git`, devices).
VFS routes are convenience for read/write without round-tripping through `cat`.

## 6. The exec channel & process model

- A new bridge message type, `shell-exec`, on `/licks-ws`. The browser handler
  spawns/uses a **dedicated headless shell session** (a fresh `AlmostBashShell`
  with full-FS access, like the panel terminal — **not** the cone's scoop shell)
  and runs `executeCommand`.
- **Session identity (DECIDED): client-supplied `X-Slicc-Session: <uuid>`,
  create-on-first-use.** Claude Code mints one uuid per working session and
  reuses it on every call — simpler and more reconnect-robust than capturing a
  server-returned id from a first response that might be lost. The kernel keys
  the headless `AlmostBashShell` session by that id and preserves `cwd`, `env`,
  and device/mount handles across calls (so `cd`/handles persist in a workflow).
  On disconnect the session + a bounded recent-output buffer are retained for a
  GC window (not torn down immediately), so re-attach can drain the tail.
- **Re-attach:** `GET /api/shell/session/<id>` returns `{ alive, cwd, runningPids,
bufferedTail }`. Same `X-Slicc-Session` on a new connection re-binds the live
  session; if it was GC'd, the next `exec` transparently creates a fresh one with
  a reset `cwd` (which Claude detects), so a lost long-job's owner knows the tail
  is gone rather than silently continuing on a stale assumption.
- **Streaming transport (DECIDED): chunked HTTP + NDJSON, not SSE.** `exec` is a
  POST that streams its own output, which maps to HTTP `Transfer-Encoding:
chunked`; SSE is GET-oriented pub/sub and the wrong shape. `sendLickRequest` is
  today request/response with a **5s default timeout** — fine for `navigate`,
  wrong for a 3-minute build. Phase 1 adds a streaming variant: the browser emits
  `shell-chunk` WS frames and a terminal `shell-done`; node-server relays them as
  newline-delimited JSON over the chunked HTTP body — `{"t":"stdout","d":"…"}`,
  `{"t":"stderr","d":"…"}`, `{"t":"exit","code":0,"pid":123}`. The MCP skin
  buffers these into a tool result (or maps them to MCP progress). This is the
  main piece of genuinely new transport work.
- **Process control:** each exec is a ProcessManager pid, so `ps` / `kill` /
  SIGINT work and long commands are killable. `command &` backgrounds.

## 7. Browser control — the single authority

Claude Code drives the browser via the shell: `playwright navigate|click|
screenshot`, `open <url>`, `playwright teleport ...`. These all route through the
one `BrowserAPI` ([browser-api.ts](../../../packages/webapp/src/cdp/browser-api.ts)),
whose `withTab` mutex serializes every operation. Because there is exactly one
CDP authority:

- No second CDP client → the B-test `NavigationWatcher` cross-attach cannot
  happen.
- No contention for the single-client `/cdp` proxy slot → the #1096 eviction war
  cannot recur.
- The federated fleet (local + teleport + Cherry + tray followers) is addressable
  through the same connection via `{runtimeId}:{localTargetId}` composite IDs.

## 8. Device pickers & mounts (human-in-the-loop, then headless)

Verified 2026-06-22: only the **picker** needs a user gesture.

- `usb/serial/hid request` and the `mount` local-directory picker require a real
  gesture and run only from the **panel terminal**
  ([usb-command.ts:4-12](../../../packages/webapp/src/shell/supplemental-commands/usb-command.ts#L4)).
- Every other device op forwards over panel-RPC and runs from **any** shell,
  including Claude Code's headless session. A mounted path lives in the shared
  VFS, visible to any shell.

So the workflow is: a human performs the one-time pick in the browser panel
(`usb request`, `mount /some/dir`); from then on Claude Code's headless commands
drive the resulting handle (`usb open usb1`, `cat /mnt/dir/x`) normally. **S3 and
da.live mounts need no gesture** — Claude Code can issue those itself.

This is a feature, not a limitation: the browser stays in the loop for exactly
the operations that physically require a human, and nothing else.

## 9. Security model

**The user's observation is correct: the browser-control surface is already
real.** The B test connected to Chrome's native CDP port and drove the
browser — that is an inherent property of Chrome's remote-debugging, and
node-server already exposes powerful loopback-gated endpoints today
(`/api/fetch-proxy` unmasks secrets; `/api/secrets`). D does **not** introduce a
new trust boundary; it **reuses the same gate** and **widens the blast radius**
from browser-control to full shell + VFS.

Therefore:

- **Reuse, don't invent, the gate:** loopback requests are exempt; remote
  requires the per-process thin-bridge token + origin allowlist
  ([bridge-security.ts](../../../packages/node-server/src/bridge-security.ts)),
  identical to `/cdp` and `/api/fetch-proxy`.
- **Sudo still applies at point of execution.** Commands run through the shell,
  so `SudoManager` command-guards and FS ACLs gate the same way they do for the
  agent today. Secret-masking happens at the fetch-proxy boundary — Claude Code
  never holds raw secrets.
- **Blast-radius acknowledgement:** a gate failure now means arbitrary shell on
  localhost, not just browser control. Mitigations: keep the thin-bridge token
  per-process and never logged (already the case); document that `--substrate`
  is a "trusted-localhost" mode; consider an allowlist of permitted command
  prefixes as a future hardening (not phase 1).

## 10. Disconnect / re-attach & the Claude-facing skill

Long jobs + flaky transports mean Claude Code needs to _know how to steer_ and
how to recover. This is a first-class deliverable, not an afterthought.

- **Re-attach protocol:** on reconnect, the headless session is re-bound by a
  stable session id Claude Code holds. A long exec that outlived a dropped WS
  keeps running in the kernel; Claude Code re-queries via `ps` and reads the
  buffered tail (the headless session retains recent output until drained).
- **A SLICC-steering skill** (`SKILL.md` Claude Code loads): documents the verb
  surface (`slicc_shell`, targets, screenshots), the one-time human gesture for
  devices/mounts, how to discover state (`ps`, `/api/targets`), and the
  reconnect/resume recipe. This is where the "handling" lives — and is a strong
  reason the MCP skin (§12) earns its keep, since typed tools + typed errors make
  the recovery logic robust.

## 11. Cross-runtime parity

- **Standalone-only in phase 1.** D depends on node-server; the extension float
  has no node-server. N/A for extension now. A future extension equivalent would
  relay over `chrome.runtime` (the extension already proxies panel↔offscreen) —
  tracked separately.
- swift-server / ios-app: N/A (followers, not substrate hosts).

## 12. MCP skin (phase 2)

Wrap the phase-1 routes as an MCP server so Claude Code adds it with
`claude mcp add`. Tools: `slicc_shell`, `slicc_read`, `slicc_write`,
`slicc_targets`, and `slicc_screenshot` (the one place binary **image content**
beats base64-in-stdout). Single-tenant, so the multi-client concerns that make a
general MCP server hard do not apply. Small delta over the raw routes; mainly
ergonomics + typed results/errors for the recovery logic.

## 13. Phasing

- **Phase 0 — spike (≤1 day):** prove the round-trip — a throwaway
  `POST /api/shell/exec` that forwards `echo hi` and `playwright navigate` over
  `/licks-ws` and returns output. No streaming, no flag.
- **Phase 1 — raw bridge (~1-2 weeks):**
  1. `--substrate` flag + `?substrate=1` + `skipConeBootstrap` wiring (§4).
  2. `shell-exec` bridge message + dedicated headless session (§6).
  3. Streaming output (chunked) + process control.
  4. The HTTP routes (§5) behind the existing gate.
  5. The SLICC-steering skill + reconnect recipe (§10).
- **Phase 2 — MCP skin (~small delta):** the MCP server wrapping phase 1 (§12).
- **Later (only if needed):** command-prefix allowlist hardening; extension-float
  equivalent; Shape C for multi-browser teleport from Claude Code.

## 14. Testing

- Mirror `packages/*/tests/`. node-server: route auth (loopback vs token),
  exec round-trip, streaming chunk assembly, timeout/kill. webapp: the
  `shell-exec` bridge handler, headless-session lifecycle, `skipConeBootstrap`
  boot. Keep coverage at/above each package floor.
- A regression test asserting substrate mode creates **no** cone scoop (the
  two-brains guarantee).

## 15. Decisions (resolved 2026-06-22)

1. **Flag default → off, explicit opt-in.** No default flip; `npm run dev` is
   unchanged (non-breaking). Steering is a distinct entrypoint (`npm run
substrate` / explicit `--substrate`). The flag is the qualifier; there is no
   auto-detection (the cone boots before any external client connects). See §4.
2. **Session identity → client-supplied `X-Slicc-Session: <uuid>`,
   create-on-first-use,** with a `GET /api/shell/session/<id>` re-attach probe and
   a post-disconnect GC window that retains the output tail. See §6.
3. **Streaming → chunked HTTP + NDJSON frames** (`stdout`/`stderr`/`exit`); SSE
   rejected (GET-oriented, wrong shape for command-scoped output). See §6.
4. **VFS routes → in phase 1.** Cheap wrappers over the same bridge→VFS path, and
   they spare Claude Code `cat`/base64 gymnastics for binary + large writes. Since
   all phases ship, there's no reason to defer them.

## 16. Risks

- Streaming transport is the main net-new complexity; get chunk framing + the
  long-timeout path right or long commands hang.
- Operational discipline: substrate mode must be used for steering, else the cone
  and Claude Code thrash the single `BrowserAPI`. Mitigated by the dedicated
  `npm run substrate` entrypoint + the MCP/steering harness always passing
  `--substrate` (not by a default flip, which would break `npm run dev`).
- Blast radius (§9): the gate must stay tight; it is now full-shell, not just
  browser.
- Disconnect/resume UX for long jobs needs the skill (§10) to be genuinely
  usable, not just present.
