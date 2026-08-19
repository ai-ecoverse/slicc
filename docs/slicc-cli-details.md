# slicc-cli deep reference

Long-form implementation detail split out of `packages/slicc-cli/CLAUDE.md` to
keep that guide under the 20,000-char cap. The CLAUDE.md still owns the
authoritative command list, safety rules, env-var and Makefile references.

## Layout

| Path                  | Purpose                                                                              |
| --------------------- | ------------------------------------------------------------------------------------ |
| `main.go`             | Arg parsing + subcommand dispatch + Ctrl+C                                           |
| `commands.go`         | `prompt` / `exec` / `follow` implementations                                         |
| `internal/protocol/`  | Wire structs mirroring `packages/shared-ts/src/tray-sync-protocol.ts`                |
| `internal/signaling/` | HTTP follower client for `tray-signaling.ts` (attach → poll/answer/ice/retry)        |
| `internal/tray/`      | pion peer + `tray-control` data channel + follower state machine                     |
| `internal/cloud/`     | iCloud tray-session parse/select/format + darwin `Sliccstart --list-sessions` reader |
| `cloud.go`            | `list-sessions` + `<verb>-cloud` family                                              |
| `internal/execrun/`   | Cross-platform runner backing `follow` + `EvalSession` (`--eval`)                    |
| `update.go`           | `cmdUpdate` + on-launch update-notice hook                                           |
| `telemetry.go`        | `initTelemetry`/`reportRuntimeError` — RUM via `@ai-ecoverse/go-optel`               |
| `internal/update/`    | Release discovery (sparse scan) + self-update apply + cached notice                  |
| `internal/logging/`   | `log/slog` diagnostic logger + `Logf` adapter for the `tray` seam + pion factory     |
| `internal/ui/`        | Terminal presentation: capability detection, event lines, sticky status bar          |

## `watch` rendering

`watch` is a passive `tail -f` on the agent, mirroring the browser thread. It
sends nothing and renders the human's prompt (`user_message_echo` → `> …`),
assistant text (`content_delta`), and tool calls (`tool_use_start` → `⚙ …`,
`tool_result` → `↳ …`), blanking a line at each turn boundary — reconnecting
with backoff (`cmdWatch`/`watchOnce`; `printWatchEvent` does the rendering).

Glyphs and wording on stdout are **literal, not mode-dependent** — the stream is
a transcript other tools grep (`cli_e2e_test.go` asserts `> <text>` and
`⚙ <tool>`); only the color varies, and only when stdout itself is a terminal.

## Terminal presentation (`internal/ui`)

`internal/ui` is the CLI's presentation layer for the long-running verbs. No
dependencies beyond the stdlib and `golang.org/x/sys` (winsize ioctl / Windows
console): raw ANSI, ~4 files.

- **Capability detection** (`Detect`) — resolves a `Mode{Color, Sticky, Unicode}`
  per stream. `Sticky` (cursor movement) requires a character device **that also
  answers a window-size query**, because `/dev/null` is a character device too.
  `Unicode` is inferred from `LC_ALL`/`LC_CTYPE`/`LANG` (plus `WT_SESSION`), and
  a false negative matters: mojibake on a legacy code page breaks the bar's
  width accounting, so every glyph has an ASCII twin. Windows opts the console
  into `ENABLE_VIRTUAL_TERMINAL_PROCESSING` and falls back to plain output if
  the console refuses.
- **Plain mode is the contract.** With no terminal (pipe, file, CI) the console
  writes `"<tag>: <msg>"` — byte-for-byte what the CLI emitted before this
  package existed, newlines inside a message included, with no repeat
  collapsing (a redirected stream is someone's log; every occurrence belongs in
  it). Without the bar the same one-line form is used, colored when the stream
  can take it — `Paint` is a no-op without color, so redirected bytes are
  unchanged either way. `--plain` and `SLICC_NO_TUI=1` force plain; `NO_COLOR`
  keeps the bar but drops color; `FORCE_COLOR`/`CLICOLOR_FORCE` colors a
  redirected stream but never makes it sticky.
- **Sticky status bar** — one repainted line below the log: state badge
  (spinner while connecting, live countdown while waiting to retry), uptime,
  time since the last frame from the leader (green→yellow→red as it ages), exec
  count, reconnect count, suppressed link diagnostics, `user@host · runner`, and
  a 16-cell history strip whose cells hold the **worst** state seen per 5 s
  bucket. Fields are laid out most-important-first and any that no longer fits
  is _skipped_, not treated as the end of the line — otherwise one long hostname
  on a narrow pane would hide the short fields behind it. Width is re-queried
  per repaint, so a resize needs no SIGWINCH handler. Deliberately **no alternate screen buffer and no scroll regions**:
  output still scrolls back normally and a killed process leaves a usable
  terminal. Repaints from state changes are throttled (80 ms); the 1 s ticker
  catches up.
- **The bar needs the last row to itself**, so it is dropped (colors kept)
  whenever something else writes to the same stream — there are two such cases,
  and both are decided once, at startup, in `commands.go`:
  - `watch` streams the transcript to **stdout** in partial lines (a
    `content_delta` rarely ends at a line boundary), so `watchModes` drops the
    bar when stdout is a terminal too.
  - the diagnostic logger writes to **stderr** on its own once turned up, so
    `stickyUnlessLogging` drops the bar whenever `diagLogger.Enabled()`. Without
    it, `SLICC_DEBUG=1` on a terminal would land a record on the bar's row and
    every later erase would target the wrong line.
- **Width accounting** (`cellWidth`) — combining marks and variation selectors
  are zero cells, the East Asian wide/fullwidth blocks and the emoji blocks are
  two, everything else one. `visibleWidth` sums those (skipping escapes) and
  `truncateVisible` drops a double-wide rune rather than splitting it, since half
  a cell is what makes a terminal wrap.
- **Events** — `Line` stamps and marks the first row and indents continuation
  rows (`│ …`), so a multi-line error reads as one event. An identical
  consecutive event is folded in place with a `(×3)` counter; one that cannot be
  rewritten keeps its detail on screen once and collapses into a single
  `↺ repeated (×N)` row instead, which is then rewritten from there on. Three
  things disqualify a rewrite, all of them cases where the cursor walk would
  land somewhere other than where the event started: more than 6 rows, a row at
  or past the terminal width (it has soft-wrapped), and a row holding anything
  beyond ASCII plus this package's own symbols (`rewriteSafe`). That last one is
  deliberately blunt: leader-supplied text can contain emoji ZWJ sequences,
  "ambiguous width" characters a CJK locale draws wide, or bytes the terminal
  replaces with a glyph of its own choosing, and an undercounted row wraps
  invisibly — so such an event is never rewritten, only marked. `Note` prints **only** in plain mode, for
  information the bar already carries live (the reconnect wait): duplicating it
  would also interleave the identical errors and defeat the collapsing.
- **Seams** — `LineWriter(kind)` adapts the console to an `io.Writer` so
  `follow.Session`'s per-command log needs no console awareness (it writes a
  bare `exec: <command>`; the console owns the prefix). `Raw` writes verbatim,
  for the banner, whose wording must not vary with the output stream.

### pion's own logging

`Conn.pionLoggerFactory` (`internal/tray/conn.go`) installs
`logging.PionFactory` on `SettingEngine.LoggerFactory`. This is load-bearing:
left nil, webrtc installs `pion/logging.NewDefaultLoggerFactory()`, which writes
**error records straight to `os.Stderr`** — a flaky TURN allocation then buries
the CLI's output under `turnc ERROR: Fail to refresh permissions: …` walls that
no `SLICC_LOG_LEVEL` can quiet. Routed through the factory they become ordinary
diagnostics (silent by default, back with `SLICC_DEBUG=1`), and
`Options.OnLinkDiag` tallies the warn-and-above ones into the status bar's
`link ⚠ N` field. `Options.OnActivity` feeds the `♥ <age>` field and fires on
**every** inbound frame, not just keepalives: the leader _answers_ pings
(`tray-follower-sync.ts` is the pinger, `LEADER_TRAY_PING_INTERVAL_MS` is the
signaling socket's keepalive, not a data-channel ping), so a follower watching
ping/pong alone would show an empty field forever. Anything arriving — chunk
framing, an unparseable frame — is proof the leader is alive, which is what the
field claims.

## `follow` startup ergonomics

All in `commands.go`:

- **Banner** — a small ASCII wordmark + the identity/runner/exec warning prints
  to stderr on start; `--no-banner` drops the art but keeps the safety warning.
- **Runner heuristic** (`runnerExecWarning`) — a known shell
  (`bash`/`sh`/`zsh`/…) or wrapper (`docker`/`podman`/…) without a trailing
  `-c` warns that the leader's command would be treated as a script FILE, not
  a command line — the `follow bash` (vs `follow bash -c`) footgun.
- **MOTD** (`hello.motd`, `followMotd`) — a one-line "who/what/where" summary
  the follower advertises so the leader surfaces it to the agent via
  `ssh --list`. The leader captures it in `tray-leader-sync.ts`
  (`getFollowerMotds`) and, alongside `getBrowserCapableBootstrapIds`, tags
  followers `[ssh]` / `[playwright]` in `host`. Additive + optional on the
  wire (browser/iOS peers omit it).

## `follow --eval` (persistent REPL) lifecycle

`execrun.EvalSession` spawns the runner ONCE and serializes leader commands
into its stdin as lines; responses are framed by **output quiescence**
(`--eval-quiet`, default 500 ms) because REPLs never signal completion. The
session outlives connections AND connection drops — a cancelled per-connection
context interrupts the in-flight computation (`interruptProcess`, SIGINT to
the group; no-op on Windows) but never kills the REPL; only `Close` (process
shutdown) and leader-sent SIGTERM/SIGKILL do. Leader SIGINT likewise
interrupts without killing (ignored on Windows — a hard kill would destroy
session state). Late output is forwarded at the head of the next response,
exec exit codes are always 0 while the REPL lives, `req.Cwd`/`req.Env` are
ignored, and REPL death marks the session dead (commands then error until
restart). `follow.NewEvalSession` routes `exec.request` into it; the MOTD
advertises a REPL target so the leader's agent sends language code, not
shell. The banner warns about `node` without `-i` (it buffers piped stdin
until EOF). Tests fake the REPL with a self-exec helper process
(`TestEvalHelperProcess`) so the suite runs on all three CI OSes; the e2e
(`TestCLIFollowEvalPersistsState`) proves cross-command state over real
WebRTC using the platform shell as a line-eval stand-in.

## Self-update mechanics

`internal/update` scans GitHub releases newest→oldest for the first one
carrying this platform's `slicc-<os>-<arch>[.exe]` asset — releases are
**sparse** (CLI binaries only attach when `packages/slicc-cli` changed), so
`releases/latest` is not enough. Same bounded pagination as the worker's
`/download/slicc-cli` route (30/page, 5 pages max). `Apply` downloads next
to the executable, runs the staged binary's `--version` as a sanity gate,
then atomically renames over the running binary (Windows: parks the old
file at `.old`, swept on later runs).

Regular verbs call `startUpdateNotice()` (main-package `update.go`): the
upgrade notice prints from a local cache
(`<user-cache-dir>/slicc/update-check.json`) and a background refresh runs
at most once per 24 h, bounded-flushed at command exit so short verbs still
persist it. Disabled via `SLICC_NO_UPDATE_CHECK=1` and for any
non-release-stamped version (`dev`, `git describe` output) —
`IsReleaseVersion` gates both the notice and the self-replace, so `slicc
update` refuses to clobber a local build that is ahead of the latest tag.
`SLICC_UPDATE_API_BASE` overrides the API base (tests/mirrors).

## Telemetry design rationale

`telemetry.go` wires `packages/go-optel` (`github.com/ai-ecoverse/go-optel`,
a sibling Go module pulled in via a local `replace` directive — this
monorepo has no `go.work`) into two checkpoints only: `enter` on launch
(`initTelemetry(sub)`, deferred right after `initTelemetry(sub)()` executes
immediately in `main.go`'s `run()`) and `error` on an operational failure
(`reportRuntimeError(source, err)`, called from the dial-error branches in
`commands.go` and the update-check/apply error branches in `update.go`).
`source` for `error` beacons is always one of a small fixed set (`dial`,
`watch`, `follow`, `update`) — never user-typed input (join URL,
exec/prompt text) — and `classifySubcommand` applies the same
allowlist-not-passthrough treatment to the `enter` beacon's subcommand
name.

Gated the same way as the update notifier: `SLICC_NO_TELEMETRY=1` opts out
outright, and `update.IsReleaseVersion(version)` means a `dev`/git-describe
local build never configures a client at all (no env var needed for that
case). Sampling is one coin flip per process (weight 100 by default,
`OPTEL_RATE`/`OPTEL_DEBUG` env override), not per checkpoint. See
`packages/go-optel/CLAUDE.md` for why `Sanitize()` (URL/path redaction
before truncation) is mandatory here rather than a nice-to-have — this
CLI's error strings can embed a leader's bearer-token join URL — and
`docs/operational-telemetry.md` ("CLI Telemetry") for the cross-float
design.

## Release signing / notarization pipeline

Release binaries are cut **atomically with the semantic-release flow** and
only when `packages/slicc-cli/` changed since the last tag.
`release-native.mjs` (the prepareCmd gate) calls `sign-and-package.sh` when
`decideSliccCliGating` opens: it cross-compiles every target on the macOS
release runner, Developer ID-signs + notarizes the two darwin binaries
(reusing release.yml's `APPLE_CERTIFICATE_BASE64` cert and
`APPLE_API_KEY_*` notarytool creds, and the `setup-go` toolchain), and
stages `artifacts/release/slicc-*` for `@semantic-release/github` to
attach. A bare CLI binary can't be stapled (only `.app`/`.dmg`/`.pkg`), so
Gatekeeper verifies the notarization online. With no cert (a fork / local
run) the binaries build + stage unsigned instead of failing.

## OS matrix and integration test

CI runs `go test ./...` on macOS/Linux/Windows (`strategy.matrix.os`) to
exercise real per-OS runtime paths — process-group signalling and the
`cmd /c` vs `sh -c` runner — that a compile-only check would miss. Tests
pick the platform shell via a `testRunner()` helper so they run rather than
skip on Windows; only the genuinely POSIX-specific cases (`sleep` + signal
delivery) stay `runtime.GOOS == "windows"`-skipped. The static gate
(`make check`) and cross-compile (`make dist`) run once on Linux — they are
platform-independent, and the coverage floor would under-count where those
cases skip.

`integration_test.go` is the real end-to-end test: it drives the whole
follower path over an actual WebRTC connection (pion ↔ pion on loopback) —
a leader peer creates the `tray-control` channel, a mock signaling server
bridges the SDP/ICE exchange to `tray.Dial`, and the leader issues an
`exec.request` that the follow session runs locally and streams back.
Deterministic (no browser, no TURN), so it runs in the normal `go test`
gate.
