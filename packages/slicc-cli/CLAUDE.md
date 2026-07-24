# slicc-cli

`slicc` — a headless SLICC **follower** CLI in Go. It joins a leader session over
the same WebRTC tray-control data channel the browser and iOS followers use, and
exposes three verbs. It is a **Go module, not an npm workspace** (like
`packages/ios-app`), so it is built with `go`/`make`, not `npm`.

```
slicc <join-url> prompt "<text>"    Stream one assistant turn, then exit
slicc <join-url> exec "<command>"   Run a command in the leader's shell, stream output
slicc <join-url> follow [--deny-exec]   Stay connected; run leader-issued commands here
```

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

`follow` advertises `hello.capabilities.exec = true`, which tells the leader it may
send `exec.request`. Each command runs via the platform shell (`bash -c` / `cmd /C`)
as the user who started `slicc`, and is echoed to stderr as it runs. A startup
banner states this plainly. `--deny-exec` connects as a plain follower and refuses
every `exec.request` with an error response.

## Build / test

```bash
make build          # → bin/slicc
make check          # gofmt check + go vet + go test (the CI gate)
make dist           # cross-compiled static binaries → dist/
go test ./...       # unit tests (protocol corpus, signaling mock, exec runner)
```

`integration_test.go` is the real end-to-end test: it drives the whole follower
path over an actual WebRTC connection (pion ↔ pion on loopback) — a leader peer
creates the `tray-control` channel, a mock signaling server bridges the SDP/ICE
exchange to `tray.Dial`, and the leader issues an `exec.request` that the follow
session runs locally and streams back. Deterministic (no browser, no TURN), so it
runs in the normal `go test` gate.
