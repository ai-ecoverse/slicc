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
  status to stderr. Never through the logger (the CLI is pipeable).
- **Diagnostics** — retries, supersede redirects (`OnJoinURLChanged`), ICE
  failures, unparseable frames → `internal/logging` on stderr.
- **pion** — `Conn.pionLoggerFactory` **must** install `logging.PionFactory`.
  Left nil, pion writes TURN refresh errors straight to `os.Stderr` and no
  log level of ours can quiet it. Warn-and-above go to the status bar
  (`OnLinkDiag`) instead.

Off by default. `SLICC_DEBUG=1` / `SLICC_LOG_LEVEL=…`; `SLICC_LOG_FORMAT=json`
for JSON.

## Terminal presentation (`internal/ui`)

`follow`/`watch` use `internal/ui` (stdlib + `golang.org/x/sys`, raw ANSI).
Interactive `follow` keeps a **sticky one-line status bar** (state, uptime,
`♥` last-frame age via `OnActivity` on every inbound frame — the leader
answers pings rather than sending them). Repeats fold as `(×N)`.

**The bar must own the last row** — dropped (colors kept) when anything else
writes the same stream: `watch` with terminal stdout, or any verb once
diagnostics go to stderr (`SLICC_DEBUG=1`). See `watchModes` /
`stickyUnlessLogging` in `commands.go`.

**Plain mode is the contract**: no terminal → pre-TUI `slicc <verb>: <msg>`,
escape-free, no cursor control. `--plain` / `SLICC_NO_TUI=1` force it.
`NO_COLOR` / `FORCE_COLOR` / `COLUMNS` as usual. Glyph/ASCII fallback:
[details](../../docs/slicc-cli-details.md).

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

`execrun.EvalSession` spawns the runner once; responses framed by output
quiescence (`--eval-quiet`, default 500 ms). The REPL outlives reconnects
(SIGINT interrupts the group, does not kill it; only `Close` / leader
SIGTERM/SIGKILL do). `req.Cwd`/`req.Env` ignored; exec exit 0 while the REPL
lives. [Details](../../docs/slicc-cli-details.md).

## Self-update (`slicc update`)

`internal/update` scans GitHub releases for this platform's
`slicc-<os>-<arch>[.exe]` (sparse: only when `packages/slicc-cli` changed;
30/page, 5 pages). `Apply` downloads, `--version`-gates, then atomically
renames (Windows parks `.old`). Notice at most once per 24 h
(`SLICC_NO_UPDATE_CHECK=1` disables). `IsReleaseVersion` gates notice and
replace — **`slicc update` refuses to clobber a local `dev`/`git describe`
build**. [Details](../../docs/slicc-cli-details.md).

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

Release binaries cut **atomically with semantic-release** only when
`packages/slicc-cli/` changed: `release-native.mjs` → `sign-and-package.sh`,
cross-compile on macOS, Developer ID + notarize darwin
(`APPLE_CERTIFICATE_BASE64` + `APPLE_API_KEY_*`). **A bare CLI binary can't
be stapled.** No cert → unsigned, don't fail. Pipeline:
[details](../../docs/slicc-cli-details.md).
