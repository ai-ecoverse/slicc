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

# ssh

Run a command on a `slicc … follow <runner>` CLI follower (or iOS exec target).

```bash
host                 # followers: [ssh] [computer] [playwright]
ssh --list           # exec targets + runtime ids + MOTD
ssh <runtime-id> "<command>"
ssh --cwd /dir <runtime-id> "ls -la"
ssh --timeout 30 <runtime-id> "<command>"
```

Ids look like `follower-<uuid>`. Browser followers are never targets. iOS accepts only `open [--universal|--x-callback] <url>` (on-device approval); `--universal` needs a universal link; `--x-callback` returns bounded JSON with distinct exit codes. `host` hides capability-less followers as a count.

Command runs as `<runner> <command>` on the follower (fixed by the follower: `bash -c`, `docker exec …`, etc.). Output buffered until complete; Ctrl+C aborts remote.

**Trust:** real machine, as the user who started `follow`, **outside** this leader's `/etc/sudoers`. Prefer narrow commands; never pipe untrusted input. To talk _up_ into another leader's virtual shell, use the `slicc` skill.
