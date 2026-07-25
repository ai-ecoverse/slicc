# slicc

A small, self-contained CLI that joins a running SLICC leader session as a
follower over WebRTC. Download a binary for your platform from the
[latest release](https://github.com/ai-ecoverse/slicc/releases) (macOS, Linux,
Windows — amd64 and arm64), or build from source with `make build`. The macOS
binaries are Developer ID-signed and notarized, so they run without a Gatekeeper
override.

```
slicc <join-url> prompt "<text>"                Send one message, stream the assistant's reply, exit
slicc <join-url> exec "<command>"               Run a command in the leader's shell, stream output, exit
slicc <join-url> watch [scoop]                  Tail the agent's output live (a scoop jid filters), until Ctrl+C
slicc <join-url> follow [--no-banner] [runner]  Stay connected; let the leader run commands on THIS machine
slicc update [--check]                          Self-update to the newest released CLI binary
```

`watch` is read-only: it prints the leader's agent output as it streams (a
`tail -f` on what the cone is doing) and sends nothing back.

`<join-url>` is a leader's `https://…/join/<token>` link (from the leader's
"Copy tray join URL", or its `host` command's `join_url`).

The `<text>`/`<command>` is curl-style — a literal string, `@path` (read a file),
or `-` / `@-` (read stdin):

```
git log --oneline -20 | slicc <url> exec -      # pipe stdin
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
