# slicc

A small, self-contained CLI that joins a running SLICC leader session as a
follower over WebRTC. Download a binary for your platform from the
[latest release](https://github.com/ai-ecoverse/slicc/releases) (macOS, Linux,
Windows — amd64 and arm64), or build from source with `make build`. The macOS
binaries are Developer ID-signed and notarized, so they run without a Gatekeeper
override. Bare executables cannot carry a stapled notarization ticket, so a copy
that has a quarantine attribute may require Apple's online Gatekeeper lookup on
first run.

```
slicc <join-url> prompt "<text>"                Send one message, stream the assistant's reply, exit
slicc <join-url> exec "<command>"               Run a command in the leader's shell, stream output, exit
slicc <join-url> watch [--plain] [scoop]        Tail the agent's output live (a scoop jid filters), until Ctrl+C
slicc <join-url> follow [--no-banner] [--plain] [runner]
                                                Stay connected; let the leader run commands on THIS machine
slicc <join-url> follow --eval [repl]           Same, but into ONE persistent REPL process (state persists)
slicc update [--check]                          Self-update to the newest released CLI binary
```

`watch` is read-only: it prints the leader's agent output as it streams (a
`tail -f` on what the cone is doing) and sends nothing back.

`<join-url>` is a leader's `https://…/join/<token>` link — the join link. Get it
from the leader's avatar menu → **Enable multi-browser sync** → the **Terminal**
tab of the Session sharing dialog, which hands you this whole command
ready to paste; or from its `host` command's `join_url`.

The `<text>`/`<command>` is curl-style — a literal string, `@path` (read a file),
or `-` / `@-` (read stdin):

```
git log --oneline -20 | slicc <url> exec cat   # pipe stdin to the leader command
echo "run this" | slicc <url> exec -           # stdin as the command text
slicc <url> prompt @brief.md                    # read a file
```

## follow — lend your machine to the leader

`follow` connects and stays up. If you give it a **runner**, the leader can run
shell commands here — each one runs as `<runner> <command>`:

```
slicc <url> follow bash -c                       # run commands via bash
slicc <url> follow sh -c
slicc <url> follow docker exec -i sandbox sh -c  # scope the leader to a container
```

- The runner names — and can sandbox — exactly what the leader may do. A bare
  `bash -c` gives full shell access as your user; a container/chroot/nsenter
  runner confines it.
- **With no runner (`slicc <url> follow`), exec is disabled** — you connect as a
  plain follower and every command is refused.
- A startup banner (ASCII wordmark + what the leader can run and as whom) prints
  on connect; `--no-banner` drops the art but keeps the safety warning. If the
  runner looks like it can't actually run commands (e.g. `follow bash` instead of
  `follow bash -c`), `follow` warns. Each command is echoed as it runs.
- The follower advertises a one-line summary of itself to the leader, so the agent
  sees who/what/where the target is via `ssh --list`.

⚠️ **`follow <runner>` is remote code execution by design.** The leader gets to
run commands on your machine. Only point it at leaders you trust, and prefer a
sandboxing runner. Set `SLICC_DEBUG=1` to see connection diagnostics on stderr.

## Live status bar

In an interactive terminal, `follow` keeps a status bar pinned below its output
and color-codes events as they happen (`watch` color-codes too, but leaves the
screen to the agent transcript it is streaming):

```
12:14:15 ✔ connected
12:14:26 ▸ exec: git status --short
12:15:02 ✖ tray attach: unexpected role "" (body: {
         │   "code": "TRAY_NOT_INITIALIZED"
         │ })
12:15:41 ✖ ↺ repeated (×6)
● connected  up 2m14s  ♥ 4s  ▸ 3 execs  ⇅ 1 reconnects  alice@laptop · bash -c  ▁▄████
```

Left to right, the bar shows the connection state (a spinner while connecting, a
live countdown while waiting to retry), uptime, how long ago the last message
from the leader arrived, exec and reconnect counts, suppressed link diagnostics
(`link ⚠ N` — the WebRTC/TURN churn that used to scroll past as
`turnc ERROR: …`, still readable with `SLICC_DEBUG=1`), who the leader runs
commands as, and a strip of recent connection history. A repeated error collapses
into one counted line instead of a wall.

Redirected output is plain and unchanged — no colors, no cursor tricks, every
occurrence logged — so pipes and CI keep working. To force that in a terminal,
use `--plain` or `SLICC_NO_TUI=1`; `NO_COLOR` keeps the bar without color, and
`COLUMNS` overrides the detected width.

On macOS, [Sliccstart](../swift-launcher/) can open `follow` mode in Terminal.app,
iTerm2, Ghostty, WezTerm, kitty, or Alacritty after a leader session is running.
It shows a one-time access warning and defaults the runner to the user's login
shell with `-c`; the command template is editable in **Settings → Terminals**.
Sliccstart resolves an existing managed, development-tree, or PATH-style binary
first and, with confirmation, downloads the signed and notarized Darwin release
into `~/Library/Application Support/Sliccstart/bin/slicc` when none is available.
The CLI is downloaded on demand and is not bundled in `Sliccstart.app`.

## follow --eval — lend the leader a persistent REPL

Plain `follow <runner>` spawns a fresh process per command, so REPL runners
lose all state between commands (and bare `node`/`python` would treat the
command as a script _file_). `follow --eval <repl>` fixes both: the REPL is
spawned **once**, each leader command is written as a line to its stdin, and
the output that follows streams back as the response. Variables, defs, and
imports persist across commands — and across reconnects, since the REPL
outlives the connection.

```
slicc <url> follow --eval python -i     # -i forces per-line eval on a pipe (prompts land on stderr)
slicc <url> follow --eval node -i       # node BUFFERS piped stdin until EOF without -i
slicc <url> follow --eval clojure       # clojure's REPL reads forms from a pipe as-is
```

Because REPLs never signal "this result is complete", a response ends once the
REPL has been **quiet for a window** (default 500 ms; tune with
`--eval-quiet <dur>`, e.g. `--eval-quiet 2s` for slow-printing REPLs). Output
of a long computation that stays silent past the window lands at the head of
the _next_ response instead — raise the window if that bites. Exit codes are
always 0 while the REPL lives (REPLs report errors in their output); if the
REPL process dies, the command errors and the follower needs a restart for a
fresh session. `exec.signal` SIGINT interrupts the current computation the way
Ctrl+C would in that REPL — the REPL itself survives (on Windows the signal is
ignored: nothing can interrupt a piped child there without killing it, and
killing the session would lose its state). A dropped connection never kills
the REPL either — it outlives reconnects; the in-flight command is interrupted
and any late output surfaces at the next response. The leader's agent sees a
REPL-flavored MOTD via
`ssh --list`, so it knows to send language code rather than shell commands.
Prompt/banner noise in responses is the REPL's own — quiet it with the REPL's
flags (`python -q`, etc.). `req.Cwd`/`req.Env` are ignored (the process is
already running).

## update — keep the binary fresh

`slicc update` finds the newest release that ships CLI binaries (not every SLICC
release does), downloads the one for your platform, verifies it runs, and
atomically replaces the running executable. `slicc update --check` only reports.

On regular launches the CLI also checks for a newer release **at most once a
day**, in the background, and prints a one-line notice on stderr when one
exists. The notice comes from a local cache
(`<user-cache-dir>/slicc/update-check.json`), so launches never wait on the
network. `SLICC_NO_UPDATE_CHECK=1` disables the launch check entirely. Dev
builds (any non-release-stamped version, incl. `git describe` output) never
check, and `slicc update` refuses to replace them with a release binary.

## Build

```bash
make build     # → bin/slicc
make check     # gofmt + go vet + golangci-lint + race tests + coverage
make dist      # cross-compiled static binaries → dist/
```

Developer/architecture notes are in [CLAUDE.md](./CLAUDE.md).
