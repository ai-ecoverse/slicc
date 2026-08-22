# slicc-cli

`slicc` — headless SLICC **follower** CLI in Go, joining a leader over the
same WebRTC tray-control data channel as browser + iOS followers. **Go
module, not an npm workspace** (like `packages/ios-app`) — built with
`go`/`make`, not `npm`. Deep-dive:
[`docs/slicc-cli-details.md`](../../docs/slicc-cli-details.md).

```
slicc <join-url> prompt "<text>"                Stream one assistant turn, then exit
slicc <join-url> exec "<command>"               Run a command in the leader's shell, stream output
slicc <join-url> watch [--plain] [scoop]        Tail the leader's live agent output, read-only
slicc <join-url> follow [--no-banner] [--plain] [runner]
                                                Stay connected; run leader-issued commands via <runner>
slicc <join-url> follow --eval [repl]           Same, into ONE persistent REPL (state persists; see README)
slicc update [--check]                          Self-update to the newest released CLI binary
slicc list-sessions [--json]                    List iCloud-synced tray sessions (macOS only; no join URLs)
slicc <verb>-cloud [--index N|--session <id>]   Resolve a session's join URL from iCloud, then run <verb>
```

- `watch` — passive `tail -f` mirror; sends nothing, reconnects with backoff.
  **Does NOT filter by scoop by default** — the cone's `scoopJid` is a
  generated uid (not `"cone"`); pass a scoop jid to filter. Render map:
  [details](../../docs/slicc-cli-details.md).
- `<text>`/`<command>` is curl-style: literal, `@path` (file), `-` / `@-`
  (stdin) — e.g. `git log | slicc <url> exec -`,
  `slicc <url> prompt @brief.md`. `readTextArg` (`main.go`) only fires for a
  single `@…`/`-` arg; multi-word prompts join verbatim.
- The trailing argv of `follow` is the **runner** — each leader command is
  appended as the final arg: `follow bash -c`, `follow sh -c`,
  `follow docker exec -i sandbox sh -c`, a multiplexer,
  `flatpak-spawn --host …`. **With no runner, `follow` refuses every command.**

## iCloud tray sessions (`list-sessions`, `<verb>-cloud`)

macOS only. `internal/cloud` **shells out** to `Sliccstart --list-sessions`
(cgo + entitlements would break `CGO_ENABLED=0`); `LocateExecutable` tries
`$SLICCSTART_APP` → `mdfind` (bundle id `com.slicc.sliccstart`) →
`/Applications` → `~/Applications`. Off macOS: `ErrUnsupported`.

- `list-sessions [--json]` — **metadata only** (opaque id, label, device,
  age), **never a join URL** — safe to pipe/log.
- `<verb>-cloud` (`follow`/`prompt`/`exec`/`watch`) resolves a session's
  **join URL** via `--reveal-urls` (Mac consent prompt; denied over SSH
  until granted once from the screen) then dispatches. **URL never printed.**
  Newest by default; `--index N` / `--session <id-prefix>` (`ParseSelector`)
  picks another; remaining argv verbatim.

Pure logic (`ParseSessions`, `ParseSelector`, `Select`, `FormatTable`) is
platform-independent + unit-tested; darwin-only exec/locate lives in
`resolve_darwin.go`; the `cloudList` seam in `cloud.go` is overridden in
tests.

## Why Go + pion

`github.com/pion/webrtc/v4` is pure Go — the follower cross-compiles to a
single static binary for macOS/Linux/Windows × amd64/arm64 with
`CGO_ENABLED=0` (`dist` target). Interoperates with browser leaders +
Cloudflare TURN. No native toolchain.

## Layout

`main.go` (argv + dispatch), `commands.go` (`prompt`/`exec`/`follow`),
`cloud.go` (`list-sessions` + `<verb>-cloud`), `update.go`, `telemetry.go`,
`internal/{protocol,signaling,tray,cloud,execrun,update,logging,ui}/`. Full
per-file map: [details](../../docs/slicc-cli-details.md#layout).

## Protocol parity

`internal/protocol` mirrors a subset of the canonical TS union. The golden
corpus (`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts` →
`packages/ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json`)
is decoded by `internal/protocol/corpus_test.go` for `exec.*`/`hello`/`status`;
a wire change breaks `go test`. On protocol changes, regenerate the corpus
JSON and update Go structs + `corpus_test.go` alongside TS + Swift mirrors.

## Diagnostics vs user-facing output

- **User-facing** — `prompt`/`exec`/`watch` write leader bytes to stdout,
  status to stderr. **Never route through the logger**; the CLI is pipeable.
- **Diagnostics** — signaling retries, supersede redirects (`OnJoinURLChanged`
  persists the replacement across `follow`/`watch` reconnects), ICE failures,
  unparseable frames go through `internal/logging` (`log/slog` `diagLogger`
  in `commands.go`, to stderr); `debugLogf` adapts to `tray.Options.Logf`.
- **pion's own records** — `Conn.pionLoggerFactory` installs
  `logging.PionFactory` on `SettingEngine.LoggerFactory`. **Required**: left
  nil, webrtc installs pion's default factory, which writes error records
  straight to `os.Stderr` — TURN refresh churn (`turnc ERROR: Fail to refresh
permissions`) then buries the CLI's own output and no log level of ours can
  quiet it. Warn-and-above records are tallied into the status bar
  (`tray.Options.OnLinkDiag`) instead of printed.

Off by default. `SLICC_DEBUG=1` (legacy = `SLICC_LOG_LEVEL=debug`) or
`SLICC_LOG_LEVEL=debug|info|warn|error`; `SLICC_LOG_FORMAT=json` swaps
`slog.TextHandler` for `slog.JSONHandler`.

## Terminal presentation (`internal/ui`)

`follow`/`watch` render through `internal/ui` (stdlib + `golang.org/x/sys`, raw
ANSI — no TUI framework). On an interactive terminal `follow` keeps a **sticky
one-line status bar** below the log: state badge (connect spinner, live retry
countdown), uptime, `♥` age of the last frame from the leader (fed by
`tray.Options.OnActivity`, which fires on _every_ inbound frame — the leader
answers pings rather than sending them, so keepalives alone would never
populate it), exec + reconnect counts, suppressed link diagnostics,
`user@host · runner`, and a per-5s connection-history strip.
Event lines are stamped, colored and glyph-marked; an identical repeat folds in
place as `(×N)`, or into a compact `↺ repeated (×N)` row when the event cannot
be rewritten safely (too tall, soft-wrapped, or holding text whose cell width we
cannot be sure of — emoji, CJK, invalid bytes). So a reconnect loop no longer
scrolls the screen away.

**The bar must own the last row**, so it is dropped (colors kept) when anything
else writes to the same stream: `watch` when **stdout** is also a terminal (its
transcript arrives in partial lines), and any verb once the diagnostic logger is
turned up (`SLICC_DEBUG=1` and friends write to **stderr** directly). Both
decisions live in `commands.go` — `watchModes` and `stickyUnlessLogging`.

**Plain mode is the contract**: with no terminal attached, output is
byte-for-byte the pre-TUI `slicc <verb>: <msg>` text, escape-free, with every
occurrence kept. Cursor control is never written to a non-terminal.
`--plain` / `SLICC_NO_TUI=1` force plain; `NO_COLOR` keeps the bar without
color; `FORCE_COLOR`/`CLICOLOR_FORCE` colors a redirected stream (still not
sticky); `COLUMNS` overrides the detected width. Design notes + the glyph/ASCII
fallback rules: [details](../../docs/slicc-cli-details.md).

## Exec safety (`follow`)

A `follow` with a runner advertises `hello.capabilities.exec = true`; each
command runs as `<runner> <command>` (runner sandboxes the exec surface),
as the user who started `slicc`, echoed to stderr (`follow.Session` writes a
bare `exec: <command>`; the console owns the prefix and styling). **A `follow` with no
runner advertises no capability and refuses every `exec.request` with an
error.** Banner + safety warning on start (`--no-banner` drops art, keeps
warning); `runnerExecWarning` flags the `follow bash` vs `follow bash -c`
footgun; MOTD (`hello.motd`, `followMotd`) surfaces via the leader's
`ssh --list` (`tray-leader-sync.ts` tags `[ssh]` / `[playwright]` in
`host`). Additive + optional on the wire.
[Details](../../docs/slicc-cli-details.md).

## follow `--eval` (persistent REPL)

`execrun.EvalSession` spawns the runner ONCE; responses framed by **output
quiescence** (`--eval-quiet`, default 500 ms) — REPLs never signal
completion. **Session outlives connections and drops**: cancelled
per-connection contexts run `interruptProcess` (SIGINT to the group; no-op
on Windows) but never kill the REPL; only `Close` and leader-sent
SIGTERM/SIGKILL do. `req.Cwd`/`req.Env` ignored; exec exit codes 0 while
REPL lives. `follow.NewEvalSession` routes `exec.request` in; MOTD
advertises a REPL target. Banner warns about `node` without `-i`.
[Details](../../docs/slicc-cli-details.md).

## Self-update (`slicc update`)

`internal/update` scans GitHub releases newest→oldest for the first with
this platform's `slicc-<os>-<arch>[.exe]` asset — releases are **sparse**
(CLI binaries only attach when `packages/slicc-cli` changed); same bounded
pagination as the worker's `/download/slicc-cli` route (30/page, 5 pages
max). `Apply` downloads, sanity-gates via `--version`, then atomically
renames over the running binary (Windows parks the old at `.old`).
`startUpdateNotice()` (`update.go`) refreshes
`<user-cache-dir>/slicc/update-check.json` at most once per 24 h.
`SLICC_NO_UPDATE_CHECK=1` disables it; `IsReleaseVersion` gates both notice
and self-replace, so **`slicc update` refuses to clobber a local build
ahead of the latest tag** (`dev`, `git describe`). `SLICC_UPDATE_API_BASE`
overrides the API base. [Details](../../docs/slicc-cli-details.md).

## Telemetry

`telemetry.go` wires `packages/go-optel` (sibling Go module via local
`replace`) into two checkpoints: `enter` on launch (`initTelemetry` from
`main.go`'s `run()`) and `error` on operational failure
(`reportRuntimeError(source, err)` from dial-error branches in
`commands.go` and update-check/apply branches in `update.go`). **`source`
is always one of a fixed set (`dial`, `watch`, `follow`, `update`) — never
user-typed input** (join URL, exec/prompt text); `classifySubcommand`
allowlists the `enter` beacon's subcommand. `SLICC_NO_TELEMETRY=1` opts
out; `update.IsReleaseVersion(version)` means a `dev`/git-describe build
never configures a client. See `packages/go-optel/CLAUDE.md` for why
`Sanitize()` is **mandatory** — CLI error strings can embed a bearer-token
join URL — and `docs/operational-telemetry.md` ("CLI Telemetry").

## Build / test / release

```bash
make build          # → bin/slicc
make check          # CI gate: gofmt + tidy-check + vet + golangci-lint + race + coverage floor
make lint           # golangci-lint (.golangci.yml)
make tidy-check     # fail when go.mod/go.sum drift from imports
make cover          # race tests + COVER_MIN floor (default 58%)
make test-json      # per-test timings → test-report.json (CI artifact)
make dist           # cross-compiled static binaries → dist/
```

**No retry wrapper**: every test is hermetic. Gates via `make check` in
the `slicc-cli` CI job: staticcheck/errcheck/unused + funlen/gocyclo/
gocognit; `make tidy-check` (Go analogue of TS knip); `COVER_MIN` floor.

Release binaries cut **atomically with semantic-release** and only when
`packages/slicc-cli/` changed since the last tag: `release-native.mjs`
(prepareCmd gate) invokes `sign-and-package.sh` when `decideSliccCliGating`
opens, cross-compiling every target on the macOS runner, Developer
ID-signing + notarizing the darwin binaries (`APPLE_CERTIFICATE_BASE64` +
`APPLE_API_KEY_*`), staging `artifacts/release/slicc-*` for
`@semantic-release/github`. **A bare CLI binary can't be stapled**;
Gatekeeper verifies notarization online. Without cert (fork/local): stages
unsigned instead of failing. Full pipeline + OS-matrix rationale
(`testRunner()`, `integration_test.go` pion↔pion loopback):
[details](../../docs/slicc-cli-details.md).
