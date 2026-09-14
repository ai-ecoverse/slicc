---
name: ssh
description: |
  Use this when you need to run a shell command on a connected tray follower —
  specifically a `slicc … follow <runner>` CLI follower that lent its machine as
  an exec target. Covers discovering targets (`host`, `ssh --list`), running
  commands (`ssh <runtime-id> <command>`), what a runner is, timeouts and Ctrl+C,
  and the important trust boundary: the command runs on the follower's real
  machine, as the user who started it, OUTSIDE this leader's sudo policy.
allowed-tools: bash
---

# ssh — run a command on a tray follower

A `slicc … follow <runner>` CLI follower (see `packages/slicc-cli`) can lend its
machine to you as a remote-exec target. `ssh` runs a command there and returns its
stdout, stderr, and exit code.

## Discover targets

CLI followers started with a **runner** and iOS followers advertising exec are targets. Find them:

```bash
host           # exec targets tagged [ssh]; browser targets tagged [playwright]
ssh --list     # just the exec targets + their runtime ids, each with a MOTD line
```

A target id looks like `follower-<uuid>`. `ssh --list` prints each target's
advertised MOTD beneath it so you know what you're connecting to. Browser
followers are never `ssh` targets. iOS followers accept only
`open [--universal|--x-callback] <url>`, gate it through on-device scoped
approval, and launch the approved destination. `--universal` requires a universal
link; `--x-callback` returns bounded JSON on stdout and distinct success, error,
or cancel exit codes. An unavailable app fails instead of pretending to launch.
`host` hides capability-less followers (e.g. transient `prompt`/`exec` CLI
connections) as a count, so the list stays the actionable targets.

## Run a command

```bash
ssh <runtime-id> "<command>"
ssh --cwd /some/dir <runtime-id> "ls -la"
ssh --timeout 30 <runtime-id> "<command>"   # kill on the follower after 30s
```

The command runs as `<runner> <command>` on the follower, where `<runner>` is
whatever it was started with — e.g. `bash -c`, `sh -c`, or a sandbox like
`docker exec -i box sh -c`. The runner is fixed by the follower; you cannot change
it from here. Output is returned once the command completes (buffered, like
`ssh host cmd`). Ctrl+C / an aborted turn interrupts the remote command.

## Trust boundary (read before using)

- The command executes on the **follower's real machine, as the user who started
  `slicc … follow`** — this is remote code execution by design.
- It runs **outside this leader's `/etc/sudoers` policy**. Your sudo rules do NOT
  gate `ssh` — the follower's own choice of runner is the only sandbox (a
  container runner scopes it; a bare `bash -c` does not).
- Treat an exec target like SSH access to someone's box: run only what you'd run
  there directly, prefer the narrowest command, and never pipe untrusted input
  into it.

## The other direction

`ssh` goes _down_ the tray, to a follower of yours. To go _up_ — into another
SLICC leader's virtual shell, given its join URL — use the `slicc` skill.
