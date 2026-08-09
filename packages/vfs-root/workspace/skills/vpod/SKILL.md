---
name: vpod
description: |
  Use this when running Linux commands in an isolated WebAssembly sandbox with
  SLICC's `vpod` shell command. Covers the ipk prerequisite, pod lifecycle
  (start/run/stop), snapshots, timeouts, and the guest-networking limits.
allowed-tools: bash
---

# vpod Linux sandboxes

The `vpod` shell command runs commands in a real 64-bit Linux guest compiled to WebAssembly (capsule-run/vpod) — a genuine kernel + userland, not a shell reimplementation. Pods are isolated from the VFS and from the host: work happens inside the guest, results come back as stdout/stderr.

## Install prerequisite

```bash
ipk add @capsule-run/vpod@0.6.0
```

There is no CDN fallback; uninstalled calls produce an actionable error with this exact command. First boot pulls the default snapshot from the vpod registry (git, curl, node, python3 baked in) and caches it in origin-private storage, so later boots are fast.

## Run commands

```bash
vpod run uname -a                     # auto-boots the default pod 'pod0'
vpod run python3 -c "print(6*7)"
vpod run --timeout 30 sh -c "git clone https://... && make"   # seconds
vpod run -- --weird-first-arg         # `--` ends flag parsing
```

`vpod run` returns the guest command's complete stdout/stderr and exit code when it finishes — there is no streaming and no TTY (vim, top, and REPLs time out; use one-shot invocations). Flags (`--name`, `--timeout`) are only recognized before the first command word, so guest args pass through untouched.

## Pod lifecycle

```bash
vpod start                            # boot the default pod explicitly
vpod start --name builder --snapshot node-20
vpod ls                               # list running pods
vpod stop [--name builder]            # close a pod
vpod --version                        # installed SDK version
```

Pods run in the background as ProcessManager-tracked units — `ps` shows them and `kill <pid>` closes them. One command runs at a time per pod; a second `vpod run` while one is in flight fails fast with a busy error (start a second named pod for parallel work).

## Networking

Guest networking requires cross-origin isolation (COOP/COEP response headers), which SLICC's origins do not serve — expect the guest to be offline (`backend: none`; `curl` inside the pod will fail). Check with:

```bash
vpod net                              # capabilities + why
vpod net --port 443                   # per-port reachability explanation
```

For network work, fetch on the host side (regular `curl` / `fetch` shell commands) and pass data into the pod via command arguments or heredocs instead.

## When to prefer vpod over v86

Both are sandboxed guests; pick by interaction model. `vpod` is command-in/result-out — fast boot, real 64-bit userland, ideal for running untrusted code or Linux-only tools. `v86` emulates full x86 hardware with a screen, keyboard, and serial console — use it when you need an interactive OS, a specific disk image, or graphics.
