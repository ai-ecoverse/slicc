# Shell Reference

Complete reference for SLICC's shell capabilities, including supplemental commands, .jsh scripts, and binary handling.

---

## Overview

SLICC uses `just-bash` (a pure-TypeScript Bash interpreter; see `packages/webapp/package.json` for the pinned version) as its core shell runtime. The interpreter itself is plain JavaScript — not WASM. This provides the standard Unix builtins (cd, ls, cat, grep, find, sed, awk, head, tail, etc.) plus ~50 custom supplemental commands registered by `packages/webapp/src/shell/supplemental-commands/index.ts` and `packages/webapp/src/shell/almost-bash-shell-headless.ts`, and any auto-discovered `.jsh` script commands on the VFS.

WASM enters only for specific runtime-heavy commands, which fetch and cache their binaries on demand: `python3` (Pyodide), `sqlite3` (sql.js), `convert` (ImageMagick), `ffmpeg`, `biome`, `esbuild`, and `v86` (x86 VM emulator). The `node -e` / `javascript` / `.jsh` sandbox is **not** WASM: scripts run as native JavaScript in the kernel's DedicatedWorker JS realm (V8 in Chrome), with user code compiled to an `AsyncFunction` body — see `packages/webapp/src/kernel/realm/realm-factory.ts` and `realm-module-system.ts` (`runUserCode`). The `AlmostBashShell` / `AlmostBashShellHeadless` classes cover the whole shell, not just the WASM-backed commands.

`convert` covers practical ImageMagick workflows beyond basic resizing: optimized thumbnails, EXIF auto-orientation, crop/extent canvas geometry, flip/flop, strip/trim, alpha and colorspace conversion, transparency, blur/sharpen, nested append composition, and text annotation. Run `convert --help` for the supported syntax and modifiers.

**Entry point**: Via the `bash` agent tool. All shell features available to agents.

### Shared `/tmp` scratch space and `$TMPDIR`

The virtual `/tmp` directory is shared, disposable scratch space for the cone and scoops; it is not the host operating system's temporary directory. It stays readable and writable by every unit.

**Write to `$TMPDIR`, not to `/tmp`.** Every unit's shell publishes `$TMPDIR` pointing at a scratch directory of its own, created before the first turn:

| unit                                 | `$TMPDIR`                |
| ------------------------------------ | ------------------------ |
| cone `cone`                          | `/tmp/cone`              |
| cone `cone-adobe`                    | `/tmp/cone-adobe`        |
| scoop `review` owned by `cone-adobe` | `/tmp/cone-adobe/review` |

A scoop's directory nests inside its owning cone's, so a cone can still read back what its scoop wrote (`agent … >> "$TMPDIR/out.txt"`) and disposing of a cone's scratch disposes of its scoops' too. `mktemp` resolves against `$TMPDIR`. A `.profile` `export TMPDIR=…` overrides it per shell; a secret named `TMPDIR` does not.

This is a **convention, not a sandbox** — one unit can still read and write another's scratch, exactly as on a real POSIX system. What it buys is a directory nothing else _routinely_ touches.

Its cleanup boundary is the explicit **New session** control: **Save & start new**, **New chat — skip memory**, and **Erase & start new** each remove the entries under the selected cone's own `$TMPDIR` before its chat is cleared — a sibling cone's scratch is never in the blast radius. Active mount roots below it and the directories containing them stay attached and are never traversed, so mounted Local, S3, and DA contents are not treated as scratch data. Page reload, app restart, and scoop creation do not clear `/tmp`.

### Bash builtins: `help` lists more than just-bash implements

just-bash ships bash's complete `help` topic table while implementing only part of it. Thirteen advertised names — `bg`, `caller`, `disown`, `enable`, `fc`, `fg`, `jobs`, `logout`, `suspend`, `times`, `trap`, `ulimit`, `umask` — reached command lookup and answered `command not found` (127). `trap` was the dangerous one: the parser accepted `trap 'cleanup' EXIT`, the script kept running, and a handler that was never installed looked like it had worked.

`packages/webapp/src/shell/supplemental-commands/bash-builtins-command.ts` registers all thirteen; the behaviour and usage text live in `bash-builtins/run.ts`, imported on first use because `index.ts` is boot-critical. Custom commands are consulted only after builtins, so these names reach dispatch precisely because upstream has no builtin for them — they can never shadow one just-bash later implements. Two behaviours, no third:

**Faithful** — where real bash without job control already answers with a diagnostic, this shell answers with bash's own text and exit code:

| command                       | behaviour                                                     |
| ----------------------------- | ------------------------------------------------------------- |
| `jobs`                        | empty table, exit 0; a jobspec gets `%1: no such job`, exit 1 |
| `fg` / `bg`                   | `bash: fg: no job control`, exit 1                            |
| `suspend`                     | `bash: suspend: cannot suspend: no job control`, exit 1       |
| `disown`                      | `bash: disown: current: no such job`, exit 1                  |
| `logout`                      | ``bash: logout: not login shell: use `exit'``, exit 1         |
| `trap -l`                     | the five signals the kernel can deliver (see `kill --help`)   |
| `trap` / `trap -p`            | empty trap table, exit 0                                      |
| `trap - SPEC`, `trap '' SPEC` | exit 0 — nothing is trapped, and nothing raises these         |

`jobs` is empty rather than wrong: `&` runs its command synchronously here, so a backgrounded command has already finished by the time `jobs` runs. For long-lived kernel processes use `ps` and `kill`.

**Loud** — everything this shell genuinely cannot do exits **2** with a one-line reason and, where one exists, the working alternative. Never a silent no-op, so `set -e` scripts stop instead of carrying on:

| command           | why, and what to use instead                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `trap 'cmd' SPEC` | no signal-delivery path into a running script — the handler could never fire. Run cleanup on the normal path or in a `\|\|` branch |
| `caller`          | the interpreter exposes no caller frames                                                                                           |
| `enable`          | builtins cannot be enabled/disabled/loaded; list with `help` or `commands`                                                         |
| `fc`              | no history editing; use `history`                                                                                                  |
| `times`           | no per-process CPU accounting; use `time <command>`                                                                                |
| `ulimit`          | interpreter limits are fixed at boot; see `df` and `meminfo`                                                                       |
| `umask`           | the VFS has no file-creation mask; use `chmod`                                                                                     |

`select` is a separate gap: it is a missing shell **keyword**, not a builtin, so it fails in just-bash's parser (`syntax error near unexpected token 'select'`, exit 2) before command lookup happens and no registration can reach it. It is not in the `help` table either, so nothing advertises it.

`bash-builtins-command.test.ts` walks the live `help` listing through a real shell and asserts no advertised name answers 127 — that is what keeps the table and dispatch from drifting apart across a just-bash upgrade.

---

## Supplemental Commands

Custom commands implemented in TypeScript and registered in just-bash.

### `--help` on a subcommand is always safe

For every command that dispatches on a verb (`playwright-cli`, `mcp`, `v86`, `layout`, `plugin`, `sprinkle`, `workflow`, …), `<command> <verb> --help` prints that verb's usage and **does nothing else**. Asking for help never opens a tab, stops a VM, rearranges panels, or deletes a registered server — the check runs before the verb's handler, and `packages/webapp/tests/shell/supplemental-commands/subcommand-help.test.ts` proves it by building every command with dependencies that throw on use.

When a verb's payload is free text that legitimately looks like a flag, pass it after `--`:

```bash
v86 type -- --help              # types the literal "--help" into the guest
sprinkle chat -- --help         # renders the literal string as Tool-UI HTML
```

A `--help` that is the VALUE of a value-taking flag stays a value: `playwright-cli route <pattern> --tab=<id> --body --help` mocks a `--help` response body, and `v86 start -append --help` boots with that kernel cmdline.

Implementers: use `isHelpRequest()` / `subcommandHelpText()` from `packages/webapp/src/shell/supplemental-commands/subcommand-help.ts` at the top of the dispatcher, never an `args[0] === '--help'` check (that one only answers the bare command). If the command parses with the shared `arg-parser`, parse first and read `flags.help` — that applies the parser's value-shadowing rules for free; a hand-rolled parser passes its value-taking flags as `isHelpRequest(args, { valueFlags })`. For commands with a fixed flag vocabulary that must reject unknown dash tokens (issue #2255), use `parseKnownFlags()` from `subcommand-flags.ts` and pass the same names as `spec.value` / `valueFlags`. Note that `df`/`diskutil` keep `-h` as `--human-readable`, POSIX-style.

| Command                                                     | File                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Key Arguments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **commands**                                                | `help-command.ts`          | List all available commands (built-ins + .jsh)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | None                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **which**                                                   | `which-command.ts`         | Resolve a command path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `<command>` — returns `/usr/bin/<name>` or VFS path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **unlink**                                                  | `unlink-command.ts`        | Remove one non-directory entry. Symbolic links are removed without following their target.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `unlink FILE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **uname**                                                   | `uname-command.ts`         | uname(1) over SLICC identity: `-s` kernel name (`SLICC`), `-n` nodename (tray role), `-r` release (running SLICC version), `-v` build stamp, `-m` machine, `-o` operating system (browser user agent), `-a` all of them in uname order. Combined short flags work; bare `uname` is `-s`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `uname -r`, `uname -sr`, `uname -a`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **host**                                                    | `host-command.ts`          | Print the current leader tray status plus `launch_url` and `join_url`; `host reset` recycles the leader session; `host leave` exits the tray (or switches to leader on `--leader <url>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `host`, `host reset`, `host leave`, `host leave --leader <worker-url>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **ssh**                                                     | `ssh-command.ts`           | Run a command on a connected tray follower. `ssh <runtime-id> <command>` runs it on the follower (a `slicc … follow` CLI runs it on its real OS) and returns the buffered stdout/stderr/exit; `ssh --list` shows exec-capable followers (the `[ssh]`-tagged rows in `host`), each with the follower's advertised MOTD. iOS accepts only `open [--universal\|--x-callback] <url>`, rejects traversal or recursively encoded path delimiters, gates the validated scope through on-device approval, and launches the approved URL. `--universal` requires a universal link. `--x-callback` replaces supplied callback keys with nonce-correlated app URLs and writes one ordered `{status,parameters}` JSON line (≤16 parameters and ≤16 KiB) before distinct success/error/cancel exits; unavailable destinations and overflow fail explicitly. Browser followers are not targets. Ctrl+C interrupts the remote command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `<runtime-id> <command...>`, `--list`/`-l`, `--cwd <dir>`, `--timeout <seconds>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **slicc**                                                   | `slicc-command.ts`         | Talk to **another** SLICC leader as a client — the reverse of `ssh`, and not `host join`. `ssh` runs a command _down_ the tray on a follower of this instance; `slicc <join-url> exec <command>` runs one _up_ a tray in a REMOTE leader's virtual shell. Unlike `host join` (a role switch that stops this leader and hands the UI away), an attachment is additive: this instance keeps leading its own tray, and can hold up to 8 at once. Verbs mirror the `slicc` Go CLI's client verbs: `prompt` streams one assistant turn from the remote agent, `exec` runs a command in its shell, `watch` passively tails its live output (read-only; bounded by `--for` because a shell command returns one buffered result). `<target>` is a join URL — dialed once and kept warm so repeated commands reuse one connection — or the name of an existing attachment from `slicc list`. Text arguments are curl-style: literal, `@path` (a VFS file), or `-` / `@-` (piped stdin). The attachment advertises `exec: false` and refuses inbound `exec.request`: it is a client only, so the remote leader can ask it for nothing. Nothing is persisted — a reload starts with no attachments. Attaching to this instance's own tray is refused (it would deadlock the leader thread). Ctrl+C interrupts the remote turn or command. The CLI's `follow` verb has no equivalent here.                                                                                                                                                                                                             | `<target> prompt [--steer] <text...>`, `<target> exec [--cwd <dir>] <command...>`, `<target> watch [--for <s>] [--until-idle] [<scoop-jid>]`, `list`, `detach <name>\|--all`, `--name <name>`, `--once`, `--timeout <seconds>`                                                                                                                                                                                                                                                                                                                                                                       |
| **oauth-token**                                             | `oauth-token/run.ts`       | Get an OAuth access token for a provider. Returns the **masked** Bearer token (in both CLI and extension modes). The proxy/SW unmasks at the network boundary. `--scope <scopes>` overrides the provider's default scopes: the cached token is reused when the scopes it was granted already cover the request (GitHub's implied scopes are understood, so a token granted `repo` satisfies `public_repo`), and a login runs only when they do not, or when the granted scopes are unknown — the case for tokens stored before scopes were recorded. Recorded grants always come from provider responses: GitHub, xAI Grok, OpenAI Codex, and MCP report them directly; Adobe records the IMS fragment value when present; GitHub Copilot and OpenRouter remain unknown because their exchanges report no reliable granted scope. `--force-login` always runs the login flow, with or without `--scope`. `oauth-token --renew [<id>]` is a diagnostic — normal renewal happens automatically on token expiry; this forces a silent renewal now via the provider's `onSilentRenew` hook (bypasses the expiry gate), reporting success and the new expiry; when it is declined it names `--force-login` and confirms the decline upstream before demanding a human (see "Held vs working" below). `oauth-token --check [<id>]` asks the provider whether it still accepts the stored token. `oauth-token --expire [<id>]` is a local testing aid that back-dates only the stored expiry so the next network operation exercises normal silent renewal; it does not revoke anything upstream. | `<providerId>`, `--provider <id>`, `--list`, `--check [<id>]`, `--scope <scopes>`, `--force-login`, `--renew [<id>]`, `--expire [<id>]`, no args = selected provider; auto-triggers login if needed                                                                                                                                                                                                                                                                                                                                                                                                  |
| **oauth-domain**                                            | `oauth-domain-command.ts`  | Manage per-provider extra allowed domains for OAuth-issued tokens. Provider hardcoded `oauthTokenDomains` stay immutable; entries here layer on top. Stored in `localStorage` (`slicc_oauth_extra_domains`); also editable from the extension options page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `list [<providerId>]`, `add <providerId> <domain>`, `remove <providerId> <domain>`, `clear <providerId>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **local-llm**                                               | `local-llm-command.ts`     | Inspect / configure the Local LLM provider (Ollama, LM Studio, llama.cpp, vLLM, mlx, Jan, LocalAI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `local-llm` or `local-llm status` — verify connection; `local-llm discover` — probe `/v1/models` and save the list to Settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **serve**                                                   | `serve-command.ts`         | Mint a worker-hosted preview URL for a VFS app directory and open it in the leader browser. `--ttl` uploads an immutable snapshot that remains available without the leader for up to 30 days. `--bridge` makes live visitors driveable; the first visit announces once while later lifecycle activity stays in a bounded, leader-memory-only recorder. `serve --logs` reads that recorder without emitting a lick or waking the cone; `serve --truncate` clears records and re-arms the announcement.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `[--entry <path>] [--ttl <duration>] [--bridge \| --no-bridge] [--stop <token>] [--list] <directory>`; `--logs [<token>] [--lines <N>]`; `--truncate [<token>]`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **biscotto** / **biscotti**                                 | `biscotto/run.ts`          | Hand someone a revocable guest seat (_biscotto_) on this cone: a private `*.sliccy.now` URL showing the live transcript and a composer. What the guest sends is reviewed before it reaches the cone, and — when the seat says so — every tool call in the turn their message causes is reviewed too. The URL is printed ONCE at mint; `biscotti` lists seats and never returns tokens, so a screenshot of the list is not a set of working guest URLs. `--gate-tools cone` is refused at configuration time (the cone is the unit executing the tool it would be asked to approve).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `biscotto serve --label <name> [--expires <duration>] [--gate-messages <approver>] [--gate-tools <approver>]`; `biscotto revoke <id>`; `biscotti`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **open**                                                    | `open-command.ts`          | Open URL or VFS file in browser tab. For VFS paths, walks up from the file's directory looking for a project-root marker (`head.html`, `fstab.yaml`, `package.json`, `.git`; falls back to the file's own directory when none is found) and passes it as `?projectRoot=` on the preview URL, so root-absolute paths (`/styles/...`) resolve against that root the same way they do under `serve` — standalone only; extension mode does not route through the preview SW and does not get this. When a `BrowserAPI` is available, stdout includes `(targetId: <id>)`. Unknown flags exit non-zero (issue #2255); flags may appear in any position and `--` ends option parsing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `<url\|path>` — serves VFS files via preview SW; `--download` / `-d` forces download; `--view` / `-v` returns image inline for agent vision                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **imgcat**                                                  | `imgcat-command.ts`        | Display image/video inline in the terminal preview. Unknown flags are rejected (`imgcat: unknown flag: --x`, exit 1) so a probe that exits 0 means the flag was honoured. Dash-leading paths need `--` (`imgcat -- --odd.png`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `<path> [path...]`; `-h` / `--help`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **zip**                                                     | `zip-command.ts`           | Create ZIP archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `<archive.zip> <file1> [file2...]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **unzip**                                                   | `unzip-command.ts`         | Extract ZIP archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `<archive.zip> [-d output-dir]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **tar**                                                     | `tar-command.ts`           | Create, extract, or list tar archives in the VFS, with optional gzip compression and automatic gzip detection when reading. `-C` changes the input base directory in create mode and the output directory in extract mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `(-c\|-x\|-t) [-zv] -f <archive> [-C <dir>] [paths...]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **xxd**                                                     | `xxd-command.ts`           | Hex dump for binary data (and its reverse). Canonical `offset: hex  ascii` dump by default; plain-hex (`-p`) and C-include (`-i`) output styles; `-r` converts a hex dump back to binary (`-r -p` for a plain dump). Reads a file or stdin and writes stdout or an output file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `xxd [infile [outfile]]`, `-c <cols>`, `-g <bytes>`, `-l <len>`, `-s <seek>` (negative counts from end), `-u` (uppercase), `-p` (plain), `-i` (C include), `-r` (reverse)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **cmp**                                                     | `cmp-command.ts`           | Compare two files byte-for-byte, reporting the first differing byte and line. Exit status is `0` for identical files, `1` for differences, and `2` for errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `cmp FILE1 FILE2`, `-s` / `--quiet` / `--silent`; `-` reads standard input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **sqlite3**                                                 | `sqlite-command.ts`        | Execute SQLite queries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `-c "SELECT * FROM table" db.sqlite`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **node**                                                    | `node-command.ts`          | Execute JavaScript code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `-e "console.log(1+1)"` with fs bridge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **python3 / python**                                        | `python-command.ts`        | Execute Python code via Pyodide. Synchronous access to a mounted path (local FS Access, S3 / R2, da.live) raises `OSError` (EIO) with a guiding message — use the async `slicc.fs` module (`await slicc.fs.read_text(...)`, `listdir`, `read_bytes`, `write_text`, `write_bytes`, `stat`, `exists`, `mkdir`, `remove`, `walk`) for on-demand mount I/O, or copy the file into the VFS first. The cwd and `/tmp` remain directly accessible. See [docs/pitfalls.md — Mounts Are Async-Only Via `slicc.fs`](./pitfalls.md#python-realm-mounts-are-async-only-via-sliccfs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `-c "print([i**2 for i in range(5)])"`, `script.py [args...]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **webhook**                                                 | `webhook-command.ts`       | Manage webhooks for event-driven licks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `webhook create <endpoint>`, `webhook list`, `webhook delete <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **websocat**                                                | `websocat-command.ts`      | Minimal WebSocket client (netcat/curl for ws://). Sends stdin lines as messages, prints received messages. Client-only — server mode and advanced specifiers (`exec:`, `tcp:`, `broadcast:`, `ws-l:`) are not supported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `websocat ws://URL`, `-1` one-shot, `-b` binary, `--jsonrpc`/`--jsonrpc-omit-jsonrpc`, `--base64`, `--protocol`, `--max-messages`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **crontask**                                                | `crontask-command.ts`      | Schedule cron jobs that dispatch licks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `crontask add <name> "0 9 * * *" scoop-name "instructions..."`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **pdftk / pdf**                                             | `pdftk-command.ts`         | Page-level PDF work: `dump_data` metadata, `dump_data_utf8` text, `cat` extract/merge, `rotate`, `burst`, plus the `uncompress` / `compress` output options (`output -` writes the PDF to stdout)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `pdftk in.pdf burst`, `pdftk in.pdf cat 1-3 output out.pdf`, `pdftk in.pdf output plain.pdf uncompress`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **pdftoppm / pdftocairo**                                   | `pdftoppm-command.ts`      | Rasterize PDF pages to PNG/JPEG via pdf.js (poppler-style flags). Renders via `OffscreenCanvas` in the kernel worker, so it works in every cone-hosting float                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `pdftoppm -png -r 150 doc.pdf page`, `pdftoppm -jpeg -singlefile -f 2 doc.pdf cover`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **pdftotext**                                               | `pdftotext-command.ts`     | Extract a PDF's text layer via pdf.js (poppler-style flags). `-layout` rebuilds column alignment; writes `<input>.txt` unless the output file is `-`. Scanned PDFs carry no text layer — rasterize with `pdftoppm` instead                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `pdftotext report.pdf -`, `pdftotext -layout -f 2 -l 5 invoice.pdf out.txt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **convert / magick**                                        | `convert-command.ts`       | Image conversion, transforms, filmstrip/grid composition, and timestamp labels (ImageMagick style). PDF inputs are rasterized first (`-density`, `doc.pdf[2]`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `convert input.jpg -resize 800x600 output.jpg`; multiple inputs with `+append` / `-append`; nested `\( ... \)` groups; labels with `-gravity`, `-fill`, `-undercolor`, `-pointsize`, and `-annotate +X+Y TEXT`                                                                                                                                                                                                                                                                                                                                                                                       |
| **playwright-cli / playwright / puppeteer**                 | `playwright-command.ts`    | Browser automation shell CLI. `frames --tab=<targetId>` lists frame IDs, which are distinct from tab target IDs; `eval`, `eval-file`, and `snapshot` accept `--tab=<targetId> --frame=<frameId>` for frame-scoped evaluation or a frame-only accessibility subtree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `snapshot [--frame=<frameId>]`, `eval [--frame=<frameId>]`, `eval-file [--frame=<frameId>]`, `frames`, `click <ref>`, `cookie-set`, `tab-list`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **curlwright**                                              | `curlwright-command.ts`    | curl's argument surface, executed by a `fetch()` inside a browser tab, so the request carries that tab's cookies, origin and session. `-o` writes a byte-exact file, which is the one thing `playwright-cli eval-file` could never do. Options a page cannot honor (`--cert`, `-k`, `-x`, `--resolve`, `--compressed`, `-b`, `-A`) are rejected by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `curlwright [curl flags] <url>`, `--tab <targetId>`, `--frame <frameId>`, `--no-credentials`; see [curlwright](#curlwright)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **screencapture**                                           | `screencapture-command.ts` | Capture user's screen via browser screen sharing API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `<output.png>`, `-c` (clipboard), `-v` / `--view` (agent vision)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **upskill**                                                 | `upskill-command.ts`       | Install or update skills from GitHub, the Tessl registry, or browse.sh; suggest skills for open browser tabs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `upskill owner/repo`, `upskill tessl:<name>`, `upskill browse:<host>/<task>`, `upskill search "query"`, `upskill tabs [--json]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **layout**                                                  | `layout-command.ts`        | The agent-facing surface for arranging the `<slicc-dock-tree>` layout — the sole layout system; every panel (chat, the four fixed tool panels, every sprinkle) is an independent, always-mounted, draggable/resizable/closable leaf. Runs in the kernel worker (no DOM) and reaches the page over the `layout-apply` panel-RPC op. `layout set <name>` loads a named preset's tree wholesale. There is exactly ONE shipped preset — `focus` (chat alone, left), which is also the boot default; canned arrangements beyond it are the user's to save (`layout save`), not the app's to guess. `layout chat <zone>` moves the pinned `chat` leaf to a zone; `layout move <surfaceId> <zone>` generalizes that to any surface (tool panel, sprinkle, or chat), detaching it from wherever it sits and making it that zone's sole leaf. `layout open <surfaceId> <zone>` places a surface into a zone alongside whatever's already there (a no-op if already placed anywhere) — the agent-driven equivalent of clicking a tool's dock icon or dragging a sprinkle in; `layout close <surfaceId>` is its inverse. A bare sprinkle name (not `chat`/a tool-panel id) is auto-prefixed to its `sprinkle:<name>` surfaceId. `layout size <surfaceId> [--width <px                                                                                                                                                                                                                                                                                                                                 | percent>] [--height <px                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | percent>]`resizes a placed leaf to an exact pixel or percent (0–100) of its current sibling group, on whichever axis(es) that leaf actually has a lever for — the same floor (2% of the group) manual divider-dragging clamps to.`layout edit`is a backwards-compatible alias for`layout set focus`(there is no editor mode to enter — moving and resizing are always available). A leaf's`.dock-tree__tile-move`hover button (top-left corner) drags it onto another tile's edge to split side-by-side, or its center to stack; every skeleton divider and in-zone split divider is pointer-drag-resizable. The tree — including chat's placement — persists per profile in`localStorage['slicc-dock-tree:default']`and is restored on boot. See`docs/layouts.md` for the full model, including locking (`DockTreeSpec.locked`) for Cherry-pushed fixed layouts. | `layout set focus` (the one shipped preset), `layout edit` (alias for it), `layout chat <zone>`, `layout open <surfaceId> <zone>`, `layout close <surfaceId>`, `layout move <surfaceId> <zone>`, `layout size <surfaceId> [--width <px\|percent>] [--height <px\|percent>]`, `layout list`, `layout reset` (`<zone>` is `top\|left\|middle\|right\|bottom`). **Panel-system verbs** (when the `panel-layouts` flag is on): `layout load <name>`, `layout save <name> [--protected]`, `layout delete <name>`, `layout docs`, `layout panels`, `layout show <panelId>`, `layout hide <panelId>` — documents save to `/workspace/layouts/` (free) or `/etc/slicc/layouts/` (approval-gated); `show`/`hide` edit the document so the change survives a re-render and is saveable. See `docs/layouts.md` |
| **upgrade**                                                 | `upgrade-command.ts`       | Discover bundled VFS files at two release refs and safely update skills, sprinkles, and sounds with preflighted three-way merges. Emits JSON per-path classifications; conflicts go to collision-safe sidecars and exit nonzero without changing live files. `upgrade status` is read-only and reports the running version, the version this profile last booted, whether a workspace merge is pending, and the exact `apply` invocation to run when it is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `upgrade status`, `upgrade apply --from=<version> --to=<version>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **sprinkle**                                                | `sprinkle-command.ts`      | Manage `.shtml` sprinkle panels and inline chat UI. `list` reports only `.shtml` files under the bounded discovery roots — `/shared/sprinkles` first, then `/workspace`, `/shared`, `/scoops`, `/home`, six levels deep, skipping build output and dot-directories (issue #2717; `base/sprinkle-roots.ts`). `open <path>` still opens any path. A sprinkle has one store but can have many rendered documents — the leader's panel plus one per connected follower that mirrored it — so `list` reports an `instance:` line per rendering runtime (followers report what they actually rendered; a failed render is absent, and the iOS follower does not report at all yet). `send` **broadcasts** to every instance unless `--runtime <id>` names one (`leader`, or a follower runtime id from `host`); it prints the instances it reached and exits non-zero when it reached none. Unknown flags are rejected on every subcommand — a probe that exits 0 means the flag was honoured. `route` is resolved by the LEADER for every runtime, including licks forwarded from a follower.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `sprinkle list [--runtime <id>]`, `sprinkle open <name>`, `sprinkle send <name> '<json>' [--runtime <id>]`, `sprinkle chat '<html>'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **session**                                                 | `session-command.ts`       | Export a transcript bundle (active or frozen session) to the VFS as a signed, redacted ZIP. Redacts known secrets and credential-pattern strings before packaging; strips reasoning blocks; copies binary attachments unchanged. See [docs/transcript-export.md](transcript-export.md) for the full bundle layout and privacy guarantees.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `session export [--id <frozen-session-id>] [--output <path>]` — default output `/workspace/slicc-transcript-<id>.zip`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **cost**                                                    | `cost-command.ts`          | Show session cost breakdown by origin. Defaults to the cone and live scoops; `--all` also includes dropped scoops and frozen sessions from `/sessions/index.json`. Legacy frozen sessions without persisted cost remain visible with a dash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `--all`, `--json`, `-h`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **models**                                                  | `models-command.ts`        | List available LLM models with pricing and benchmarks. The `►` marker and the `Currently using:` footer report the model the agent **actually resolves** (`resolveCurrentModel()`), not the raw selected id — so a fallback shows the real model and flags a divergence from the selection. The active model is never hidden by version-family dedup. Unknown flags are rejected (non-zero exit) — a probe that exits 0 means the flag was honoured. It lists the full catalogue: `/etc/models` is enforced when a scoop is spawned, not here, so a listed model from another account may still need an allow entry (see [approvals](approvals.md#model-access-policy----etcmodels)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `--all`, `--all-versions`, `--json`, `--provider <id>`, `--refresh`, `--no-benchmarks`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **secret**                                                  | `secret-command.ts`        | Manage secrets (API keys, tokens) with domain-scoped injection, folded into the sudo model. Unknown flags are rejected on every subcommand — a probe that exits 0 means the flag was honoured. `set <name> <value> --domain <patterns>` creates an in-memory **session-only** secret (no approval, never persisted); every set requires a non-empty domain allowlist. `get`/`read`/`peek`/`list`/`test` need no approval. Persisting (`--persist`), editing scope (`scope`), and changing an existing secret's value each raise a native sudo prompt (deny blocks; "Always" skips future prompts for that op this session). `peek` shows only the first/last chars of the unmasked value. `set` also reads the value from stdin (`echo "$TOKEN" \| secret set NAME --domain ...`) so the literal never lands in the agent's tool-call argv; on a successful set the masked replacement is injected into the owning shell's live env (POSIX-name secrets only — parity with `fetchSecretEnvVars`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `set <name> [<value>] --domain <patterns> [--persist]` (value via arg OR stdin), `get`/`read <name>`, `peek <name>`, `scope <name> --domain <patterns>`, `list`, `delete <name>`, `test <name> <url>`, `edit`                                                                                                                                                                                                                                                                                                                                                                                        |
| **sudo**                                                    | `sudo-command.ts`          | Request human approval to run a single command verbatim. The cone (or any agent shell) can call `sudo <cmd> [args...]` to explicitly route a sensitive action through the sudo broker (which may hand the prompt to a connected iPhone's Face ID sheet when the human is driving from it or the leader is headless — #2062); "Allow" runs the inner command once, "Always" persists a `NOPASSWD Cmnd` grant in `/etc/sudoers.d/granted` (no future prompt), "Deny" exits `1` with `sudo: approval denied`. The inner argv is forwarded verbatim (no re-parsing) and the one-shot bypass keyed by canonical subject prevents a double prompt when the inner command is itself policy-gated. Exits `1` with `sudo: command-level approval is not configured` in floats without a broker (e.g. panel terminal). See [docs/approvals.md — Sudo policy](./approvals.md#sudo--etcsudoers-policy).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `sudo <cmd> [args...]`, `-h`/`--help`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **mount**                                                   | (MountCommands class)      | Mount local directories or remote storage (S3 / S3-compatible / DA) into the VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `mount [--source <url>] [--profile <name>] <path>`, `mount unmount [--clear-cache] <path>`, `umount [--clear-cache] <path>`, `mount list`, `mount refresh [--bodies] <path>`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **umount**                                                  | (MountCommands class)      | Alias for `mount unmount <path>` — same parser, flags, and exit codes; diagnostics are prefixed `umount:`. Exists because muscle memory reaches for the Unix spelling (issue #2738).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `umount [--clear-cache] <path>`, `-h`/`--help`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **mcp**                                                     | `mcp-command.ts`           | Manage Model Context Protocol servers. Persists to `/workspace/.mcp/servers.json`, registers each as an `mcp:<name>` OAuth provider when auth is required, auto-writes a `.jsh` alias shim at `/workspace/.mcp/aliases/<name>.jsh`, and materializes MCP Apps as sprinkles under `/workspace/.mcp/sprinkles/<name>/`. Registration is lazy (re-registers from `servers.json` on the first subcommand call). OAuth discovery prefers RFC 9728 Protected Resource Metadata at `<server>/.well-known/oauth-protected-resource`, but transparently falls back to RFC 8414 Authorization Server Metadata at the server's own origin (`<server>/.well-known/oauth-authorization-server`) when PRM is absent — matching `mcp-remote` / Cloudflare-worker MCP servers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `mcp add <url> [name]`, `mcp list`, `mcp delete <name>`, `mcp invoke <name> [tool] [--flag value]`, `mcp refresh <name>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **plugin**                                                  | `plugin-command.ts`        | Load [Agent Plugins](https://agent-plugins.org) packages (spec v1.0.0): portable directories bundling Agent Skills (`skills/*/SKILL.md`) and MCP servers (`mcp.json`) behind a `plugin.json` manifest. `install` validates the closed manifest schema + name constraints, records the plugin in `/workspace/.plugins/plugins.json` (skills then surface through standard skills discovery), and bridges `streamable-http` MCP servers into the MCP store as `<plugin>:<server>`. `stdio` entries are skipped (no subprocesses in the browser) and legacy `sse` entries are skipped, per the spec's single-transport allowance; component failures are isolated so one bad component never blocks the rest. `validate` is a dry-run conformance check. `install`/`validate` also accept a GitHub reference (`owner/repo`, `owner/repo@branch`, or `https://github.com/owner/repo[/tree/branch[/dir]]`): the repo ZIP is downloaded via codeload and extracted into `/workspace/.plugins/sources/`; `remove` deletes that managed dir (local installs keep their files).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `plugin install <path\|repo>`, `plugin list`, `plugin info <name>`, `plugin validate <path\|repo>`, `plugin remove <name>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **usb**                                                     | `usb-command.ts`           | WebUSB access from the shell. Opaque device handles (`usb1`, `usb2`, …) back a page-side registry; control + bulk/interrupt transfers round-trip via panel-RPC. `usb request` needs a real user gesture. Chromium-only; unavailable in the cloud / hosted-leader float.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `usb list`, `usb request [--vid 0x.. --pid 0x.. --class N --serial S]`, `usb open\|close\|reset <handle>`, `usb claim\|release <handle> <iface>`, `usb control-in\|control-out`, `usb transfer-in\|transfer-out`, `--raw`                                                                                                                                                                                                                                                                                                                                                                            |
| **serial**                                                  | `serial-command.ts`        | Web Serial access from the shell. Same handle-registry + panel-RPC bridge as `usb`. `serial request` needs a real user gesture. Chromium-only; unavailable in the cloud / hosted-leader float.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `serial list`, `serial request [--vid 0x.. --pid 0x..]`, `serial open <handle> [--baud N …]`, `serial close <handle>`, `serial read <handle> [--bytes N --until <hex> --timeout-ms N --hex]`, `serial write <handle>`, `serial signals <handle> get\|set`                                                                                                                                                                                                                                                                                                                                            |
| **hid**                                                     | `hid-command.ts`           | WebHID access from the shell. Same handle-registry + panel-RPC bridge as `usb`. `hid request` needs a real user gesture and registers every granted interface as a separate handle (multi-interface devices like VIA/QMK keyboards stay reachable); I/O subcommands (`watch`/`send`/`query`/`feature-*`) auto-open closed devices. `hid query` is the VIA-style request/response verb: subscribe, send, await the first input report, unsubscribe. Chromium-only; unavailable in the cloud / hosted-leader float.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `hid list`, `hid request [--vid 0x.. --pid 0x.. --usage-page N --usage N]`, `hid open\|close <handle>`, `hid send <handle> <report-id>`, `hid query <handle> <report-id> [--timeout <ms>]`, `hid feature-send <handle> <report-id>`, `hid feature-get <handle> <report-id> <length>`, `hid watch <handle>`, `--raw`                                                                                                                                                                                                                                                                                  |
| **esptool**                                                 | `esptool-command.ts`       | Flash ESP32 / ESP8266 chips via esptool-js, layered on the `serial` handle namespace. Without `--port` the Web Serial picker opens (needs a user gesture). esptool-js loads lazily via dynamic `import()` (CSP-safe). Chromium-only; unavailable in the cloud / hosted-leader float.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `esptool chip_id`, `esptool read_mac`, `esptool flash_id`, `esptool read_reg <addr>`, `esptool read_flash <addr> <size> <outfile>`, `esptool erase_flash`, `esptool erase_region <addr> <size>`, `esptool write_flash <addr> <file>...`, `esptool run`, `--port <handle>`, `--baud N`, `--vid 0x..`, `--pid 0x..`, `--erase`                                                                                                                                                                                                                                                                         |
| **git**                                                     | (isomorphic-git)           | Browser-native Git subset, not the full system Git CLI. Supports local-path/`file://` clones, relative revisions, commit ranges, pathspecs, remote-ref inspection, and merge-base queries. Symbolic-ref mutation does not persist reflogs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Includes `merge-base`, `ls-remote`, `symbolic-ref`, and the existing porcelain commands. `diff`/`log`/`status` honor `-- <pathspec>`; `rev-parse` supports `~`, `^`, `@{n}`, `--short`, and `--abbrev-ref`. `symbolic-ref -m` remains unsupported because reflogs are not persisted.                                                                                                                                                                                                                                                                                                                 |
| **agent**                                                   | `agent-command.ts`         | Spawn an ephemeral one-shot sub-scoop via `globalThis.__slicc_agent`. Shell surface for scoop delegation from any float. Inherits the parent's model when invoked from inside a scoop shell. Three positional args (no `--cwd`): `cwd`, `allowed-commands` glob, and the prompt. `--workspace-mode private\|shared-readonly` names the isolation policy (default `shared-readonly` is today's sandbox; `snapshot`/`shared-live` exit 1). `--read-only` is pure-replace for `visiblePaths` — pass `--read-only "/docs/,$(pwd)"` to keep the cwd visible alongside read-only roots. `--background-after <s>` sets the spawned scoop's `bash` detach budget (default 600s; `0` detaches every command immediately), so an unsupervised run reports a slow command back as a `bash` lick instead of stalling on it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `agent <cwd> <allowed-commands> "<prompt>"`, `--model <id>` (bare id, shorthand, or `provider:model`; cross-provider ids need an `/etc/models` allow entry), `--thinking <off\|low\|medium\|high>` (alias `--effort`), `--workspace-mode <private\|shared-readonly>`, `--read-only <comma-separated-paths>`, `--background-after <seconds>`                                                                                                                                                                                                                                                          |
| **discover**                                                | `discover-command.ts`      | Fetch a URL and surface RFC 8288 / RFC 9727 link-discovery results as JSON. Routes through the proxied fetch (CORS bypass + forbidden-header bridging). Output: `{ url, status, links[], handoff, discovery? }`. With `--follow`, also fetches P0 capability docs (api-catalog, service-desc, service-meta, status, llms.txt) and includes them under `discovery`. See [link-discovery.md](link-discovery.md). For listing installed skills, use `upskill --list` or read `/workspace/skills/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `discover <url>`, `discover --follow <url>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **tsc**                                                     | `tsc-command.ts`           | Single-file TypeScript compiler over the bundled `typescript` package. Walks up from `ctx.cwd` to merge nearest `tsconfig.json`'s `compilerOptions` over `ES2022`/`ESNext` defaults. No cross-file program-level type checking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `tsc [files...]`, `--noEmit`, `--outDir`, stdin → stdout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **test**                                                    | `test-command.ts`          | Test runner over the [tst](https://github.com/dy/tst) library. Discovers `*.test.{js,ts}` in `ctx.cwd`, TS-transpiles each, runs each file in its own realm. Reporters: `tap` (default), `--reporter=spec` → tst `pretty`. Fork mode disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `test [glob]`, `--reporter=<tap\|spec>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **biome**                                                   | `biome-command.ts`         | Biome `check`, `lint`, and `format` over ipk-installed `@biomejs/wasm-web` and `@biomejs/js-api`; diagnostics use plain text by default or structured JSON for scripts. Walks directories filtered to known extensions, including `.jsh`/`.bsh`; those AsyncFunction bodies are wrapped before parsing and safely unwrapped after formatting. Discovers and applies the nearest `biome.json`/`biome.jsonc`; see [Biome wrapper behavior](#biome-wrapper-behavior).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `biome check <path>`, `biome lint <path>`, `biome format <path>`, `--write`, `--check` (format only), `--config-path <file>`, `--stdin-file-path <path>`, `--reporter <plain\|json>`, `--json`                                                                                                                                                                                                                                                                                                                                                                                                       |
| **esbuild**                                                 | `esbuild-command.ts`       | esbuild bundler / transpiler. The wasm package is loaded from the ipk-installed dependency tree. A VFS plugin routes local paths through `ctx.fs` and bare specifiers through the nearest ipk-installed `node_modules`, with no network fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `esbuild <entry>`, `--bundle`, `--transform`, `--format`, `--platform=`, `--external:`, `--define:`, `--tree-shaking`, `--banner:`, `--footer:`, `--minify`, `--sourcemap`, `--target`, `--loader`, `--outfile`                                                                                                                                                                                                                                                                                                                                                                                      |
| **ffmpeg**                                                  | `ffmpeg-command.ts`        | Audio/video transcoding with two engines behind one argv: mediabunny (WebCodecs; `ffmpeg/bunny-translate.ts` decides, `bunny-run.ts` runs) for one-input/one-output jobs whose every option maps — remux, h264/hevc/vp8/vp9/av1 + aac/opus/mp3/vorbis/flac/pcm transcodes, trims, `scale`/`crop`/`transpose`/`fps`, `-ac`/`-ar`, bitrate/crf, faststart, tags — and ffmpeg.wasm for everything else (lavfi, concat, filtergraphs, `-f null` sinks, images). stderr names the engine; `FFMPEG_ENGINE=wasm\|mediabunny` forces one. Wasm engine: `@ffmpeg/core` by default; `FFMPEG_CORE=mt` on a cross-origin-isolated runtime opts into the multi-threaded `@ffmpeg/core-mt` (`ipk add -g @ffmpeg/core-mt@<pinned>`) for SINGLE-input jobs — multi-input jobs deadlock its pthread pool and are refused, and `-threads`/`-filter_threads` are capped unless given; `ffmpeg -version` prints which core booted. Inputs are never copied into the wasm heap: each run mounts them read-only via WORKERFS from lazily-read `Blob`s (the VFS hands out the native OPFS / FSA `File` when it has one, see `VirtualFS.getNativeFile`), so input size is bounded by disk, not by the 2 GiB heap; only the output is buffered in MEMFS.                                                                                                                                                                                                                                                                                                                                                            | `ffmpeg -i input.mp4 -vcodec libx264 output.mp4` Argv is re-parsed and rebuilt against the in-memory FS, so an option that takes a value must be recognized as such: unknown `-flags` consume the next token unless it is another option or the trailing output path (`VALUE_TAKING_FLAGS` / `BOOLEAN_FLAGS` in `ffmpeg-command.ts`). Analysis sinks (`-f null` with `-` or `/dev/null`, or bare `/dev/null` with `-f null` injected) skip VFS writeback and return filter measurements on stderr (`silencedetect`, `loudnorm`, …). Lone `-` without `-f null` is rejected (stdout is not emulated). |
| **ffprobe**                                                 | `ffprobe-command.ts`       | Media probe. Reads the container index through mediabunny first (`ffmpeg/bunny-probe.ts`: typed fields, no wasm boot, no install); containers it does not read fall back to the emulation on the same `@ffmpeg/core` instance as `ffmpeg` (no separate ffprobe wasm/ipk for this pin), which mounts the input via WORKERFS (lazily read, so a multi-GB file probes without entering the wasm heap), runs `ffmpeg -i <file>` with no output, parses the Input #N banner for duration / format / per-stream codec·type·rate·channels·resolution·fps, and formats `-of json` / `csv` / `default=nw=1:nk=1`. Unsupported options are rejected by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **v86**                                                     | `v86-command.ts`           | Run an x86 virtual machine on the v86 wasm engine. Install-gated: `ipk add -g v86@<pinned>` provides both the JS glue and the wasm binary (nothing bundled, no CDN fallback). `v86 start` boots the guest as a named background unit in the kernel worker (ProcessManager-tracked, so `ps` / `kill` work); later invocations drive it: `type`/`key` (keyboard), `mouse` (PS/2 relative), `screenshot` (VGA → PNG in the VFS), `text` (text-mode dump), `serial` (send/read serial console), `state save/load`, `stop`. BIOS blobs are not in the npm tarball — download seabios/vgabios once into `/workspace/.v86/` (the command prints the exact curl lines). `-state` resumes a saved snapshot (`.zst` ok, skips BIOS), `-fs9p <url>` attaches a network-backed 9p root, `-net <ne2k\|virtio>[,relay=fetch]` picks the NIC — together these boot the copy.sh Arch Linux demo image straight into a shell; `relay=fetch` gives the guest outbound HTTP via v86's fetch relay, rerouted through the SLICC fetch proxy (guest DNS answered in-engine, plain-http to external hosts upgraded to https). `-vga <MiB>` sizes the Bochs-dispi SVGA/VBE framebuffer (default 8) for high-res VESA modes. `v86 serve` streams the screen into `$TMPDIR/v86-serve-<name>/` (viewer index.html + live frames at 1–10 fps) so `serve <that dir>` can mint an iframe-able preview URL.                                                                                                                                                                                                               | `v86 start -cdrom alpine.iso`, `v86 start -state arch_state.bin.zst -fs9p https://i.copy.sh/arch/ -net virtio`, `v86 text`, `v86 screenshot`, `v86 serve --fps 4`, `v86 type "root                                                                                                                                                                                                                                                                                                                                                                                                                   |
| "`, `v86 key ctrl-alt-del`, `v86 serial --tail`, `v86 stop` |
| **fswatch**                                                 | `fswatch-command.ts`       | Watch a VFS path for changes via `globalThis.__slicc_fs_watcher` and route each change through `globalThis.__slicc_lick_handler` to a target scoop. Maintains an in-process `activeWatches` map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `fswatch create --path <path> --pattern <glob> [--scoop <name>] [--name <name>]`, `fswatch list`, `fswatch delete <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **ps**                                                      | `ps-command.ts`            | List active processes from `ProcessManager` — scoop turns, tool calls, shell execs, jsh/python scripts. Equivalent to inspecting `/proc/` directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `ps`, `--all`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **kill**                                                    | `kill-command.ts`          | Send a signal to a `ProcessManager`-tracked process. `SIGKILL` is uncatchable (worker.terminate() / iframe.remove(), exit 137).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `kill <pid>`, `kill -<SIGNAL> <pid>` (`SIGINT`/`SIGTERM`/`SIGKILL`/`SIGSTOP`/`SIGCONT`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **meminfo**                                                 | `meminfo-command.ts`       | Agent-cluster memory diagnostics via `performance.measureUserAgentSpecificMemory()` — total + per-attribution breakdown (bytes, types, scope/url), sorted descending. Requires a cross-origin-isolated runtime (the hosted leader is, via `Document-Isolation-Policy`); non-isolated floats get an explanatory error. Measurement timing is browser-randomized — expect a short delay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `meminfo`, `meminfo --json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **rsync**                                                   | `rsync-command.ts`         | Diff-aware copy between VFS paths (or mounted backends). Used for syncing workspace state into a mount, or vice versa.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `rsync <src> <dst>`, `--dry-run`, `--delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **man**                                                     | `man-command.ts`           | Print the embedded man-page for a given command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `man <command>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **dig**                                                     | `dig-command.ts`           | DNS lookup via DoH (DNS-over-HTTPS), routed through the proxied fetch. Name and supported record-type positionals are order-insensitive. `@server` selects Cloudflare, Google, or Quad9; unsupported servers fall back to the default Cloudflare resolver with a note on stderr. Other `+opts` are tolerated as no-ops.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `dig <name> [type] [@server] [+short] [--json]`, `dig -x <address> [@server] [+opts] [--json]`, `dig -v` / `dig --version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **nuke**                                                    | `nuke-command.ts`          | Wipe SLICC state. Clears IndexedDB (VFS, sessions, scoops, mounts, all five DBs) and reloads. Destructive. Unknown flags are rejected (exit non-zero) rather than joined into the launch-code check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `nuke`, `--yes` (skip confirmation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **say**                                                     | `say-command.ts`           | macOS `say`-equivalent — speak the text via the Web Speech API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `say "Hello"`, `-v <voice>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **hear**                                                    | `hear-command.ts`          | Push-to-talk voice transcription. **Page realm only** (mic, AudioContext) — the kernel worker bridges over the `hear-*` panel-RPC ops. Two engines: Web Speech API (immediate), hot-swapped to on-device Whisper (`onnx-community/whisper-tiny`) once ready. Import the speech interface from `@slicc/webcomponents/composer/speech` (deep subpath) — never the barrel, which registers custom elements at import time and breaks DOM-less realms (see `docs/pitfalls.md` § "Speech: Never Import the Barrel in DOM-less Realms").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `hear` (one-shot capture)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **afplay / chime**                                          | `afplay-command.ts`        | Play a sound file. `chime` is a convenience alias for the bundled notification sounds in `/shared/sounds/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `afplay <path>`, `chime [done\|alert\|...]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **pbcopy / pbpaste / xclip / xsel**                         | `clipboard-commands.ts`    | Copy stdin to the clipboard / paste clipboard to stdout via the browser Clipboard API. All four aliases share the same implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `echo hi \| pbcopy`, `pbpaste`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
|                                                             |                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | parent of e4bf5527c (feat(work-unit): explicit workspace isolation modes for children (#2277)) |

### `oauth-token`: held vs working

A stored OAuth token that has not reached its recorded expiry can already have
been invalidated upstream — a revoked grant or an ended SSO session leaves the
local record untouched. `--list` and `--renew` read that local record only, so
they report which token is **held** (`token held for <user>, local expiry in
23h`) and never call it `valid` or `logged in`.

`oauth-token --check [<id>]` is the surface that answers whether the token still
**works**: it calls the provider's optional `onValidateToken` hook — one cheap,
time-bounded authenticated call, `GET /user` for GitHub — and reports
`ACCEPTED`, `REJECTED`, or `UNKNOWN`. Only a response that proves refusal (401)
is `REJECTED`; statuses a healthy token also produces (GitHub answers 403 when
throttling), 5xx, and transport failures are `UNKNOWN`, which says nothing about
the token. Providers without the hook say so rather than guessing.

Failure output always names `oauth-token <id> --force-login`, but only claims a
human is unavoidable when that is established. `onSilentRenew` returning `null`
does not prove it — provider hooks collapse transport failures into `null` too —
so a declined `--renew` runs the upstream check before deciding. Exit codes:

- **3** — automated recovery is exhausted: nothing is stored, or the provider
  confirms it no longer accepts what is stored. Stop and ask a human to run
  `--force-login`.
- **1** — the outcome is not settled: the command could not run, the result is
  unknown, or an automated rung remains. A refused token on a provider that can
  still renew points at `--renew` first, because a stored refresh token may
  replace the access token without any human. A renewal that _threw_ asks for a
  retry rather than a consent window. A decline the provider will not
  corroborate names the likely fix without claiming retries are pointless — and
  when the check reports the stored token is still `ACCEPTED`, the output says
  so: nothing is broken for callers, only the renewal did not happen.
- **0** — success.

### Git clone depth and branch refs

SLICC's browser-native `git clone` deliberately defaults to depth 1 and a single branch: without
flags, it fetches only the tip of the remote's default branch. This differs from the native Git
CLI's full-history, all-branch default and keeps browser-backed clones fast and compact.

```bash
# Clone a non-default branch (still depth 1 and single-branch)
git clone --branch feature https://github.com/example/project.git project

# Keep depth 1, but fetch all remote branch refs during clone
git clone --no-single-branch https://github.com/example/project.git project

# Add a branch to an existing optimized clone, then create its local branch
cd project
git fetch origin feature
git checkout -b feature origin/feature
```

Use `--depth <n>` to request a different history depth.

### Git revision resolution

`show`, `ls-tree`, `cherry-pick`, `revert`, `rebase`, `diff`, `merge-base` and `rev-parse`
resolve their revision arguments through one helper, `resolveRevision()` in
`packages/webapp/src/git/commands/revision.ts`, so they all accept the same tokens: a ref
(`HEAD`, `main`, `origin/main`, a tag), a full or abbreviated oid, and `~`/`^` suffixes.

`log` is the exception — it hands its revision straight to `git.log()`, so it takes whatever
isomorphic-git accepts and not the suffix forms above.

Resolution order matters for performance, not just precedence. A ref is looked up first —
matching git, where a branch named `deadbeef` wins over the oid prefix `deadbeef` — and
`expandOid()` is only attempted for tokens that match `/^[0-9a-f]{4,40}$/i`. `expandOid()` reads
every `.git/objects/pack/*.idx` searching for a prefix match, so trying it first made
`git rev-parse HEAD` over a `--mount`ed host repo read all 30 pack indexes (3.8 MB, 34 bridge
requests) instead of `HEAD` plus `packed-refs` (issue #2713).

### `git log --all` walks every branch in one pass

`--all` used to run `git.log({ ref: branch, depth: 50 })` once per branch, concatenate the
results, sort them by date and only then apply `-n`. With 29 local branches that is 29
independent walks, each with its own isomorphic-git object cache, so all 30 pack indexes were
parsed once per branch: `git log --oneline --all -n 20` over a `--mount`ed host repo took
157 s and 72,767 bridge requests (issue #2712).

`walkAllBranches()` (`packages/webapp/src/git/commands/log-walk.ts`) is one date-ordered
traversal instead — seed a priority queue with every branch tip, pop the newest commit, yield
it, push its parents — so each commit object is read exactly once. It is an async generator,
so a consumer that stops pulling never pays for the next generation of commit reads: `-n 20`
reads 20 commits plus the queue frontier, not 50 per branch. Without `-n`, `--all` returns
the newest 50 commits across all branches (the old per-branch depth, now a global one).

**`--all -- <path>` filters the traversal as it runs, and is NOT capped.** A fixed candidate
window makes the answer depend on how busy the other branches are — 500 commits on one branch
would push another branch's matching tip out of the window and the match would vanish with no
diagnostic. The walk continues until `-n` matches are found or every branch is exhausted, the
same as real `git log`; commits are pulled in batches only so the pathspec filter can prime
its `commit oid -> tree oid` memo.

The adapter caches what such a walk repeats. `createIsomorphicGitFs(vfs, { objectCache: true })`
(`packages/webapp/src/git/vfs-fs-adapter.ts`) memoizes the `objects/pack` listing
isomorphic-git re-reads on every packed object lookup, plus the `objects/` fan-out listing
that decides whether the loose-object probe `_readObject` always tries first can find anything
at all. The memo's lifetime is the adapter object's, and `GitCommands.contextFor()` builds one
adapter per invocation — so two commands overlapping in time never share a view of the object
store, and nothing is cached across commands. Any write through the adapter drops the memo on
both sides of the write, so an object created mid-command is visible to the next read.

### Read-only git commands never touch the index

`status`, `ls-files`, `diff` and `clean --dry-run` pass `refresh: false` to
isomorphic-git's workdir walker (`NO_INDEX_REFRESH` in
`packages/webapp/src/git/commands/shared.ts`). The default, `refresh: true`,
re-inserts each stat'd file into the index just to warm its stat cache — and
because `GitIndexManager` writes the whole index whenever it is dirty, that
costs one full `.git/index` rewrite PER FILE. Over a `--mount`ed host checkout
a single `git ls-files` rewrote the user's real index 3,485 times (#2708).

If you add a command that walks the working tree, decide first whether it is
allowed to write: anything read-only spreads `NO_INDEX_REFRESH` into its
`statusMatrix` / `WORKDIR()` call. The stat cache still warms on the commands
that legitimately write the index (`add`, `commit`, `reset`, `stash`,
`rebase`).

### Packfiles are read once per shell, not once per command

isomorphic-git keeps parsed `.idx` files and read `.pack` buffers on the `cache`
object the CALLER hands it. Every `git` subcommand shares ONE cache per
`GitCommands` instance (`packages/webapp/src/git/git-cache.ts`, #2710), so a
second command reuses the packfile the first one paid for; a new isomorphic-git
call site that forgets `cache: ctx.cache` silently re-reads the whole pack (92 MB
over the bridge on the slicc checkout) and re-parses all 30 indexes.

The cache is dropped for a repository when its `objects/pack` listing or
`packed-refs` mtime moves, and after `fetch` / `pull` / `clone`. A read that
FAILED is evicted when the command settles — isomorphic-git caches the in-flight
promise, so a transient bridge error would otherwise be replayed to every later
command. At most four pack BUFFERS stay resident; the least recently used are
unloaded and re-read on demand, while their parsed indexes stay cached.

`git` also skips isomorphic-git's deep SHA-1 verification of the pack payload
(`patches/isomorphic-git+1.41.9.patch`) — a 5.2 s hash of a 92 MB pack that
canonical git only performs on `fsck` / `index-pack`. The O(1) trailer check
still runs, and `SLICC_GIT_VERIFY_PACKS=1` in the environment turns the deep
check back on.

### `git diff` never reads an unchanged blob

Every git command runs against the VFS, so on a `--mount`ed host repo each object
read is an HTTP round trip through the hostfs bridge. `git diff` therefore decides
what changed from OIDs before it reads any content (#2719):

- **Index vs workdir** (`git diff`): the workdir bytes of a tracked file are read
  once and hashed with `hashBlob`; the object store is touched only when that hash
  differs from the index OID. A clean tree reads zero blobs.
- **Tree vs index / tree vs tree** (`--staged`, `<rev> <rev>`): entries whose OIDs
  match are skipped, and two subtrees sharing a tree OID are pruned from the walk
  instead of being descended.
- **Untracked and pathspec-excluded subtrees are pruned in the walk's
  `iterate` hook**, not in `map`. `map` runs _after_ isomorphic-git has already
  `readdir`/`lstat`ed the entry, so pruning there still costs one round trip
  per tracked path; filtering in `iterate` works from the path string alone and
  costs nothing. `node_modules` and `.git` are never enumerated, and
  `git diff -- one/file.txt` never stats a sibling directory.
- Workdir walks pass `NO_INDEX_REFRESH` — a read-only command must not rewrite
  `.git/index` (#2708), per the section above.

When adding a diff variant, keep the OID comparison ahead of the content read and
the pathspec test ahead of the walk: the pre-2719 code compared decoded strings
and pulled all 3,549 tracked blobs out of the packfile on every invocation.

### `ipk install -g` / `npm install -g`

`ipk install -g <pkg>` (and `npm install -g`, `npm i -g`) installs into the shared
global prefix at `/shared/lib/node_modules`, records direct dependencies in
`/shared/lib/package.json`, and publishes PATH-visible `.jsh` delegators under
`/shared/bin` for package bins (each delegator runs `ipx --global <bin>` so the
global executable wins even when the invoking cwd has a same-named local package).
Local project installs are unchanged: without `-g`,
packages still land in `<cwd>/node_modules` and update the nearest project
`package.json`. Module resolution and `ipx`/`npx` also search the global tree after
the cwd-relative `node_modules` walk.

### `ipk uninstall -g` / `npm uninstall -g`

`ipk uninstall -g <pkg>` (aliases: `npm uninstall -g`, `npm remove -g`, `npm rm -g`)
removes the named package from `/shared/lib/package.json`, prunes orphaned
top-level entries from `/shared/lib/node_modules`, re-resolves remaining global
direct dependencies, and refreshes `.bin` shims plus `/shared/bin` delegators.
Without `-g`, uninstall removes entries from the cwd `package.json` and reconciles
`<cwd>/node_modules` the same way.

### `ipk list -g` / `npm root -g`

`npm list -g` (and `ipk list -g`) prints direct global dependencies with installed
versions. `npm root -g` prints `/shared/lib/node_modules`; `npm root` without `-g`
prints `<cwd>/node_modules`.

### `ipx` / `npx` built-in redirects

`ipx` runs JavaScript package bins from the nearest installed `node_modules`, then the
shared global tree at `/shared/lib/node_modules`; `npx` is an
alias with the same behavior. `ipx --global <bin>` (and `npx --global`) resolves only
from `/shared/lib/node_modules` — use this when a cwd-local package would shadow the
global install. When no local bin or installed package resolves, the command
normally installs the requested package and runs its bin. Before that network install,
`ipx`/`npx` consults `builtin-shadow-map.ts`. A match exits non-zero and prints a stderr hint
that names the SLICC built-in, suggests an invocation using the user's arguments, and includes
the exact `ipk add` bootstrap when the built-in needs one.

Prefer the suggested built-in. To deliberately bypass the redirect and install the npm package,
place `--force` before its name: `npx --force <package> [args...]` (or the equivalent `ipx`
form). Already-installed packages, locally resolved bins, and unmapped package names retain the
normal behavior.

`packages/webapp/src/shell/supplemental-commands/builtin-shadow-map.ts` is authoritative. It
currently maps exactly these npm package names:

| npm package names                                       | SLICC built-in   |
| ------------------------------------------------------- | ---------------- |
| `@biomejs/biome`, `biome`                               | `biome`          |
| `esbuild`                                               | `esbuild`        |
| `playwright`, `@playwright/test`, `playwright-core`     | `playwright-cli` |
| `puppeteer`, `puppeteer-core`                           | `puppeteer`      |
| `typescript`                                            | `tsc`            |
| `imagemagick`, `imagemagick-cli`, `imagemagick-convert` | `convert`        |
| `magick-cli`, `@imagemagick/magick-wasm`                | `magick`         |
| `ffmpeg`, `@ffmpeg/ffmpeg`                              | `ffmpeg`         |
| `sqlite3`                                               | `sqlite3`        |
| `v86`                                                   | `v86`            |

### `npm run` / `ipk run` script running

`npm run <script>` (aliases: `ipk run`, `npm run-script`, and the `npm test` / `start` /
`stop` / `restart` lifecycle shortcuts) runs a `scripts` entry from the NEAREST
`package.json` walking up from the cwd, with that package's directory as the working
directory. `npm run` with no script name lists what is defined.

- `pre<script>` and `post<script>` run around the body; a failing `pre` aborts before it.
- Arguments after the script name (and after an optional `--`) are appended to the body,
  shell-quoted: `npm run build -- --watch`. Everything after `--` belongs to the script,
  including `--help` and flags that would otherwise be npm's.
- `npm_lifecycle_event`, `npm_lifecycle_script`, `npm_package_name`, and
  `npm_package_version` are exported, and every reachable `node_modules/.bin` is prepended
  to `$PATH`.
- `--silent` / `-s` drops the `> pkg@version script` banner; `--if-present` turns a missing
  script into exit 0. Both are recognized on either side of the script name
  (`npm run build --silent` works), but never after `--`.
- `start` falls back to `node server.js` when the package has a `server.js`, and `restart`
  to `npm stop --if-present && npm start`, matching npm's built-in lifecycle defaults.
  `test` and `stop` have no default.
- The failing stage's exit code is the command's exit code.

`$PATH` lookup only finds `.jsh`/`.bsh` scripts, not the JS `node_modules/.bin` shims `ipk`
writes, so a command-position word that names no registered command but does have a `.bin`
shim is rewritten to `ipx <word>` (the runner that can execute those shims). Command position
survives keywords a command follows directly (`if`, `then`, `else`, `elif`, `while`, `until`,
`do`, `time`, `!`), so `if mytool; then mytool2; fi` rewrites both. Nothing else is rewritten:
a registered built-in keeps priority, the subject of `for`/`case` is never treated as a
command, and an unknown word stays unknown — no implicit install, so a typo still fails as a
typo.

### Biome wrapper behavior

`biome` is inert until `@biomejs/wasm-web`, `@biomejs/js-api`, and `esbuild-wasm`
are installed in the VFS with `ipk add`. It has three subcommands:

- `check` — lint and check formatting; `--write` applies formatting changes.
- `lint` — lint only and never write files.
- `format` — print one file's formatted content, use `--write` to update files, or
  use `--check` to report unformatted files without printing changes. `--write`
  and `--check` are mutually exclusive.

`--stdin-file-path <path>` selects the parser for piped input. The explicit
`--config-path <file>` option overrides discovery. Otherwise, discovery starts in
the first target file's directory (or the current directory for stdin), walks
toward `/`, and prefers `biome.json` over `biome.jsonc` at each directory.
Comments and trailing commas are accepted. Formatter/linter enabled gates and
file include/exclude patterns are evaluated before processing, so skipped files
produce no findings or writes and are omitted from `filesChecked`. Config
`extends` is not resolved. Path-based plugins cannot be loaded through the pinned
WASM JavaScript API and produce a precise configuration error instead of a runtime
failure.

Diagnostics are plain text: the wrapper removes the HTML tags and entities emitted
by the WASM API, and it does not add ANSI escapes.

Use `--reporter json` or its `--json` alias for machine-readable output. This
reporter writes one JSON document to stdout and writes no diagnostic text to
stderr. `format` reports formatting status without mixing formatted source into
the JSON stream. Reporter selection does not change the exit code.

```json
{
  "summary": { "errors": 1, "warnings": 0, "filesChecked": 1, "unformattedFiles": 0 },
  "diagnostics": [
    {
      "severity": "error",
      "category": "lint/suspicious/noDebugger",
      "message": "This is an unexpected use of the debugger statement.",
      "filePath": "/workspace/src/example.js",
      "line": 2,
      "column": 1
    }
  ],
  "files": [{ "path": "/workspace/src/example.js", "unchanged": true }]
}
```

`summary.errors` and `summary.warnings` are the counts used by the command,
`filesChecked` is the number of processed files, and `unformattedFiles` counts
files whose source differs from Biome's formatted output. Source and file
diagnostics use the real VFS path and a 1-based line and column derived from the
span; non-file failures may use an empty `filePath`, and diagnostics without a
source span use `null` for both position fields. Wrapped `.jsh` and `.bsh` files
are shifted back to positions in the original, unwrapped source.
Failures before file checking are represented as error diagnostics with a
`usage`, `configuration`, `io`, or `runtime` category, rather than being written
to stderr.

| Exit code | Meaning                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | No findings; checked files are formatted.                                                                                                               |
| `1`       | An error, fatal, or warning diagnostic; an unformatted file under `check` or `format --check`; a missing package/file; or an invalid discovered config. |
| `2`       | Usage error, including a missing or invalid explicit `--config-path`.                                                                                   |

**Example usage**:

```bash
# List all available commands
commands

# Resolve a command path
which node
# Output: /usr/bin/node

# Print the running SLICC version (kernel release)
uname -r
# Output: 6.66.1

# Kernel name, nodename, release, build, machine, user agent
uname -a

# Show the current leader tray status, launch URL, and join URL
host

# In a leader runtime, launch_url is the tray URL itself
# In non-leader/error runtimes with a saved session, it stays the local app launch URL
# join_url exposes the tray join capability directly when a session exists

# Follow another browser's tray as a follower. Paste the https://…/join/<token>
# join link the leader shows in its Session sharing dialog. Works in both the
# standalone and extension floats — in the extension this is the only way to
# follow a leader, since the WC UI dropped the join field. The follower
# connects asynchronously; run `host` afterwards to check the status.
host join https://www.sliccy.ai/join/<trayId>.<secret>

# Disconnect from a leader (follower) or stop being a leader. Clears the
# stored tray URLs so the next session boots dormant. Available in both
# the standalone and extension floats. Exits 0 with an informational
# stderr line when no tray session is active so `host leave || …`
# script chains don't trip on a dormant runtime.
host leave

# Leave whatever role this runtime is in and immediately become a leader
# on the supplied worker. Useful for testing extension-leader behavior
# after a follower session, without manual localStorage surgery.
host leave --leader https://www.sliccy.ai

# List followers that can run commands (a `slicc … follow` CLI shows a
# `[ssh]` tag in `host`; browser followers show `[playwright]`). Only `[ssh]`
# targets accept commands; `ssh --list` prints each with its advertised MOTD.
ssh --list

# Run a command on a follower's real machine (as the user who started
# `slicc … follow`) and return its stdout/stderr/exit. Ctrl+C interrupts it.
ssh follower-abc123 "uname -a"
ssh --cwd /tmp follower-abc123 "ls -la"
echo "hello" | ssh follower-abc123 cat   # piped stdin is forwarded

# The other direction: talk to ANOTHER SLICC leader as a client. This
# instance keeps leading its own tray throughout (unlike `host join`, which
# is a role switch). The join URL is dialed once and kept warm, so the
# second command below reuses the first one's connection.
slicc https://www.sliccy.ai/join/abc123 exec "uname -a"
slicc https://www.sliccy.ai/join/abc123 prompt "what are you working on?"

# Name an attachment, then address it by name.
slicc --name lab https://www.sliccy.ai/join/abc123 exec "git -C /workspace status"
slicc lab prompt "summarize the diff"
git diff | slicc lab prompt @-           # curl-style: - / @- read stdin, @path reads a VFS file

# Tail the remote agent's live output for 60s (read-only — sends nothing),
# stopping early once its current turn finishes.
slicc lab watch --for 60 --until-idle

# Housekeeping. Attachments are page-lifetime only; a reload starts with none.
slicc list
slicc detach lab
slicc https://www.sliccy.ai/join/abc123 --once exec "date"   # attach, run, drop

# Open a URL in a browser tab
open https://example.com

# Mint a worker-hosted preview URL for a VFS app directory and broadcast
# preview.open to all followers (defaults to index.html as the entry).
# The URL opens at the entry's own path (.../index.html), not bare "/".
serve /workspace/app

# Same, with a custom entry file — URL opens at .../pages/home.html
serve --entry pages/home.html /workspace/app

# Opt into leader-managed live updates (Phase 2). Cherry-attached followers
# default-on; --no-bridge always wins over both --bridge and the default.
serve --bridge /workspace/app

# Open a VFS file in a browser tab (legacy local preview service worker —
# unified worker preview takes over via `serve`; this path stays for
# direct one-off file opens pre-Phase-3 SW deletion). Detects a project
# root by walking up for head.html/fstab.yaml/package.json/.git so
# root-absolute paths (/styles/...) resolve the same way they do under
# `serve` (standalone only).
open /workspace/app/index.html

# Force download instead of opening in tab
open --download /workspace/report.pdf

# View an image (agent can see it in the response). The image travels as an
# `<img:data:…>` marker in the bash result, which the agent adapter turns into
# an image content block and the chat row renders inline. Markers are exempt
# from the 40KB bash output cap (up to 1MB of images per command, newest kept),
# so the base64 is never tail-truncated into unreadable text (#2217).
open --view --size medium /workspace/screenshot.png

# Execute JavaScript
node -e "console.log('Hello from Node')"

# Execute Python
python3 -c "print(sum(range(10)))"

# Create ZIP archive
zip archive.zip file1.txt file2.txt

# Query SQLite
sqlite3 -c "SELECT COUNT(*) FROM users" database.db

# Browse with playwright-cli
playwright-cli open https://example.com
playwright-cli snapshot

# Capture user's screen (prompts user to select screen/window/tab)
screencapture desktop.png
screencapture --view screen.png   # Capture and return for agent vision
screencapture -c                   # Capture to clipboard

# Display image
imgcat screenshot.png

# Schedule a cron job
crontask add "daily-backup" "0 2 * * *" backup-scoop "Backup all files"

# Reset the dock-tree to the shipped arrangement (`focus` is the only preset)
layout set focus

# Open the files panel alongside whatever's already there, then drag it onto
# another tile's edge to split, or its center to stack (drag the tile's
# hover-reveal move button, top-left corner)
layout open files right

# Resize it to 30% of its sibling group's height, then close it
layout size files --height 30%
layout close files

# Move chat to a different zone (top/left/middle/right/bottom) — `move` works
# for any surface (tool panel, sprinkle, or chat), detaching it from wherever
# it sits; a bare sprinkle name auto-prefixes to its sprinkle:<name> id
layout chat right
layout move sprinkle:weather bottom

# List presets / reset to "focus"
layout list
layout reset

# "focus" alias — there's no separate "editor mode" to enter anymore, the
# dock-tree is always the layout
layout edit
```

---

## workflow

Run Claude Code dynamic workflows natively. A workflow is a plain-JavaScript orchestration script that fans out work to many parallel subagents while keeping intermediate results in script variables rather than stuffing them into the model's context window.

**Workflows run in the background by default** (non-blocking). `workflow run` returns immediately with a run ID; completion is delivered as a new turn for cone-initiated runs or via `workflow status <id>`. Use `--wait` to block for the full result inline (SP1 behavior). Non-nesting.

### Usage

```bash
workflow run <file.js> [--args <json>] [--budget <n>] [--concurrency <n>] [--wait]
workflow run --script '<inline js>' [...]
workflow save <runId> <name> [--force]
workflow status <id>
workflow list
workflow stop <id>
```

- `<file.js>` — path to a workflow `.js` file
- `--script '<code>'` — inline script (no temp file)
- `--args <json>` — parsed JSON exposed as the `args` global
- `--budget <n>` — token budget (stub in SP1: `budget.total` set but not enforced)
- `--concurrency <n>` — parallel agent limit (defaults to 8, clamped to `[1, min(16, max(8, cores×4))]`)
- `--wait` — block until completion and print the full result (foreground mode; SP1 behavior)

**Background run:** `workflow run` prints `▶ workflow '<name>' started (run <id>). Watch: workflow status <id>` and returns immediately. The workflow executes in the background; cone-initiated runs deliver completion as a new turn with the result path + preview. Terminal/scoop runs surface via `workflow status <id>`.

**Save/status/list/stop:**

- `workflow save <runId> <name> [--force]` — persist a backgrounded run's source to `/workspace/.workflows/<name>.workflow.js`. Only backgrounded (non-`--wait`) runs are saveable (a `--wait` run has no run id). Rejects a name already taken by a built-in or existing command; `--force` overwrites an existing saved workflow.
- `workflow status <id>` — show live progress and final result for a run
- `workflow list` — list all runs with status
- `workflow stop <id>` — kill a running workflow (SIGKILL)

### Meta block (required)

Every workflow must define a pure-literal `meta` object with a `name` (conventionally `export const meta` at the top — the parser locates it anywhere in the file and `name` is the only required field):

```js
export const meta = {
  name: 'review-changes', // required
  description: 'one-line summary', // optional (shown in the run banner)
};
// body uses injected globals below
```

### Orchestration API

| Global        | Signature & semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`       | `agent(prompt: string, opts?: {model?, schema?, phase?, label?, thinking?}): Promise<any>`. No `schema` → text string. With `schema` (JSON Schema) → subagent calls `StructuredOutput` tool, returns validated object. Resolves `null` on failure/skip. `model` overrides session model. `thinking` sets thinking level (`'off'\|'minimal'\|'low'\|'medium'\|'high'\|'xhigh'`). `schema` path enforces structured output with up to 2 in-conversation nudges; terminal failure → `null`. |
| `parallel`    | `parallel(thunks: Array<() => Promise<any>>): Promise<any[]>`. Barrier — awaits all. Never rejects; failing thunks → `null` in result array. Use when you genuinely need all results together. ≤4096 items per call (throws `WorkflowError` if exceeded).                                                                                                                                                                                                                                |
| `pipeline`    | `pipeline(items, stage1, stage2, ...): Promise<any[]>`. Streaming per-item, NO barrier — item A can be in stage 3 while B is in stage 1. Each stage callback receives `(prevResult, originalItem, index)`. A throwing stage drops that item to `null` and skips its remaining stages. ≤4096 items per call (throws `WorkflowError` if exceeded). The default for multi-stage work.                                                                                                       |
| `phase`       | `phase(title: string): void`. Start a progress group; subsequent `agent()` calls group under it (SP4 UI; SP1 emits `WFPHASE` marker to stdout).                                                                                                                                                                                                                                                                                                                                          |
| `log`         | `log(message: string): void`. Narrator line above progress (SP1 emits `WFLOG` marker to stdout).                                                                                                                                                                                                                                                                                                                                                                                         |
| `args`        | `any` — the value passed via `--args`, verbatim (`undefined` if absent).                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `budget`      | `{ total: number\|null, spent(): number, remaining(): number }`. SP1 stub: `spent()` returns `0` (agents don't surface token usage yet), so hard ceiling never trips. Shape present so CC scripts that read `budget` don't crash. Precise accounting + enforcement deferred to SP6.                                                                                                                                                                                                      |
| `workflow`    | `workflow(name \| {scriptPath}, args?): Promise<any>`. Throws `WorkflowNestingUnsupportedError` in SP1 (real nesting is SP6 backlog).                                                                                                                                                                                                                                                                                                                                                    |
| `Date`        | Shadowed: argless `new Date()` and `Date.now()` throw `WorkflowDeterminismError`. Pass time via `args`.                                                                                                                                                                                                                                                                                                                                                                                  |
| `Math`        | Shadowed: `Math.random()` throws `WorkflowDeterminismError`. Vary by index instead.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `crypto`      | Shadowed: `crypto.getRandomValues()` / `crypto.randomUUID()` throw `WorkflowDeterminismError`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `performance` | Shadowed: `performance.now()` throws `WorkflowDeterminismError`.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| timers        | `setTimeout` / `setInterval` / `queueMicrotask` throw `WorkflowDeterminismError`.                                                                                                                                                                                                                                                                                                                                                                                                        |

Workflow scripts have NO access to `fs`, `exec`, `fetch`, `require`, `process`, `module`, `exports`, `skill`, `http`, `browser`, `usb`, `serial`, `hid`, `cli`, `c`, `time`, `fmt`, or `pool` — only agents touch files/shell.

### Constraints

- **Concurrency cap:** defaults to 8; `--concurrency` clamps to `[1, min(16, max(8, cores×4))]` (scoops are I/O-bound on the LLM, not CPU-bound, so the cap scales ~4 scoops/core, floors at 8 so small boxes still fan out, and ceilings at 16 to protect provider rate limits + browser memory)
- **Total cap:** 1000 agents per run (runaway-loop backstop); exceeding throws `WorkflowAgentCapError`
- **Per-call cap:** `parallel` / `pipeline` accept ≤4096 items; exceeding throws `WorkflowError`
- **Determinism:** `Date.now()`, `Math.random()`, `crypto`, `performance.now`, timers throw `WorkflowDeterminismError` so runs are replayable
- **Isolation:** soft (cooperative). Script runs in the same scope as the prelude; determined scripts can reach `globalThis.*` or use `eval`. Hard enforcement deferred to SP6 realm-native fork.

### Agent spawning

Each `agent(prompt, opts)` call:

1. Acquires a concurrency slot (defaults to 8, waits if full)
2. Spawns an ephemeral scoop via the `agent` shell command
3. Read scope: `/workspace/` (read-only) + the per-run scratch cwd (`/shared/workflow-runs/<runId>/scratch/`)
4. Write scope: the scratch cwd **plus the ambient `/shared/`, `/tmp/`, and the agent's own `/scoops/<name>/`** (the standard scoop sandbox — `--read-only` only narrows _read_ roots, not writable ones). Concurrent runs share `/shared/`, so a workflow agent can in principle touch another run's `/shared/workflow-runs/*`.
5. With `schema`: injects a `StructuredOutput` tool and instructs the scoop to call it. pi validates the tool-call args against the schema (mismatch → error fed back to the model → retry); the validated args are captured and returned JSON-parsed. Up to 2 nudges if the scoop never calls the tool.
6. Without `schema`: returns the final text (last `send_message` or accumulated response)
7. On failure (exit ≠ 0 or no valid `StructuredOutput` call after nudges): resolves `null`

### Example

```js
export const meta = {
  name: 'repo-audit',
  description: 'Fan-out verification over repo files',
};

const files = ['src/index.ts', 'src/util.ts', 'src/helper.ts'];

phase('Verify files');
const results = await parallel(
  files.map(
    (f) => async () =>
      agent(`Check ${f} for type safety issues`, {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, issues: { type: 'array' } },
          required: ['ok', 'issues'],
        },
      })
  )
);

const valid = results.filter(Boolean).filter((r) => r.ok);
log(`${valid.length}/${files.length} files passed`);

return { passed: valid.length, total: files.length };
```

### Output

```
workflow: repo-audit — Fan-out verification over repo files
▸ Verify files
· 3/3 files passed
{"passed":3,"total":3}
```

### Error handling

- **Script throw** → exit 1 + stderr with message + stack
- **Agent failure/skip** → that `agent()` resolves `null` (not surfaced as run error)
- **Schema mismatch** → validation error fed back to model → retry; terminal failure after nudges → `null`
- **Cap exceeded** (1000 total, 4096 per call) → thrown `WorkflowAgentCapError` / `WorkflowError` (script can catch)
- **Determinism violation** → thrown `WorkflowDeterminismError`
- **Realm crash / SIGKILL** → exit 1 / 137; no partial-success masquerading as success

No silent fallbacks.

### Saved & skill workflows as commands

`*.workflow.js` files auto-discover as shell commands:

- **Saved workflows** (`/workspace/.workflows/<name>.workflow.js`) → bare `<name>` command
- **Skill-bundled workflows** (`/workspace/skills/<skill>/.workflows/<name>.workflow.js`) → `<skill>:<name>` command

Bare-name dispatch precedence: `built-in > .jsh > saved-workflow`. A saved workflow shadowed by a built-in or `.jsh` file remains runnable via `workflow run /workspace/.workflows/<name>.workflow.js`.

**Args:** Invoke as `<name> '<json>'` (or `<skill>:<name> '<json>'`). A single JSON-valid arg is passed verbatim; a non-JSON arg is passed as a string; multiple args are passed as a JSON array. Use `--` to force literal positionals. `--wait` runs inline (foreground) instead of backgrounding.

**Examples:**

```bash
# Save a good run as a reusable command
workflow save wf_abc123 repo-audit

# Run it later
repo-audit '{"paths": ["src/"]}'

# Skill workflow
codebase:sweep --wait
```

---

## webhook and crontask topology behavior

**Float discrimination:** Lick legs (`webhook`, `crontask`, the `/licks-ws` bridge) behave differently by float topology (`resolveFloatTopology()` in `packages/webapp/src/core/float-topology.ts`):

- **`node-rest` topology** (standalone thin-bridge, Electron, hosted/cloud): `webhook` URLs come from the local node-server REST endpoints (`/api/webhooks/<id>`); `crontask` fires via the node-server-managed scheduler; lick events reach the kernel worker over the `/licks-ws` WebSocket bridge.
- **Extension-delegate leader** (pinned hosted tab): `webhook` URLs come from the connected tray worker (requires an active leader tray; otherwise `webhook create` reports "connect a leader tray"); `crontask` runs on the in-tab worker `LickManager` and fires only while the leader tab is open (tab-lifetime — closing or navigating the tab terminates all crontasks).
- **Followers** (all floats): `navigate` licks (including SLICC handoffs) are forwarded to the leader instead of handled locally. Other lick types are not generated by followers.

**Target validation (#2524):** an explicit `--scoop` on `webhook create`, `crontask create` or `fswatch create` is resolved against the live work-unit roster in every float (standalone direct manager, side-panel BroadcastChannel proxy alike) and exits 1 listing the valid targets when it matches nothing. Omitting `--scoop` is unchanged. A roster the command cannot consult (kernel host not booted) accepts the target as before.

**Webhook delivery receipts (#2524):** a POST is answered from the leader's disposition, not from "we forwarded it". The **failure** receipts are the new part and read the same in both topologies: `404` `WEBHOOK_NOT_REGISTERED` (unknown webhook id), `422` `WEBHOOK_TARGET_UNRESOLVED` (target gone, event discarded), `500` `WEBHOOK_DISPATCH_FAILED`, plus node-server's pre-existing `503` when no browser is connected. The **success** receipt is topology-specific and byte-for-byte what it was before #2524 — the tray worker answers `202 {"ok":true,"accepted":true}`, the node-server answers `200 {"ok":true,"received":true}` — so a caller checking for one shape must not assert it against the other. Success covers both a delivered event and one the webhook's own `--filter` dropped. The tray worker asks for the disposition with a `deliveryId` on `webhook.event` and waits briefly for the leader's `webhook.delivery`; the node-server asks over the lick bridge as a request. A leader too old to answer keeps the success receipt: silence is not evidence of a drop.

---

## playwright-cli

Browser automation is also exposed as shell commands: `playwright-cli`, `playwright`, and `puppeteer`.

- **Shared state across aliases**: all three names operate on the same current tab, snapshot cache, cookies/storage context, and `/.playwright/session.md` history.
- **Default targeting**: `open` / `tab-new` open in the background by default, but if there is no current browser target yet, the first opened tab becomes current so `snapshot` works immediately.
- **Fresh refs required**: `click`, `fill`, `goto`, `go-back`, `go-forward`, `reload`, and similar state-changing commands invalidate prior snapshot refs. After history navigation or reload, run `snapshot` again before using refs.
- **Cookie convenience forms**: `cookie-set <name> <value>` and `cookie-delete <name>` use the current page URL when `--domain` and `--path` are omitted.
- **Teleport restores auth state**: arm it explicitly with `playwright teleport --start=<regex> --return=<regex>` or implicitly with `--teleport-start` / `--teleport-return` on `open`, `tab-new`, or `goto` / `navigate`. When the leader hits `--start`, the intercepted auth URL opens on a follower for the human to finish login; when the follower hits `--return`, teleport restores both cookies and page storage (`localStorage` + `sessionStorage`) back to the leader. For cross-origin SSO flows, teleport hydrates the captured app origin first, then lands on the best matching app URL. Teleport needs a follower with `Network.*` (cookie/storage) access, so a cherry host target is never eligible — auto-selection skips it and an explicit `teleport --runtime <id>` naming a cherry host is rejected at arm time. Eligibility now reads advertised capabilities for every target kind rather than only cherry, so a follower that says `network: false` is excluded whatever it calls itself; a follower that has said `hello` but not yet advertised targets qualifies on its `capabilities.browser` flag, which keeps exec-only followers (the `slicc … follow` CLI) out — their `tab.open` would hang rather than fail. `teleport --list` and auto-selection work without `--runtime` in both realms: the leader page publishes live getters, and the kernel-worker shell reads the same roster from the `slicc.leaderTrayFollowers` mirror (refreshed on every follower message, so "most recently active" tracks real human activity rather than keepalive traffic).
- **Unsupported arguments are rejected, per subcommand**: the argv a verb accepts is declared in `playwright/slicc-commands.json` and enforced by `playwright/validate-args.ts` before the handler runs, so an unknown flag or an extra positional exits 1 with a usage line instead of being parsed and then ignored. That is what makes exit 0 mean "everything you passed was honoured" (#2405). `screenshot`'s positional is an element ref — the output path is `--filename=<path>`, and `screenshot /tmp/x.png` is an error rather than a PNG written somewhere else. A verb with no manifest entry is not validated, so a stale manifest weakens the check but never breaks a working call.
- **Unexpected dialogs**: attached pages auto-dismiss unexpected JavaScript dialogs so a stray `alert()` or similar modal does not stall automation indefinitely.
- **`--frame` on `eval` / `eval-file` / `snapshot`**: evaluates in (or snapshots) that child frame instead of the main one; `frames --tab=<id>` lists frame IDs. Other verbs reject `--frame` rather than ignoring it.
- **Top-level await/return in `eval` / `eval-file`**: source may use top-level `await` (e.g. `eval "await fetch(url).then(r => r.text())"`) and `return` (e.g. `eval "const r = await fetch(url); return r.status"`). A plain expression / multi-statement script is tried first (last-expression completion values and promise-returning expressions are preserved); an async-IIFE fallback kicks in only on a parse-time `SyntaxError`, so side-effecting code is never executed twice.
- **Link-header discovery**: `playwright-cli fetch <url>` always emits JSON with parsed RFC 8288 `links[]` and any SLICC handoff match; pass `--discover` to also fetch P0 capability docs (`api-catalog`, `service-desc`, `llms.txt`, …) and to populate `discovery.browseShSkills[]` with any browse.sh catalog entries whose hostname matches the destination URL (cold-cache call triggers one lazy fetch per shell). The same `--discover` flag on `goto` / `navigate` / `open` / `tab-new` performs an auxiliary proxied fetch and switches output to the same JSON payload. See [link-discovery.md](link-discovery.md) for the full module map.

### Common flow

```bash
playwright-cli open https://example.com
playwright-cli snapshot
playwright-cli click e5
playwright-cli snapshot
playwright-cli cookie-set theme dark
```

### Session files

- `/.playwright/session.md` — chronological command log
- `/.playwright/snapshots/` — saved accessibility snapshots for state-changing commands that auto-snapshot
- `/.playwright/screenshots/` — saved screenshots

Use the skill doc at `packages/vfs-root/workspace/skills/playwright-cli/SKILL.md` for the full command list and operating guidance.

---

## curlwright

`curlwright` is curl's argument surface, run by a `fetch()` **inside a browser tab**. The request carries that tab's cookies, its origin, its TLS/session state and its service-worker routing — which is the difference between a `401`/`403`/`421` and a `200` when you are calling an app's own backend.

```bash
curlwright -s -X POST https://app.example.com/api/v1/items \
  -H 'X-CSRF-Token: abc' -d '{"name":"x"}' --tab <targetId>
curlwright -o /tmp/deck.key https://p27-iwres.icloud.com/iwmb/keynote/utoken:<T>/fetchDocument
curlwright -i -w '%{http_code}\n' https://app.example.com/api/me
```

- **Tab selection**: `--tab <targetId>` is explicit and always wins. Without it, `curlwright` uses the tab on the request URL's origin — the one holding the session — but only when **exactly one** tab matches; otherwise it falls back to the single open tab. Two tabs on one origin may be two different accounts (the roster spans tray followers), so that is an error listing the candidates, as is having no match with several tabs open. `--frame <frameId>` runs in a child frame of that tab.
- **Byte-exact output**: bodies always cross the bridge as base64 bytes, so `-o` / `-O` write the file the server sent, and a text body reaches stdout verbatim (never JSON-parsed and re-serialized). A binary body with no `-o` prints curl's "binary output" warning instead of corrupting the terminal; `-o -` forces it through.
- **Credentials default to `include`** — the entire point. `--no-credentials` opts out.
- **Supported**: `-X`, `-H` (repeatable), `-d` / `--data-raw` / `--data-binary` / `--data-ascii` / `--data-urlencode` / `--json`, `-F` / `--form-string`, `-G`, `-u`, `-e`, `-r`, `-o`, `-O`, `-i`, `-I`, `-D`, `-w`, `-s`, `-S`, `-v`, `-f`, `-m`, `-L`. `@file` arguments read from the VFS. curl's header forms are honored in full: `-H 'Name: v'` sets, `-H 'Name;'` sends an empty value, and `-H 'Name:'` **suppresses** a default `curlwright` would otherwise derive (so `-H 'Content-Type:' -d …` really does send no Content-Type). `-r 0-499` becomes `Range: bytes=0-499`.
- **A body on GET or HEAD is bad usage** (exit 2), not a runtime failure: `fetch()` rejects it, so `-I -d …` or `-X GET -d …` is refused up front with a pointer to `-G` rather than surfacing later as an opaque exit 7.
- **Rejected by name**: options a page cannot honor — `--cert`, `--key`, `--cacert`, `-k`, `-x`, `--interface`, `--unix-socket`, `--resolve`, `--compressed`, `-b`, `-c`, `-A`, `--connect-timeout`, `--limit-rate`, `-C`, HTTP-version pins. So are `-H` values `fetch()` would silently strip (`Origin`, `Referer`, `Cookie`, `Host`, `Sec-*`, `Proxy-*`) — a silently dropped header is worse than a refused one.
- **Exit codes** mirror curl: `0` ok, `2` bad usage, `7` the fetch failed, `22` with `--fail` on HTTP >= 400, `23` write error, `26` an unreadable input file, `28` `--max-time` expired.
- **`-w` variables**: `%{url_effective}`, `%{http_code}`, `%{content_type}`, `%{size_download}`, `%{size_header}`, `%{size_upload}`, `%{method}`, `%{num_redirects}`, `%{time_total}`, `%{exitcode}`, `%{errormsg}`, `%{json}`, plus `%header{Name}`. The format string is rendered even when the transfer never completed, so `%{exitcode}` and `%{errormsg}` still reach stdout after a timeout or a network error.

Two deliberate deviations from curl, both because a page `fetch` cannot do otherwise:

- **Redirects are always followed.** The intermediate `3xx` is not observable from the page, so `-L` is accepted and is already the behavior, and `%{num_redirects}` is `0` or `1` — "at least one hop" — rather than a count.
- **Cross-origin responses expose only CORS-safelisted headers** unless the server sends `Access-Control-Expose-Headers`. Same-origin requests — the intended use — see all of them.

---

## upskill

Skill package manager. Installs into `/workspace/skills/<name>/` from three registries:

| Install ref                        | Registry                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upskill <owner>/<repo>[@branch]`  | GitHub. Supports `--skill <name>` (repeatable), `--all`, `--path <subfolder>`, `--branch/-b`, `--list`, `--force`. Refreshing an installed skill: prefer `upskill update`.                   |
| `upskill tessl:<name>`             | Tessl registry (resolves to a GitHub source under the hood).                                                                                                                                 |
| `upskill browse:<hostname>/<task>` | [browse.sh](https://browse.sh) site-specific skills. Equivalent URL form: `upskill https://browse.sh/skills/<hostname>/<task>`. Installs into `/workspace/skills/browse-<hostname>-<name>/`. |

### `upskill update|upgrade [<skill>…] [--dry-run] [--branch <ref>] [--from <owner>/<repo>] [--path <dir>] [--json]`

Re-installs skills from the source recorded at install time, so refreshing a skill no longer means remembering the repo and running `--force`. With no skill name, every skill that has provenance is updated.

Each install writes `<skill>/.upskill` — source kind, `owner/repo` (or browse.sh slug), ref, resolved commit sha, the timestamp of the last install/update, and the file list it wrote. `upskill info <name>` surfaces it as `Installed from:`.

**The sha is the fast path.** When the recorded commit still equals the ref's head and every recorded file is still on disk, `update` reports `already current` from one ~200-byte commits call and never downloads the archive. A moved sha, a missing file, or no recorded sha falls through to the full content compare. The two commands treat the API differently on purpose: an _install_ skips the sha lookup unless a `github.token` is configured, because the codeload path is deliberately rate-limit-free (pinned by `tessl.test.ts`); an explicit _update_ spends the request, because there it replaces a whole repo archive.

`--from <owner>/<repo>` records a source for a skill that has none — installed by hand, or before provenance tracking. The skill directory is located in the repo by its `SKILL.md` (pass `--path <dir>` if that lookup is ambiguous or the skill is vendored deeper), and the resolved path is recorded, so the next update needs no arguments. Because nothing is attributable to a previous install, that first update can add and overwrite but never delete.

Every path is classified with the vocabulary `upgrade apply` uses for bundled workspace files:

| Status       | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| `unchanged`  | Local bytes already match upstream.                                         |
| `updated`    | Upstream differs; the local file is overwritten.                            |
| `added`      | Upstream ships a file the install does not have.                            |
| `removed`    | Upstream dropped a file **this command installed** (tracked in `.upskill`). |
| `kept-local` | A dotfile, or a file upskill never installed — left untouched.              |

**The no-argument sweep names what it could not check.** An installed skill with no `.upskill` record cannot be updated, so the sweep lists it under `Skipped <n> skills with no install provenance` and scopes its closing line to the skills it actually checked (`All 13 skills with provenance are current.`). This is informational, not a failure: it stays off stderr and the exit code stays 0, because runtime-bundled skills legitimately have no record (`upgrade apply` keeps those current) and the rest only need a source recorded once with `upskill update <skill> --from <owner>/<repo>`. With nothing skipped, the closing line is the unqualified `All skills are current.`

`--dry-run` reports the classification and writes nothing. `--json` emits `{ ok, dryRun, results[], skipped[] }` for scripted callers — `skipped` is the name-sorted list of unattributed skills and does not affect `ok`.

### What upskill never touches

Two rules, and `--force` and `update` obey both, so "refresh this skill" means the same thing whichever command the user reaches for:

1. **Dotfiles in a skill directory.** Never modified, never deleted — on install, on `--force`, or on `update`. Skills keep credentials there (`skills/bb/scripts/.config`, `skills/gmail/scripts/.config`), and before this rule a `--force` refresh silently revoked them along with the `.upskill` record. Upstream dotfiles (`.gitignore`, `.config.example`) are still written on **first** install, otherwise they could never land at all; after that they belong to the user.
2. **Files no recorded install wrote.** Only paths in the `.upskill` file list are removable, so a user's own `NOTES-local.md` is reported `kept-local` and survives. A skill with no record (installed before provenance tracking) has nothing attributable, so a `--force` reinstall still clears its non-dot files — recording a source with `upskill update <skill> --from <owner>/<repo>` is what upgrades it to the protected behavior.

Archive entries whose path escapes the skill directory (`../`, absolute, or backslash-separated) are dropped by every write path — install, `--force`, and `update` — and never enter the recorded file list.

`upskill search "<query>"` round-robin interleaves results from Tessl and the browse.sh catalog (first hit from each source, then second from each, …) so both registries get visibility in the top page. `upskill recommendations` matches your profile; add `--install` to write the matches.

### browse.sh: SLICC adapter preamble

Installed browse.sh `SKILL.md` files get a fixed preamble inserted **immediately below the upstream YAML frontmatter** (the frontmatter remains the first thing in the file; the upstream body round-trips byte-identical below the preamble). The preamble is the same for every browse.sh skill regardless of `recommendedMethod`:

```markdown
> [!NOTE] **Imported from browse.sh** — original slug: `<hostname>/<task>`
>
> **SLICC adaptation:** use `playwright-cli` — you are running inside the user's real browser session, so the bot-detection workarounds the upstream skill assumes are usually unnecessary.
>
> Source: <https://browse.sh/skills/<hostname>/<task>> · updated <date>
```

### `upskill tabs [--json]`

Suggests skills for each open browser tab. For every tab `upskill tabs` lists:

- **Origin-advertised upskill rels** — for each tab URL, fetches it through the same proxied fetch the rest of the shell uses, parses the response's `Link` header (same `parseLinkHeader` helper as `discover` / PR #602), and surfaces any `Link: <…>; rel="https://www.sliccy.ai/rel/upskill"` the site emits. Distinct from `discoverLinks`, which follows P0 capability rels (`api-catalog`, `service-desc`, `llms-txt`, …) — `upskill tabs` only looks at the `upskill` rel.
- **Browse.sh catalog matches** — hostname-exact after stripping leading `www.` (so `https://www.weather.gov/` matches `weather.gov` but `https://forecast.weather.gov/` does not). Each match prints `installHint` and a `✓` marker for skills already installed under `/workspace/skills/browse-<host>-<name>/`.

`--json` emits the same data as a `{ tabs: TabUpskillResult[] }` envelope (one entry per tab with `targetId`, `url`, `hostname`, `active`, `origin[]`, `catalog[]`, `failures[]`). Per-tab discovery failures are collected non-fatally; a catalog fetch failure becomes a stderr warning but the command still exits 0. Without a browser API attached the command prints `browser APIs unavailable in this environment` and exits 1.

---

## mount

Bridges local directories and remote object storage into the VirtualFS so that file tools (`read_file`, `write_file`, `edit_file`, `bash`) operate on remote content the same way they do on browser-local files. Three peer backends share a `MountBackend` interface: a local FS Access backend (uses the `showDirectoryPicker()` flow), an S3 / S3-compatible backend (AWS, Cloudflare R2, MinIO via custom endpoints), and a DA backend (Adobe da.live, authenticated via the existing Adobe IMS provider).

Implementation lives outside `supplemental-commands/`: `packages/webapp/src/fs/mount-commands.ts` is the dispatcher, registered via the `MountCommands` class consumed by `almost-bash-shell.ts`. Backends are under `packages/webapp/src/fs/mount/`.

### Subcommands

| Form                                                | Behavior                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mount <path>`                                      | Local FS Access mount. Opens a directory picker (cone-only — fails fast in scoops, which have no UI gesture).                                                                                                                                                                                                                                                                                           |
| `mount --source s3://<bucket>[/<prefix>] <path>`    | S3 / S3-compatible mount. Reads creds from `s3.<profile>.*` secrets (`--profile` selects the namespace; defaults to `default`). Allowed in scoops.                                                                                                                                                                                                                                                      |
| `mount --source da://<org>/<repo>[/<path>] <path>`  | Adobe da.live mount. Reuses the existing Adobe provider's IMS bearer token; `--profile` is accepted for symmetry but has a single global identity in v1. Probes the site config first and re-routes to the Helix 6 Source Bus when the site has been upgraded (issue #2227); fails rather than guessing if the config is unreadable. Allowed in scoops.                                                 |
| `mount --source aem://<org>/<site>[/<path>] <path>` | AEM Helix 6 Source Bus mount (`api.aem.live`). Same IMS bearer as `da://`, no config probe. The Source Bus has no ETags, so writes are guarded by modification time and only for files that were read first. Allowed in scoops.                                                                                                                                                                         |
| `mount list` (`--list`, `-l`)                       | List active mounts with each mount's index state: `indexed: <n> entries`, `indexing: <n> entries...`, `pending index`, or — when the index was skipped — a distinct cause line (depth-exceeded, entries-exceeded, cycle-detected, or a generic index error; see [Index bounds and skip states](#index-bounds-and-skip-states)). A skipped index still serves reads via the slow per-`readDir` fallback. |
| `mount unmount [--clear-cache] <path>`              | Tear down a mount. `--clear-cache` also drops cached listings + bodies for that mount; without it, cache entries persist until TTL or the next session.                                                                                                                                                                                                                                                 |
| `umount [--clear-cache] <path>`                     | Top-level alias for `mount unmount`. Identical behaviour and exit codes; errors read `umount: …`. `mount -u <path>` also still works. Unmounting a path that was never mounted is a no-op under either spelling (`VirtualFS.unmount` is idempotent).                                                                                                                                                    |
| `mount refresh [--bodies] <path>`                   | Re-walk the source and diff against the cache. Prints `Refreshed <path>: +<added> -<removed> ~<changed> (<unchanged> unchanged, <errors> errors)`. Without `--bodies` only the listing is rechecked; with `--bodies` changed files are conditionally re-fetched.                                                                                                                                        |

### Mount-time flags

| Flag                  | Applies to            | Effect                                                                                                                                                                                                                      |
| --------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source <url>`      | mount                 | Selects a remote backend by URL scheme (`s3://`, `da://`, `aem://`). Without `--source`, the local picker is used.                                                                                                          |
| `--backend <da\|aem>` | mount                 | Forces the Adobe backend instead of probing the site config. Only meaningful with a `da://` or `aem://` source.                                                                                                             |
| `--profile <name>`    | mount                 | Profile name resolved against `s3.<profile>.*` secrets (S3) or used as a label (DA). Defaults to `default`.                                                                                                                 |
| `--no-probe`          | mount                 | Skip the mount-time `HEAD` bucket / `GET /list` round-trip. Use when latency matters and you trust the source URL is well-formed and accessible. Does not skip the `da://` content-source probe — use `--backend` for that. |
| `--max-body-mb <n>`   | mount                 | Override the per-mount maximum body size for read/write. Defaults: S3 25 MB, DA/AEM 5 MB. Files exceeding the threshold throw `EFBIG` before any body bytes flow.                                                           |
| `--clear-cache`       | mount unmount, umount | Drop the `RemoteMountCache` entries (listings + bodies) for this mount.                                                                                                                                                     |
| `--bodies`            | mount refresh         | After the listing diff, conditionally re-fetch bodies for paths whose ETag changed. Without this flag a refresh is one paginated list (or one DA recursive walk) plus zero body bytes.                                      |

### Index bounds and skip states

Each mount is indexed in the background for fast file discovery and listings. The walk is bounded so a deep, huge, or self-referential tree can't peg / OOM the kernel worker; hitting a bound **skips** the index (reads fall back to the slow per-`readDir` path).

Defaults (raised 10× in #1186): max directory depth **400**, max total entries **2,000,000**. Two env vars override them — `SLICC_MOUNT_INDEX_MAX_DEPTH` and `SLICC_MOUNT_INDEX_MAX_ENTRIES`. Each must be a positive integer; an invalid value (non-numeric, zero, negative, or `NaN`) is ignored, falling back to the default with a logged warning. (The worker / browser float has no OS env, so defaults always apply there.)

`mount list` reports the index state per mount and distinguishes four skip causes:

- `index skipped: directory nesting exceeded the depth limit` — **depth-exceeded**; raise `SLICC_MOUNT_INDEX_MAX_DEPTH` or unmount.
- `index skipped: mounted tree is too large` — **entries-exceeded** (explicitly not a cycle); raise `SLICC_MOUNT_INDEX_MAX_ENTRIES` or unmount.
- `index skipped: self-referential mount cycle detected` — **cycle-detected**; a confirmed self-reference (directory-fingerprint prefilter + `FileSystemHandle.isSameEntry()`), unmount it.
- `index error: <message>` — **indexing-error**; any other failure.

Only a confirmed self-reference is labeled a cycle — a large or deep but legitimate mount is no longer mislabeled as "likely cyclic".

### Caching and conflict semantics

Remote backends share a `RemoteMountCache` (TTL + ETag, IDB-backed under `slicc-mount-cache`). Default TTL is 30 s.

- **Reads**: cache-fresh → zero RTT; cache-stale → conditional `GET` with `If-None-Match` (304 keeps cached body, 200 replaces it); cache-miss → unconditional `GET`.
- **Writes**: existing files use `If-Match: <etag>`; new files use `If-None-Match: *` to refuse silent overwrite. A 412 from a fresh first-attempt PUT surfaces as `FsError('EBUSY', …)` so the agent's edit loop can re-read and retry. (412 inside a bounded retry window of an in-flight PUT is silently reconciled — that case means "we already won this PUT" rather than a conflict.)
- **Auth**: 401/403 triggers a one-time profile re-resolution (covers credential rotation and IMS token refresh) before bubbling `EACCES`.
- **Recovery**: mount descriptors persist across sessions. On reload, local mounts may need a user gesture to re-grant the FS Access handle; remote mounts auto-restore as long as profiles resolve and IMS hasn't expired. Failures surface via a `session-reload` lick that the cone renders as an actionable retry prompt.

### Credentials

S3 secrets follow the `s3.<profile>.*` namespace. DA reuses the Adobe IMS token from the existing provider — no DA-specific secret to set. See [docs/secrets.md](secrets.md#mount-backend-secrets) for the full key list and example setup.

### Examples

```bash
# Local picker (cone only — runs in the panel/UI context with a user gesture)
mount /mnt/local

# S3 (AWS) — first store scoped creds, then mount
echo "$AWS_ACCESS_KEY_ID" | secret set s3.aws.access_key_id --domain "*.amazonaws.com"
echo "$AWS_SECRET_ACCESS_KEY" | secret set s3.aws.secret_access_key --domain "*.amazonaws.com"
mount --source s3://my-bucket/site --profile aws /mnt/aws

# Cloudflare R2 (S3-compatible — uses --source s3:// with a custom endpoint in the profile)
echo "$R2_ACCESS_KEY_ID" | secret set s3.r2.access_key_id --domain "*.r2.cloudflarestorage.com"
echo "$R2_SECRET_ACCESS_KEY" | secret set s3.r2.secret_access_key --domain "*.r2.cloudflarestorage.com"
secret set s3.r2.endpoint https://<account>.r2.cloudflarestorage.com --domain "*.r2.cloudflarestorage.com"
mount --source s3://my-r2-bucket/path --profile r2 /mnt/r2

# Adobe da.live — uses the Adobe provider's existing IMS identity
mount --source da://my-org/my-repo /mnt/da

# AEM Helix 6 Source Bus — same identity, api.aem.live instead of admin.da.live
mount --source aem://my-org/my-site /mnt/aem

# Inspect, refresh, unmount
mount list
mount --list                         # same as `mount list`
mount refresh /mnt/r2                # listing-only diff
mount refresh --bodies /mnt/r2       # also revalidates changed bodies
mount unmount --clear-cache /mnt/r2  # drops cache as well
umount /mnt/r2                       # alias for `mount unmount /mnt/r2`
```

### Approval flow

Local mounts surface a one-click approval card; S3 / DA mounts have none. The full gesture-bridge and trust-boundary model is documented in [`docs/approvals.md` — Local mount picker](./approvals.md#local-mount-picker). Local mounts are cone-only because the directory picker requires a real user gesture; S3 / DA mounts work from scoops because their credentials come from the secret store.

---

## serve

Mint a worker-hosted preview URL for a VFS directory, served through the Cloudflare Durable Object tray hub. Plain `serve` serves read-only HTML/assets; `serve --bridge` makes the preview **driveable** — visitor tabs auto-connect as live synthetic-CDP targets the leader can navigate/click/evaluate/screenshot via playwright.

```bash
serve <dir>                           # Read-only preview
serve --ttl 30d <dir>                 # Immutable snapshot, available without the leader
serve --bridge <dir>                  # Driveable preview (opt-in)
serve --bridge --max-tabs 10 <dir>    # Cap concurrent bridge connections (default 20)
serve --bridge --quiet <dir>          # Suppress connect/disconnect licks

`--ttl` accepts positive whole `m`, `h`, `d`, or `w` durations up to exactly `30d`. It
implies `--no-bridge` and cannot be combined with `--bridge` or `--max-tabs`. The snapshot
is limited to 1,000 files, 25 MiB per file, and 50 MiB total. `serve --list` shows each
preview's mode and expiry; `serve --stop` immediately revokes and deletes either mode.
serve --no-bridge <dir>               # Force read-only (wins over everything)
serve --stop <token>                  # Revoke preview + delete auto-provisioned webhook
serve --list                          # List active previews and their tokens
serve --logs [<token>] [--lines <N>]
serve --truncate [<token>]            # Clear records and re-arm first-visit announcement
```

### Flags

- `--bridge` — Make the preview driveable. Visitors auto-connect as synthetic-CDP targets (`preview:<token>:<connId>`); the leader drives them via playwright. Auto-provisions a webhook for page→cone `window.slicc.emit()` events. **Security:** Cross-subdomain cookie risk accepted and documented — host-only cookies isolated, but `Domain=.sliccy.now` cookies readable across previews. Opt-in only per serve; never implied by `allowLive` or Cherry follower attachment.
- `--no-bridge` — Force read-only. Wins over `--bridge` and Cherry-follower default.
- `--max-tabs <N>` — Cap concurrent bridged tabs per preview (default 20). DO rejects bridge upgrades when cap reached; the over-cap tab still loads as a normal (non-driveable) preview and the leader is not told it exists.
- `--quiet` — Suppress the preview's first-visit announcement. Webhook licks the page emits still flow.
- `--stop <token>` — Revoke the preview: closes bridge sockets, rejects new connections, deletes the auto-provisioned webhook.

### Diagnostics

- `serve --logs [<token>] [--lines <N>]` — Print recorded connects and disconnects oldest-to-newest, including timestamps and whether each event was announced or suppressed. The optional exact preview token scopes one preview; `--lines` keeps only the newest N matching entries. This read-only command never emits a lick or wakes the cone. The bounded recorder is leader-memory-only and resets when the leader restarts; the per-preview quiet and announcement latch state does not.
- `serve --truncate [<token>]` — Clear all lifecycle records, or only those for the exact preview token, **and durably re-arm the matching first-visit announcement latch**. The next visit announces once again unless the preview was minted with `--quiet`, including after a leader restart. Output reports both the number of records cleared and announcements re-armed.

## biscotto / biscotti

Hand someone a **revocable guest seat** on this cone. They get a private
`*.sliccy.now` URL with the live transcript and a composer; they are not a
follower and cannot drive the browser, read the filesystem, run commands, or
answer your approval prompts.

```bash
biscotto serve --label "Anna"                       # owner approves each message
biscotto serve --label "Anna" --expires 7d
biscotto serve --label "Anna" --gate-messages cone  # the cone agent decides
biscotto serve --label "Anna" --gate-tools scoop:reviewer
biscotti                                            # list seats
biscotto revoke <id>
```

- `--label` — who the seat is for. Shown on every approval prompt as the
  **authenticated** identity, beside what the guest actually wrote. A guest can
  write anything in their message; they cannot write this.
- `--expires` — `30m`, `12h`, `7d`. Max 30d. Omit and the seat lives as long as
  the tray. Enforced leader-side by a local timer as well as at the door: a
  guest's channel is peer-to-peer, so an expiry only the hub knows about could
  never end a session already in progress.
- `--gate-messages` / `--gate-tools` — who approves: `user` (default), `cone`,
  `agent`, `scoop:<name>`, or `off`. The two are independent; an ungated
  message can still start a gated turn.
- **`agent`** runs a purpose-built approver per request — a bounded agent that
  reads the request and answers allow/deny, and whose RESULT is the verdict. It
  writes nothing, holds only read-only inspection commands, and is driven by
  `/etc/APPROVALS.md`, which you can edit; changes take effect on the next
  decision. Anything it cannot be read as an explicit `allow` — a crash, empty
  output, unparseable JSON, an unknown verdict word — is a denial. Unlike
  `cone` this also works for `--gate-tools`, because the approver is a separate
  run rather than the unit blocked on the tool.
- `--gate-tools cone` is **refused** — for a tool call the cone is the unit
  executing it, so it would be asked to approve something it is blocked on. Use
  `agent` or `scoop:<name>` when you want tool calls decided without you.
- `biscotto revoke` tombstones the token AND closes any live channel. If the
  leader cannot be reached it says so rather than reporting a clean success:
  the seat is dead for new joins, but someone already connected may still hold
  a channel.

**The URL is shown once.** A listing never returns seat tokens.

**What a guest can see.** The whole shared thread, including tool output and
file contents that appear in it. A biscotto URL is therefore read access to
that thread's workspace activity — scope the seat accordingly.

### Visitor page API (bridged previews only)

When `--bridge` is set, the worker injects `/__slicc/preview-bridge.js` into HTML responses. The bootstrap exposes `window.slicc`:

```javascript
window.slicc.emit(name, detail?)  // Fire an attributed Preview Event lick on the leader cone
window.slicc.on(name, callback)   // Subscribe to CustomEvents the agent dispatches
```

- `emit(name, detail?)` → sent over the bridge **WebSocket**, so the tray Durable Object can **attribute** it to the originating tab: the resulting webhook lick carries `x-slicc-preview-conn` / `x-slicc-preview-token` headers (stamped server-side from the socket) and renders as a distinct **Preview Event** tied to `preview:<token>:<connId>` — the same id you drive, and separable from a plain webhook. Falls back to a same-origin `/__slicc/emit` beacon (unattributed) only when the socket isn't open, e.g. during page unload. The `detail` you pass is never mutated; the tab identity rides in the headers.
- `on(name, cb)` → `addEventListener` sugar for `CustomEvent`s the agent dispatches via `Runtime.evaluate`.

Both are no-ops when `--bridge` is absent.

### Security posture

**Opt-in only**: `serve --bridge` explicitly; never implied by `allowLive` or Cherry follower attachment.

**What the leader can do** (honest capability statement): Within the `<token>.sliccy.now` origin, the leader can `Runtime.evaluate` arbitrary JS, read/write the DOM, read `localStorage`/`sessionStorage`, read cookies scoped to that host, dispatch clicks/keys (`Input.*`), navigate, and open URLs. On a shared URL, the agent can observe and manipulate whatever a visitor does on that page. This is a real capability, not "harmless self-XSS."

**Origin confinement + cross-subdomain cookie residual risk (accepted)**: Each preview's unique `<token>.sliccy.now` subdomain isolates **host-only** cookies (the default) per preview. Residual gap: a cookie explicitly set with `Domain=.sliccy.now` is readable across **every** preview subdomain. This **cannot be enforced by a response-header test** — the page runs arbitrary JS and the bridge allows `Runtime.evaluate`, so `document.cookie = "...; Domain=sliccy.now"` can happen at runtime. **Decision (accepted + documented):** the exposure is narrow (host-only cookies already isolated; only apps that deliberately set a parent-domain cookie are affected, and none do today), `--bridge` is opt-in, and the agent authors the served content. Known residual risk; not otherwise mitigated.

**Revocation**: `serve --stop <token>` closes all bridge sockets for that token, rejects new upgrades, and deletes the auto-provisioned webhook.

**Visibility**: The first visit announces once unless `--quiet` is set. Later connects and all disconnects remain silent but are available through `serve --logs`; `serve --truncate` clears the recorder and re-arms that one announcement. The bootstrap may render an optional subtle "live" badge (not a prompt — respects the automatic choice).

---

## usb

WebUSB access from the shell (`packages/webapp/src/shell/supplemental-commands/usb-command.ts`). Opaque device handles (`usb1`, `usb2`, …) back a page-side registry — `USBDevice` objects never cross the worker boundary. A DOM realm (panel terminal / extension shell) talks to `navigator.usb` directly; the kernel worker forwards every op over panel-RPC to the page-side handlers (`usb-backends.ts`). Chromium-only; unavailable in the cloud / hosted-leader float.

The `usb request` chooser requires a real user gesture (see [Gesture bridge](#gesture-bridge-usb--serial--hid) below). All `*-in` transfers hex-dump by default; pass `--raw` to emit raw bytes. Transfers are capped at 4 MiB.

### Subcommands

| Form                                           | Behavior                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `usb list`                                     | List currently-granted devices as `handle  vid:pid  name [open]`.             |
| `usb request [filter flags]`                   | Open the device picker (needs a user gesture); prints the granted handle row. |
| `usb open\|close\|reset <handle>`              | Open, close, or reset a device.                                               |
| `usb select-config <handle> <value>`           | Select a device configuration.                                                |
| `usb claim\|release <handle> <interface>`      | Claim or release an interface.                                                |
| `usb control-in <handle> <length> [setup]`     | Control transfer IN of `<length>` bytes (hex by default, `--raw` for bytes).  |
| `usb control-out <handle> [setup]`             | Control transfer OUT; payload read from stdin.                                |
| `usb transfer-in <handle> <endpoint> <length>` | Bulk/interrupt transfer IN.                                                   |
| `usb transfer-out <handle> <endpoint>`         | Bulk/interrupt transfer OUT; payload read from stdin.                         |

### Flags

| Flag                                             | Applies to                   | Effect                                                     |
| ------------------------------------------------ | ---------------------------- | ---------------------------------------------------------- |
| `--vid 0x..` `--pid 0x..`                        | `request`                    | Filter the picker by vendor / product id (hex or decimal). |
| `--class N` `--subclass N` `--protocol N`        | `request`                    | Filter the picker by USB class codes.                      |
| `--serial S`                                     | `request`                    | Filter the picker by serial number.                        |
| `--request-type standard\|class\|vendor`         | `control-in` / `control-out` | Control setup request type (default `vendor`).             |
| `--recipient device\|interface\|endpoint\|other` | `control-in` / `control-out` | Control setup recipient (default `device`).                |
| `--request N` `--value N` `--index N`            | `control-in` / `control-out` | Control setup packet fields (default `0`).                 |
| `--raw`                                          | `control-in` / `transfer-in` | Emit raw bytes instead of a hex dump.                      |

### Examples

```bash
# Grant + open a device, then read a 64-byte vendor control transfer
usb request --vid 0x2341 --pid 0x0043   # prints e.g. "usb1  0x2341:0x0043  Arduino"
usb open usb1
usb control-in usb1 64 --request-type vendor --request 0x01 --value 0x0200

# Bulk write from stdin, then read back 512 bytes raw
printf '\x01\x02\x03' | usb transfer-out usb1 1
usb transfer-in usb1 0x81 512 --raw > dump.bin

usb close usb1
```

---

## serial

Web Serial access from the shell (`packages/webapp/src/shell/supplemental-commands/serial-command.ts`). Opaque port handles (`serial1`, `serial2`, …) back a page-side registry — `SerialPort` objects never cross the worker boundary. Same DOM-direct / panel-RPC bridge as `usb` (`serial-backends.ts`). Chromium-only; unavailable in the cloud / hosted-leader float.

The `serial request` chooser requires a real user gesture (see [Gesture bridge](#gesture-bridge-usb--serial--hid)). `read` emits raw bytes by default; `--hex` hex-dumps. Reads/writes are capped at 4 MiB.

**Handles are invalidated by re-enumeration.** A board that resets — every
`esptool` flash does this — cycles its USB device, and Chrome hands back a
_new_ `SerialPort` object. `serial list` reconciles on each call: ports that
disappeared are evicted and their handles stop resolving, so a script must
re-read the handle rather than cache `serial1`:

```bash
H=$(serial list | head -1 | cut -f1)
serial open "$H" --baud 115200
```

Opening a handle whose device went away reports that the handle may be stale
and tells you to re-run `serial list`, instead of surfacing the browser's bare
`Failed to open serial port`.

### Subcommands

| Form                                      | Behavior                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `serial list`                             | List currently-granted ports as `handle  vid:pid [open]`.               |
| `serial request [--vid 0x.. --pid 0x..]`  | Open the port picker (needs a user gesture); prints the granted handle. |
| `serial open <handle> [open flags]`       | Open a port with the given line settings.                               |
| `serial close <handle>`                   | Close a port. Idempotent — closing an already-closed port succeeds.     |
| `serial read <handle> [read flags]`       | Read bytes (raw by default, `--hex` to dump).                           |
| `serial write <handle>`                   | Write stdin bytes to the port; prints `<n> bytes written`.              |
| `serial signals <handle> get`             | Print control input signals (`cts dcd dsr ri`).                         |
| `serial signals <handle> set [sig flags]` | Set control output signals.                                             |

### Flags

| Flag                                              | Applies to    | Effect                                              |
| ------------------------------------------------- | ------------- | --------------------------------------------------- |
| `--baud N`                                        | `open`        | Baud rate (default `9600`).                         |
| `--data-bits N` `--stop-bits N`                   | `open`        | Frame data/stop bit counts.                         |
| `--parity none\|even\|odd`                        | `open`        | Parity mode.                                        |
| `--flow-control none\|hardware`                   | `open`        | Flow control mode.                                  |
| `--buffer-size N`                                 | `open`        | Read buffer size.                                   |
| `--bytes N`                                       | `read`        | Stop after N bytes (capped at the 4 MiB limit).     |
| `--until <hex>`                                   | `read`        | Stop once this byte sequence is seen (e.g. `0d0a`). |
| `--timeout-ms N`                                  | `read`        | Stop after N ms (default `1000`).                   |
| `--hex`                                           | `read`        | Hex-dump bytes instead of emitting raw.             |
| `--dtr on\|off` `--rts on\|off` `--break on\|off` | `signals set` | Set the corresponding output signal.                |

### Examples

```bash
# Grant a port, open it at 115200 8N1, send a command, read the reply line
serial request --vid 0x2e8a           # prints e.g. "serial1  0x2e8a:0x0005"
serial open serial1 --baud 115200
printf 'AT\r\n' | serial write serial1
serial read serial1 --until 0d0a --timeout-ms 500 --hex

# Toggle DTR/RTS and inspect input signals
serial signals serial1 set --dtr on --rts off
serial signals serial1 get            # -> cts=1 dcd=0 dsr=1 ri=0
serial close serial1
```

---

## hid

WebHID access from the shell (`packages/webapp/src/shell/supplemental-commands/hid-command.ts`). Opaque device handles (`hid1`, `hid2`, …) back a page-side registry — `HIDDevice` objects never cross the worker boundary. Same DOM-direct / panel-RPC bridge as `usb` (`hid-backends.ts`). Chromium-only; unavailable in the cloud / hosted-leader float.

The `hid request` chooser requires a real user gesture (see [Gesture bridge](#gesture-bridge-usb--serial--hid)). `hid watch` subscribes to a device's input reports over a page→worker event channel (`hid-input-report`), accumulating them as hex lines until SIGINT (Ctrl+C), then printing them. `hid query` is the VIA-style request/response companion: it subscribes, sends one output report (payload from stdin), waits for the first input report (default 1000 ms, override with `--timeout <ms>`), then always unsubscribes — non-zero exit with a clear message on timeout. `feature-get` and `query` hex-dump by default; `--raw` emits bytes. Report payloads are capped at 4 MiB.

**Multi-interface devices.** A single physical HID device can expose several `HIDDevice` interfaces sharing one vid/pid — a VIA/QMK keyboard typically grants a keyboard interface, a consumer-controls interface, and a 0xFF60 raw-HID interface in one chooser pick. `hid request` registers **every** granted interface as a separate handle, and `hid list` / `hid request` print one line per handle with the first collection's `usagePage:usage` column so the right one is selectable. The legacy v1 collapse-by-vid/pid behavior is gone; two physically identical units still share a handle (no serial number to disambiguate).

**Auto-open.** `hid watch`, `hid send`, `hid feature-send`, and `hid feature-get` call `device.open()` automatically if the device is closed — WebHID rejects I/O and never fires `inputreport` on closed devices, so `hid open` is no longer required as a precondition. `hid open` and `hid close` remain available for explicit lifecycle control.

### Subcommands

| Form                                            | Behavior                                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hid list`                                      | List currently-granted devices as `handle  vid:pid  usagePage:usage  name [open]`.                                                                                                                 |
| `hid request [filter flags]`                    | Open the device picker (needs a user gesture); prints one line per granted interface.                                                                                                              |
| `hid open\|close <handle>`                      | Open or close a device (auto-open makes `open` optional for I/O).                                                                                                                                  |
| `hid send <handle> <report-id>`                 | Send an output report; payload read from stdin. Auto-opens.                                                                                                                                        |
| `hid query <handle> <report-id>`                | Send an output report and await one input report (VIA-style request/response). Payload from stdin; hex by default, `--raw` for bytes; `--timeout <ms>` (default 1000) bounds the wait. Auto-opens. |
| `hid feature-send <handle> <report-id>`         | Send a feature report; payload read from stdin. Auto-opens.                                                                                                                                        |
| `hid feature-get <handle> <report-id> <length>` | Receive a feature report (hex by default, `--raw` for bytes). Auto-opens.                                                                                                                          |
| `hid watch <handle>`                            | Stream input reports as hex lines until Ctrl+C. Auto-opens.                                                                                                                                        |

### Flags

| Flag                         | Applies to             | Effect                                                                            |
| ---------------------------- | ---------------------- | --------------------------------------------------------------------------------- |
| `--vid 0x..` `--pid 0x..`    | `request`              | Filter the picker by vendor / product id.                                         |
| `--usage-page N` `--usage N` | `request`              | Filter the picker AND, on output, reorder the matching interface to the top line. |
| `--raw`                      | `feature-get`, `query` | Emit raw bytes instead of a hex dump.                                             |
| `--timeout <ms>`             | `query`                | Bound the wait for the response input report (default 1000 ms).                   |

### Examples

```bash
# Grant a multi-interface keyboard; raw-HID interface is reordered to the top
hid request --vid 0x320f --usage-page 0xff60
#  hid3  0x320f:0x5000  0xff60:0x0061  Nano Pad
#  hid1  0x320f:0x5000  0x0001:0x0006  Nano Pad
#  hid2  0x320f:0x5000  0x000c:0x0001  Nano Pad

# Watch input reports on the raw-HID interface; no prior `hid open` needed
hid watch hid3                        # streams "<reportId> <hex bytes>" lines

# Send an output report and round-trip a feature report (both auto-open)
printf '\x00\xff' | hid send hid3 0
hid feature-get hid3 3 8 --raw > feature.bin

# VIA-style request/response: ask for the protocol version on report id 0
printf '\x01' | hid query hid3 0                # one-line hex reply
printf '\x01' | hid query hid3 0 --timeout 250  # bounded wait, non-zero on miss
hid close hid3
```

### Realm device scripting (event-driven HID from `node -e` / `.jsh`)

Device objects returned by the in-realm `hid.list()` / `hid.request()` globals expose an `EventTarget`-shaped surface so a VIA-style request/response can run as a single script. `addEventListener('inputreport', cb)` lazily subscribes the kernel-side backend (reusing the same `panel-rpc-event` / `subscribeInputReports` relay the panel-terminal `hid watch` uses) and tears it down when the last listener is removed; realm teardown (`rpc.dispose()`) drains any leftovers so the page-side `inputreport` listener can't leak. The top-level `hid` global is unchanged — `.list()` and `.request()` remain the only entry points — and only the returned device objects gained methods.

| Method                                          | Notes                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| `device.addEventListener('inputreport', cb)`    | Lazy backend subscribe on first listener. Event: `{ reportId, data: DataView }`. |
| `device.removeEventListener('inputreport', cb)` | Lazy backend unsubscribe when the listener count hits zero.                      |
| `device.addEventListener('disconnect', cb)`     | Registration accepted; no backend emit today (no navigator-level relay).         |
| `device.onInputReport(cb)`                      | Alias for `addEventListener('inputreport', cb)`.                                 |

```bash
# VIA-style protocol-version round trip as one node script
node -e "
const [device] = await hid.list();
await device.open();
const reply = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 1000);
  device.addEventListener('inputreport', function once(e) {
    clearTimeout(t);
    device.removeEventListener('inputreport', once);
    const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    resolve(bytes);
  });
});
await device.sendReport(0, new Uint8Array([0x01]));
const bytes = await reply;
console.log('reply:', [...bytes].map(b => b.toString(16).padStart(2,'0')).join(' '));
"
```

The same surface is available from `.jsh` scripts (which run in the same realm). The realm-RPC plumbing reuses the existing event channel (`hid-input-report`) — no new transport — so behavior is identical in the standalone (panel + kernel worker) and extension floats. Already-granted handles are required: `hid.request()` from a realm still requires a user gesture, same as the shell `hid request` subcommand.

---

## esptool

Flash ESP32 / ESP8266 chips from the shell via esptool-js (`packages/webapp/src/shell/supplemental-commands/esptool-command.ts`). Layered on the `serial` handle namespace: pass `--port <handle>` to reuse a port from `serial request`, or omit it to open the Web Serial picker. esptool-js loads lazily via dynamic `import()` (CSP-safe). Subcommands mirror the Python esptool CLI. Chromium-only; unavailable in the cloud / hosted-leader float.

Without `--port`, the Web Serial picker opens and requires a real user gesture (see [Gesture bridge](#gesture-bridge-usb--serial--hid)).

### Subcommands

| Form                                         | Behavior                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `esptool chip_id`                            | Detect the chip and print its variant, features, crystal + MAC.        |
| `esptool read_mac`                           | Print the factory MAC address.                                         |
| `esptool flash_id`                           | Print SPI flash manufacturer / device id / detected flash size.        |
| `esptool read_reg <addr>`                    | Print a 32-bit register value at `<addr>` as a zero-padded hex string. |
| `esptool read_flash <addr> <size> <outfile>` | Read `<size>` bytes from `<addr>` and write them to a VFS file.        |
| `esptool erase_flash`                        | Erase the entire flash.                                                |
| `esptool erase_region <addr> <size>`         | Erase a flash region (`<addr>` + `<size>`, 4 KiB-sector aligned).      |
| `esptool write_flash <addr> <file> [...]`    | Flash firmware; takes one or more `<addr> <file>` pairs.               |
| `esptool run`                                | Leave the bootloader and hard-reset into the application.              |

`chip_id` also accepts the aliases `chip_info` and `id`; subcommands accept `-`/`_` interchangeably.

### Flags

| Flag                      | Applies to    | Effect                                               |
| ------------------------- | ------------- | ---------------------------------------------------- |
| `--port H`                | all           | Use an existing serial handle from `serial request`. |
| `--baud N`                | all           | Flash baud rate (default `115200`).                  |
| `--vid 0x..` `--pid 0x..` | all           | Picker filter when `--port` is omitted.              |
| `--erase`                 | `write_flash` | Erase the whole chip before writing.                 |

### Examples

```bash
# Reuse an already-granted serial port
serial request                         # -> serial1
esptool --port serial1 chip_id
esptool --port serial1 read_mac
esptool --port serial1 flash_id

# Inspect a register and dump a slice of flash to a VFS file
esptool --port serial1 read_reg 0x3ff5a000
esptool --port serial1 read_flash 0x1000 0x4000 dump.bin

# Erase just the NVS partition, then run the app
esptool --port serial1 erase_region 0x9000 0x6000
esptool --port serial1 run

# Flash a bootloader + app, erasing first (opens the picker, needs a gesture)
esptool --baud 921600 write_flash --erase 0x1000 bootloader.bin 0x10000 app.bin
```

---

## Gesture bridge (usb / serial / hid)

`usb request`, `serial request`, `hid request`, and `esptool` without `--port` all call a WebUSB / Web Serial / WebHID device picker that the browser only allows from inside a user-gesture handler. The kernel worker has no `window`, so the panel terminal pre-intercepts the keystroke and runs the picker in the page realm, forwarding a rewritten command carrying `--__resolved <handle>`. Picker subcommands therefore do **not** work from an agent `bash` tool call or a scoop with no UI — only from the panel terminal (cone) or an extension popup. Already-granted handles can be operated on from any realm via panel-RPC.

Full gesture-bridge mechanics, extension popup routing, and the shared trust model are documented in [`docs/approvals.md` — usb / serial / hid / esptool](./approvals.md#usb--serial--hid--esptool).

---

## `node` invocation forms

The `node` shim (`shell/supplemental-commands/node-command.ts`) accepts the same argument shapes as real Node:

| Form                      | Program source       | `process.argv`                    |
| ------------------------- | -------------------- | --------------------------------- |
| `node -e CODE [ARGS…]`    | `CODE`               | `['node', ...ARGS]`               |
| `node SCRIPT [ARGS…]`     | VFS file at `SCRIPT` | `['node', <abs SCRIPT>, ...ARGS]` |
| `… \| node`               | piped stdin          | `['node']`                        |
| `node - [ARGS…]`          | stdin                | `['node', '-', ...ARGS]`          |
| `node /dev/stdin [ARGS…]` | stdin                | `['node', '/dev/stdin', ...ARGS]` |

`/dev/fd/0` and `/proc/self/fd/0` are accepted as aliases of `/dev/stdin`. These
device tokens are **not** VFS files — the shim recognizes them before the
script-file lookup, so the heredoc idiom works:

```bash
node /dev/stdin << 'EOF'
const fs = require('fs');
console.log(fs.readdirSync('/workspace').length);
EOF
```

A leading shebang line is stripped in every form. In the stdin forms the script
does **not** see its own source as stdin (`fs.readFileSync(0)` returns empty),
and relative `require('./x')` resolves against the shell's cwd rather than
`/dev`.

`--help` / `-h` / `--version` / `-v` are node's own options only when they
_precede_ the program source. After it they belong to the script, so
`node /dev/stdin --help` runs the heredoc with `--help` in `process.argv`
instead of printing the shim's usage.

---

## .jsh Script Commands

JavaScript shell scripts discovered from the shell's `$PATH` (#2085). Executable like any shell command.

**Discovery**: `jsh-discovery.ts` scans the `$PATH` search roots recursively, in order:

```
Default PATH: /usr/bin:/workspace/skills:/workspace/.mcp/aliases:/workspace/bin:/shared/bin
  /usr/bin              — synthetic registry dir (built-ins + registered commands)
  the remaining entries — .jsh search roots, scanned recursively

Rules: earlier root wins a basename conflict; first basename wins inside a root;
       node_modules/ and dot-dirs below a root never register commands.
```

`/usr`, `/usr/bin`, and `/usr/bin/<command>` are synthesized from the command
registry — they have no VFS entry — so `VfsAdapter` answers for them directly.
All three metadata surfaces agree: `exists`, `stat`, **and `lstat`** (none of
these paths can be a symlink, so `stat` and `lstat` return the same answer).
That last one matters for commands that read metadata without following links —
`du`, `find -type`, `tar`. When `lstat` did not answer, they saw `ENOENT` for
the whole tree, and because `du` reports any error during its walk as
`cannot access '<argument>'`, even `du -sh /` failed once the walk reached
`/usr`.

There is no full-filesystem scan: a `.jsh` outside the roots is not a command
until its directory is added to `PATH` — `export PATH="$PATH:/my/tools"`
interactively (registration completes between submissions) or persistently in
`~/.profile` (live for the shell's very first command). Scoops get their own
workspace roots prepended (`/scoops/<folder>/workspace/{skills,bin}`).

`script-catalog.ts` is the shared lookup layer used by `AlmostBashShell`, `which`, and browser-script matching, with one cache per distinct root set. When an `FsWatcher` is present it caches discovery results and clears them on filesystem changes; a mount only disables caching for root sets it overlaps, because external edits inside File System Access mounts are not observable through the watcher.

**Execution**: Via `jsh-executor.ts` (dual-mode):

- CLI: `AsyncFunction` constructor with Node-like globals
- Extension: Sandbox iframe (CSP-compliant), VFS via postMessage

**Event-loop keep-alive (Node parity).** Real Node does not `await` a CJS
script's return value. After the body finishes it keeps the process alive
while libuv still has ref'd handles — timers (`setTimeout` / `setInterval`)
and I/O (`fs`, `fetch`, sockets, `child_process`). A pending Promise with
no handle (`new Promise(() => {})`) does **not** keep it alive.
`process.exit(N)` skips remaining handles.

SLICC matches that: `.jsh` / `node` wrap the entry in `AsyncFunction` (so
top-level `await` works), then drain outstanding RPC (fs/exec/fetch) and
user timers before `realm-done`. Fire-and-forget `.then()`, unawaited
`main()`, and nested `setTimeout` therefore print before the command
exits. An uncleared `setInterval` or hung I/O hangs until the shell job
is SIGKILL'd, the same way hung I/O hangs real Node.

### Globals API

#### process

```typescript
process.argv: string[]                       // ['node', 'script.jsh', ...args]
process.env: object                          // Environment variables (+ selected-provider API key, see below)
process.cwd(): string                        // Current working directory
process.exit(code?: number)                  // Exit with code (0 default)
process.stdout.write(s)                      // Write to stdout
process.stderr.write(s)                      // Write to stderr
process.stdin.read(): string | null          // Buffered piped stdin; null after EOF or when nothing was piped
process.stdin.isTTY: false                   // Always false in this environment
process.stdin.on(event, cb)                  // EventEmitter surface: 'data' → 'end' → 'close'
process.stdin[Symbol.asyncIterator]()        // Yields the buffered string once
String(process.stdin)                        // Non-consuming view of the buffer
```

#### Provider API key in `process.env`

When the provider steering the cone has a plain API-key account, realm scripts
(`.jsh`, `node -e`, `ipx`) see that key under the env name the provider's own
SDK reads — `AI_GATEWAY_API_KEY` for `vercel-ai-gateway`, `OPENAI_API_KEY` for
`openai`, `GEMINI_API_KEY` for `google`, … (table: `shell/provider-env-seed.ts`,
mirroring pi-ai). Only the _selected_ provider is seeded, only into realms the
cone owns (scoop shells never see it), OAuth access tokens are not seeded (use
`oauth-token <provider>`), and an explicit shell assignment
(`AI_GATEWAY_API_KEY=… fx …`) always wins. The `fx` skill in
[ai-ecoverse/skills](https://github.com/ai-ecoverse/skills) relies on this to
run Vercel's fx agent with zero credential plumbing.

#### stdin (via `process.stdin`)

Stdin from upstream pipelines is buffered **fully and read-ahead** before the script runs — there is **no streaming**. The kernel hands the realm one complete buffer; there is no incremental source, chunks are latin1-preserved **strings** (not `Buffer`s), and an `'error'` event never fires.

`process.stdin` exposes three consumption surfaces that all share a **single one-shot `consumed` flag**. Whichever surface consumes first wins; the others then see EOF. Do not mix them expecting to read the buffer twice.

1. **`read()`** — drains the buffer with Node-like EOF semantics:

   ```typescript
   // echo "a,b,c" | parse-csv
   const data = process.stdin.read(); // 'a,b,c\n'
   const again = process.stdin.read(); // null — buffer was drained
   ```

2. **Events** (`on` / `once` / `addListener` / `off` / `pause` / `resume` / `setEncoding`) — the entire buffer arrives as a **single** `'data'` chunk, then `'end'`, then `'close'`. This is a compatibility shim for copy/pasted Node snippets, **not** real streaming — do not reach for it expecting incremental delivery.

   ```typescript
   // echo "a,b,c" | parse-csv
   let s = '';
   process.stdin.on('data', (d) => (s += d)).on('end', () => console.log(s));
   ```

   `pause()` suppresses that emission — the buffer stays intact until `resume()` re-arms it (or another surface drains it), and `process.exit(N)` called from a `'data'`/`'end'`/`'close'` handler exits the script with code `N`.

3. **Async iteration** — yields the buffered string once:

   ```typescript
   let total = '';
   for await (const chunk of process.stdin) total += chunk;
   ```

Because the `consumed` flag is shared, once any surface has drained the buffer the others see EOF: `read()` returns `null` and the events surface emits `'end'` only (no `'data'`). If no input is piped, `read()` returns `null` immediately (Node parity — never `''`), and the events surface emits `'end'` with no `'data'`.

For a non-consuming view, use `String(process.stdin)` or `process.stdin.toString()`.

Stdin is intentionally NOT exposed as a top-level identifier — user scripts are free to declare their own `const stdin = …` without colliding with the runtime.

Two more Node stdin idioms are served on top of the same buffer:

- **`fs` stdio fds and device paths** — `fs.readFileSync(0)` / `fs.readFile(0)` / `'/dev/stdin'` return the full buffered stdin (encoding-aware; does NOT consume `process.stdin`'s one-shot flag). Writes to fd `1`/`2` or `/dev/stdout`/`/dev/stderr` (`writeFileSync`, `appendFileSync`, async `writeFile`/`appendFile`) land on stdout/stderr, and `existsSync`/`accessSync`/`statSync` report the three stream devices as present (`isFile()` true, `isCharacterDevice()` true, size 0). Wrong-direction stream ops and unknown numeric fds throw `EBADF`.
- **`require('readline')` / `require('readline/promises')`** — `createInterface({ input: process.stdin })` (optionally with `output`, `terminal`) reads the buffered input line-by-line: `'line'`/`'close'` events, `for await (const line of rl)`, and `question(query[, cb])` (Promise form without a callback) answering with the next unconsumed line (`''` at EOF). Creating the interface drains `process.stdin` (Node flowing-mode parity); a final unterminated line is still emitted and CRLF is stripped.

#### console

```typescript
console.log(...args); // stdout (space-separated)
console.info(...args); // stdout
console.warn(...args); // stderr
console.error(...args); // stderr
```

#### fs (VirtualFS bridge)

All paths are resolved relative to `process.cwd()`.

```typescript
fs.readFile(path): Promise<string>
fs.readFileBinary(path): Promise<Uint8Array>
fs.writeFile(path, content: string): Promise<void>
fs.writeFileBinary(path, bytes: Uint8Array): Promise<void>
fs.readDir(path): Promise<string[]>
fs.exists(path): Promise<boolean>
fs.stat(path): Promise<{ isDirectory, isFile, size }>
fs.mkdir(path): Promise<void>
fs.rm(path): Promise<void> // Recursive delete
fs.fetchToFile(url, path): Promise<number> // Download and save, returns byte count
```

#### exec (shell command bridge)

Run any shell command through just-bash and get the result. Works in both CLI and extension mode.

```typescript
exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>
exec.spawn(argv: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>
exec.start(commandOrArgv: string | string[], opts?: {
  stdin?: string; stdinKind?: 'text' | 'bytes'; args?: string[];
}): { kill(sig?: string): Promise<boolean>; stdin: { write(chunk: string): void; end(): void }; done: Promise<{ stdout; stderr; exitCode }> }

// Example: get an OAuth token
const r = await exec('oauth-token adobe');
const token = r.stdout.trim();

// Example: list files
const ls = await exec('ls -la /workspace');
console.log(ls.stdout);

// Example: shell-free argv form (no shell parsing — safe for untrusted args)
await exec.spawn(['git', 'commit', '-m', userMessage]);
```

**`exec.start` — killable, buffered-stdin spawn handle.** `exec.start` returns
immediately with a handle instead of a promise. Buffer input with
`stdin.write(chunk)`, launch the command with `stdin.end()`, and `await done`
for the `{ stdout, stderr, exitCode }` result. `kill(signal?)` fans a signal
out to the in-flight command via the `exec:kill` op. This is the substrate the
realm `require('child_process')` polyfill is built on. It is **not**
interactive or streaming: just-bash is one-shot buffered, so `stdin` is a
single upfront buffer (post-launch `stdin.write` calls are dropped) and the
result arrives only when the command completes.

```typescript
const h = exec.start(['jq', '.name']);
h.stdin.write('{"name":"slicc"}');
h.stdin.end();
const { stdout } = await h.done;
// h.kill('SIGTERM'); // abort an in-flight command
```

`require('child_process')` / `require('node:child_process')` (`.jsh` / `node`
realm) resolves to a shim over `exec.start`: `exec` / `execFile` / `spawn`
return a `ChildProcess` EventEmitter (`'exit'` / `'close'`, Readable
`.stdout` / `.stderr`); `exec` / `execFile` carry `util.promisify.custom`. The
sync forms (`execSync` / `execFileSync` / `spawnSync`) run on the blocking
sync-XHR bridge and follow Node's return/throw contracts; they need a
controlling Service Worker, so on a float without one they throw an error
naming the async escape hatch. `fork` always throws — no long-lived process
model. `.bsh` scripts run in the target page (no shell bridge), so
`child_process` is unavailable there.

#### require / module / exports

Scripts can import npm packages via `require('package-name')`. This fetches from esm.sh CDN and caches for the session. Version pinning is supported: `require('lodash@4')`.

```typescript
const _ = require('lodash');
const { marked } = require('marked');
const chalk = require('chalk@5');
module.exports: {}        // Available for ES module pattern
exports: module.exports   // Alias
```

### jsh runtime extensions

> Companion file for in-VFS agents: `packages/vfs-root/workspace/skills/skill-authoring/jsh-runtime-extensions.md`. Keep both in sync when the API changes.

The following globals were added in PR #786 and are available in the jsh realm in both standalone and extension floats. They were extracted from cross-skill duplication analysis (see the workspace spec at `analyze-skills`); skills SHOULD prefer them over hand-rolled equivalents. Test availability with `node -e "console.log(typeof process.argv.parseFlags, typeof browser, typeof http, typeof skill)"`.

#### `process.argv.parseFlags()`

Replaces the per-skill `--flag=val` / `--flag val` / positional parsing loop reinvented in every surveyed skill.

```typescript
process.argv.parseFlags(): {
  positional: string[];   // non-flag args
  flags: Record<string, string | boolean>;
  subcommand: string | null; // first positional, if it looks like a subcommand
}
```

```javascript
// Today (every skill, ~25 LoC):
for (let i = 1; i < args.length; i++) {
  /* …--flag=val / --flag val / positional… */
}

// Proposed:
const { positional, flags, subcommand } = process.argv.parseFlags();
```

#### `browser` global

Replaces the `exec('playwright-cli tab-list')` shell-out + regex parse used in ~12 skills.

```typescript
browser.findTab(opts: { domain?: string; urlMatch?: RegExp | string }): Promise<TabHandle | null>
browser.ensureTab(url: string): Promise<TabHandle>            // open if missing
browser.eval(tab, fn: Function | string): Promise<unknown>    // sync expression
browser.evalAsync(tab, fn: AsyncFunction): Promise<unknown>   // async, returns parsed JSON
browser.cookie(tab, name: string): Promise<string | null>
browser.localStorage(tab, key: string): Promise<string | null>
```

The page-context bridge is owned by the runtime — skills never author eval-file temp files or parse double-encoded JSON.

#### `browser.websocket` — declarative WebSocket observer

Sanctioned replacement for the `WebSocket.prototype.send` monkey-patches that
Tessl/Snyk flagged in `slack.jsh`. Skill code never patches a third-party
page's prototype, never sees the full inbound frame firehose, and cannot
supply an arbitrary URL to forward to.

```typescript
const sub = await browser.websocket
  .on(tab, { urlMatch: /wss-primary\.slack\.com/ })
  .filter({ parseAs: 'json', where: { type: 'message', channel: 'C0899S7HV0E' } })
  .forward({ sink: 'webhook', webhookId: 'slack-watch-abc123' });

await sub.update({ filter: { where: { channel: 'C-new' } } });
await sub.close();
await browser.websocket.list();
```

**Security review notes (Wave 4.1):**

- The page-side router (`__sliccWsRouter`) is a single static, runtime-owned
  script. It patches `WebSocket.prototype.send` **at most once per tab** —
  `installWsRouter()` is idempotent. Skills cannot supply page-context code;
  the router source lives in `packages/webapp/src/kernel/realm/ws-router-page.ts`.
- The `filter` selector is a declarative JSON object (`parseAs`, `where`,
  `project`). The realm builder rejects a `Function` or string of JS at the
  boundary, so a compromised skill cannot smuggle code into the runtime via
  the filter slot.
- The runtime forwards matched frames to one of four sanctioned sinks:
  - `'webhook'` — resolved against the existing `webhook` registry; an
    unknown `webhookId` rejects at `subscriber-creation time`.
  - `'scoop'` — delivered via `orchestrator.dispatchToScoop`.
  - `'vfs'` — appended to an absolute path that must start with
    `/workspace/`.
  - `'log'` — telemetry only.
- Outbound (`WebSocket.prototype.send`) interception is **out of scope** —
  `send` is hooked only as a discovery mechanism so the inbound `message`
  listener can be attached.
- Subscribers owned by a scoop are auto-closed when the scoop is dropped
  (`Orchestrator.unregisterScoop` → `WsSubscriberRegistry.dropForScoop`).

**Sink set is a closed enum.** Skills cannot supply an arbitrary URL — the page-side router (runtime-owned, audited once) only knows how to forward matched frames to: a registered `webhook` ID, an in-process `scoop`, an allowlisted VFS `path`, or `log`. There is no way for skill code to monkey-patch `WebSocket.prototype` or author the page-context router.

```javascript
// Before (~90 LoC of injected, string-built JS; flagged for prototype hijacking + exfil):
const interceptorCode = `(async () => { WebSocket.prototype.send = function(data) { /* … */ }; })()`;
await fs.writeFile(tmpFile, interceptorCode);
await exec(`playwright-cli eval-file ${tmpFile} --tab=${tabId}`);

// After (~10 LoC, no page-authored JS, audited sinks):
const sub = await browser.websocket
  .on(tab, { urlMatch: /wss-primary\.slack\.com/ })
  .filter({ parseAs: 'json', where: { type: 'message', channel: 'C0899S7HV0E' } })
  .forward({ sink: 'webhook', webhookId: 'slack-watch-abc123' });
```

#### `browser.fetch(tab, url, opts)`

Replaces the eval-file + base64 + double-JSON-unwrap pattern in ~9 skills (slack, linkedin, concur, suno, fluffyjaws, servicenow, apple-music, oryx, outlook).

```typescript
browser.fetch(tab: TabHandle, url: string, opts?: {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | ...;
  headers?: Record<string, string>;
  body?: unknown;                  // object → JSON-stringified
  credentials?: 'include' | 'omit'; // defaults to 'include'
  responseType?: 'text' | 'json' | 'binary';
  timeoutMs?: number;               // page-side AbortSignal.timeout()
}): Promise<{
  ok: boolean; status: number; statusText: string;
  url: string;                      // final URL after redirects
  redirected: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyEncoding?: 'base64';          // set for a binary body
}>
```

Runs inside the tab's origin, so session cookies and same-origin headers are automatic. Response body is JSON-parsed when content-type permits. From the shell, [`curlwright`](#curlwright) is the same capability with curl's flags.

#### `http.client({ baseUrl, token, headers, retry, timeoutMs })`

Standard API-client builder for the jsh realm. `token` is lazy (resolved freshly per request); `Retry-After` (seconds or HTTP date) takes precedence over exponential backoff.

```typescript
http.client(config: {
  baseUrl?: string;
  token?: (req?: { method: string; path: string; url: string }) =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
  headers?: Record<string, string>;
  retry?: { on: number[]; maxAttempts: number };
  timeoutMs?: number;
}): {
  get(path, opts?):    Promise<unknown>;
  post(path, opts?):   Promise<unknown>;
  put(path, opts?):    Promise<unknown>;
  patch(path, opts?):  Promise<unknown>;
  delete(path, opts?): Promise<unknown>;
}
// opts: { params?, headers?, body?, signal?: AbortSignal, raw?: boolean }
//  - body object → JSON, params → querystring
//  - raw: when true, returns { body, headers, status } instead of just body
```

### Example .jsh Script

```javascript
// /workspace/skills/my-tool/process-csv.jsh
const args = process.argv.slice(2);

if (args.length < 1) {
  console.error('Usage: process-csv <input.csv>');
  process.exit(1);
}

const inputFile = args[0];
const outputFile = args[1] || inputFile.replace(/\.csv$/, '.json');

(async () => {
  try {
    const csv = await fs.readFile(inputFile);
    const lines = csv.split('\n').filter((l) => l.trim());
    const header = lines[0].split(',').map((s) => s.trim());

    const rows = lines.slice(1).map((line) => {
      const values = line.split(',').map((s) => s.trim());
      return Object.fromEntries(header.map((h, i) => [h, values[i]]));
    });

    const json = JSON.stringify(rows, null, 2);
    await fs.writeFile(outputFile, json);

    console.log(`Converted: ${inputFile} → ${outputFile}`);
    console.log(`Records: ${rows.length}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
```

**Usage**:

```bash
# Call by basename (from any directory)
process-csv input.csv output.json
```

### Error Handling

```javascript
try {
  const data = await fs.readFile('/nonexistent.json');
} catch (err) {
  // err.message: "ENOENT: /nonexistent.json not found"
  console.error(err.message);
  process.exit(1);
}
```

---

## Argument Parsing

Shell arguments support quotes, escapes, and whitespace.

**Parser**: `parse-shell-args.ts`

### Rules

| Pattern         | Result                              |
| --------------- | ----------------------------------- |
| `word`          | Single word token                   |
| `"hello world"` | Single token: `hello world`         |
| `'hello world'` | Single token: `hello world`         |
| `hello\ world`  | Single token: `hello world`         |
| `a "b c" d`     | Three tokens: `a`, `b c`, `d`       |
| `"a\"b"`        | Single token: `a"b` (escaped quote) |

### Examples

```bash
# Multiple words in quotes
node -e "console.log('Hello, World')"
# Parsed as: ['node', '-e', "console.log('Hello, World')"]

# Path with spaces
open "/path/to/my file.html"
# Parsed as: ['open', '/path/to/my file.html']

# Escaped characters
echo "Line 1\nLine 2"
# Parsed as: ['echo', 'Line 1\nLine 2']
```

---

## Command Discovery

### Priority Roots

Scan order (first wins):

1. `/workspace/skills/` — Skill scripts, highest priority
2. `/` — Full filesystem walk

### Basename Rule

When multiple `.jsh` files have the same basename:

```
/workspace/skills/my-skill/build.jsh     ← Chosen
/tools/scripts/build.jsh                 ← Ignored (same basename)
```

First occurrence by priority root wins.

### Dynamic Registration

The `commands` command lists all available commands:

```bash
$ commands
Available commands:
  Built-in: ls, cat, grep, find, sed, awk, head, tail, ...
  Custom: convert, sqlite3, webhook, crontask, ...
  Scripts: process-csv, backup-db, deploy-site, ...
```

The agent can dynamically discover new scripts via `commands`, then invoke them by name.

---

## Sprinkle & Dip Bridge

`.shtml` sprinkles (and trusted dips) talk to SLICC through a `slicc.*` bridge object injected into their sandboxed iframe — usable from `<script>` tags and `onclick` attributes. Beyond lick events and the read-only VFS helpers, the bridge exposes the same Tier 1 jsh runtime globals that `.jsh` scripts use. Every call routes through the **same worker shell** `.jsh` / `node -e` runs in, so a sprinkle reaches the full supplemental-command surface and any `.jsh` script on the VFS.

**Files**: `packages/webapp/src/ui/sprinkle-bridge.ts` (sprinkles), `packages/webapp/src/ui/dip.ts` (dips). In the thin extension these run in the hosted leader tab / `?cherry=1` follower on the `sliccy.ai` origin, not an extension sandbox.

### Shell & agent surface

| Method                       | Returns                               | Notes                                                                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slicc.exec(cmd)`            | `Promise<{stdout, stderr, exitCode}>` | Runs `cmd` in the worker shell. A non-zero `exitCode` — or `127` when no shell bridge is wired — is returned in the result, never thrown.                                                                                                                           |
| `slicc.exec.spawn(argv)`     | `Promise<{stdout, stderr, exitCode}>` | Array-form exec that bypasses shell parsing (safer for untrusted args).                                                                                                                                                                                             |
| `slicc.agent(prompt, opts?)` | `Promise<{stdout, exitCode}>`         | Spawns a one-shot sub-scoop, blocks until it completes, resolves with its final message on `stdout`. `opts`: `{cwd, allowedCommands, model, thinking, readOnly}`. Sugar over `slicc.exec` building the `agent` command. Errors come back on `stdout`, never thrown. |

### Tier 1 jsh globals

These mirror the `.jsh` runtime globals (see `jsh-runtime-extensions.md` in the skill-authoring skill). Each routes through one round-trip into the worker realm.

| Method                                                              | Returns                                                                                                                                       | Notes                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `slicc.fetch(url, init?)`                                           | `Promise<Response>` (a real `Response` — `.ok`/`.status`/`.statusText`/`.url`/`.headers` plus `.json()`/`.text()`/`.arrayBuffer()`/`.blob()`) | Proxied, secret-injecting fetch — **not** the iframe's CORS-bound native `fetch`.                                            |
| `slicc.http.client(config)`                                         | client with `get`/`post`/`put`/`patch`/`delete`                                                                                               | Higher-level API client over the proxied fetch. `config`: `{baseUrl, token, headers, retry, timeoutMs}`.                     |
| `slicc.browser.*`                                                   | `Promise<unknown>`                                                                                                                            | Playwright-style CDP surface (`findTab`, `ensureTab`, `eval`, `evalAsync`, `cookie`, `localStorage`, `fetch`). Trusted-only. |
| `slicc.fetchToFile(url, path)`                                      | `Promise<number>`                                                                                                                             | Download a URL (via the proxied fetch) straight to a VFS file; resolves with the byte count.                                 |
| `slicc.readFileBinary(path)` / `slicc.writeFileBinary(path, bytes)` | `Promise<Uint8Array>` / `Promise<void>`                                                                                                       | Binary VFS I/O (parity with the jsh `fs` global).                                                                            |

### Stateful device surface

Sprinkles (and trusted dips) get a `slicc.hid` / `slicc.serial` / `slicc.usb` surface that talks page-direct to the same shared device registries the worker reaches over panel-RPC. Handles created via the `hid` / `serial` / `usb` shell commands are visible here and vice versa.

For HID, `open(handle)` automatically attaches an `inputreport` listener on the host; reports arrive over the existing host→iframe push channel as `dip-device-event` / `sprinkle-device-event` postMessages. `close(handle)` (or sprinkle / dip teardown) drops the subscription so the host doesn't leak listeners.

```js
const [info] = await slicc.hid.list();
await slicc.hid.open(info.handle);
slicc.hid.on('inputreport', ({ handle, reportId, data }) => {
  console.log('got', reportId, Array.from(data));
});
await slicc.hid.sendReport(info.handle, 0, new Uint8Array([0x01, 0x02]));
```

| Method                                                   | Returns                       | Notes                                                                                            |
| -------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `slicc.hid.list()`                                       | `Promise<HidDeviceInfo[]>`    | Already-granted devices; no picker.                                                              |
| `slicc.hid.request(filters?)`                            | `Promise<HidDeviceInfo[]>`    | Shows the WebHID picker; every granted interface of a multi-interface device is registered.      |
| `slicc.hid.open(handle)` / `slicc.hid.close(handle)`     | `Promise<void>`               | `open` auto-attaches the host's input-report listener; `close` (or sprinkle close) detaches it.  |
| `slicc.hid.sendReport(handle, reportId, data)`           | `Promise<void>`               | `data` is `Uint8Array`.                                                                          |
| `slicc.hid.on('inputreport', cb)` / `slicc.hid.off(...)` | `void`                        | `cb({handle, reportId, data})` — `data` is a `Uint8Array`. Subscriptions are torn down on close. |
| `slicc.serial.list()` / `slicc.serial.request(filters?)` | `Promise<SerialDeviceInfo[]>` | Already-granted vs. picker; parity with `hid`.                                                   |
| `slicc.serial.open(handle, options)` / `serial.close(h)` | `Promise<void>`               | `options` mirrors the Web Serial open shape (`baudRate`, `dataBits`, …).                         |
| `slicc.usb.list()` / `slicc.usb.request(filters?)`       | `Promise<UsbDeviceInfo[]>`    | Already-granted vs. picker; parity with `hid`.                                                   |
| `slicc.usb.open(handle)` / `slicc.usb.close(handle)`     | `Promise<void>`               | Control / bulk transfers stay on the realm-side `usb` global for v1.                             |

Untrusted inline-chat dips (fenced ` ```shtml ` blocks emitted by the agent) NEVER receive `slicc.hid` / `serial` / `usb`. Any spoofed request from such an iframe is rejected with `device access not allowed for this dip` before it reaches the registry.

### Trust boundary

- **Sprinkles** are sourced from the VFS (under `/shared/sprinkles/`, `/workspace/sprinkles/`, etc.) and always get the full bridge.
- **Trusted dips** — `.shtml` loaded from an image reference under a known sprinkles directory — get `exec`/`agent` and the Tier 1 jsh globals too.
- **Untrusted inline-chat dips** (fenced ` ```shtml ` blocks emitted by the agent) NEVER receive `exec`/`agent`/`browser`, the other realm-backed globals, or the `hid` / `serial` / `usb` device surface, so an attacker-controlled cone reply can't spawn shell commands, scoops, or reach a connected device. `slicc.browser` and `slicc.{hid,serial,usb}` are trusted-only by construction.

---

## Binary Handling

SLICC's shell supports binary data (images, PDFs, archives) via careful encoding.

**Binary cache**: `binary-cache.ts`

### Flow

1. **VFS read**: `fs.readFileBinary(path)` returns `Uint8Array`
2. **just-bash limitations**: Bash strings are Unicode; binary data must be encoded
3. **Latin-1 encoding**: Binary bytes preserved via `String.fromCharCode(byte)` mapping
4. **VFS write**: `fs.writeFile(path, encodedString)` is detected as binary (stored in cache) and decoded back to `Uint8Array`

### API

```typescript
// Read binary
const bytes: Uint8Array = await fs.readFileBinary('/image.png');

// Write binary
const newBytes = new Uint8Array([0xFF, 0xD8, ...]);
await fs.writeFile('/output.jpg', newBytes);
```

### Tools Supporting Binary

- **playwright-cli**: `screenshot --filename=<path>` saves PNGs directly to the VFS
- **node** / **.jsh**: `fs.readFileBinary()`, `fs.writeFileBinary()` available
- **bash**: Limited binary support (command output truncated at 100KB)

---

## Proxied Fetch

Network requests are proxied to handle CORS and cross-origin restrictions.

### Request Bodies

`SecureFetch` carries a `body: string`, so every non-text payload rides the
**latin1 convention** (one character per byte) and `prepareRequestBody` decodes
it back to raw bytes whenever the Content-Type is not text-shaped. Both the
`.jsh` `fetch` global and the kernel realm's `fetch` RPC accept:

| Body                                       | Wire form        | Default `Content-Type` (caller always wins)            |
| ------------------------------------------ | ---------------- | ------------------------------------------------------ |
| `string`                                   | verbatim         | none                                                   |
| `URLSearchParams`                          | `toString()`     | `application/x-www-form-urlencoded;charset=UTF-8`      |
| `Uint8Array` / `ArrayBuffer` / typed array | latin1           | `application/octet-stream`                             |
| `Blob` / `File`                            | latin1           | the blob's own `type`, else `application/octet-stream` |
| `FormData`                                 | latin1 multipart | `multipart/form-data; boundary=<token>`                |
| `ReadableStream`                           | —                | rejected; collect it into a `Uint8Array` first         |

The defaults above hold on **both** paths. The realm's `serializeRequestInit`
has to decide them itself rather than leaning on the host adapter: everything
crosses the RPC boundary as a string, so by the time the adapter sees the body
it can no longer tell a `URLSearchParams` from a `text/plain` payload. A
`GET`/`HEAD` request drops the body on both paths and advertises no
Content-Type for it.

`multipart/form-data` is serialized by `webapp/src/base/multipart-form-data.ts`
— the single encoder, also used by the DA mount backend. **The boundary token
is minted in the same call that lays down the delimiters** and returned as a
ready-made Content-Type; never generate one separately, because a header that
disagrees with the body makes the request unparseable server-side. Field names
and filenames are escaped per the WHATWG algorithm (`"` / CR / LF → `%22` /
`%0D` / `%0A`), so a crafted name cannot forge a part header.

`browser.fetch` takes the same shapes but rebuilds a real `FormData` in the
page instead, letting the page's own `fetch` set the boundary.

### CLI Mode

Express server provides `/api/fetch-proxy`:

```bash
curl -X POST /api/fetch-proxy \
  -H "X-Target-URL: https://api.example.com/data" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

All `fetch()` and `curl` calls route through proxy (CLI: `/api/fetch-proxy`, extension: `fetch-proxy.fetch` SW Port handler). Both modes now provide full secret-injection coverage.

**Download size ceiling.** The `SecureFetch` contract hands just-bash a complete `Uint8Array`, and the VFS keeps its own copy in the vnode cache until the write syncs, so one download costs a small multiple of its size in renderer RAM. `proxied-fetch.ts` therefore refuses bodies over 512 MiB (`setResponseBodyCap` to tune) with a clear `exceeds the … download limit` error — checked against the `Content-Length` / `X-Proxy-Content-Length` hint before any allocation, and again as the bytes stream in on every realm branch (CLI `/api/fetch-proxy`, extension Port, thin-bridge delegate, kernel-worker panel-RPC). Bodies over 32 MiB are not parked in `binary-cache`. just-bash's own `curl` is patched (`patches/just-bash+3.4.2.patch`) so `curl -o`/`-O` no longer latin1-stringifies the whole body for a stdout it never prints — in the browser that string cost ~32 bytes of V8 heap per downloaded byte and was what crashed the leader tab on a ~250 MB download.

Browsers strip `Origin`, `Referer`, `Cookie`, and `Proxy-*` from page-context `fetch()` calls, so the proxy restores them via an `X-Proxy-*` transport and synthesizes a default `Origin` from the target URL when no caller value survives. In CLI mode the Express handler decodes the headers and Node `fetch()` carries them through; in the extension SW, decoding alone is not sufficient because Chrome strips/rewrites forbidden headers regardless of the init dict, so the SW additionally installs a per-request `chrome.declarativeNetRequest` session rule (keyed to a unique URL fragment) that rewrites them on egress. Override with `curl -H "Origin: ..."` (or pass an `Origin` header to any `SecureFetch`-backed call). See [Origin Contract: Forbidden Headers & Default-Origin Fallback](./pitfalls.md#origin-contract-forbidden-headers--default-origin-fallback) in `docs/pitfalls.md` for the full contract.

### Extension Mode

Extension mode routes through the service worker `fetch-proxy.fetch` Port handler. The handler unmasks secrets at the network boundary and uses `host_permissions` for CORS bypass:

```json
"host_permissions": [
  "https://*/*",
  "http://*/*"
]
```

### Behavior

| Runtime           | Fetch Type         | Route                     |
| ----------------- | ------------------ | ------------------------- |
| CLI Node          | Any                | `/api/fetch-proxy`        |
| CLI browser page  | Anthropic API      | Direct (whitelist)        |
| CLI browser page  | Other cross-origin | `/api/fetch-proxy`        |
| Extension         | Anthropic API      | Direct (whitelist)        |
| Extension         | Other              | Direct (host_permissions) |
| Extension sandbox | Any                | postMessage to parent     |

---

## Common Patterns

### Chain Commands

```bash
cat input.txt | grep "pattern" | sort | uniq
```

### Conditional Execution

```bash
mkdir -p output && cp file.txt output/ || echo "Failed"
```

### Variable Expansion

```bash
MYVAR="hello"
echo $MYVAR
```

### Function Definition

```bash
greet() {
  echo "Hello, $1"
}
greet "World"
```

### Here Document

```bash
cat > file.txt << EOF
Line 1
Line 2
EOF
```

### Command Substitution

```bash
DATE=$(date)
echo "Today is $DATE"
```

---

## Performance

- **Command startup**: <100ms (just-bash initialization)
- **Script execution**: O(script complexity), typically <500ms
- **File I/O**: IndexedDB operations, <100ms per file
- **Binary operations**: LightningFS encoding/decoding, <50ms for typical images

For large-scale processing (1000+ files), batch operations and `.jsh` scripts are faster than shell loops.

---

## CDN-backed require()

`node -e`, `.jsh`, and `.bsh` scripts can import npm packages at runtime via `require()`:

```js
const _ = require('lodash');
const { marked } = require('marked');
const chalk = require('chalk@5');
```

Packages are fetched from [esm.sh](https://esm.sh) and cached for the session. Version pinning via `@version` syntax is supported.

**Note:** require() is synchronous. Modules referenced with string literals are automatically pre-fetched before script execution. For dynamic specifiers, use `await import('https://esm.sh/' + name)` directly.

### Node Built-in Modules

Some Node.js built-in modules are available via `require()`:

| Module                                           | Status                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `fs`                                             | ✅ VFS bridge (readFile, writeFile, readDir, exists, stat, mkdir, rm)                                                      |
| `process`                                        | ✅ Shim (argv, env, cwd, exit, stdout, stderr)                                                                             |
| `buffer`                                         | ✅ Browser polyfill                                                                                                        |
| `path`                                           | ✅ Via esm.sh (browser polyfill)                                                                                           |
| `url`, `querystring`, `util`, `events`, `assert` | ✅ Via esm.sh                                                                                                              |
| `child_process`                                  | ✅ Realm shim over the `exec.start` bridge (`exec`/`execFile`/`spawn`); sync forms over the sync-XHR bridge; `fork` throws |
| `http`, `https`, `crypto`, `net`, etc.           | ❌ Not available in browser                                                                                                |

The `node:` prefix is supported: `require('node:path')` works the same as `require('path')`.

---

## Limitations

- **Binary output in bash**: Commands producing binary output are limited to 100KB (just-bash constraint)
- **Symlinks**: Not supported by LightningFS
- **Large files**: Reading >100MB files in bash is slow; use `node -e` or `.jsh` scripts instead
- **Network timeout**: curl/fetch timeout at 30 seconds (default)

---

## Dual-Mode Notes

### CLI Mode

- Full bash capabilities
- Shell state persisted across commands
- `node -e` uses `AsyncFunction` constructor
- Fetch requests routed through Express `/api/fetch-proxy`

### Extension Mode

- Full bash capabilities (same as CLI)
- Shell state persisted across commands
- `node -e` and `.jsh` scripts run in sandbox iframe (CSP-compliant)
- Fetch requests via `host_permissions` (no proxy needed)

Both modes share the same VirtualFS and command interface.

---

## Useful Commands

```bash
# Find files
find /workspace -name "*.js" -type f

# Search text
rg "TODO" /src --type js

# Process JSON
curl https://api.example.com/data | jq '.items[] | select(.status == "active")'

# Probe a WebSocket echo server (send one message, receive one, exit)
echo hello | websocat -1 wss://ws.vi-server.org/mirror

# Drive a Chrome DevTools target via JSON-RPC over WebSocket
echo 'Page.navigate {"url":"https://example.com"}' \
  | websocat -1 --jsonrpc --jsonrpc-omit-jsonrpc \
      ws://127.0.0.1:9222/devtools/page/<id>

# Batch rename
for file in *.txt; do mv "$file" "${file%.txt}.md"; done

# ZIP archive
zip -r backup.zip /workspace -x "*.node_modules/*" "*.git/*"

# Git workflow
git status
git add .
git commit -m "Feature: add new tool"
git push origin main

# Python data processing
python3 -c "
import json
data = json.load(open('data.json'))
result = [x for x in data if x['count'] > 10]
print(json.dumps(result, indent=2))
"

# Node scripting
node -e "
const fs = require('fs');
const files = fs.readdirSync('.');
console.log(files);
"

# Schedule a task
crontask add "cleanup" "0 3 * * 0" cleaner-scoop "Remove old files from /tmp"

# List configured secrets (names + domains, never values)
secret list

# Check if a secret would be injected for a URL
secret test GITHUB_TOKEN https://api.github.com/repos/foo/bar

# Set a session secret with the literal value as an argument (in-memory only, no prompt)
secret set OPENAI_KEY sk-proj-... --domain "api.openai.com"

# Set a session secret from stdin — value never appears in argv / transcript
echo "$TOKEN" | secret set GITHUB_TOKEN --domain "api.github.com"

# Persist a secret (raises a sudo prompt; --domain is required)
secret set GITHUB_TOKEN ghp_... --domain "api.github.com" --persist

# Explicitly request approval to run a sensitive command
sudo git push origin main
```

---

## `slicc --cloud` CLI

Laptop-side orchestration of cloud SLICC sandboxes via e2b.dev. Mutually exclusive with `--hosted`.

### Subcommands

- **`start [--name <label>] [--env-file <path>] [--substrate <id>]`** — create a sandbox, upload secrets, wait for join URL. Prints the tray join URL once the leader is ready.
- **`list`** — show all known cloud sessions (registry + live state from e2b).
- **`pause <sandboxId|name>`** — pause the sandbox; state preserved on e2b storage. The sandbox can be resumed later from the same state.
- **`resume <sandboxId|name>`** — resume a paused sandbox; kicks `/api/leader-restart`, polls for refreshed join URL. Returns the new join URL.
- **`kill <sandboxId|name>`** — destroy the sandbox; remove from registry. Irreversible.

### Registry

Cloud session state lives in `~/.slicc/cloud-sessions.json`. Each entry maps a sandbox ID to its name, substrate, creation time, and last known join URL.

### Secrets

`--cloud start` reads from `~/.slicc/secrets.env` (or the path specified via `--env-file`) and uploads it to `/slicc/secrets.env` inside the sandbox. `E2B_API_KEY` and `E2B_API_KEY_DOMAINS` are stripped before upload so the cloud agent cannot spawn additional sandboxes against your account.

### Known Limitations

See `README.md` § Cloud for prerequisites and limitations (OAuth providers, local mounts, pause TTL, credential rotation, SIGINT handling).

## HOME and ~/.profile

`$HOME` is resolved at shell construction (`home-dir.ts`): the most recently
onboarded `/home/<slug>` wins (fallback `/home/user`, created on demand), and
`$USER` is its basename. Scoop shells pin `HOME=/scoops/<folder>/home`. When
`$HOME/.profile` exists it is sourced through the interpreter before the first
command — the persistence mechanism for env vars and `PATH` extensions:

```bash
echo 'export MY_VAR=value' >> ~/.profile          # survives reloads
echo 'export PATH="$PATH:/my/tools"' >> ~/.profile # adds a command dir
```

A broken profile logs a warning and the shell continues; a `cd` inside the
profile cannot move the shell's contracted working directory.

## References

- **just-bash**: <https://github.com/jotaen/just-bash>
- **Supplemental commands**: `packages/webapp/src/shell/supplemental-commands/`
- **JSH executor**: `packages/webapp/src/shell/jsh-executor.ts`
- **Binary cache**: `packages/webapp/src/shell/binary-cache.ts`
- **Argument parser**: `packages/webapp/src/shell/parse-shell-args.ts`
- **Discovery**: `packages/webapp/src/shell/script-catalog.ts`, `packages/webapp/src/shell/jsh-discovery.ts`
