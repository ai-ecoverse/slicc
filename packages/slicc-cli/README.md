# slicc

A small, self-contained CLI that joins a running SLICC leader session as a
follower over WebRTC. Download a binary for your platform from the
[latest release](https://github.com/ai-ecoverse/slicc/releases) (macOS, Linux,
Windows — amd64 and arm64), or build from source with `make build`.

```
slicc <join-url> prompt "<text>"      Send one message, stream the assistant's reply, exit
slicc <join-url> exec "<command>"     Run a command in the leader's shell, stream output, exit
slicc <join-url> follow [runner...]   Stay connected; let the leader run commands on THIS machine
```

`<join-url>` is a leader's `https://…/join/<token>` link (from the leader's
"Copy tray join URL", or its `host` command's `join_url`).

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
- A startup banner states, in plain terms, what the leader can run and as whom.
  Each command is echoed as it runs.

⚠️ **`follow <runner>` is remote code execution by design.** The leader gets to
run commands on your machine. Only point it at leaders you trust, and prefer a
sandboxing runner. Set `SLICC_DEBUG=1` to see connection diagnostics on stderr.

## Build

```bash
make build     # → bin/slicc
make check     # gofmt + go vet + golangci-lint + race tests + coverage
make dist      # cross-compiled static binaries → dist/
```

Developer/architecture notes are in [CLAUDE.md](./CLAUDE.md).
