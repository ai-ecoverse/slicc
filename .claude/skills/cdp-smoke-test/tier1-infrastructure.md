# Tier 1 — Infrastructure (no AI provider required)

Validates infrastructure: build, harness, bridge, UI shell, kernel. No
account or API key is needed for any check in this tier.

Prerequisite: harness running and console watcher attached (see § Setup in
[SKILL.md](SKILL.md)).

## Checks

| Check           | How                                                                                                                                         | Pass                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Boot            | `slicc-cdp eval "document.readyState"`                                                                                                      | `complete`, composer present                  |
| Panels          | `slicc-cdp click "Files · VFS"` (also `Terminal`, `Memory`, `Monitor`, `Browser · CDP`), then `slicc-cdp shot /tmp/panel.png`               | each panel renders                            |
| Terminal        | `slicc-cdp term "help"` then screenshot                                                                                                     | kernel shell lists commands                   |
| Accounts dialog | `slicc-cdp click "Add AI"` (no provider yet) or `slicc-cdp click "Account"` then `slicc-cdp click "Account settings…"` (provider connected) | dialog with provider `<select>` (~40 entries) |
| Console         | `cat /tmp/slicc-console.log`                                                                                                                | no errors/exceptions                          |

## VFS checks

Run through the Terminal panel (open it first with
`slicc-cdp click "Terminal"`, wait ~2 s for the shell). Send each command
with `slicc-cdp term "…"`, then read the buffer with `slicc-cdp term-text`
after ~2 s — output asserts on text, not screenshots.

| Check          | Command                                                            | Pass                                                                                                          |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Seeded content | `ls /workspace && ls /shared`                                      | `/workspace`: `CLAUDE.md`, `skills`; `/shared`: `CLAUDE.md`, `sounds`, `sprinkles` (from `packages/vfs-root`) |
| Read           | `head -1 /shared/CLAUDE.md`                                        | `# sliccy`                                                                                                    |
| Write + read   | `echo vfs-ok > /workspace/.tier1-vfs && cat /workspace/.tier1-vfs` | `vfs-ok`                                                                                                      |
| Delete         | `rm /workspace/.tier1-vfs && cat /workspace/.tier1-vfs`            | `cat: … No such file or directory`                                                                            |

## Pitfalls

- `vfs` is not a kernel-shell command; type `help` in the terminal for the
  real list.
- The terminal panel is narrow — `term-text` output wraps long commands
  across lines; assert on output lines, not the echoed command.
- If a `term` send doesn't echo in the buffer (focus not yet settled after
  other CDP interactions), resend it once.
- Command output **without a trailing newline** is currently invisible in
  the interactive terminal (erased by the readline prompt redraw,
  issue #1583, fix: PR #1584) — keep assertions on newline-terminated output, or append
  `; echo` to the command.
