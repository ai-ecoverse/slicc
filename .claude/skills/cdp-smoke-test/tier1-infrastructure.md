# Tier 1 — Infrastructure (no AI provider required)

Validates infrastructure: build, harness, bridge, UI shell, kernel. No
account or API key is needed for any check in this tier.

Prerequisite: harness running and console watcher attached (see § Setup in
[SKILL.md](SKILL.md)).

## Checks

| Check           | How                                                                                                                           | Pass                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Boot            | `slicc-cdp eval "document.readyState"`                                                                                        | `complete`, composer present                  |
| Panels          | `slicc-cdp click "Files · VFS"` (also `Terminal`, `Memory`, `Monitor`, `Browser · CDP`), then `slicc-cdp shot /tmp/panel.png` | each panel renders                            |
| Terminal        | `slicc-cdp term "help"` then screenshot                                                                                       | kernel shell lists commands                   |
| Accounts dialog | `slicc-cdp click "Add AI"`                                                                                                    | dialog with provider `<select>` (~40 entries) |
| Console         | `cat /tmp/slicc-console.log`                                                                                                  | no errors/exceptions                          |

## Pitfalls

- `vfs` is not a kernel-shell command; type `help` in the terminal for the
  real list.
