---
name: jshd
description: |
  Durable background .jsh units. Use when a script must outlive the shell
  command that started it, survive reload, or run as a daemon (dev servers,
  watchers, skill-side computer backends). Covers `jshd start|ls|status|stop|
  restart|rm|logs|enable|disable`.
allowed-tools: bash
---

# jshd

Durable `.jsh` units that outlive bash and restore after reload. Detached bash jobs die with the kernel worker — use `jshd` instead.

```bash
jshd start -n watcher --enable --restart always /workspace/watch.jsh
jshd ls
jshd logs watcher -n 50
jshd stop watcher          # or: kill <pid> — stop, no restart
jshd enable|disable watcher
jshd rm watcher            # stop + delete record + log
```

Records `/workspace/.jshd/<name>.json`; logs `/workspace/.jshd/log/<name>.log`. `ps` shows `kind: jsh`. Restart (`always`/`on-failure`/`no`) applies to natural exit only; 8 failures/60s → `errored` + lick.

Keep-alive = pending timers or host subscriptions (`hid`/`usb`, `sliccy:computer.register`). Computer backends: `require('sliccy:computer').register(...)` — see `examples/fake-computer.jsh`.

`--enable`d units relaunch after mounts restore, through cone `SudoFS`. Restricted scoops cannot start/stop/rm/enable/disable. Thin extension: `start` is best-effort; `ls` notes non-durable.
