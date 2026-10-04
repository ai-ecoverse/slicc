# slicc-cli

`slicc` — headless SLICC **follower** CLI in Go, joining a leader over the same
WebRTC tray-control data channel as browser + iOS followers. **Go module, not an
npm workspace** — built with `go`/`make`, not `npm`. Deep reference:
[details](../../docs/slicc-cli-details.md).

```
slicc <join-url> prompt [--allsettled 2m] "<text>"   Stream one assistant turn, then exit
slicc <join-url> wait --allsettled 2m       Observe all units until they settle, without a prompt
slicc <join-url> abort                      Stop the cone and its scoops; wait for abort_ack
slicc <join-url> exec "<command>"            Run in the leader's shell, stream output
slicc <join-url> new-session [--save|--skip|--erase]   Fresh cone chat, verified empty
slicc <join-url> model [--json] [<model>]    List models, or switch the cone
slicc <join-url> thinking [--json] [<level>] Print the cone's thinking level, or set it
slicc <join-url> watch [--plain] [scoop]     Tail the leader's live output, read-only
slicc <join-url> follow [--no-banner] [--plain] [runner]   Stay connected; run cmds via <runner>
slicc <join-url> follow --eval [repl]        Same, into ONE persistent REPL
slicc <join-url> follow --computer[=require] macOS: also bring this Mac's screen + input
slicc update [--check]                       Self-update to the newest released binary
slicc list-sessions [--json]                 List iCloud tray sessions (macOS; no join URLs)
slicc <verb>-cloud [--index N|--session <id>]   Resolve join URL from iCloud, run <verb>
```

- `prompt` ends on `turn_end`/`error`, or a processing→ready `status` flip
  (`SLICC_PROMPT_SETTLE`, default 2 s) with no resumed activity/pending
  `tool_use_start` — a tool-using turn flips `ready` **twice**, so exiting on the
  first gives an empty reply. A v10 leader's `user_message_ack` `rejected` exits 1.
  [Exit codes](../../docs/slicc-cli-details.md#prompt-exit-codes).
- `prompt --allsettled <dur>` (`prompt_settled.go`) also waits for every unit: exits
  once the turn ended, no unit is `processing` or has a pending tool, and no frame
  arrived for `<dur>`. `wait --allsettled <dur>` (`wait.go`) is a silent observer.
  [Details](../../docs/slicc-cli-details.md#prompt---allsettled).
- SIGINT: `prompt` sends `abort`, waits for `abort_ack`, exits 130 (no ack in
  `SLICC_ABORT_CONFIRM`, 12s → exit 1). The standalone `abort` verb sends the same
  frame and exits 0 only after the ack.
- `new-session`/`model`/`thinking` (`session.go`) reuse browser/iOS control
  messages: `new-session` polls `request_snapshot` until the transcript has no user
  message; `model` resolves an exact catalogue id; `thinking <level>` exits 1 if the
  resolved level differs (`--allow-downgrade`).
  [Thinking](../../docs/slicc-cli-details.md#thinking).
- `watch` — passive `tail -f` mirror; sends nothing, reconnects on drop.
  **Does NOT filter by scoop by default** — the cone's `scoopJid` is a generated uid
  (not `"cone"`); pass a scoop jid to filter. [Render](../../docs/slicc-cli-details.md#watch-rendering).
- `<text>`/`<command>` is curl-style: literal, `@path` (file), `-` / `@-` (stdin).
  `readTextArg` fires only for a single `@…`/`-` arg; multi-word args join as-is.
- The trailing argv of `follow` is the **runner** — each leader command is appended
  as the final arg (`follow bash -c`, `follow docker exec -i sandbox sh -c`); see
  Exec safety.

## iCloud tray sessions (`list-sessions`, `<verb>-cloud`)

macOS only; else `ErrUnsupported`. `internal/cloud` **shells out** to `Sliccstart
--list-sessions` (cgo + entitlements would break `CGO_ENABLED=0`), found via
`LocateExecutable` (`$SLICCSTART_APP` → `mdfind` → `/Applications` →
`~/Applications`). `list-sessions [--json]` is **metadata only** (id, label, device,
age) — **never a join URL**, safe to pipe/log. `<verb>-cloud`
(`follow`/`prompt`/`exec`/`watch`) resolves the **join URL** via `--reveal-urls`
(Mac consent prompt; denied over SSH until granted once from the screen) and
dispatches — URL never printed; newest first, `--index N` / `--session <id-prefix>`
pick another.

## `follow --computer` (native macOS screen + input)

macOS only; shells out to `Sliccstart --computer-follow <url> --pair <token>`
(`CGO_ENABLED=0`; TCC would attribute a bare binary to the terminal). Invariants:

- **One roster entry.** Both peers send the same `hello.pairId`; the leader folds
  them (`follower-pairing.ts`) into one machine tagged `[ssh] [computer]`.
- **Ready ≠ attached.** `..._READY` means only "understands the flag"; `Start`
  waits for `..._ATTACHED` (`..._FAILED <reason>` → `ErrAttachFailed`), never ready
  alone. Read via a line-scanning `cmd.Stdout` writer, not `StdoutPipe` (races
  `Wait`, dropping `FAILED`).
- **Lifecycle.** SIGTERM + grace on exit; a crashed CLI is covered by the launcher's
  parent-pid watch. `TRAY_SUPERSEDED` → `Retarget`. `--computer=require` exits
  non-zero on failure; plain `--computer` warns and follows on.
  [More](../../docs/slicc-cli-details.md#follow---computer-native-macos-screen--input)

## Why Go + pion, layout

`github.com/pion/webrtc/v4` is pure Go — one static binary cross-compiled for
macOS/Linux/Windows × amd64/arm64 (`CGO_ENABLED=0`, `dist`), interoperating with
browser leaders + Cloudflare TURN. Top-level `*.go` plus `internal/*/`; map:
[layout](../../docs/slicc-cli-details.md#layout).

## Protocol parity

`internal/protocol` mirrors a subset of the canonical TS union. A golden corpus
(`tray-sync-protocol-corpus.ts` → the ios-app `tray-sync-corpus.json` fixture) is
decoded by `internal/protocol/corpus_test.go`, so a wire change breaks `go test`;
regenerate the JSON + update Go and Swift mirrors.

## Diagnostics vs user-facing output

- **User-facing** — `prompt`/`exec`/`watch` write leader bytes to stdout, status to
  stderr. **Never route through the logger** (the CLI is pipeable).
- **Diagnostics** — signaling retries, supersede redirects, ICE failures,
  unparseable frames → `internal/logging` (`diagLogger` → stderr). Off by default
  (`SLICC_DEBUG=1`, `SLICC_LOG_LEVEL`, `SLICC_LOG_FORMAT=json`).
- **pion's own records** — `Conn.pionLoggerFactory` must install `logging.PionFactory`
  on `SettingEngine.LoggerFactory`: left nil, webrtc's default factory floods
  `os.Stderr` and buries output.
  [Why](../../docs/slicc-cli-details.md#pions-own-logging).

## Terminal presentation (`internal/ui`)

`follow`/`watch` render through `internal/ui` (raw ANSI, no TUI framework). On an
interactive terminal `follow` keeps a **sticky one-line status bar** that must own
the last row (dropped, colors kept, when another writer shares the stream).
**Plain mode is the contract**: with no terminal, output is byte-for-byte the
pre-TUI `slicc <verb>: <msg>` text, escape-free. `--plain`/`SLICC_NO_TUI=1` force it;
`NO_COLOR`/`FORCE_COLOR`/`CLICOLOR_FORCE`/`COLUMNS` tune it.
[Details](../../docs/slicc-cli-details.md#terminal-presentation-internalui).

## Exec safety (`follow`)

A `follow` with a runner advertises `hello.capabilities.exec = true`; each command
runs as `<runner> <command>` (runner sandboxes the surface) as the invoking user.
**No runner → no capability, every `exec.request` refused.** `runnerExecWarning`
flags the `follow bash` vs `follow bash -c` footgun. Startup banner (`--no-banner`
drops the art) + the `hello.motd` surfaced via `ssh --list`:
[More](../../docs/slicc-cli-details.md#follow-startup-ergonomics).

## follow `--eval` (persistent REPL)

`execrun.EvalSession` spawns the runner once; responses framed by output quiescence
(`--eval-quiet`, default 500 ms). **Session outlives connections**: a cancelled
per-connection context interrupts in-flight work (SIGINT; no-op on Windows) but
never kills the REPL — only `Close`/leader SIGTERM/SIGKILL do.
[Lifecycle](../../docs/slicc-cli-details.md#follow---eval-persistent-repl-lifecycle).

## Self-update (`slicc update`)

`internal/update` scans releases newest→oldest for this platform's
`slicc-<os>-<arch>[.exe]` — binaries attach only when `packages/slicc-cli` changed,
so `releases/latest` won't do. `IsReleaseVersion` gates notice + self-replace:
**`update` won't clobber a local build ahead of the latest tag**.
`SLICC_NO_UPDATE_CHECK=1` disables the ≤24 h notice.
[Details](../../docs/slicc-cli-details.md#self-update-mechanics).

## Telemetry

`telemetry.go` wires `packages/go-optel` into `enter` (launch) + `error` (failure)
checkpoints. **The `error` `source` and `enter` subcommand always come from a fixed
allowlist (`classifySubcommand`) — never user input.** `SLICC_NO_TELEMETRY=1` opts
out; a `dev` build configures no client. `Sanitize()` is **mandatory** (errors can
embed a bearer-token join URL).
[Rationale](../../docs/slicc-cli-details.md#telemetry-design-rationale),
`docs/operational-telemetry.md`.

## Build / test / release

```bash
make build          # → bin/slicc
make check          # CI gate: gofmt + tidy-check + vet + golangci-lint + race + coverage floor
make cover          # race tests + COVER_MIN floor (default 58%)
make dist           # cross-compiled static binaries → dist/
```

`make check` is the CI gate; every test is hermetic (no retry wrapper). Release
binaries cut atomically with semantic-release, only when `packages/slicc-cli/`
changed since the last tag (`release-native.mjs` → `sign-and-package.sh`, Developer
ID signing + notarizing the darwin binaries).
[Signing](../../docs/slicc-cli-details.md#release-signing--notarization-pipeline),
[OS matrix](../../docs/slicc-cli-details.md#os-matrix-and-integration-test).
