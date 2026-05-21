# Hosted SLICC on e2b — MVP

> **Document status: target architecture / design spec.** Describes an MVP "cloud leader" float that runs the existing SLICC webapp inside an e2b.dev sandbox. Almost all the behavior described here is **not implemented** — this spec is the contract implementation should deliver. Where behavior is already in place (the tray hub on the Cloudflare worker, `LeaderTrayManager`, `EnvSecretStore`, etc.) it is described to anchor the diff. Each line item in §"Components inventory" carries a **(NEW / MODIFIED / EXISTING)** tag.

## Summary

A new fourth float — **hosted-leader** — runs the existing SLICC webapp, node-server, and Chromium inside an [e2b.dev](https://e2b.dev) sandbox started by a local CLI command (`sliccy --cloud start`). The webapp inside the cloud Chromium is the cone **and** the tray leader, identical to standalone CLI mode. It connects outbound to the existing Cloudflare worker (`wss://www.sliccy.ai/controller/:token`), mints a normal tray, and prints the standard `/join/:token` URL back to the user, who attaches from any follower (iOS app, desktop SLICC, browser tab).

The whole product surface is **CLI + an e2b sandbox**. The Cloudflare worker is unchanged except for a small, gated `kind: 'desktop' | 'hosted'` extension that bumps the reclaim TTL to 30 days for hosted trays so paused sessions can survive across days. There is no new server, no new web UI on sliccy.ai, no new authentication surface.

The architectural payoff matches the prior Cloudflare-Sandbox draft: **the cloud agent is the existing webapp.** The build artifact is identical to the desktop CLI build. Cloud is a packaging story, not a fork.

## Current implementation baseline

The following primitives are existing and depended on. Anything _not_ in this list is part of the MVP workstream.

- **Cloudflare worker** at `packages/cloudflare-worker/` exposes `POST /tray`, `GET|POST /controller/:token`, `GET|POST /join/:token`, `POST /webhook/:token/:webhookId`, `GET /handoff`, OAuth and config endpoints, and a SPA fallback. The worker is **a coordination plane, not a data plane**: tray content (chat, agent events, snapshots, CDP requests, fs requests) flows over WebRTC `RTCDataChannel` peer-to-peer between leader and followers, mediated by Cloudflare TURN. Worker WebSocket carries only signaling.
- **Tray DO** (`SessionTrayDurableObject` at `packages/cloudflare-worker/src/session-tray.ts`) holds a `TrayRecord` with `leader: LeaderRecord | null`, controllers, bootstraps, capability tokens. Persistence via `state.storage.put/get` on a single `'tray'` key. `TRAY_RECLAIM_TTL_MS = 60 * 60 * 1000` (1h) in `packages/cloudflare-worker/src/shared.ts` for live-leader-blip recovery.
- **Webapp is the tray leader.** `LeaderTrayManager` lives in `packages/webapp/src/scoops/tray-leader.ts`. It opens the leader WebSocket, runs WebRTC bootstrap, handles control messages. Produces a `LeaderTraySession` record carrying `{trayId, controllerId, controllerUrl, joinUrl, webhookUrl, runtime, ...}`. Constructor option `runtime` is a free-form string used in attach payloads and surfaced to followers. `start()` resolves to the session but fires **no callback** today — only `onReconnected` / `onReconnecting` / `onReconnectGaveUp` exist (`LEADER_TRAY_RECONNECT_MAX_ATTEMPTS = 20`, exponential backoff). On certain attach errors, `shouldRecreateTray` triggers a fresh `POST /tray` and **mints a new joinUrl** — distinct from the reclaim path. node-server has zero tray-leader code.
- **`page-leader-tray.ts`** (`packages/webapp/src/ui/page-leader-tray.ts:190`) hardcodes `runtime: 'slicc-standalone'` and is the only standalone-runtime caller of `LeaderTrayManager`. Auto-start in `main.ts:2687` runs `startPageLeaderTray(buildLeaderTrayOptions(storedWorkerBaseUrl))` only when `storedWorkerBaseUrl` is present in localStorage. Hosted-leader needs an unconditional-start path that does not rely on a prior `host leave --leader` write.
- **`runtime-mode.ts`** at `packages/webapp/src/ui/runtime-mode.ts:11` defines `UiRuntimeMode = 'standalone' | 'extension' | 'electron-overlay' | 'extension-detached'`. `resolveUiRuntimeMode` returns only `electron-overlay` or `standalone` for non-extension. `shouldUseRuntimeModeTrayDefaults` returns true only for `electron-overlay` or `standalone+hasRuntimeConfigEndpoint`. Both must learn `'hosted-leader'`.
- **`/api/runtime-config`** at `packages/node-server/src/index.ts:813` returns `trayWorkerBaseUrl`. The webapp reads it to set the leader's worker URL. Hosted mode must wire this end-to-end (env var at sandbox start → node-server reads → endpoint serves the right value).
- **node-server** at `packages/node-server/` launches Chromium with `--remote-debugging-port=0` (port read from stderr), serves the webapp on port 5710 (falls back if busy), exposes `/api/fetch-proxy`, `/api/secrets/*`, `/cdp`. CDP and webapp ports are dynamic.
- **`EnvSecretStore`** at `packages/node-server/src/secrets/env-secret-store.ts` reads from a file path resolved as `--env-file <path>` flag → `SLICC_SECRETS_FILE` env → `~/.slicc/secrets.env`. The `_DOMAINS` companion is required, not optional. Already supports the path override we need.
- **`SecretProxyManager`** at `packages/node-server/src/secrets/proxy-manager.ts` calls `reload()` once at server boot. No automatic re-read; not a concern for MVP.
- **Tray sync protocol** lives at `packages/webapp/src/scoops/tray-sync-protocol.ts` and is mirrored by the iOS follower at `packages/ios-app/SliccFollower/Models/SyncProtocol.swift`. Hosted leader does not change the wire protocol; existing followers (iOS, desktop, browser) work unmodified.
- **Kernel host** at `packages/webapp/src/kernel/host.ts` is the shared boot sequence (orchestrator + lick-manager + agent-bridge + tray subs + cone bootstrap + `/proc` mount). Hosted-leader reuses it unchanged.
- **`buildChromeLaunchArgs`** at `packages/node-server/src/chrome-launch.ts:155` builds the Chromium argv (CDP port, `--user-data-dir`, `--disable-blink-features=AutomationControlled`, etc.). Container-required flags (`--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--headless=new`) are NOT present today — must be added on a new `--hosted` code path.

## Goals

- A user can run `sliccy --cloud start` from their laptop and within ~3–5 seconds get back a tray join URL that any follower (iOS, desktop, browser) can open to drive the session.
- The hosted runtime reuses the existing webapp and node-server end-to-end. Build artifacts are identical to the desktop CLI build; the e2b template just bakes them in.
- Followers attach via the existing tray protocol with no new transport.
- Pause/resume across days works: `sliccy --cloud pause <id>` parks the session on e2b's storage, `sliccy --cloud resume <id>` brings it back; the leader inside the resumed sandbox reconnects to the same tray with the same controller token.
- Provider credentials reach the cloud sandbox via the existing `EnvSecretStore` boundary — no parallel system, no server-side keychain.
- e2b's `auto_pause: true` handles the 1h (Base) / 24h (Pro) continuous-runtime cap automatically; we never explicitly pause for cap protection.
- Worker change is bounded to a single gated branch (`TrayRecord.kind === 'hosted'`): roughly 50–100 lines across `CreateTrayRequest`, `POST /tray`, the DO internal create, both reclaim sites, the leader-summary deadline, the webapp's `createTraySession` body, and worker tests. Desktop trays are untouched.

## Non-goals

- **OAuth-based providers.** Anthropic OAuth, GitHub OAuth login, Adobe IMS, Google. MVP requires static keys / PATs in `secrets.env`. Documented limitation; punted to vNext.
- **Multi-user / shared cloud sessions.** Each user runs their own CLI with their own e2b API key. No worker-side session ownership, no sliccy.ai account model, no quotas.
- **Web UI on sliccy.ai for cloud sessions.** CLI is the only surface.
- **Crash recovery via periodic snapshots.** A sandbox crash (rare, not the cap path) loses state. No periodic explicit `pause()` checkpoints in MVP.
- **Replacement of the Chrome extension or desktop floats.** Hosted is a fourth float, not a substitute.
- **The prior draft's full lifecycle product** (6-state machine, read-only follower projections, lick-while-asleep, sliccy.ai session UI, IMS gating, multi-tenancy). All explicit non-goals; intentionally out of scope.

## Substrate decision

The compute substrate is **e2b.dev sandboxes** with a custom baked SLICC template. Substrate-specific facts we depend on:

- **Custom templates** with a `start_cmd` captured in the snapshot — sandbox creation boots into an already-running process in ~2–3s ([E2B template docs](https://e2b.dev/docs/sandbox-template)).
- **Pause/resume** via `sandbox.pause()` + `Sandbox.connect(sandboxId)`. Full state (filesystem + memory + processes) preserved. Pause ~4s/GB RAM, resume ~1s, paused indefinitely ([E2B persistence docs](https://e2b.dev/docs/sandbox/persistence)).
- **`auto_pause: true`** at sandbox creation: when the continuous-runtime cap is hit, the sandbox is paused (not killed), state preserved ([E2B issue #875](https://github.com/e2b-dev/e2b/issues/875)).
- **Public URL per port**: `https://{port}-{sandboxId}.e2b.app/`. **Not used by MVP** — leader connects outbound to sliccy.ai; the sandbox URL is never surfaced to users.
- **Outbound internet** is open by default. LLM API calls and the tray controller WebSocket reach the worker / providers unimpeded.
- **Filesystem API on paused-or-running sandboxes**: `sbx.files.read/write` from the SDK, used by the CLI to (a) upload `secrets.env` after `Sandbox.create` and (b) read `/tmp/slicc-join.json` to surface the join URL.
- **Pricing** is per-second compute + memory + storage while running; storage-only while paused ([E2B pricing](https://e2b.dev/pricing)). Pause cost is the dominant lever for letting users park sessions cheaply.

Rejected alternatives:

- **Cloudflare Sandbox** (the prior draft's substrate) — viable but tangles in CF-specific DOs as per-session coordinator and an egress proxy. e2b is simpler for an MVP that does not need worker-mediated session ownership.
- **Self-managed VM (Fly.io, Cloud Run, etc.)** — more operational surface, no built-in pause/resume.

## Architecture

```
                   USER'S MACHINE
   ┌────────────────────────────────────────────┐
   │ Terminal                                   │
   │   $ sliccy --cloud start [--env-file ...]  │
   │   $ sliccy --cloud list / pause / resume   │
   │                                            │
   │ Browser / iOS / Desktop SLICC (FOLLOWER)   │
   │   opens https://www.sliccy.ai/join/<tok>   │
   └─────────────┬──────────────────────────────┘
                 │ (1) CLI calls e2b SDK
                 │     Sandbox.create({template:"slicc", autoPause:true})
                 │     uploads ~/.slicc/secrets.env → /slicc/secrets.env
                 │ (3) CLI reads /tmp/slicc-join.json via sbx.files.read
                 │     prints joinUrl to terminal
                 ▼
       ┌─────────────────────────────────────────┐
       │  E2B Sandbox  (custom slicc template)   │
       │  start_cmd: /usr/local/bin/slicc-start  │
       │  (captured in snapshot — already        │
       │   running on create)                    │
       │                                         │
       │  ┌─ node-server (--hosted) ───────────┐│
       │  │   serves webapp on localhost:5710  ││
       │  │   launches headless Chromium with  ││
       │  │     --user-data-dir=/data/profile  ││
       │  │   exposes POST /api/cloud-status   ││
       │  │     (localhost only)               ││
       │  └──────┬─────────────────────────────┘│
       │         │                              │
       │  ┌─ Chromium ──────────────────────────┐│
       │  │   loads localhost:5710/?            ││
       │  │     runtime=hosted-leader          ││
       │  │                                    ││
       │  │   ┌─ Webapp (cone + tray leader) ─┐││
       │  │   │   Kernel host boots as usual  │││
       │  │   │   LeaderTrayManager runs the  │││
       │  │   │     standard POST /tray flow  │││
       │  │   │   On tray ready (and on every │││
       │  │   │     reconnect), POSTs         │││
       │  │   │     /api/cloud-status with    │││
       │  │   │     {joinUrl, trayId, ...}    │││
       │  │   └──────────────────────────────┘││
       │  └────────────────────────────────────┘│
       │                                         │
       │  Outbound only:                         │
       │    wss://www.sliccy.ai/controller/:tok  │
       │    LLM provider API calls               │
       │    (via SecretProxyManager scrubbing)   │
       └─────────────────────────────────────────┘
                 ▲
                 │ (2) Webapp boots, mints tray
                 │     via existing worker
                 │
       ┌──────────────────────────────────────┐
       │  Cloudflare Worker (UNCHANGED apart  │
       │  from hosted-tray TTL bump)          │
       │  POST /tray                          │
       │  /controller/:token                  │
       │  /join/:token                        │
       │  /webhook/:token/:webhookId          │
       └──────────────────────────────────────┘
```

**Key architectural points.**

1. The e2b sandbox URL (`https://5710-{sandboxId}.e2b.app/`) **is never used**. Everything reaches the user through the existing tray hub. The sandbox is logically a private container.
2. The webapp's behavior inside the cloud Chromium is the same shape as standalone CLI, with the small but real boot deltas required to (a) emit the new `'slicc-hosted-leader'` runtime string, (b) always auto-start the leader regardless of stored localStorage state, (c) fire an `onLeaderReady` callback on initial create (not just on reconnect), (d) include `kind: 'hosted'` in the `POST /tray` body. Detailed in §"Hosted leader boot contract" below.
3. node-server in `--hosted` does **not** speak the tray protocol. It's a thin host: serves the webapp, exposes `/api/cloud-status` for the cloud webapp to publish its `joinUrl`, exposes `/api/leader-restart` for the CLI's resume-kick path, and launches Chromium with container-required flags against a `runtime=hosted-leader` URL with a persistent `--user-data-dir=/data/profile`.
4. The user-data-dir at `/data/profile` is what survives pause/resume. The webapp's IndexedDB (VFS, agent sessions, accounts), cookies, and localStorage all live there.

## Hosted leader boot contract

Everything that has to be true at the moment the cloud Chromium loads `localhost:5710/?runtime=hosted-leader`:

1. **`UiRuntimeMode` learns `'hosted-leader'`.** Added to the union in `packages/webapp/src/ui/runtime-mode.ts`. `resolveUiRuntimeMode(href, isExtension)` returns `'hosted-leader'` when the URL has `?runtime=hosted-leader`. `shouldUseRuntimeModeTrayDefaults` returns true for `'hosted-leader'`, so the cloud webapp learns the worker URL through `/api/runtime-config` the same way standalone does.
2. **Unconditional auto-start.** `main.ts` adds a hosted-leader branch parallel to the existing `storedWorkerBaseUrl ?` fork at ~`main.ts:2687`. Hosted-leader always starts the leader via `startPageLeaderTray(buildLeaderTrayOptions(workerBaseUrl))`, where `workerBaseUrl` is resolved from `/api/runtime-config`. Does not depend on prior localStorage state (the spec's earlier "identical to standalone" framing was wrong on this point).
3. **Runtime string is threaded through.** `startPageLeaderTray` accepts a `runtime` parameter (default `'slicc-standalone'`); the hosted-leader caller passes `'slicc-hosted-leader'`. `buildLeaderTrayOptions` propagates it. `page-leader-tray.ts:190`'s hardcode becomes parameter-driven.
4. **`onLeaderReady` callback exists.** `LeaderTrayManagerOptions` gains `onLeaderReady?: (session: LeaderTraySession) => void`. `start()` calls it after the first `connectOnce()` succeeds, in addition to `onReconnected` firing on subsequent reconnects. The hosted-leader caller passes a callback that POSTs `{joinUrl, trayId, controllerUrl, webhookUrl, runtime, sliccVersion}` to `http://localhost:5710/api/cloud-status` — once on initial create, again on each reconnect.
5. **`kind: 'hosted'` in `POST /tray` body.** `LeaderTrayManagerOptions` gains `kind?: 'desktop' | 'hosted'`. `createTraySession()` includes `kind: this.options.kind ?? 'desktop'` in the body. The hosted-leader caller passes `'hosted'`.
6. **`/api/runtime-config` returns the correct worker URL.** node-server in `--hosted` reads `SLICC_TRAY_WORKER_BASE_URL` from process env (set by the CLI at `Sandbox.create` time via e2b's `envVars` option). The endpoint at `packages/node-server/src/index.ts:813` returns this value. Defaults to `https://www.sliccy.ai` when unset; staging URLs supported for development.

The `onLeaderReady` and `kind` options are additive: legacy callers ignore them, and the worker tolerates a missing `kind` (defaulting to `'desktop'`).

## CLI surface

Five subcommands under `sliccy --cloud`. All call the e2b SDK from the local CLI; no other dependencies.

```
sliccy --cloud start [--env-file <path>] [--name <label>]
  • Reads E2B_API_KEY from process.env or ~/.slicc/secrets.env
  • Reads --env-file or default ~/.slicc/secrets.env
  • Calls Sandbox.create({template: "slicc", autoPause: true,
                          metadata: {sliccVersion, createdBy, name}})
  • Uploads env file: sbx.files.write("/slicc/secrets.env", contents)
  • Polls sbx.files.read("/tmp/slicc-join.json") every 500ms, up to 60s
  • Prints: joinUrl, sandboxId, "Open in iOS / browser / desktop SLICC"
  • Appends entry to ~/.slicc/cloud-sessions.json

sliccy --cloud list
  • Reads ~/.slicc/cloud-sessions.json
  • For each entry, calls sbx.getInfo() to enrich state
  • Prints table: sandboxId, name, state (running|paused|dead), joinUrl, age

sliccy --cloud pause <sandboxId|name>
  • sbx.pause(); updates local registry to state=paused

sliccy --cloud resume <sandboxId|name>
  • sbx = await Sandbox.connect(sandboxId)
  • Issues a "kick" to the resumed leader to recover from the case where
    reconnect attempts had already given up before the pause:
      sbx.commands.run("curl -X POST localhost:5710/api/leader-restart")
    node-server's /api/leader-restart endpoint (--hosted only) signals the
    cloud webapp via CDP Page.reload(). After the reload, the
    hosted-leader boot path runs again and posts a fresh
    /api/cloud-status.
  • Polls /tmp/slicc-join.json for a monotonic-newer updatedAt than the
    last-seen value in ~/.slicc/cloud-sessions.json (mtime is unreliable
    across container restore).
  • If the webapp had to recreate the tray (shouldRecreateTray path —
    a different failure mode than reclaim, distinguished by the
    payload's trayId differing from the stored one), CLI updates the
    local registry with the new joinUrl and surfaces a clear "tray
    was rebuilt; a new join URL is in effect; followers must re-attach"
    notice. Old followers fail with 404 on the stale token.
  • If the running sandbox's template version (read from sandbox
    metadata.sliccVersion) differs from the local CLI's, prints a soft
    warning but proceeds.
  • Prints joinUrl (same or new).

sliccy --cloud kill <sandboxId|name>
  • sbx.kill(); removes registry entry
```

**Local registry** (`~/.slicc/cloud-sessions.json`):

```json
{
  "sessions": [
    {
      "sandboxId": "ix7p9q...",
      "name": "task-1",
      "createdAt": "2026-05-22T12:00:00Z",
      "joinUrl": "https://www.sliccy.ai/join/<token>",
      "lastSeen": "2026-05-22T14:30:00Z",
      "state": "running"
    }
  ]
}
```

**Auth source resolution.** `E2B_API_KEY` from `process.env` wins; falls back to the same key parsed out of `~/.slicc/secrets.env` (with the existing `_DOMAINS=e2b.dev` annotation, required by `EnvSecretStore`). If neither source has a key, CLI errors with a friendly setup hint.

## node-server `--hosted` mode

A thin shim around the existing CLI boot. Differences from default:

| Default standalone                                  | `--hosted`                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auto-opens user's local browser to `localhost:5710` | Disabled. Chromium is launched headlessly inside the sandbox against `localhost:5710/?runtime=hosted-leader` (headful + Xvfb is future work, tied to OAuth provider support).                                        |
| Vite HMR enabled in dev                             | Disabled. Serves built static assets from `/opt/slicc/ui`.                                                                                                                                                           |
| `EnvSecretStore` resolves `~/.slicc/secrets.env`    | Resolves `/slicc/secrets.env` via existing `SLICC_SECRETS_FILE` env.                                                                                                                                                 |
| Chrome `--user-data-dir=<tmp>` per-port             | `--user-data-dir=/data/profile` (persistent across pause/resume).                                                                                                                                                    |
| Chrome args from `buildChromeLaunchArgs` only       | Hosted code path adds container flags: `--headless=new`, `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--font-render-hinting=none`. Without these, Chromium fails to start in unprivileged sandboxes. |
| `trayWorkerBaseUrl` resolved from `--lead`/Vite env | Reads `SLICC_TRAY_WORKER_BASE_URL` env (set by CLI at sandbox-create via e2b `envVars`). Default `https://www.sliccy.ai`.                                                                                            |
| No `/api/cloud-status`                              | Adds `POST /api/cloud-status` (localhost only).                                                                                                                                                                      |
| No `/api/leader-restart`                            | Adds `POST /api/leader-restart` (localhost only). Triggers a CDP `Page.reload()` against the local webapp tab; CLI uses this on resume to recover the leader from a pre-pause `onReconnectGaveUp` state.             |

**`/api/cloud-status` contract.** Localhost only, no auth (sandbox is a private execution boundary).

```ts
app.post('/api/cloud-status', express.json(), (req, res) => {
  const { joinUrl, trayId, controllerUrl, webhookUrl, runtime } = req.body;
  if (typeof joinUrl !== 'string') return res.status(400).end();
  fs.writeFileSync(
    '/tmp/slicc-join.json',
    JSON.stringify({
      joinUrl,
      trayId,
      controllerUrl,
      webhookUrl,
      runtime,
      updatedAt: new Date().toISOString(),
    })
  );
  res.json({ ok: true });
});
```

The file lives at `/tmp/slicc-join.json` because the CLI's polling step is a one-liner: `await sbx.files.read('/tmp/slicc-join.json')`. Each `POST /api/cloud-status` overwrites it, so the file's `mtime` (or a monotonic `updatedAt`) is the signal a re-mint has happened on resume.

## webapp `hosted-leader` runtime

See §"Hosted leader boot contract" above for the full set of changes; this section summarizes the diff:

- `packages/webapp/src/ui/runtime-mode.ts`: add `'hosted-leader'` to `UiRuntimeMode`; teach `resolveUiRuntimeMode` and `shouldUseRuntimeModeTrayDefaults` about it.
- `packages/webapp/src/scoops/tray-leader.ts`: add `onLeaderReady` to `LeaderTrayManagerOptions` and fire from `start()` after the first successful `connectOnce()`. Add `kind?: 'desktop' | 'hosted'` to options; include in `createTraySession` body.
- `packages/webapp/src/ui/page-leader-tray.ts`: accept `runtime` and `kind` parameters; remove the `'slicc-standalone'` hardcode.
- `packages/webapp/src/ui/main.ts`: add a hosted-leader branch in the tray-block that always starts the leader (independent of localStorage state), threading `runtime='slicc-hosted-leader'` and `kind='hosted'` through, plus an `onLeaderReady` callback that POSTs to `/api/cloud-status`.

The `'hosted-leader'` runtime label is informational from the tray protocol's perspective — followers see it but don't branch on it. The label exists so the worker (via `kind`) and the local boot path can branch.

## e2b template

A new package at `packages/dev-tools/e2b-template/`.

**Layout:**

```
packages/dev-tools/e2b-template/
  e2b.Dockerfile       # base image + Chromium + Node + bundled webapp + start command
  e2b.toml             # e2b template config: name=slicc, start_cmd, resources
  start.sh             # entrypoint: exec node-server --hosted
  package.json         # version pinning; "build" script invokes e2b CLI
  scripts/
    build-template.sh  # wraps `e2b template build` with the right tag
    verify-template.sh # spins one sandbox, asserts /tmp/slicc-join.json, kills
  README.md
```

**Dockerfile sketch (resources tunable):**

```dockerfile
FROM e2bdev/code-interpreter:latest
RUN apt-get update && apt-get install -y \
    chromium-browser fonts-liberation libnss3 libatk-bridge2.0-0 \
    libgtk-3-0 libxss1 libasound2 \
 && rm -rf /var/lib/apt/lists/*

COPY dist/node-server  /opt/slicc/node-server
COPY dist/ui           /opt/slicc/ui
COPY packages/dev-tools/e2b-template/start.sh /usr/local/bin/slicc-start
RUN chmod +x /usr/local/bin/slicc-start

RUN mkdir -p /data/profile /slicc

ENV SLICC_HOSTED=1
ENV SLICC_SECRETS_FILE=/slicc/secrets.env
ENV CHROME_USER_DATA_DIR=/data/profile

EXPOSE 5710
```

**`e2b.toml`:**

```toml
template_name = "slicc"
team_id = "<adobe-team-id>"
cpu_count = 2
memory_mb = 2048
start_cmd = "slicc-start"
```

**`start.sh`:**

```bash
#!/bin/sh
set -e
exec /opt/slicc/node-server/dist/index.js --hosted --port 5710 --no-open
```

**Build pipeline.**

1. `npm run build` at repo root → produces `dist/node-server/` + `dist/ui/`.
2. `npm run build -w @slicc/e2b-template` → calls `e2b template build`, publishes a new template version tagged with the SLICC release version (`metadata.sliccVersion`).
3. Release gate (CI): rebuild + republish template; run `verify-template.sh` against the freshly published template.

**Resource sizing.** 2 vCPU / 2 GB memory chosen as the baseline. Pause time scales ~4s/GB RAM, so 2 GB = ~8s to pause. We will revisit when we have real workloads.

**Base image choice.** Chromium-from-apt over Google Chrome (no extra license terms, CDP-equivalent). **Headless Chromium** (`--headless=new`) for MVP — OAuth providers are out of MVP scope, so the headless-breaks-login-flows objection does not apply yet. Future work: switch to headful + Xvfb (or e2b's desktop image variant) once we add OAuth provider support.

## Pause / resume flow

```
PAUSE
1. CLI: sliccy --cloud pause <id> | OR | e2b auto-pause on runtime cap
2. e2b serializes container state: FS at /data + /slicc, memory of all
   running processes (node-server, Chromium, the webapp page), open
   file descriptors (NOT open sockets).
3. Sandbox is "paused" — billed for storage only, no compute.

RESUME
1. CLI: sliccy --cloud resume <id>
2. sbx = await Sandbox.connect(<sandboxId>) — restore container, ~1s+
3. node-server is alive; Chromium is alive; webapp page is alive mid-frame.
4. Webapp's LeaderTrayManager auto-reconnect loop detects the dead WebSocket
   and reconnects to /controller/:token with the SAME controller token
   (still held in IndexedDB inside the persisted profile dir).
5. Worker's SessionTrayDO recognizes the returning leader via the reclaim
   window. With the hosted-tray TTL bump (below), this works up to 30 days.
6. LeaderTrayManager's onReconnected fires → onLeaderReady → POST
   /api/cloud-status → /tmp/slicc-join.json refreshed.
7. CLI's resume command polls for the file mtime to advance, then prints
   the joinUrl (which is the same URL as before — the controller token
   didn't change).
```

**What survives:** the entire profile dir, all IndexedDB databases (`slicc-fs`, `slicc-fs-global`, `slicc-groups`, `agent-sessions`, `browser-coding-agent`), localStorage (including `slicc_accounts`), the webapp's running JS heap, the orchestrator, the WasmShell, in-flight scoop tab state, scoop conversation history, mounts metadata.

**What does NOT survive:** TCP sockets (WebSocket to the worker, CDP socket — both auto-reconnect), TURN allocations (renegotiated on follower reconnect).

### Hosted-tray `kind` plumbing and reclaim TTL bump

The current `TRAY_RECLAIM_TTL_MS = 60 * 60 * 1000` (1h) in `packages/cloudflare-worker/src/shared.ts` is designed for desktop "wifi-blip" reclaim. A 30-day pause exceeds it, and the worker GCs the leader slot.

**Change:** introduce a `kind: 'desktop' | 'hosted'` field on `TrayRecord`, populated at `POST /tray` from the request body, and branch the reclaim TTL on it. This is **not a one-liner** — the touch list is:

| File                                                | Change                                                                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cloudflare-worker/src/shared.ts`          | Add `HOSTED_TRAY_RECLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000`. Add `kind: 'desktop' \| 'hosted'` to `CreateTrayRequest` (optional, defaults to `'desktop'`). Add `kind` to `TrayRecord`. |
| `packages/cloudflare-worker/src/index.ts`           | `POST /tray` handler reads `kind` from request body, defaults `'desktop'`, forwards to DO internal create.                                                                             |
| `packages/cloudflare-worker/src/session-tray.ts`    | Persist `kind` on the `TrayRecord`. Branch the reclaim TTL at both existing sites (the disconnect-grace at ~line 1106 and the `leaderSummary().reconnectDeadline` at ~line 698).       |
| `packages/webapp/src/scoops/tray-leader.ts`         | `createTraySession()` body includes `kind: this.options.kind ?? 'desktop'`.                                                                                                            |
| `packages/cloudflare-worker/tests/index.test.ts`    | Cover `kind=hosted` create path; assert 30d deadline surfaces in `leaderSummary`.                                                                                                      |
| `packages/cloudflare-worker/tests/deployed.test.ts` | Smoke check the new field shape against deployed staging (worker-routes-mirror rule).                                                                                                  |

Estimated 50–100 lines including tests. Desktop trays are untouched: `kind` defaults to `'desktop'` everywhere, and the existing 1h reclaim is preserved on that branch.

```ts
const reclaimMs = tray.kind === 'hosted' ? HOSTED_TRAY_RECLAIM_TTL_MS : TRAY_RECLAIM_TTL_MS;
```

## Components inventory

| Path / artifact                                     | Status                                   | Notes                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dev-tools/e2b-template/`                  | **NEW** directory (NOT an npm workspace) | Dockerfile, e2b.toml, start.sh, build scripts. Owns template version pinning. Carries its own `package.json` only if needed by the `e2b template build` tooling; not part of `workspaces` in root `package.json`.                                                             |
| `packages/node-server/src/cloud/`                   | **NEW** subdirectory                     | `start.ts`, `list.ts`, `pause.ts`, `resume.ts`, `kill.ts` — one file per subcommand. `registry.ts` for `~/.slicc/cloud-sessions.json` I/O. `e2b-client.ts` for SDK wrapping.                                                                                                  |
| `packages/node-server/src/index.ts`                 | **MODIFIED**                             | New `--hosted` flag (parallels `--serve-only`); new `--cloud <subcmd>` dispatcher. The hosted flag triggers container Chrome args, disables auto-open, registers `/api/cloud-status` and `/api/leader-restart`. `/api/runtime-config` reads `SLICC_TRAY_WORKER_BASE_URL` env. |
| `packages/node-server/src/chrome-launch.ts`         | **MODIFIED**                             | New `--hosted` code path that appends container flags (`--headless=new`, `--no-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--font-render-hinting=none`). Honors `CHROME_USER_DATA_DIR` env. Non-hosted path unchanged.                                             |
| `packages/webapp/src/ui/runtime-mode.ts`            | **MODIFIED**                             | Add `'hosted-leader'` to `UiRuntimeMode`; teach `resolveUiRuntimeMode` and `shouldUseRuntimeModeTrayDefaults` about it.                                                                                                                                                       |
| `packages/webapp/src/ui/main.ts`                    | **MODIFIED**                             | hosted-leader branch in the tray-block at ~line 2687 always starts the leader regardless of stored localStorage, threading `runtime='slicc-hosted-leader'` and `kind='hosted'`, plus an `onLeaderReady` callback POSTing to `/api/cloud-status`.                              |
| `packages/webapp/src/ui/page-leader-tray.ts`        | **MODIFIED**                             | Accept `runtime` and `kind` parameters; remove the `runtime: 'slicc-standalone'` hardcode at line 190.                                                                                                                                                                        |
| `packages/webapp/src/scoops/tray-leader.ts`         | **MODIFIED**                             | Add `onLeaderReady?: (session: LeaderTraySession) => void` option; fire from `start()` after the first successful `connectOnce()`. Add `kind?: 'desktop' \| 'hosted'` option; include in `createTraySession()` body.                                                          |
| `packages/cloudflare-worker/src/shared.ts`          | **MODIFIED**                             | Add `HOSTED_TRAY_RECLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000`. Add optional `kind` to `CreateTrayRequest`. Add `kind` to `TrayRecord`.                                                                                                                                          |
| `packages/cloudflare-worker/src/index.ts`           | **MODIFIED**                             | `POST /tray` handler reads `kind` from request body (default `'desktop'`); forwards to DO internal create.                                                                                                                                                                    |
| `packages/cloudflare-worker/src/session-tray.ts`    | **MODIFIED**                             | Persist `kind` on `TrayRecord`. Branch reclaim TTL at both sites: the disconnect-grace at ~line 1106 AND `leaderSummary().reconnectDeadline` at ~line 698.                                                                                                                    |
| `packages/cloudflare-worker/tests/index.test.ts`    | **MODIFIED**                             | Cover the `kind=hosted` POST /tray branch, the 30-day reclaim window, and the new `reconnectDeadline` for hosted trays.                                                                                                                                                       |
| `packages/cloudflare-worker/tests/deployed.test.ts` | **MODIFIED**                             | Smoke check the new field shape on the deployed staging worker (worker-routes-mirror rule).                                                                                                                                                                                   |
| `packages/node-server/tests/cloud/*`                | **NEW** tests                            | Mock e2b SDK; verify subcommand parsing, registry I/O, polling, the resume-kick / page-reload path, monotonic `updatedAt` semantics, template-version-mismatch warning.                                                                                                       |
| `packages/node-server/tests/cloud-live.test.ts`     | **NEW** opt-in test                      | Gated by `SLICC_TEST_E2B_API_KEY` (matching `feat/s3-da-mounts` `test:live`). Excluded from CI. Asserts full create → cloud-status → tray-join → pause → resume → still-works cycle.                                                                                          |
| `packages/webapp/tests/scoops/tray-leader.test.ts`  | **MODIFIED**                             | Verify `onLeaderReady` fires on initial create AND on each reconnect; verify `kind` is included in `POST /tray` body when set.                                                                                                                                                |
| `README.md`                                         | **MODIFIED**                             | New section "Cloud (`sliccy --cloud`)" — quickstart, prerequisites (e2b account, secrets.env), known limitations (no OAuth providers, no FS-Access mounts, 30-day pause cliff).                                                                                               |
| `docs/architecture.md`                              | **MODIFIED**                             | Add the hosted-leader float to the floats list and the subsystem map.                                                                                                                                                                                                         |
| `docs/shell-reference.md`                           | **MODIFIED**                             | Document the `--cloud` subcommands.                                                                                                                                                                                                                                           |
| `CLAUDE.md` (root)                                  | **MODIFIED**                             | Add "Cloud (hosted-leader) float" to the Floats list under "Concepts".                                                                                                                                                                                                        |
| `packages/node-server/CLAUDE.md`                    | **MODIFIED**                             | Document `--hosted` mode and `--cloud` subcommands.                                                                                                                                                                                                                           |
| `packages/cloudflare-worker/CLAUDE.md`              | **MODIFIED**                             | Document the `kind: 'desktop' \| 'hosted'` TrayRecord branch and `HOSTED_TRAY_RECLAIM_TTL_MS`.                                                                                                                                                                                |

Nothing else is touched. No new npm workspaces (template lives as a folder, not a workspace). New external dependency: the e2b TypeScript SDK package (currently published as `e2b` on npm) in `packages/node-server/package.json` — exact name and version pin confirmed at implementation time.

## Failure modes

1. **e2b API error during `--cloud start`.** CLI surfaces the error; sandbox is killed (if it got created). User retries.
2. **Sandbox crash mid-session.** Distinct from the auto-pause-on-cap path. State is lost. Follower sees a tray-disconnect and the standard "leader gone" UX; user runs `--cloud start` again. **MVP accepts this.** Future work may add periodic explicit `pause()` snapshots for crash insurance.
3. **Pause failure** (e2b SDK error). CLI reports honestly; updates `~/.slicc/cloud-sessions.json` based on actual `sbx.getInfo()` state.
4. **Resume failure** (e2b SDK error, sandbox no longer exists, etc.). CLI reports cleanly, suggests `--cloud kill` to remove the stale entry.
5. **Leader had given up reconnecting before pause.** With `LEADER_TRAY_RECONNECT_MAX_ATTEMPTS = 20` and exponential backoff (~minutes), if the sandbox lost network before e2b auto-paused, the leader can be in `onReconnectGaveUp` state. The webapp's reconnect loop is dormant on resume. **Mitigation:** `--cloud resume` always issues `POST localhost:5710/api/leader-restart`, which triggers a CDP `Page.reload()`. After reload, the hosted-leader boot path runs from scratch and reclaims the tray (or rebuilds via `shouldRecreateTray` — see #6).
6. **Tray is gone (not just reclaim-window-expired) on resume.** If pause exceeded 30 days, or the worker GC'd the tray for any other reason, `LeaderTrayManager`'s `claimLeaderSession` hits a `shouldRecreateTray` error path and mints a **new tray with a new joinUrl**. CLI detects this by comparing the `trayId` in the refreshed `/tmp/slicc-join.json` to the stored one, updates `~/.slicc/cloud-sessions.json`, and surfaces a "tray was rebuilt; new join URL — existing followers must re-attach" notice. Old `/join/:token` URLs fail with 404.
7. **node-server fails to come up inside the sandbox.** CLI poll on `/tmp/slicc-join.json` times out after 60s. CLI prints the last 50 lines of `/tmp/slicc-stderr.log` (start.sh redirects node-server stderr there) and kills the sandbox.
8. **Provider credential invalid.** Identical to local CLI — agent errors propagate to the follower's chat UI. No special handling.
9. **secrets.env upload fails after `Sandbox.create`** (e.g., e2b filesystem error). CLI kills the sandbox and errors out before announcing success.
10. **Template version mismatch on resume.** If the running sandbox's `metadata.sliccVersion` differs from the local CLI's package version, CLI prints a soft warning but proceeds. Protocol skew between leader and follower is possible; user can `--cloud kill` and `--cloud start` to get a fresh sandbox on the current template.
11. **Race: `--cloud pause` invoked while leader is mid-reconnect.** Pause may snapshot a transient state. On resume, the reconnect attempt either completes against the worker (most likely if the reconnect window hadn't given up) or triggers the `--cloud resume` page-reload kick. Practical impact: extra ~1-2s of recovery; no data loss.

## Testing strategy

- **Unit tests (`packages/node-server/tests/cloud/`)**: mock the e2b SDK. Verify subcommand parsing, registry serialization, polling behavior, error paths. Achievable in CI with no network.
- **Unit tests for `--hosted` mode** (`packages/node-server/tests/index.test.ts`): cover the new flag, the `/api/cloud-status` endpoint, the env-path override.
- **Webapp test** (`packages/webapp/tests/scoops/tray-leader.test.ts`): the `onLeaderReady` callback is invoked on initial create and on each reconnect.
- **Worker tests** (`packages/cloudflare-worker/tests/index.test.ts`, `tests/deployed.test.ts`): `kind=hosted` branch on `POST /tray`, longer reclaim window. Per the worker routes mirror rule, both files updated.
- **Live e2b harness** (`packages/node-server/tests/cloud-live.test.ts`): gated by `SLICC_TEST_E2B_API_KEY` env var (matching the `feat/s3-da-mounts` `test:live` pattern). Excluded from CI. Asserts the full create → /api/cloud-status → tray-join → pause → resume → still-works cycle. Run locally pre-release.
- **Template verification** (`packages/dev-tools/e2b-template/scripts/verify-template.sh`): one sandbox spin-up, `/tmp/slicc-join.json` assert, kill. Wired into the release gate.

Coverage thresholds: new `packages/node-server/src/cloud/` code must stay above the existing 65% lines/statements/functions, 55% branches floor for node-server. New webapp code follows the global 50/40 floor.

## Phasing

The TTL bump moves earlier (was Phase 3, now Phase 1) so pause/resume work end-to-end the moment we ship it.

1. **Phase 1 — hosted-tray `kind` + 30-day TTL.** Worker change: add `kind` to `CreateTrayRequest` and `TrayRecord`, branch both reclaim sites, mirror both test files per the worker routes rule. Smallest reviewable diff; no behavior change for desktop trays. Ships first so subsequent phases land on a worker that already understands hosted trays.
2. **Phase 2 — webapp hosted-leader boot path.** `UiRuntimeMode` extension, `runtime-mode` helpers, `page-leader-tray` parameterization, `LeaderTrayManager` `onLeaderReady` + `kind`, `main.ts` hosted-leader branch. End state: a webapp built from main, loaded with `?runtime=hosted-leader`, mints a hosted tray.
3. **Phase 3 — node-server `--hosted` + e2b template.** `--hosted` flag, container Chrome args, `/api/cloud-status` and `/api/leader-restart`, env-driven runtime-config, the `packages/dev-tools/e2b-template/` template + Dockerfile + build scripts. End state: a manually-created e2b sandbox boots, follower can attach.
4. **Phase 4 — `--cloud` CLI surface.** `start / list / pause / resume / kill`, registry I/O, monotonic `updatedAt` polling, resume-kick path, template-version-mismatch warning, `shouldRecreateTray` distinction handling. End state: full MVP loop works on a developer's laptop, including pause-for-days.
5. **Phase 5 — release pipeline.** Live e2b harness wired up, template build CI, README + docs updates, dogfooding pass.

Each phase is independently shippable and reviewable. Phases 2–4 are the bulk of the work; 1 is a tight worker patch landed first to avoid cross-phase resume cliffs; 5 is plumbing.

## Known limitations (accepted)

- **OAuth-based providers.** Anthropic OAuth, GitHub OAuth, Adobe IMS, Google not supported. Static keys / PATs only via `secrets.env`. Roadmap'd: a tray-mediated OAuth relay where the follower's browser performs the OAuth flow and pushes the token to the cloud leader. Out of MVP scope.
- **Single-user.** CLI uses the user's own e2b account; no shared sessions.
- **No web UI on sliccy.ai for cloud sessions.** CLI only.
- **Sandbox crash** (distinct from auto-pause-on-cap) loses state. No periodic snapshots in MVP.
- **Pause beyond 30 days** exceeds the bumped reclaim TTL. The leader will mint a fresh tray with a new joinUrl (`shouldRecreateTray` path); CLI surfaces the URL change and old followers fail with 404. Acceptable cliff.
- **Webhooks / crons / fswatch / sprinkle / navigate licks while paused.** Worker returns `410 NO_LIVE_LEADER` for webhook deliveries to a hosted tray with a paused leader (same as a desktop tray with a dead leader today — no special hosted-tray behavior). Cron/fswatch live in the paused webapp, do not fire. Explicit non-goal; documented.
- **Local FS-Access mounts.** `mount --source <local-dir>` needs `showDirectoryPicker` and a user gesture, neither of which exist in headless cloud Chromium. S3 / S3-compatible / DA mounts via `secrets.env`-resolved credentials work as on desktop. Documented in README.
- **Paused-sandbox secrets visibility.** `/slicc/secrets.env` lives on the sandbox's persisted disk. Anyone with access to the e2b team account (dashboard or API) can attach to a paused sandbox and read its filesystem. Treat the e2b team account as a credential boundary equivalent to the local laptop's filesystem. Documented in README.
- **e2b tier caps.** Free tier: 20 concurrent sandboxes, 1h sessions. Pro tier ($150/mo): 100 concurrent + 24h sessions. Pause/resume resets the runtime clock either way. Documented in README.
- **Local CLI registry only.** `~/.slicc/cloud-sessions.json` is machine-local. Sessions created on laptop A are not visible from laptop B. `--cloud list` always queries e2b's API as well, so unknown-but-running sandboxes show up; the local registry just adds `name` and `joinUrl` cache.

## Open questions (genuinely open)

1. **e2b team account ID** — confirmed exists; specific team_id to bake into `e2b.toml` needs to be supplied at implementation time. Implementation-time concern, not design-time.
2. **`@e2b/sdk` package name and version pin.** Current name as of design time is `e2b` on npm (TS SDK). To be confirmed when wiring into `packages/node-server/package.json`.
3. **Chromium auto-update inside the template.** The template snapshot pins Chromium to whatever was in `apt` at build time. Updating Chromium requires a template rebuild. Acceptable; documented in `packages/dev-tools/e2b-template/README.md`.
4. **`/data/profile` size growth.** Long-running paused sessions accumulate IndexedDB / mount data. Pricing implication via paused storage costs. Punt until we observe real usage.

## Future work

- **OAuth relay via the follower.** Adds the missing provider class. Tray-mediated; preserves the "credentials never leave the user's machine" model for the OAuth flow itself.
- **Periodic snapshot for crash recovery.** Cheap, opt-in `--cloud start --snapshot-every 10m`.
- **Worker-side `--cloud` (Approach B from brainstorm).** Worker holds an e2b key on behalf of users without an e2b account; web UI at `sliccy.ai/cloud`. Builds on top of MVP without rewiring it.
- **Token re-mint on resume.** Removes the 30-day cliff; CLI calls a small worker endpoint, gets a fresh controller token, pushes into the resumed sandbox via `sbx.commands.run` writing to webapp localStorage. Implementation cost: ~2 days.
- **Wake-on-webhook for hosted trays.** Worker endpoint that calls e2b `Sandbox.connect()` (resume) when a webhook arrives for a paused hosted tray, then forwards the webhook event after the leader reconnects. Removes the "no webhooks while paused" limitation.
- **`--cloud logs <id>`.** Stream `/tmp/slicc-stderr.log` and chromium console via e2b SDK. Necessary for production-quality debugging.
- **Cost hygiene.** `--cloud list` decorated with estimated storage cost per paused sandbox; opt-in `--cloud gc --older-than 7d`.
- **Cloud as a tool for the cone.** A `cloud` shell command lets the cone spawn cloud follower sandboxes for delegated work. Builds on the MVP CLI as a library, not a fork.
- **Multi-laptop registry sync.** Store `~/.slicc/cloud-sessions.json` to a synced location (iCloud / a private gist / R2 keyed off Adobe IMS) so the same paused sandbox is `list`-visible from any of the user's machines.
