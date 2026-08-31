# slicc-cli

`slicc` — headless SLICC **follower** CLI in Go, joining a leader over the same
WebRTC tray-control data channel as browser + iOS followers. **Go module, not an
npm workspace** (like `packages/ios-app`) — built with `go`/`make`, not `npm`.
Deep-dive: [`docs/slicc-cli-details.md`](../../docs/slicc-cli-details.md).

```
slicc <join-url> prompt "<text>"                Stream one assistant turn, then exit
slicc <join-url> exec "<command>"               Run a command in the leader's shell, stream output
slicc <join-url> watch [--plain] [scoop]        Tail the leader's live agent output, read-only
slicc <join-url> follow [--no-banner] [--plain] [runner]
                                                Stay connected; run leader commands via <runner>
slicc <join-url> follow --eval [repl]           Same, into ONE persistent REPL
slicc update [--check]                          Self-update to the newest released CLI binary
slicc list-sessions [--json]                    List iCloud tray sessions (macOS; no join URLs)
slicc <verb>-cloud [--index N|--session <id>]   Resolve a session's join URL from iCloud, run <verb>
```

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

## Why Go + pion

`github.com/pion/webrtc/v4` is pure Go — the follower cross-compiles to a single
static binary for macOS/Linux/Windows × amd64/arm64 (`CGO_ENABLED=0`, `dist`
target), interoperating with browser leaders + Cloudflare TURN.

## Layout

`main.go` (argv + dispatch), `commands.go` (`prompt`/`exec`/`follow`),
`cloud.go` (`list-sessions` + `<verb>-cloud`), `update.go`, `telemetry.go`,
`internal/{protocol,signaling,tray,cloud,execrun,update,logging,ui}/`. Per-file
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
(tagged `[ssh]`/`[playwright]`).
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
