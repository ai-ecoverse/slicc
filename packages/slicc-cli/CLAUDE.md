# slicc-cli

`slicc` — a headless SLICC **follower** CLI in Go. It joins a leader session over
the same WebRTC tray-control data channel the browser and iOS followers use, and
exposes three verbs. It is a **Go module, not an npm workspace** (like
`packages/ios-app`), so it is built with `go`/`make`, not `npm`.

```
slicc <join-url> prompt "<text>"                Stream one assistant turn, then exit
slicc <join-url> exec "<command>"               Run a command in the leader's shell, stream output
slicc <join-url> watch [scoop]                  Tail the leader's live agent output, read-only
slicc <join-url> follow [--no-banner] [runner]  Stay connected; run leader-issued commands via <runner>
slicc <join-url> follow --eval [repl]           Same, into ONE persistent REPL (state persists; see README)
slicc update [--check]                          Self-update to the newest released CLI binary
```

`watch` is a passive `tail -f` on the agent that mirrors the browser thread: it
sends nothing and renders the human's prompt (`user_message_echo` → `> …`),
assistant text (`content_delta`), and tool calls (`tool_use_start` → `⚙ …`,
`tool_result` → `↳ …`), blanking a line at each turn boundary — reconnecting with
backoff (`cmdWatch`/`watchOnce`; `printWatchEvent` does the rendering). By default
it does **not** filter by scoop (the cone's `scoopJid` is a generated uid, not the
literal `"cone"`, and the leader broadcasts the selected scoop — the browser
view); pass a scoop jid to filter to one.

The `<text>`/`<command>` argument is curl-style: a literal string, `@path` (read a
file), or `-` / `@-` (read stdin) — so `git log | slicc <url> exec -` and
`slicc <url> prompt @brief.md` work. Resolution lives in `readTextArg` (main.go)
and only kicks in for a single `@…`/`-` argument, so multi-word prompts still join
verbatim.

The trailing argv of `follow` is the **runner** each leader-issued command is handed
to (command appended as the final arg): `follow bash -c`, `follow sh -c`,
`follow docker exec -i sandbox sh -c`, a multiplexer, `flatpak-spawn --host …`, etc.
With no runner, `follow` connects as a plain follower and refuses every command.

## Why Go + pion

The follower must speak real WebRTC (SCTP data channel) and interoperate with
browser leaders + Cloudflare TURN. `github.com/pion/webrtc/v4` is pure Go, so the
CLI cross-compiles to a single static binary for macOS/Linux/Windows × amd64/arm64
with `CGO_ENABLED=0` (see the `dist` target). No native toolchain required.

## Layout

| Path                  | Purpose                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.go`             | Arg parsing + subcommand dispatch + Ctrl+C handling                                                                                         |
| `commands.go`         | `prompt` / `exec` / `follow` implementations                                                                                                |
| `internal/protocol/`  | Wire structs mirroring `packages/shared-ts/src/tray-sync-protocol.ts` (the subset the CLI uses)                                             |
| `internal/signaling/` | HTTP follower client for `tray-signaling.ts` (attach → poll/answer/ice/retry), ported from the iOS connector                                |
| `internal/tray/`      | pion peer + `tray-control` data channel + follower state machine (hello, ping/pong, dispatch)                                               |
| `internal/execrun/`   | Cross-platform OS command runner backing `follow` (streams stdout/stderr, forwards signals) + `EvalSession` (persistent-REPL `--eval` mode) |
| `update.go`           | `cmdUpdate` (`slicc update [--check]`) + the on-launch update-notice hook                                                                   |
| `internal/update/`    | Release discovery (sparse-release scan), self-update apply, once-a-day cached notice                                                        |
| `internal/logging/`   | `log/slog` structured diagnostic logger (text/JSON handler, env-driven level) + the `Logf` adapter the `tray` seam consumes                 |

## Protocol parity

`internal/protocol` mirrors a subset of the canonical TS union. The golden corpus
(`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts` →
`packages/ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json`)
is decoded by `internal/protocol/corpus_test.go` for the message types the CLI
produces/consumes (`exec.*`, `hello`), so a wire change that breaks the CLI fails
`go test`. When the
tray protocol changes, regenerate the corpus JSON and update the Go structs +
`corpus_test.go` alongside the TS and Swift mirrors.

## Diagnostics vs user-facing output

Two output paths, deliberately separate:

- **User-facing streaming** — `prompt`/`exec`/`watch` write the leader's bytes
  straight to stdout (and their own status lines to stderr). Never route this
  through the logger; the CLI is meant to be pipeable.
- **Diagnostics** — signaling retries, supersede redirects, ICE failures and
  unparseable frames go through `internal/logging`, a `log/slog` logger built
  once in `commands.go` (`diagLogger`) and written to stderr. `debugLogf` is the
  thin `func(format string, args ...any)` adapter that satisfies the existing
  `tray.Options.Logf` seam, so `internal/tray` keeps its callback-shaped API.

Off by default. Enable with `SLICC_DEBUG=1` (legacy switch, equals
`SLICC_LOG_LEVEL=debug`) or `SLICC_LOG_LEVEL=debug|info|warn|error`;
`SLICC_LOG_FORMAT=json` swaps `slog.TextHandler` for `slog.JSONHandler`.

## Exec safety (`follow`)

A `follow` with a runner advertises `hello.capabilities.exec = true`, telling the
leader it may send `exec.request`. Each command runs as `<runner> <command>` (so
the runner names — and can sandbox — the exec surface, e.g. a container or a
restricted shell), as the user who started `slicc`, and is echoed to stderr as it
runs. A `follow` with **no** runner advertises no capability and refuses every
`exec.request` with an error response.

Startup ergonomics (all in `commands.go`):

- **Banner** — a small ASCII wordmark + the identity/runner/exec warning prints to
  stderr on start; `--no-banner` drops the art but keeps the safety warning.
- **Runner heuristic** (`runnerExecWarning`) — a known shell (`bash`/`sh`/`zsh`/…)
  or wrapper (`docker`/`podman`/…) without a trailing `-c` warns that the leader's
  command would be treated as a script FILE, not a command line — the `follow bash`
  (vs `follow bash -c`) footgun.
- **MOTD** (`hello.motd`, `followMotd`) — a one-line "who/what/where" summary the
  follower advertises so the leader surfaces it to the agent via `ssh --list`. The
  leader captures it in `tray-leader-sync.ts` (`getFollowerMotds`) and, alongside
  `getBrowserCapableBootstrapIds`, tags followers `[ssh]` / `[playwright]` in
  `host`. Additive + optional on the wire (browser/iOS peers omit it).

## follow `--eval` (persistent REPL)

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
restart). `follow.NewEvalSession`
routes `exec.request` into it; the MOTD advertises a REPL target so the
leader's agent sends language code, not shell. The banner warns about `node`
without `-i` (it buffers piped stdin until EOF). Tests fake the REPL with a
self-exec helper process (`TestEvalHelperProcess`) so the suite runs on all
three CI OSes; the e2e (`TestCLIFollowEvalPersistsState`) proves cross-command
state over real WebRTC using the platform shell as a line-eval stand-in.

## Self-update (`slicc update`)

`internal/update` scans GitHub releases newest→oldest for the first one carrying
this platform's `slicc-<os>-<arch>[.exe]` asset — releases are **sparse** (CLI
binaries only attach when `packages/slicc-cli` changed), so `releases/latest` is
not enough. The same bounded pagination as the worker's `/download/slicc-cli`
route (30/page, 5 pages max). `Apply` downloads next to the executable, runs the
staged binary's `--version` as a sanity gate, then atomically renames over the
running binary (Windows: parks the old file at `.old`, swept on later runs).

Regular verbs call `startUpdateNotice()` (main-package `update.go`): the upgrade
notice prints from a local cache (`<user-cache-dir>/slicc/update-check.json`)
and a background refresh runs at most once per 24 h, bounded-flushed at command
exit so short verbs still persist it. Disabled via `SLICC_NO_UPDATE_CHECK=1`
and for any non-release-stamped version (`dev`, `git describe` output) —
`IsReleaseVersion` gates both the notice and the self-replace, so `slicc
update` refuses to clobber a local build that is ahead of the latest tag.
`SLICC_UPDATE_API_BASE` overrides the API base (tests/mirrors).

## Build / test

```bash
make build          # → bin/slicc
make check          # CI gate: gofmt + tidy-check + go vet + golangci-lint + race tests + coverage floor
make lint           # golangci-lint run (config in .golangci.yml)
make tidy-check     # fail when go.mod/go.sum drift from the tree's imports
make cover          # race tests + total-coverage floor (COVER_MIN, default 58%)
make dist           # cross-compiled static binaries → dist/
```

Gates: `.golangci.yml` (staticcheck/errcheck/unused + funlen/gocyclo/gocognit for
complexity, matching the TS side's biome complexity gate), `make tidy-check`
(unused/missing module dependencies — the Go analogue of the TS side's knip run)
and the `COVER_MIN` coverage floor in the Makefile. All run in the `slicc-cli` CI
job via `make check`. Release binaries are cut **atomically with the semantic-release flow** and only
when `packages/slicc-cli/` changed since the last tag. `release-native.mjs`
(the prepareCmd gate) calls `sign-and-package.sh` when `decideSliccCliGating`
opens: it cross-compiles every target on the macOS release runner, Developer
ID-signs + notarizes the two darwin binaries (reusing release.yml's
`APPLE_CERTIFICATE_BASE64` cert and `APPLE_API_KEY_*` notarytool creds, and the
`setup-go` toolchain), and stages `artifacts/release/slicc-*` for
`@semantic-release/github` to attach. A bare CLI binary can't be stapled (only
`.app`/`.dmg`/`.pkg`), so Gatekeeper verifies the notarization online. With no
cert (a fork / local run) the binaries build + stage unsigned instead of failing.

**OS matrix:** the follower targets macOS/Linux/Windows, so CI runs `go test ./...`
on all three (`strategy.matrix.os`) to exercise the real per-OS runtime paths —
process-group signalling and the `cmd /c` vs `sh -c` runner — that a compile-only
check would miss. Tests pick the platform shell via a `testRunner()` helper so they
run rather than skip on Windows; only the genuinely POSIX-specific cases (`sleep` +
signal delivery) stay `runtime.GOOS == "windows"`-skipped. The static gate
(`make check`) and cross-compile (`make dist`) run once on Linux — they are
platform-independent, and the coverage floor would under-count where those cases skip.

`integration_test.go` is the real end-to-end test: it drives the whole follower
path over an actual WebRTC connection (pion ↔ pion on loopback) — a leader peer
creates the `tray-control` channel, a mock signaling server bridges the SDP/ICE
exchange to `tray.Dial`, and the leader issues an `exec.request` that the follow
session runs locally and streams back. Deterministic (no browser, no TURN), so it
runs in the normal `go test` gate.
