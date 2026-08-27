---
name: slicc
description: |
  Use this when you need to reach ANOTHER SLICC instance — ask its agent a
  question, run a command in its virtual shell, or watch what it is doing —
  given its tray join URL. Covers the three client verbs (`prompt`, `exec`,
  `watch`), how attachments are named and reused, and the two distinctions that
  matter: `slicc` is the reverse of `ssh`, and it is NOT `host join` (your own
  tray keeps running). Also covers what it deliberately cannot do.
allowed-tools: bash
---

# slicc — talk to another SLICC leader

Given another instance's join URL, `slicc` connects to it as a client over the
same tray data channel its followers use. You keep leading your own tray the
whole time.

## Two things this is not

- **Not `ssh`.** `ssh <runtime-id> <cmd>` runs a command _down_ your tray, on a
  follower that lent you its machine. `slicc <join-url> exec <cmd>` runs one _up_
  a tray you joined, in a remote leader's **virtual** shell — its VFS, its tools,
  no real machine involved.
- **Not `host join`.** That is a role switch: it stops your leader and hands your
  UI to the remote instance. An attachment here is additive and invisible to your
  own tray.

## Verbs

```bash
slicc <target> prompt "<text>"          # one assistant turn from the remote agent
slicc <target> exec "<command>"         # run in the remote leader's virtual shell
slicc <target> watch [--for <seconds>]  # tail its live output (read-only)
```

`<target>` is a join URL (`https://…/join/<token>`) or the name of an existing
attachment. A URL is dialed once and **kept warm**, so a run of commands against
the same instance pays one handshake:

```bash
slicc --name lab https://www.sliccy.ai/join/abc123 exec "ls /workspace"
slicc lab exec "git -C /workspace log --oneline -5"
slicc lab prompt "what are you stuck on?"
```

Text arguments are curl-style — literal, `@path` for a VFS file, `-` / `@-` for
piped stdin:

```bash
git diff | slicc lab prompt @-
slicc lab prompt @/workspace/brief.md
```

Housekeeping (attachments are session-only; a reload starts with none):

```bash
slicc list
slicc detach lab                                  # or: slicc detach --all
slicc https://…/join/abc123 --once exec "date"    # attach, run, drop
```

## watch is bounded

A shell command returns one buffered result, so there is no `tail -f` to leave
running. `watch` takes a window instead — default 30s, `--for <seconds>` to
change it, `--until-idle` to stop early once the remote's current turn finishes.
It sends nothing to the remote. With no scoop jid it renders every scoop; the
cone's jid is a generated uid (not `"cone"`), readable from the remote's `host`.

## Limits and trust

- **You are a client, not a target.** The attachment advertises `exec: false` and
  refuses inbound `exec.request`. A remote leader cannot make you run anything.
- **The CLI's `follow` verb has no equivalent here** — that one serves a remote
  leader's commands on a real machine, which is a different trust decision.
- Attaching to your own tray is refused; it would deadlock the leader thread.
- At most 8 attachments at once. `detach` when done.
- `prompt` spends the **remote** instance's tokens on the **remote** model, and
  `exec` runs under the **remote** instance's sudo policy, not yours.
- Ctrl+C (or an aborted turn) interrupts the remote turn or command.
