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

# slicc

Client to another SLICC leader via its join URL. You keep leading your own tray.

Not `ssh` (down to a follower's real machine). Not `host join` (role switch that stops your leader). Attachments are additive and invisible to your tray.

```bash
slicc <target> prompt "<text>"
slicc <target> exec "<command>"
slicc <target> watch [--for <seconds>]
slicc --name lab https://www.sliccy.ai/join/abc123 exec "ls /workspace"
slicc lab exec "git -C /workspace log --oneline -5"
slicc lab prompt "what are you stuck on?"
git diff | slicc lab prompt @-
slicc lab prompt @/workspace/brief.md
slicc list
slicc detach lab                    # or: slicc detach --all
slicc https://…/join/abc123 --once exec "date"
```

`<target>` = join URL or attachment name. URLs stay warm after first dial. Text args: literal, `@path`, `-`/`@-` for stdin.

`watch` defaults to 30s; `--for <seconds>` or `--until-idle`. Read-only; no scoop jid → all scoops. Cone jid is a generated uid (from remote `host`), not `"cone"`.

Limits: you advertise `exec: false` (no inbound exec); no CLI `follow` equivalent; self-attach refused; max 8 attachments; `prompt`/`exec` use remote tokens/sudo; Ctrl+C interrupts remote. Session-only attachments (gone on reload).
