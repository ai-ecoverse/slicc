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
| `cwd`       | string  | no       | Working directory                         |
| `timeoutMs` | number  | no       | Per-call timeout in ms (default 10 min)   |
| `stream`    | boolean | no       | If `true`, returns chunked NDJSON instead |

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

Take a screenshot, read the PNG back as base64:

```bash
# Navigate and capture
curl -s -X POST http://localhost:5710/api/shell/exec \
  -H "X-Slicc-Session: $SESSION" \
  -H "Content-Type: application/json" \
  -d '{"command":"playwright navigate https://example.com && playwright screenshot /tmp/shot.png"}'

# Read the PNG
curl -s "http://localhost:5710/api/vfs/read?path=/tmp/shot.png&encoding=base64" \
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

S3 and da.live mounts require **no gesture** — Claude Code can issue those itself via
`mount --source s3://...` through `POST /api/shell/exec`.

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

Background a long command to avoid holding the HTTP connection:

```bash
curl -s -X POST http://localhost:5710/api/shell/exec \
  -H "X-Slicc-Session: $SESSION" \
  -H "Content-Type: application/json" \
  -d '{"command":"npm run build &"}'
# Returns immediately; poll ps for the pid
```

## Browser control

Browser automation goes through shell commands via `POST /api/shell/exec`. There is
exactly one CDP authority in substrate mode (no NavigationWatcher cross-attach):

```bash
# Navigate
{"command":"playwright navigate https://github.com"}

# Click
{"command":"playwright click 'a[href*=issues]'"}

# Evaluate
{"command":"playwright evaluate 'document.title'"}

# Screenshot (then read via GET /api/vfs/read?path=/tmp/shot.png&encoding=base64)
{"command":"playwright screenshot /tmp/shot.png"}
```

See `docs/shell-reference.md` for the full `playwright-cli` command reference.
