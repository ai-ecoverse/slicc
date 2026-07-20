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

## Plumbing checks

Infrastructure Tier 2 silently depends on — all assertable pre-provider:

| Check           | How                                                                                                                                                         | Pass                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Bridge liveness | `slicc-cdp eval` for the header chip text (a leaf element containing `npx · live`)                                                                          | `npx · live` — leader↔bridge WebSocket is up                                                                     |
| Service workers | `slicc-cdp eval "navigator.serviceWorker.getRegistrations().then(rs => rs.map(r => ({sw: r.active?.scriptURL.split('/').pop(), state: r.active?.state})))"` | `llm-proxy-sw.js` + `preview-sw.js`, both `activated`                                                            |
| Network egress  | `slicc-cdp term "playwright-cli fetch https://example.com > /tmp/f.json; head -c 200 /tmp/f.json"`                                                          | JSON with `"status": 200` — fetch-proxy through the bridge                                                       |
| Browser control | `slicc-cdp term "playwright-cli open https://example.com && playwright-cli tab-list"`, then `playwright-cli tab-close --tab <targetId>`                     | tab opens with a `targetId`, appears in `tab-list`, closes — the same CDP loop Tier 2's agent uses, minus the AI |

## VFS checks

Run through the Terminal panel (open it first with
`slicc-cdp click "Terminal"`, wait ~2 s for the shell). Send each command
with `slicc-cdp term "…"`, then read the buffer with `slicc-cdp term-text`
after ~2 s — output asserts on text, not screenshots.

| Check          | Command                                                            | Pass                                                                                                          |
| -------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Seeded content | `ls /workspace && ls /shared`                                      | `/workspace`: `CLAUDE.md`, `skills`; `/shared`: `CLAUDE.md`, `sounds`, `sprinkles` (from `packages/vfs-root`) |
| Read           | `head -1 /shared/CLAUDE.md`                                        | `# sliccy`                                                                                                    |
| Shell state    | `cd /shared && pwd`, then `cd / && pwd`                            | `/shared`, then `/` — cwd persists across commands in the kernel session                                      |
| Write + read   | `echo vfs-ok > /workspace/.tier1-vfs && cat /workspace/.tier1-vfs` | `vfs-ok`                                                                                                      |
| Delete         | `rm /workspace/.tier1-vfs && cat /workspace/.tier1-vfs`            | `cat: … No such file or directory`                                                                            |

### Persistence across reload (run LAST — resets panel state)

Proves IndexedDB durability and re-exercises boot + bridge reattach:

1. `slicc-cdp term "echo persist-ok > /workspace/.tier1-persist"`
2. `slicc-cdp eval "location.reload(); 'reloading'"`, wait ~12 s, assert
   `document.readyState` is `complete`
3. `slicc-cdp term "cat /workspace/.tier1-persist && rm /workspace/.tier1-persist"`
   → `persist-ok` (the `term` command self-heals: it reopens the panel only
   when actually hidden and waits for the kernel prompt before typing)

## Pitfalls

- `vfs` is not a kernel-shell command; type `help` in the terminal for the
  real list.
- The terminal panel is narrow — `term-text` output wraps long commands
  across lines; assert on output lines, not the echoed command.
- `slicc-cdp term` self-heals dropped sends: it opens the panel only when
  hidden (blind "Terminal" clicks TOGGLE — they close an open panel),
  waits up to 15 s for the kernel prompt, verifies the echo, and retries
  once. If it still fails, the kernel session is genuinely stuck.
- Command output **without a trailing newline** is currently invisible in
  the interactive terminal (erased by the readline prompt redraw,
  issue #1583, fix: PR #1584) — keep assertions on newline-terminated output, or append
  `; echo` to the command.
