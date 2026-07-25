# slicc-cli

`slicc` — a headless SLICC **follower** CLI in Go. It joins a leader session over
the same WebRTC tray-control data channel the browser and iOS followers use, and
exposes three verbs. It is a **Go module, not an npm workspace** (like
`packages/ios-app`), so it is built with `go`/`make`, not `npm`.

```
slicc <join-url> prompt "<text>"      Stream one assistant turn, then exit
slicc <join-url> exec "<command>"     Run a command in the leader's shell, stream output
slicc <join-url> follow [runner...]   Stay connected; run leader-issued commands via <runner>
```

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

| Path                  | Purpose                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `main.go`             | Arg parsing + subcommand dispatch + Ctrl+C handling                                                          |
| `commands.go`         | `prompt` / `exec` / `follow` implementations                                                                 |
| `internal/protocol/`  | Wire structs mirroring `packages/shared-ts/src/tray-sync-protocol.ts` (the subset the CLI uses)              |
| `internal/signaling/` | HTTP follower client for `tray-signaling.ts` (attach → poll/answer/ice/retry), ported from the iOS connector |
| `internal/tray/`      | pion peer + `tray-control` data channel + follower state machine (hello, ping/pong, dispatch)                |
| `internal/execrun/`   | Cross-platform OS command runner backing `follow` (streams stdout/stderr, forwards signals)                  |

## Protocol parity

`internal/protocol` mirrors a subset of the canonical TS union. The golden corpus
(`packages/webapp/src/scoops/tray-sync-protocol-corpus.ts` →
`packages/ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json`)
is decoded by `internal/protocol/corpus_test.go` for the message types the CLI
produces/consumes (`exec.*`, `hello`), so a wire change that breaks the CLI fails
`go test`. When the
tray protocol changes, regenerate the corpus JSON and update the Go structs +
`corpus_test.go` alongside the TS and Swift mirrors.

## Exec safety (`follow`)

A `follow` with a runner advertises `hello.capabilities.exec = true`, telling the
leader it may send `exec.request`. Each command runs as `<runner> <command>` (so
the runner names — and can sandbox — the exec surface, e.g. a container or a
restricted shell), as the user who started `slicc`, and is echoed to stderr as it
runs. The startup banner shows the exact runner. A `follow` with **no** runner
advertises no capability and refuses every `exec.request` with an error response.

## Build / test

```bash
make build          # → bin/slicc
make check          # CI gate: gofmt + go vet + golangci-lint + race tests + coverage floor
make lint           # golangci-lint run (config in .golangci.yml)
make cover          # race tests + total-coverage floor (COVER_MIN, default 48%)
make dist           # cross-compiled static binaries → dist/
```

Gates: `.golangci.yml` (staticcheck/errcheck/unused + funlen/gocyclo/gocognit for
complexity, matching the TS side's biome complexity gate) and the `COVER_MIN`
coverage floor in the Makefile. Both run in the `slicc-cli` CI job. Release
binaries are attached to each GitHub release by `.github/workflows/slicc-cli-release.yml`
(decoupled from semantic-release; triggered on `release: published`).

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
