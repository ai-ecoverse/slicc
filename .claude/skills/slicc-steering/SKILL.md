---
name: slicc-steering
description: |
  Use this skill when you need to drive a running `npm run substrate` SLICC instance
  from an external Claude Code orchestrator over loopback HTTP. Covers session identity,
  shell exec (streaming and non-streaming), VFS read/write, browser control via
  playwright shell commands, the one-time device/mount gesture caveat, state discovery,
  and the reconnect/resume recipe after a dropped connection.
---

# slicc-steering

Substrate mode exposes the SLICC shell, VFS, browser targets, and lick injection over
loopback HTTP so an external Claude Code orchestrator can drive SLICC without touching
the cone. There is no cone in substrate mode — commands run in headless
`AlmostBashShellHeadless` sessions keyed by a caller-supplied UUID.

**Only available in the standalone CLI float.** The Chrome extension has no node-server
(spec §11); substrate mode is not available there.

## Launch

```bash
npm run substrate           # = tsx packages/node-server/src/index.ts --substrate
# or, with the UI served by a local wrangler on :8787 (start it first; see dev:standalone:fresh):
npm run substrate-dev       # = WORKER_BASE_URL=http://localhost:8787 tsx packages/node-server/src/index.ts --substrate
```

Chrome boots with `?substrate=1` → `skipConeBootstrap` → exactly one CDP authority.
Default UI port: `5710`. Mutually exclusive with `--hosted`.

> **Prefer an isolated profile/port for steering.** The default port `5710` shares one
> Chrome profile with every other SLICC instance, so substrate inherits that profile's
> saved accounts, version marker, and any persisted session (which can fire benign
> page-side LLM calls on boot). `PORT=5720 npm run substrate` gives an isolated profile
> (`browser-coding-agent-chrome-5720`) and its own IndexedDB — cleaner for headless
> steering. (Tray auto-join is already suppressed in substrate regardless of port.)

## Discover or attach to a running instance

A substrate instance is a long-lived, shared bridge: any number of orchestrator
sessions can drive **one** instance concurrently, each with its **own**
`X-Slicc-Session`. **Probe before you launch** — re-running `npm run substrate` while one
is already up does **not** attach; it boots a second independent instance on the next
free port (5711…), and the only hint is a `Port 5710 in use, serving on port 5711` log
line.

```bash
# 1. Find the port (default 5710; a non-default instance records its port here).
PORT=$(jq -r '.port // 5710' ~/.slicc/substrate.json 2>/dev/null || echo 5710)

# 2. Confirm a *live substrate* actually answers there. The file is only a hint —
#    a hard crash (SIGKILL) leaves it behind — so the probe is the real liveness check.
if curl -fsS "http://localhost:$PORT/api/status" | jq -e '.substrate == true' >/dev/null 2>&1; then
  echo "Attach: reuse http://localhost:$PORT with a fresh X-Slicc-Session UUID"
else
  echo "Launch: PORT=$PORT npm run substrate"   # nothing live here
fi
```

`GET /api/status` returns `{ status, service, timestamp, substrate, servePort, pid }`;
`substrate: true` is what distinguishes a steering bridge from a plain `npm run dev`
leader. The discovery file `~/.slicc/substrate.json` (`{ port, pid, startedAt }`) is
written on boot and cleared on exit.

**Shared vs isolated when several sessions attach to one instance:** each
`X-Slicc-Session` gets its own headless shell — `cwd`, `env`, and device/mount handles are
isolated per session. But the **VFS** (one OPFS) and the **browser** (one CDP authority)
are shared singletons, so coordinate `/workspace` writes and browser navigation across
concurrent drivers.

## Auth

Substrate binds **loopback only** (`127.0.0.1`) and is **trusted-localhost** by design
(spec §9): any local caller drives the bridge **ungated** — plain `curl localhost:5710/...`
works with no token. The `127.0.0.1` bind is the trust boundary, so treat anything that can
reach the port as fully trusted — it can run arbitrary shell commands on the host.

> A per-process **bridge token is minted** (substrate is thin-bridge): it gates the `/cdp`
> WebSocket and the cross-origin `/api` CORS gate — the hosted leader's same-token requests
> are allowed, others get `403`, and non-allowlisted browser origins are CORS-blocked. The
> steering routes (`/api/shell/exec`…) are additionally **loopback-only** via a `Host`-header
> guard. Loopback / no-Origin callers pass ungated — that's the supported steering path.
> Remote steering isn't possible because the server binds `127.0.0.1` and the Host guard
> rejects non-loopback `Host` headers — _not_ because a token is absent.

## Session identity

Mint **one** `X-Slicc-Session` UUID per working session and reuse it on every call.
The kernel keys a persistent headless shell by this UUID so `cd`, `env`, and
device/mount handles persist across calls. Sessions idle > 5 minutes are GC'd.

```bash
SESSION=$(uuidgen)   # or python3 -c "import uuid; print(uuid.uuid4())"
```

## Bootstrap SLICC's brain (do this FIRST, before driving anything)

You are not SLICC's cone — you don't get SLICC's system prompt or skills for free, so
you will _guess_ at the shell (especially `playwright-cli`) and get it wrong. Don't guess.
SLICC's own runtime knowledge is sitting in the substrate's VFS and shell; load it into
your context at the start of every session and treat it as authoritative. Three sources,
in order:

1. **The agent system prompt** — `GET /api/vfs/read?path=/shared/CLAUDE.md`. This is the
   exact instruction file SLICC's cone runs on: the ice-cream vocabulary (cone / scoops /
   licks / floats), the shell-first philosophy, and the runtime conventions. Read it once
   and adopt it — it makes you behave like SLICC instead of an outsider poking at an API.

2. **The core skills — read these two IN FULL before driving (non-optional):**

   ```bash
   curl -s "http://localhost:5710/api/vfs/read?path=/workspace/skills/playwright-cli/SKILL.md" | jq -r .content
   curl -s "http://localhost:5710/api/vfs/read?path=/workspace/skills/mount/SKILL.md" | jq -r .content
   ```

   `playwright-cli` is how you drive the browser (SLICC's whole point) and the one
   surface that _wedges the instance_ when misused; `mount` is how you reach data
   (S3 / da.live / local dirs). `<cmd> --help` lists a command's flags — the SKILL.md
   teaches how to _drive_ it (refs go stale after every interaction, iframe handling,
   the `pdf` shortcut, network capture). Read the SKILL.md; don't substitute `--help`.

   Then list the catalog and read any others the task implicates:

   ```bash
   curl -s -X POST http://localhost:5710/api/vfs/list \
     -H "Content-Type: application/json" -d '{"path":"/workspace/skills"}' | jq -r '.[].name'
   curl -s "http://localhost:5710/api/vfs/read?path=/workspace/skills/<name>/SKILL.md" | jq -r .content
   ```

   `host` (tray/fleet), `secret`, and `oauth-token` have **no SKILL.md** — their
   authoritative docs are `<cmd> --help` / `man <cmd>` (and `host` is covered under
   _Tray membership_ below). Compatibility skills also live under any reachable
   `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` — `find` them over
   `/api/shell/exec` if a mounted repo is in play.

   **Don't reach for SLICC's orchestration skills (`delegation` / `agent` /
   `scoop_scoop` / `workflow`) to parallelize — that's your job as the brain.** They
   spawn scoops that need an LLM provider logged into the instance (substrate runs no
   cone, so nothing is inherited) and bill the _instance's_ tokens, not yours. To fan
   out, open multiple `X-Slicc-Session`s or spawn your own Claude Code subagents.

3. **Authoritative command usage** — never infer a command's flags. SLICC's own
   prompt (which you just read in `/shared/CLAUDE.md`) says to explore with these;
   use them over the shell instead of remembered syntax:

   ```bash
   {"command":"commands"}             # list every available command (the canonical lister; `help` also works)
   {"command":"playwright --help"}    # full playwright-cli surface (navigate/click/tab-new/teleport/…)
   {"command":"<cmd> --help"}         # any command's real flags
   {"command":"man <topic>"}          # long-form docs for a topic (e.g. `man playwright`)
   {"command":"skill list"}           # installed skills (then read the relevant SKILL.md, or `upskill search "<query>"`)
   ```

   These are the live source of truth and always match the running build — unlike
   this skill's prose, which can drift. When in doubt, run `<cmd> --help` / `man`
   and read the actual usage rather than reaching for remembered syntax.

> Rule of thumb: if you're about to type a `playwright`/`mount`/`git`/`webhook` command
> from memory, run its `--help` first. One extra exec beats a wrong guess that wedges the
> single-threaded session.

## API surface

Base URL: `http://localhost:5710`

### POST /api/shell/exec

Run a shell command.

Headers: `X-Slicc-Session: <uuid>` (required), `Content-Type: application/json`

Body:

| Field       | Type    | Required | Description                               |
| ----------- | ------- | -------- | ----------------------------------------- |
| `command`   | string  | yes      | Shell command to execute                  |
| `timeoutMs` | number  | no       | Per-call timeout in ms (default 10 min)   |
| `stream`    | boolean | no       | If `true`, returns chunked NDJSON instead |

> **Working directory**: the session's `cwd` persists across calls (spec §6 — `cd` survives between
> requests in the same session). To run in a specific directory use `cd /path && <command>`.

Non-streaming response `200`:

```json
{ "stdout": "...", "stderr": "...", "exitCode": 0, "pid": 1234 }
```

Streaming response `200` (`Content-Type: application/x-ndjson`):

```
{"t":"stdout","d":"building...\n"}
{"t":"stderr","d":"warning: ...\n"}
{"t":"exit","code":0,"pid":1234}
```

On mid-stream timeout, the server emits `{"t":"error","message":"Request timeout"}` and
closes. The browser-side process keeps running; reclaim it with `ps` and `kill`.

Errors: `400` missing session/command, `503` no browser connected, `504` timeout,
`500` other.

### GET /api/shell/session/:id

Probe whether a session is alive and read its tail buffer.

Response `200`:

```json
{ "alive": true, "cwd": "/workspace", "runningPids": [1025], "bufferedTail": "..." }
```

Errors: `503`, `504`, `500`.

### GET /api/vfs/read?path=&encoding=

Read a VFS file. `encoding` is `utf-8` (default) or `base64` (for binary).

Response `200`: `{ "content": "...", "encoding": "utf-8" }`

Errors: `400` missing path, `404` ENOENT, `503`, `504`.

### POST /api/vfs/write

Write a VFS file.

Body: `{ "path": "/workspace/out.txt", "content": "...", "encoding": "utf-8" }`

Response `200`: `{ "ok": true }`

### GET /api/vfs/stat?path=

Response `200`: `{ "type": "file"|"directory", "size": 1234, "mtime": 1700000000000 }`

### POST /api/vfs/list

Body: `{ "path": "/workspace" }`

Response `200`: `[{ "name": "foo.ts", "type": "file" }, ...]`

### GET /api/targets

Returns all browser targets — local plus the federated fleet (tray followers) —
as `PageInfo[]`, the same set `playwright tab-list` surfaces. Each entry carries
a `runtime` field so you can target a follower without parsing composite ids:

- **Local** targets: `runtime: null`, plain `targetId`.
- **Follower** targets: `runtime: "<runtimeId>"` (e.g. `"follower-<uuid>"`), with a
  composite `targetId` of the form `"<runtimeId>:<localTargetId>"`.

```json
[
  { "targetId": "ABC123", "title": "App", "url": "https://.../?substrate=1", "runtime": null },
  {
    "targetId": "follower-9f...:DEF456",
    "title": "Gmail",
    "url": "https://mail.google.com/",
    "runtime": "follower-9f..."
  }
]
```

Follower targets appear only when the instance is a tray leader with connected
followers; with no tray the list is local-only. Errors: `503` no browser,
`504` timeout.

### POST /api/lick/emit

Inject a lick event into the webapp's `LickManager`.

Body:

```json
{ "type": "navigate", "data": { "verb": "handoff", "target": "...", "url": "..." } }
```

`navigate` data fields: `verb` (`"handoff"` | `"upskill"`), `target`, `url` (required);
`instruction`, `branch`, `path`, `title` (optional).

`webhook` data fields: `webhookId` (required), `headers` (optional), `body` (optional).

Response `200`: `{ "ok": true }`

Errors: `400` missing/bad type, `503`, `504`.

## Concrete examples

### 1. Mint a session and run a command

```bash
SESSION=$(uuidgen)

curl -s -X POST http://localhost:5710/api/shell/exec \
  -H "X-Slicc-Session: $SESSION" \
  -H "Content-Type: application/json" \
  -d '{"command":"echo hi"}' | jq .
# → {"stdout":"hi\n","stderr":"","exitCode":0,"pid":1025}
```

### 2. Stream a long-running build

```bash
curl -s -X POST http://localhost:5710/api/shell/exec \
  -H "X-Slicc-Session: $SESSION" \
  -H "Content-Type: application/json" \
  -d '{"command":"npm run build 2>&1","stream":true}' \
  | while IFS= read -r line; do echo "$line" | jq -r '.d // empty'; done
```

Each line is a JSON frame. The final frame is `{"t":"exit","code":0,"pid":...}`.

### 3. Screenshot round-trip

Open a NEW tab and screenshot it by id (do **not** `playwright navigate` — that drives
SLICC's own app page and wedges the instance; see Browser control). `tab-new` prints
`[targetId: <ID>]`; `screenshot` saves to an auto-named `/tmp/screenshot-<ts>.png`:

```bash
# Open in a new tab → returns "...[targetId: ABC123...]"
curl -s -X POST http://localhost:5710/api/shell/exec \
  -H "X-Slicc-Session: $SESSION" -H "Content-Type: application/json" \
  -d '{"command":"playwright tab-new https://example.com"}'

# Screenshot that tab by id (path arg is ignored — it auto-names the file)
curl -s -X POST http://localhost:5710/api/shell/exec \
  -H "X-Slicc-Session: $SESSION" -H "Content-Type: application/json" \
  -d '{"command":"playwright screenshot --tab ABC123..."}'

# Find the auto-named file (POST /api/vfs/list {"path":"/tmp"}), then read it
curl -s "http://localhost:5710/api/vfs/read?path=/tmp/screenshot-<ts>.png&encoding=base64" \
  | jq -r .content | base64 -d > shot.png
```

### 4. Write a file to VFS and verify

```bash
curl -s -X POST http://localhost:5710/api/vfs/write \
  -H "Content-Type: application/json" \
  -d '{"path":"/workspace/hello.txt","content":"hello world\n"}'

curl -s "http://localhost:5710/api/vfs/read?path=/workspace/hello.txt" | jq -r .content
```

### 5. Check browser targets

```bash
curl -s http://localhost:5710/api/targets | jq '[.[] | {title, url}]'
```

## Device and mount gesture caveat (one-time, then headless)

`usb/serial/hid request` and the LOCAL `mount /dir` picker need a one-time human
gesture in the SLICC browser panel terminal. After the human grants the picker:

1. The handle (e.g. `usb1`, `serial1`, `hid1`) is registered in the page-side registry.
2. Subsequent headless commands via `POST /api/shell/exec` can drive the handle directly:
   `usb open usb1`, `cat /mnt/mydir/file.txt`, etc.

S3 mounts require **no gesture** — Claude Code can issue `mount --source s3://...` itself
(credentials come from the `s3.<profile>.*` secrets, not a login).

### Provider-gated capabilities (no provider for the brain, but yes for some features)

Substrate runs **no cone**, so **no LLM provider / API key is needed to drive it**. But
certain _capabilities_ piggyback on a logged-in provider and won't work without it:

- **`da://` (da.live) mounts** reuse the **Adobe IMS token** from a logged-in Adobe account
  (`mount/profile.ts` → `getAccounts()` where `providerId === 'adobe'`). With no Adobe
  account, `mount --source da://...` fails with _"No Adobe IMS account found. Log in via
  Settings → Providers → Adobe first."_ Adobe login is an interactive IMS popup, so it needs
  a **one-time human login in the SLICC browser** (same shape as the device/mount gesture);
  after that the orchestrator can `mount --source da://...` headlessly.
- Same idea for **OAuth-gated MCP servers** — the provider must be authenticated in the
  instance.

This is also why an **isolated fresh profile** (`PORT=5720`) has no provider features until
you log in, whereas a shared default-port profile may already carry an Adobe session.

## State discovery

| Goal                             | How                                                  |
| -------------------------------- | ---------------------------------------------------- |
| List running processes           | `POST /api/shell/exec` with `"command":"ps"`         |
| List browser targets             | `GET /api/targets`                                   |
| Check if session is alive / tail | `GET /api/shell/session/:id`                         |
| Kill a runaway process           | `POST /api/shell/exec` with `"command":"kill <pid>"` |

## Reconnect / resume recipe

Hold **one** `X-Slicc-Session` UUID for the lifetime of your orchestration session.

When a connection drops mid-exec:

1. The browser-side exec **keeps running**. The server-side stream was cut, but the
   shell process is alive in the kernel.
2. Re-probe: `GET /api/shell/session/:id` → check `alive`, `runningPids`, `bufferedTail`.
3. If `alive: true` and `runningPids` is non-empty, the command is still running. Poll
   until `runningPids` empties or issue `kill <pid>` to abort it.
4. Read `bufferedTail` for the last output the kernel buffered.
5. If `alive: false` (session GC'd after > 5 min idle), the next exec creates a fresh
   shell with a reset `cwd`. Detect this via the probe before assuming the prior state
   is intact.

For a long command, **don't** use `&` (the headless shell runs it in the foreground and
never frees the session — see the "No `&` job control" note under Browser control). Instead
either stream it, or fire it on its **own** session and poll that session's status:

```bash
# Stream (frames arrive as it runs; the HTTP call lasts the command's lifetime):
curl -sN -X POST http://localhost:5710/api/shell/exec \
  -H "X-Slicc-Session: $SESSION" -H "Content-Type: application/json" \
  -d '{"command":"npm run build 2>&1","stream":true}'

# Or run it on a dedicated session and poll GET /api/shell/session/<that-uuid>
# (runningPids non-empty = still running) so your main session stays free.
```

## Browser control

Browser automation goes through shell commands via `POST /api/shell/exec`. There is
exactly one CDP authority in substrate mode (no NavigationWatcher cross-attach).

> ⚠️ **Substrate has exactly ONE browser target at boot: SLICC's own app page
> (`?substrate=1`).** `playwright navigate <url>` drives the _active_ page — so navigating
> it away tears down the webapp + kernel worker + lick bridge and **wedges the whole
> instance** (every bridge route then returns `504`; `/api/status` stays up, which is the
> tell). **Never `playwright navigate` (or `open`) without first creating a tab.** Open a
> NEW tab with `playwright tab-new <url>` and drive **that** tab by its `--tab <targetId>`.

```bash
# Open the site in a NEW tab — returns "[targetId: <ID>]" (does NOT touch the app page):
{"command":"playwright tab-new https://example.com"}

# Drive / screenshot that tab by its id. NOTE: `screenshot` ignores any path argument and
# saves to an auto-named /tmp/screenshot-<ts>.png — list /tmp to find it, then read it via
# GET /api/vfs/read?path=/tmp/screenshot-<ts>.png&encoding=base64
{"command":"playwright screenshot --tab <targetId>"}
```

> **No `&` job control.** The headless shell (just-bash) runs `cmd &` in the **foreground** —
> it does NOT background or free the session, and `$!` is `0`. A session is single-threaded
> (an overlapping exec returns `session busy`). For long work use `stream:true` or a large
> `timeoutMs`; for concurrency use **separate** `X-Slicc-Session` UUIDs. `ps` and `kill <pid>`
> work normally for tracked processes.

### Tray membership (join / lead) is explicit, never implicit

Substrate boots **tray-clean** (no cone, one CDP authority) and never auto-joins a tray.
Drive tray membership explicitly over `POST /api/shell/exec`:

- **Become a leader:** `{"command":"host lead"}` — with **no argument it defaults to the
  production hub** `https://www.sliccy.ai`, which is the common substrate case. Pass a URL
  (`host lead https://staging-worker…`) only for staging / self-hosted. Equivalent:
  `host leave --leader <worker-base-url>`.
- **Join a leader:** `{"command":"host join <join-url>"}` — paste the leader's
  `https://www.sliccy.ai/join/<sessionId>.<token>` URL.
- **Status / read your join URL:** `{"command":"host"}` · **Reset (leader only):**
  `{"command":"host reset"}` · **Leave:** `{"command":"host leave"}` (no-op + exit 0 when
  already dormant).

**`host lead` is async — poll, don't assume.** It returns while the leader is still
`status: connecting`. Poll `host` until a `join_url:` line appears. Success looks like:

```
status: leader          # NOT "leading" — grep for exactly "status: leader"
join_url: https://www.sliccy.ai/join/<sessionId>.<token>
```

**Always use the `www.` host, never the bare apex.** `host lead https://sliccy.ai` fails:
the apex 301-redirects to `www.sliccy.ai`, and browser `fetch` downgrades the leader's
`POST /tray` to `GET` across the redirect → it lands on the SPA fallback HTML →
`JSON.parse` chokes with `Unexpected token '<', "<!DOCTYPE"…`. The no-arg default already
uses `www.`, so just run `host lead` with no URL. A failed lead sticks at `status: error`;
**recover with `host leave` then re-run `host lead`** (don't retry from the error state).

**Reading follower status:** once you've `host join`ed, `host` reports
`status: follower (connected)` plus the `join_url:`. (Before the b268 fix it mis-reported
`status: inactive` even while genuinely following — the page-side follower status now
mirrors to the worker so `host` sees it.)

### Driving a site that needs login (human-in-the-loop) — reuse a follower tab

You can't sign into arbitrary third-party sites yourself — credentials and MFA are the
human's. Before opening a fresh login tab on the leader:

1. **Check the fleet for an already-authenticated tab.** `GET /api/targets` lists local
   _and_ follower tabs; follower entries carry `runtime: "follower-<uuid>"` and a
   composite `targetId` of the form `"<runtimeId>:<localTargetId>"`. The tab you need
   may already be open and signed-in on a follower (often the human's own browser).
2. **Drive that tab where it lives** — pass its composite `targetId` straight to the
   usual commands: `playwright snapshot --tab=<runtimeId>:<localTargetId>` (then
   `click` / `fill` / etc.). To OPEN a new tab on a specific follower instead, use
   `playwright tab-new <url> --runtime=<runtimeId>`. Don't duplicate an authenticated
   session onto the leader.
3. **If no authenticated tab exists, hand off to the human** — foreground a login tab
   and ask them to sign in; don't hunt for stored credentials.

For full command usage, **run `playwright --help` / `help`** (see _Bootstrap SLICC's brain_
above) — the remote orchestrator can't read repo docs like `docs/shell-reference.md`.
