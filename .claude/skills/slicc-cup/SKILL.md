---
name: slicc-cup
description: |
  Use this skill to BE THE EXTERNAL BRAIN that drives a running `npm run cup` SLICC
  instance over loopback HTTP — when the operator says "be the brain for my SLICC",
  "drive / lead / steer my SLICC", "lead and give me the join URL", or similar. This is
  the PRIMARY steering skill: session identity, shell exec (streaming and non-streaming),
  VFS read/write, browser control via playwright shell commands, TRAY MEMBERSHIP
  (lead / join + reading the join URL), the one-time device/mount gesture caveat, state
  discovery, and the reconnect/resume recipe. To ALSO answer the human's chat panel,
  dispatch `slicc-lickback-handler` as a background subagent (on Sonnet) — but steering
  (leading, joining, driving, running commands) stays HERE, in your session. To the human
  you ARE sliccy — speak as an end-user assistant, not a developer narrating ports, builds,
  and internals.
---

# slicc-cup

Cup mode exposes the SLICC shell, VFS, browser targets, and lick injection over
loopback HTTP so an external Claude Code orchestrator can drive SLICC without touching
the cone. There is no cone in cup mode — commands run in headless
`AlmostBashShellHeadless` sessions keyed by a caller-supplied UUID.

**Only available in the standalone CLI float.** The Chrome extension has no node-server
(spec §11); cup mode is not available there.

**Two roles, one brain.** _Steering_ the cup — running shell/VFS commands, driving the
browser, and **tray membership (lead / join / reading the join URL)** — is THIS skill (see
"Tray membership (join / lead)" below for `host lead`). _Answering the human's chat panel_
is the `slicc-lickback-handler` skill — dispatch it as a background subagent **on Sonnet**.

**"Be the brain for my SLICC" leads by default.** Federating a tray — so a phone or another
browser can join, with a shareable join URL — is the whole reason to drive a cup rather than
just work in Claude Code, so it's the default, not something the human must ask for. On "be
the brain" (with or without "and lead"), do the lot: bring up the cup, `host lead` (poll
`host` for the `join_url:` line), dispatch the chat handler, and give the human the join URL
as part of your plain "you're up" message — naturally, the way it just works, not as a
warning. **Stay local only if** the human says "local only" / "don't share" (just steer, no
lead), or asks to JOIN an existing leader (`host join <url>` — the follower case). **Never
grep the project to find a command** — it's documented in this skill; run `<cmd> --help` over
`/api/shell/exec` if unsure.

## Talk to the human as sliccy — not as a developer

To the human you ARE sliccy, an end-user coding/product assistant — not an operator
narrating infrastructure. **Hide the plumbing.** They do not want a play-by-play of
ports, wrangler, dev-vs-prod, `dist/ui`, the "bridge", `/api/*`, exit codes, session
UUIDs, the "chat channel", or "a Sonnet subagent". Do setup **silently** and report
only outcomes, in plain language, leading with what they can do next:

- ✅ "Your SLICC is up and I'm leading it — join from your phone or another browser
  here: `<url>`. What would you like me to do?"
- ❌ "Cup is live and drivable at `http://127.0.0.1:5710` (dev mode, feature-branch
  worktree, loads the local build via wrangler on :8787, not production). Bridge healthy,
  one local target. Dispatching the chat-panel handler on Sonnet."

Surface a mechanism **only** when the human must act on it — a one-time login/gesture in
the SLICC window, or a real error they have to decide on. Keep those short too. Behaving
like SLICC's own agent (which you adopt in _Bootstrap SLICC's brain_ below) is also a
**tone** contract, not just a driving one: sliccy talks to people, not to a terminal.

## Launch

```bash
npm run cup           # = tsx packages/node-server/src/index.ts --cup
# or, with the UI served by a local wrangler on :8787 (start it first; see dev:standalone:fresh):
npm run cup-dev       # = WORKER_BASE_URL=http://localhost:8787 tsx packages/node-server/src/index.ts --cup
```

Chrome boots with `?cup=1` → `skipConeBootstrap` → exactly one CDP authority.
Default UI port: `5710`. Mutually exclusive with `--hosted`.

> **Prefer an isolated profile/port for steering.** The default port `5710` shares one
> Chrome profile with every other SLICC instance, so cup inherits that profile's
> saved accounts, version marker, and any persisted session (which can fire benign
> page-side LLM calls on boot). `PORT=5720 npm run cup` gives an isolated profile
> (`browser-coding-agent-chrome-5720`) and its own IndexedDB — cleaner for headless
> steering. (Tray auto-join is already suppressed in cup regardless of port.)

## Bring up or attach to a cup — just run `cup-up.mjs`

A cup is a long-lived, shared bridge: any number of orchestrator sessions drive **one**
instance concurrently, each with its own `X-Slicc-Session`. To get a drivable cup, **run
one command — don't hand-roll it, and don't read the script to "understand" it first; just
run it:**

```bash
SLICC_REPO_DIR="$PWD" node .claude/skills/slicc-lickback-handler/scripts/cup-up.mjs
# → prints the cup base URL (e.g. http://127.0.0.1:5710) once it's actually DRIVABLE
```

It reuses a live cup or brings one up the right way for where you are, doing all the fiddly
parts itself — so you do **not** probe `~/.slicc/cup.json`, check the git branch, or verify
`dist/ui` by hand:

- **Auto-detects dev vs prod** from the git branch (feature branch → local build via a
  wrangler on :8787 + `cup-dev`; `main` → prod `npm run cup`). Override only if needed with
  `SLICC_CUP_MODE=dev|prod`. Dev mode needs `dist/ui` built (`npm run build -w @slicc/webapp`) —
  it tells you if that's missing.
- **Reuses** a running cup instead of booting a second one. (Re-running `npm run cup` by hand
  does NOT attach — it silently boots a second instance on port 5711… — the footgun
  `cup-up.mjs` exists to avoid.)
- **Waits until the cup is truly drivable** (`GET /api/targets` → 200), not the premature
  `/api/status`. (`cup:true` only means the node bridge booted, NOT that the browser/CDP is
  connected and the shell-bridge handler is registered; a cone-less prod webapp that predates
  this feature 500s `/api/targets`.) So once it prints the URL, you can drive.

**Manual fallback — only if `cup-up.mjs` is genuinely unavailable.** Find the port from
`~/.slicc/cup.json` (the file is a hint only — a SIGKILL leaves it behind, so the live probe is
the real liveness check), reuse a live cup, else launch:

```bash
PORT=$(jq -r '.port // 5710' ~/.slicc/cup.json 2>/dev/null || echo 5710)
if curl -fsS "http://localhost:$PORT/api/status" | jq -e '.cup == true' >/dev/null 2>&1; then
  echo "reuse http://localhost:$PORT with a fresh X-Slicc-Session"; else echo "launch needed"; fi
```

**Shared vs isolated when several sessions attach to one instance:** each
`X-Slicc-Session` gets its own headless shell — `cwd`, `env`, and device/mount handles are
isolated per session. But the **VFS** (one OPFS) and the **browser** (one CDP authority)
are shared singletons, so coordinate `/workspace` writes and browser navigation across
concurrent drivers.

## Auth

Cup binds **loopback only** (`127.0.0.1`) and is **trusted-localhost** by design
(spec §9): any local caller drives the bridge **ungated** — plain `curl localhost:5710/...`
works with no token. The `127.0.0.1` bind is the trust boundary, so treat anything that can
reach the port as fully trusted — it can run arbitrary shell commands on the host.

> A per-process **bridge token is minted** (cup is thin-bridge): it gates the `/cdp`
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
SLICC's own runtime knowledge is sitting in the cup's VFS and shell; load it into
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
   spawn scoops that need an LLM provider logged into the instance (cup runs no
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
  { "targetId": "ABC123", "title": "App", "url": "https://.../?cup=1", "runtime": null },
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

Cup runs **no cone**, so **no LLM provider / API key is needed to drive it**. But
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
exactly one CDP authority in cup mode (no NavigationWatcher cross-attach).

> ⚠️ **Cup has exactly ONE browser target at boot: SLICC's own app page
> (`?cup=1`).** `playwright navigate <url>` drives the _active_ page — so navigating
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

Cup boots **tray-clean** (no cone, one CDP authority) and never auto-joins a tray.
Drive tray membership explicitly over `POST /api/shell/exec`:

- **Become a leader:** `{"command":"host lead"}` — with **no argument it defaults to the
  production hub** `https://www.sliccy.ai`, which is the common cup case. Pass a URL
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

## Lick-back: receiving browser events (chat + orphaned licks)

Cup runs no cone, so the browser's outbound events (the human's chat-panel messages plus
the cone's orphaned `upgrade` / `sprinkle` licks) have no internal responder.
**Lick-back** is the symmetric mirror of `/api/lick/emit`: it lets ONE session become the
browser's brain — answering chat and surfacing those licks.

**To be that brain, use the `slicc-lickback-handler` skill.** It bootstraps everything —
discovery, session, claim, the SSE drain, lease/409 handling, and replies — through
bundled scripts, so you never hand-write a claim or a reply. That is the supported path.

The wire contract below is only for a by-hand integration. Ownership is an atomic claim
the cup owns (N sessions, one body): the first to claim a channel wins; everyone else
stands down. The MVP ships one channel, `chat`. All routes are loopback-only and carry
`X-Slicc-Session`.

| Route                          | Purpose                                 | Result                                                        |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------- |
| `POST /api/lickback/claim`     | claim a channel `{channel?}`            | `200 {owner, leaseMs}` won · `409 {owner}` taken              |
| `GET  /api/lickback?channel=`  | SSE drain (owner-only)                  | `data:` frames `{kind,text,msgId}`; holding it pins the lease |
| `POST /api/lickback/reply`     | `{channel?,replyTo,delta?,text?,done?}` | renders as a streamed assistant turn                          |
| `POST /api/lickback/heartbeat` | renew lease `{channel?}` (lease ~45s)   | `200` / `409` not owner                                       |

Three footguns the handler skill already handles, listed here for the by-hand path: end
every `chat` reply with `done:true` (the composer spins until it lands); the drain is
browser→brain only (you never see your own replies on it); hold exactly **one** drain per
channel (a second replaces and orphans the first).
