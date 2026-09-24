# slicc-cli

`slicc` — headless SLICC **follower** CLI in Go, joining a leader over the same
WebRTC tray-control data channel as browser + iOS followers. **Go module, not an
npm workspace** (like `packages/ios-app`) — built with `go`/`make`, not `npm`.
Deep-dive: [`docs/slicc-cli-details.md`](../../docs/slicc-cli-details.md).

```
slicc <join-url> prompt "<text>"                Stream one assistant turn, then exit
slicc <join-url> exec "<command>"               Run a command in the leader's shell, stream output
slicc <join-url> new-session [--save|--skip|--erase]
                                                Fresh cone conversation ("New chat"), verified empty
slicc <join-url> model [--json] [<model>]       List models, or switch the cone and await model.state
slicc <join-url> watch [--plain] [scoop]        Tail the leader's live agent output, read-only
slicc <join-url> follow [--no-banner] [--plain] [runner]
                                                Stay connected; run leader commands via <runner>
slicc <join-url> follow --eval [repl]           Same, into ONE persistent REPL
slicc <join-url> follow --computer[=require]    macOS: also bring this Mac's screen + input
slicc update [--check]                          Self-update to the newest released CLI binary
slicc list-sessions [--json]                    List iCloud tray sessions (macOS; no join URLs)
slicc <verb>-cloud [--index N|--session <id>]   Resolve a session's join URL from iCloud, run <verb>
```

- `prompt` ends on a `turn_end`/`error` event, or on a processing→ready
  `status` flip that stands for `SLICC_PROMPT_SETTLE` (default 2 s) with no
  resumed activity and no pending `tool_use_start`. Live leaders broadcast
  `ready` after every assistant _message_, so a tool-using turn flips twice;
  exiting on the first flip returned an empty reply (`promptTurn` in
  `commands.go`).
- `new-session`/`model` (`session.go`) send the follower control messages the
  browser/iOS followers already use (`new_session`, `models.request`,
  `model.select`):
  - `new-session` polls `request_snapshot` until the transcript has no user
    message, because the leader sends no acknowledgement.
  - `model` resolves the query to an exact catalogue id (the leader applies only
    exact ids) and waits for the `model.state` broadcast that confirms it.
  - Their structs are in `internal/protocol` and round-trip the tray-sync corpus.
- `watch` — passive `tail -f` mirror; sends nothing, reconnects with backoff.
  **Does NOT filter by scoop by default** — the cone's `scoopJid` is a generated
  uid (not `"cone"`); pass a scoop jid to filter.
  [Render](../../docs/slicc-cli-details.md#watch-rendering).
- `<text>`/`<command>` is curl-style: literal, `@path` (file), `-` / `@-`
  (stdin) — e.g. `git log | slicc <url> exec -`, `slicc <url> prompt @brief.md`.
  `readTextArg` only fires for a single `@…`/`-` arg; multi-word prompts join
  verbatim.
- The trailing argv of `follow` is the **runner** — each leader command is
  appended as the final arg (`follow bash -c`, `follow docker exec -i sandbox
sh -c`). **With no runner, `follow` refuses every command.**

## iCloud tray sessions (`list-sessions`, `<verb>-cloud`)

macOS only. `internal/cloud` **shells out** to `Sliccstart --list-sessions`
(cgo + entitlements would break `CGO_ENABLED=0`); `LocateExecutable` tries
`$SLICCSTART_APP` → `mdfind` → `/Applications` → `~/Applications`. Off macOS:
`ErrUnsupported`.

- `list-sessions [--json]` — **metadata only** (opaque id, label, device,
  age), **never a join URL** — safe to pipe/log.
- `<verb>-cloud` (`follow`/`prompt`/`exec`/`watch`) resolves a session's **join
  URL** via `--reveal-urls` (Mac consent prompt; denied over SSH until granted
  once from the screen) then dispatches. **URL never printed.** Newest by
  default; `--index N` / `--session <id-prefix>` picks another; remaining argv
  verbatim.

Pure logic (`ParseSessions`/`ParseSelector`/`Select`/`FormatTable`) is
platform-independent + unit-tested; darwin-only exec/locate lives in
`resolve_darwin.go` (`cloudList` seam overridden in tests).

## `follow --computer` (native macOS screen + input, #3260)

macOS only, composes with every follow mode (ui / shell / `--eval`). The CLI
cannot capture a screen (`CGO_ENABLED=0`, and TCC would attribute a bare
binary's grant to the **terminal**), so `internal/computer` **shells out** the
same way `internal/cloud` does: `Sliccstart --computer-follow <url> --pair
<token>`, headless and `.accessory`, reusing `LocateExecutable`.

- **One roster entry.** Both peers send the same `hello.pairId`; the leader
  folds them (`webapp/src/scoops/tray-leader/follower-pairing.ts`) so
  `host` shows one machine tagged `[ssh] [computer]` (#3381 — `ssh --list`
  stays exec-only, since `ssh` cannot reach a capture-only peer) and
  `computer add ssh` picks ScreenCaptureKit over the terminal-attributed
  `screencapture` shell-out. Token is minted per process —
  a bootstrap id doesn't exist yet and changes on reconnect. **With no runner
  there is no exec peer to fold into**, so the launcher keeps its own entry.
- **Handshake: ready ≠ attached.** `SLICC_COMPUTER_FOLLOW_READY` (30 s) only
  means "understands the flag" — an old Sliccstart ignores it and boots its GUI,
  never exiting. `Start` then waits for `SLICC_COMPUTER_FOLLOW_ATTACHED` (60 s);
  `SLICC_COMPUTER_FOLLOW_FAILED <reason>` → `ErrAttachFailed`. **Never return on
  ready alone** — that let `--computer=require` continue without a screen. Read
  via a line-scanning `cmd.Stdout` writer — **not `StdoutPipe`**, which races
  `Wait` and can drop the `FAILED` line.
- **Prompts up front.** `Sliccstart --computer-preflight --json` runs before
  connecting; a lazy first prompt would land mid-turn. A partial grant warns,
  never aborts. Input still needs `--allow-input` + the sudo hop.
- **Lifecycle.** SIGTERM + 5 s grace on CLI exit; a SIGKILLed/crashed CLI is
  covered by the launcher's own **parent-pid watch**. Reconnects need nothing;
  a launcher that gives up exits and `OnExit` warns. `TRAY_SUPERSEDED` **does**
  need action — `Retarget` restarts it on the replacement URL, **in the
  background** (it now waits for attach; never block the dial path on it).
- **Failure policy.** `--computer` warns and follows on; `--computer=require`
  exits non-zero. Off macOS: `ErrUnsupported`, never an unknown-option error.

[Details](../../docs/slicc-cli-details.md#follow---computer-native-macos-screen--input)

## Why Go + pion

`github.com/pion/webrtc/v4` is pure Go — the follower cross-compiles to a single
static binary for macOS/Linux/Windows × amd64/arm64 (`CGO_ENABLED=0`, `dist`
target), interoperating with browser leaders + Cloudflare TURN.

## Layout

`main.go` (argv + dispatch), `commands.go` (`prompt`/`exec`/`follow`),
`cloud.go` (`list-sessions` + `<verb>-cloud`), `update.go`, `telemetry.go`,
`internal/{protocol,signaling,tray,cloud,computer,execrun,update,logging,ui}/`. Per-file
map: [details](../../docs/slicc-cli-details.md#layout).

## Protocol parity

`internal/protocol` mirrors a subset of the canonical TS union. A golden corpus
(`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts` →
`packages/ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json`)
is decoded by `internal/protocol/corpus_test.go` for `exec.*`/`hello`/`status`,
so a wire change breaks `go test`. On protocol changes, regenerate the corpus
JSON and update the Go structs alongside the TS + Swift mirrors.

## Diagnostics vs user-facing output

- **User-facing** — `prompt`/`exec`/`watch` write leader bytes to stdout, status
  to stderr. **Never route through the logger**; the CLI is pipeable.
- **Diagnostics** — signaling retries, supersede redirects (`OnJoinURLChanged`
  persists the replacement across `follow`/`watch` reconnects), ICE failures,
  and unparseable frames go through `internal/logging` (`diagLogger` → stderr);
  `debugLogf` adapts to `tray.Options.Logf`.
- **pion's own records** — `Conn.pionLoggerFactory` installs `logging.PionFactory`
  on `SettingEngine.LoggerFactory`. **Required**: left nil, webrtc's default
  factory writes errors to `os.Stderr` and TURN churn buries the CLI's output.
  [Why + `LogWanted`](../../docs/slicc-cli-details.md#pions-own-logging).

Off by default. `SLICC_DEBUG=1` (= `SLICC_LOG_LEVEL=debug`) or
`SLICC_LOG_LEVEL=debug|info|warn|error`; `SLICC_LOG_FORMAT=json` selects the
JSON handler.

## Terminal presentation (`internal/ui`)

`follow`/`watch` render through `internal/ui` (stdlib + `golang.org/x/sys`, raw
ANSI — no TUI framework). On an interactive terminal `follow` keeps a **sticky
one-line status bar** below the log (connection state, uptime, `♥` leader-frame
age, exec/reconnect counts, link diagnostics, `user@host · runner`, history
strip); identical event repeats fold in place as `(×N)`. **The bar must own the
last row**, so it is dropped (colors kept) whenever another writer shares the
stream — `watch` on a terminal **stdout**, or any verb once the diagnostic
logger is up (`SLICC_DEBUG=1` → stderr); both decided in `commands.go`.

**Plain mode is the contract**: with no terminal, output is byte-for-byte the
pre-TUI `slicc <verb>: <msg>` text, escape-free, every occurrence kept; cursor
control never hits a non-terminal. `--plain`/`SLICC_NO_TUI=1` force plain;
`NO_COLOR`, `FORCE_COLOR`/`CLICOLOR_FORCE`, and `COLUMNS` tune the rest.
[Details](../../docs/slicc-cli-details.md#terminal-presentation-internalui).

## Exec safety (`follow`)

A `follow` with a runner advertises `hello.capabilities.exec = true`; each
command runs as `<runner> <command>` (runner sandboxes the exec surface), as the
user who started `slicc`, echoed to stderr. **A `follow` with no runner
advertises no capability and refuses every `exec.request`.** On start a banner +
safety warning prints (`--no-banner` drops the art); `runnerExecWarning` flags
the `follow bash` vs `follow bash -c` footgun; the MOTD surfaces via `ssh --list`
(`host` tags `[ssh]`/`[computer]`/`[playwright]`).
[Wiring](../../docs/slicc-cli-details.md#follow-startup-ergonomics).

## follow `--eval` (persistent REPL)

`execrun.EvalSession` spawns the runner ONCE; responses framed by **output
quiescence** (`--eval-quiet`, default 500 ms) since REPLs never signal
completion. **Session outlives connections and drops**: a cancelled
per-connection context interrupts the in-flight computation (SIGINT; no-op on
Windows) but never kills the REPL — only `Close` and leader-sent SIGTERM/SIGKILL
do. `req.Cwd`/`req.Env` ignored; exec exit codes 0 while the REPL lives.
[Lifecycle](../../docs/slicc-cli-details.md#follow---eval-persistent-repl-lifecycle).

## Self-update (`slicc update`)

`internal/update` scans GitHub releases newest→oldest for the first with this
platform's `slicc-<os>-<arch>[.exe]` asset — releases are **sparse** (CLI
binaries attach only when `packages/slicc-cli` changed), so `releases/latest`
won't do. `startUpdateNotice()` refreshes a cached notice at most once per 24 h;
`SLICC_NO_UPDATE_CHECK=1` disables it. `IsReleaseVersion` gates both notice and
self-replace, so **`slicc update` refuses to clobber a local build ahead of the
latest tag**. `SLICC_UPDATE_API_BASE` overrides the API base.
[Details](../../docs/slicc-cli-details.md#self-update-mechanics).

## Telemetry

`telemetry.go` wires `packages/go-optel` (sibling Go module via local `replace`)
into two checkpoints: `enter` on launch and `error` on operational failure. **The
`error` `source` and the `enter` subcommand are always drawn from a fixed
allowlist (`dial`/`watch`/`follow`/`update`, `classifySubcommand`) — never
user-typed input.** `SLICC_NO_TELEMETRY=1` opts out; a `dev`/git-describe build
never configures a client. `Sanitize()` is **mandatory** (CLI error strings can
embed a bearer-token join URL): see `packages/go-optel/CLAUDE.md`,
`docs/operational-telemetry.md`, and the
[rationale](../../docs/slicc-cli-details.md#telemetry-design-rationale).

## Build / test / release

```bash
make build          # → bin/slicc
make check          # CI gate: gofmt + tidy-check + vet + golangci-lint + race + coverage floor
make lint           # golangci-lint (.golangci.yml)
make tidy-check     # fail when go.mod/go.sum drift from imports (Go analogue of TS knip)
make cover          # race tests + COVER_MIN floor (default 58%)
make test-json      # per-test timings → test-report.json (CI artifact)
make dist           # cross-compiled static binaries → dist/
```

`make check` is the CI gate; every test is hermetic — **no retry wrapper**.

Release binaries cut **atomically with semantic-release** and only when
`packages/slicc-cli/` changed since the last tag: `release-native.mjs`
(prepareCmd gate) invokes `sign-and-package.sh` when `decideSliccCliGating` opens
— cross-compiling on the macOS runner, Developer ID-signing + notarizing the
darwin binaries (unsigned without a cert). Full pipeline + OS-matrix rationale:
[signing](../../docs/slicc-cli-details.md#release-signing--notarization-pipeline),
[OS matrix](../../docs/slicc-cli-details.md#os-matrix-and-integration-test).
