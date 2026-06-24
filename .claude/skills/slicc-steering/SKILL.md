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
npm run substrate           # = tsx packages/node-server/src/index.ts --dev --substrate
# or
npm run dev -- --substrate
```

Chrome boots with `?substrate=1` → `skipConeBootstrap` → exactly one CDP authority.
Default UI port: `5710`. Mutually exclusive with `--hosted`.

> **Prefer an isolated profile/port for steering.** The default port `5710` shares one
> Chrome profile with every other SLICC instance, so substrate inherits that profile's
> saved accounts, version marker, and any persisted session (which can fire benign
> page-side LLM calls on boot). `PORT=5720 npm run substrate` gives an isolated profile
> (`browser-coding-agent-chrome-5720`) and its own IndexedDB — cleaner for headless
> steering. (Tray auto-join is already suppressed in substrate regardless of port.)

## Auth

Loopback callers (localhost / no-Origin `curl`) are exempt from the bridge token gate.
Plain `curl localhost:5710/...` works with no token. Remote allowlisted origins need
`X-Bridge-Token`. This is trusted-localhost mode (spec §9): commands run ungated; the
loopback gate is the trust boundary.

## Session identity

Mint **one** `X-Slicc-Session` UUID per working session and reuse it on every call.
The kernel keys a persistent headless shell by this UUID so `cd`, `env`, and
device/mount handles persist across calls. Sessions idle > 5 minutes are GC'd.

```bash
SESSION=$(uuidgen)   # or python3 -c "import uuid; print(uuid.uuid4())"
```

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

Returns all browser targets (local + federated fleet) as `PageInfo[]`.

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
certain *capabilities* piggyback on a logged-in provider and won't work without it:

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

- **Join a leader:** `{"command":"host join <join-url>"}`
- **Become a leader:** `{"command":"host lead <worker-base-url>"}` (starts a tray from any
  state and prints the join URL; `host leave --leader <worker-base-url>` does the same)
- **Status / read your join URL:** `{"command":"host"}` · **Reset:** `{"command":"host reset"}`

See `docs/shell-reference.md` for the full `playwright-cli` command reference.
