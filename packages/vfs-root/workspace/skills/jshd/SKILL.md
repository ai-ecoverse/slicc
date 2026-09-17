---
name: jshd
description: |
  Durable background .jsh units. Use when a script must outlive the shell
  command that started it, survive reload, or run as a daemon (dev servers,
  watchers, skill-side computer backends). Covers `jshd start|ls|status|stop|
  restart|rm|logs|enable|disable`.
allowed-tools: bash
---

# jshd: durable background jsh units

Use `jshd` when a `.jsh` script (or skill command) should keep running after the bash call returns, and come back after a reload.

Do **not** use a detached `bash` job (`background_after: 0`) for this. Detached jobs die with the kernel worker. `jshd` persists a unit record and restores `--enable`d units on boot.

```bash
jshd start -n watcher --enable --restart always /workspace/watch.jsh
jshd ls
jshd logs watcher -n 50
jshd stop watcher          # stop, do not restart
kill <pid>                 # same: stop, do not restart
jshd enable watcher        # restore on next reload
jshd disable watcher       # leave running, skip restore
jshd rm watcher            # stop and delete record + log
```

Records: `/workspace/.jshd/<name>.json`. Logs: `/workspace/.jshd/log/<name>.log`.

`ps` shows the unit as `kind: jsh`. Restart policy (`always` / `on-failure` / `no`) applies only to a natural exit. A crash-loop (8 failures in 60s) marks the unit `errored` and licks the cone.

Keep-alive is the realm: pending timers or host-event subscriptions (`hid`/`usb` event listeners, `sliccy:computer.register`) keep the worker up. A script that returns with nothing pending exits.

A durable computer backend is a `jshd` unit that calls `require('sliccy:computer').register(...)`. The `register()` subscription to host `computer-call` events is the keep-alive. Example: `/workspace/skills/jshd/examples/fake-computer.jsh`.

`--enable`d units are relaunched after mounts restore and before the cone's first turn. Restored units keep canonical `PATH`, can still `exec` child commands, and run through the cone's `SudoFS` (writes to `/etc/sudoers` still require approval). Restricted scoop shells cannot `jshd start` (or stop/restart/rm/enable/disable) — units are cone-owned.

On the thin Chrome extension, `start` still runs as best effort; `ls` reports the unit is not durable (no DedicatedWorker).
