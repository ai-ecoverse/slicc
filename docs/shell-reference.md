# Shell Reference

Complete reference for SLICC's shell capabilities, including supplemental commands, .jsh scripts, and binary handling.

---

## Overview

SLICC uses `just-bash` (a pure-TypeScript Bash interpreter; see `packages/webapp/package.json` for the pinned version) as its core shell runtime. The interpreter itself is plain JavaScript — not WASM. This provides the standard Unix builtins (cd, ls, cat, grep, find, sed, awk, head, tail, etc.) plus ~50 custom supplemental commands registered by `packages/webapp/src/shell/supplemental-commands/index.ts` and `packages/webapp/src/shell/almost-bash-shell-headless.ts`, and any auto-discovered `.jsh` script commands on the VFS.

WASM enters only for specific runtime-heavy commands, which fetch and cache their binaries on demand: `python3` (Pyodide), `sqlite3` (sql.js), the `node -e` / `javascript` sandbox (QuickJS), `convert` (ImageMagick), `ffmpeg`, `biome`, and `esbuild`. The `AlmostBashShell` / `AlmostBashShellHeadless` classes cover the whole shell, not just the WASM-backed commands.

**Entry point**: Via the `bash` agent tool. All shell features available to agents.

### Shared `/tmp` scratch space

The virtual `/tmp` directory is shared, disposable scratch space for the cone and scoops; it is not the host operating system's temporary directory. Its cleanup boundary is the explicit **New session** control: **Save & start new**, **New chat — skip memory**, and **Erase & start new** each remove ordinary `/tmp` entries before the cone chat is cleared. Active mount roots below `/tmp` and the directories containing them stay attached and are never traversed, so mounted Local, S3, and DA contents are not treated as scratch data. Page reload, app restart, and scoop creation do not clear `/tmp`.

---

## Supplemental Commands

Custom commands implemented in TypeScript and registered in just-bash.

| Command                                     | File                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Key Arguments                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **commands**                                | `help-command.ts`          | List all available commands (built-ins + .jsh)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | None                                                                                                                                                                                                                                                                                                                                            |
| **which**                                   | `which-command.ts`         | Resolve a command path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `<command>` — returns `/usr/bin/<name>` or VFS path                                                                                                                                                                                                                                                                                             |
| **uname**                                   | `uname-command.ts`         | Print the current browser user agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | None                                                                                                                                                                                                                                                                                                                                            |
| **host**                                    | `host-command.ts`          | Print the current leader tray status plus `launch_url` and `join_url`; `host reset` recycles the leader session; `host leave` exits the tray (or switches to leader on `--leader <url>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `host`, `host reset`, `host leave`, `host leave --leader <worker-url>`                                                                                                                                                                                                                                                                          |
| **oauth-token**                             | `oauth-token-command.ts`   | Get an OAuth access token for a provider. Returns the **masked** Bearer token (in both CLI and extension modes). The proxy/SW unmasks at the network boundary. `oauth-token --renew [<id>]` is a diagnostic — normal renewal happens automatically on token expiry; this forces a silent renewal now via the provider's `onSilentRenew` hook (bypasses the expiry gate), reporting success and the new expiry, for verifying renewal without waiting for natural expiry.                                                                                                                                                                                                                                                                                                                                                                                            | `<providerId>`, `--provider <id>`, `--list`, `--renew [<id>]`, no args = selected provider; auto-triggers login if needed                                                                                                                                                                                                                       |
| **oauth-domain**                            | `oauth-domain-command.ts`  | Manage per-provider extra allowed domains for OAuth-issued tokens. Provider hardcoded `oauthTokenDomains` stay immutable; entries here layer on top. Stored in `localStorage` (`slicc_oauth_extra_domains`); also editable from the extension options page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `list [<providerId>]`, `add <providerId> <domain>`, `remove <providerId> <domain>`, `clear <providerId>`                                                                                                                                                                                                                                        |
| **local-llm**                               | `local-llm-command.ts`     | Inspect / configure the Local LLM provider (Ollama, LM Studio, llama.cpp, vLLM, mlx, Jan, LocalAI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `local-llm` or `local-llm status` — verify connection; `local-llm discover` — probe `/v1/models` and save the list to Settings                                                                                                                                                                                                                  |
| **serve**                                   | `serve-command.ts`         | Mint a worker-hosted preview URL for a VFS app directory, broadcast `preview.open` to all connected followers, and open the URL in the leader's tab. Two mint paths: in-realm `getPreviewMinter()` (extension agent + panel terminal) or panel-RPC `tray-open-preview` (standalone). Requires an active leader tray. The minted URL opens directly at the entry file's path relative to `<directory>` (e.g. `serve /workspace/app` → `.../index.html`, `serve --entry=drafts/foo.html /workspace/app` → `.../drafts/foo.html`) rather than always at bare `/`, so relative links inside the entry resolve the same way they do under `open`; root-absolute links (`/styles/...`) already resolved correctly against `<directory>`. When a `BrowserAPI` is available, stdout includes ` (targetId: <id>)` for follow-up `playwright-cli <command> --tab <id>` calls. | `[--entry <relative-path>] [--bridge \| --no-bridge] [--stop <token>] [--list] <directory>` — defaults to `index.html`; `--bridge` opts into leader-managed live updates (Cherry-attached followers default-on); `--no-bridge` forces off; `--stop` and `--list` parse but are deferred to a follow-up. `--project` is an obsolete no-op alias. |
| **open**                                    | `open-command.ts`          | Open URL or VFS file in browser tab. For VFS paths, walks up from the file's directory looking for a project-root marker (`head.html`, `fstab.yaml`, `package.json`, `.git`; falls back to the file's own directory when none is found) and passes it as `?projectRoot=` on the preview URL, so root-absolute paths (`/styles/...`) resolve against that root the same way they do under `serve` — standalone only; extension mode does not route through the preview SW and does not get this. When a `BrowserAPI` is available, stdout includes ` (targetId: <id>)`.                                                                                                                                                                                                                                                                                              | `<url\|path>` — serves VFS files via preview SW; `--download` / `-d` forces download; `--view` / `-v` returns image inline for agent vision                                                                                                                                                                                                     |
| **imgcat**                                  | `imgcat-command.ts`        | Display image inline in terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `<path>` — base64 + ansi escape codes                                                                                                                                                                                                                                                                                                           |
| **zip**                                     | `zip-command.ts`           | Create ZIP archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `<archive.zip> <file1> [file2...]`                                                                                                                                                                                                                                                                                                              |
| **unzip**                                   | `unzip-command.ts`         | Extract ZIP archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `<archive.zip> [-d output-dir]`                                                                                                                                                                                                                                                                                                                 |
| **tar**                                     | `tar-command.ts`           | Create, extract, or list tar archives in the VFS, with optional gzip compression and automatic gzip detection when reading. `-C` changes the input base directory in create mode and the output directory in extract mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `(-c\|-x\|-t) [-zv] -f <archive> [-C <dir>] [paths...]`                                                                                                                                                                                                                                                                                         |
| **xxd**                                     | `xxd-command.ts`           | Hex dump for binary data (and its reverse). Canonical `offset: hex  ascii` dump by default; plain-hex (`-p`) and C-include (`-i`) output styles; `-r` converts a hex dump back to binary (`-r -p` for a plain dump). Reads a file or stdin and writes stdout or an output file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `xxd [infile [outfile]]`, `-c <cols>`, `-g <bytes>`, `-l <len>`, `-s <seek>` (negative counts from end), `-u` (uppercase), `-p` (plain), `-i` (C include), `-r` (reverse)                                                                                                                                                                       |
| **sqlite3**                                 | `sqlite-command.ts`        | Execute SQLite queries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `-c "SELECT * FROM table" db.sqlite`                                                                                                                                                                                                                                                                                                            |
| **node**                                    | `node-command.ts`          | Execute JavaScript code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `-e "console.log(1+1)"` with fs bridge                                                                                                                                                                                                                                                                                                          |
| **python3 / python**                        | `python-command.ts`        | Execute Python code via Pyodide. Synchronous access to a mounted path (local FS Access, S3 / R2, da.live) raises `OSError` (EIO) with a guiding message — use the async `slicc.fs` module (`await slicc.fs.read_text(...)`, `listdir`, `read_bytes`, `write_text`, `write_bytes`, `stat`, `exists`, `mkdir`, `remove`, `walk`) for on-demand mount I/O, or copy the file into the VFS first. The cwd and `/tmp` remain directly accessible. See [docs/pitfalls.md — Mounts Are Async-Only Via `slicc.fs`](./pitfalls.md#python-realm-mounts-are-async-only-via-sliccfs).                                                                                                                                                                                                                                                                                            | `-c "print([i**2 for i in range(5)])"`, `script.py [args...]`                                                                                                                                                                                                                                                                                   |
| **webhook**                                 | `webhook-command.ts`       | Manage webhooks for event-driven licks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `webhook create <endpoint>`, `webhook list`, `webhook delete <id>`                                                                                                                                                                                                                                                                              |
| **websocat**                                | `websocat-command.ts`      | Minimal WebSocket client (netcat/curl for ws://). Sends stdin lines as messages, prints received messages. Client-only — server mode and advanced specifiers (`exec:`, `tcp:`, `broadcast:`, `ws-l:`) are not supported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `websocat ws://URL`, `-1` one-shot, `-b` binary, `--jsonrpc`/`--jsonrpc-omit-jsonrpc`, `--base64`, `--protocol`, `--max-messages`                                                                                                                                                                                                               |
| **crontask**                                | `crontask-command.ts`      | Schedule cron jobs that dispatch licks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `crontask add <name> "0 9 * * *" scoop-name "instructions..."`                                                                                                                                                                                                                                                                                  |
| **pdftk / pdf**                             | `pdftk-command.ts`         | PDF manipulation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `pdf burst input.pdf`, `pdf cat input.pdf output output.pdf`                                                                                                                                                                                                                                                                                    |
| **convert / magick**                        | `convert-command.ts`       | Image conversion (ImageMagick style)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `convert -resize 800x600 input.jpg output.jpg`                                                                                                                                                                                                                                                                                                  |
| **playwright-cli / playwright / puppeteer** | `playwright-command.ts`    | Browser automation shell CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `snapshot`, `click <ref>`, `cookie-set`, `tab-list`                                                                                                                                                                                                                                                                                             |
| **screencapture**                           | `screencapture-command.ts` | Capture user's screen via browser screen sharing API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `<output.png>`, `-c` (clipboard), `-v` / `--view` (agent vision)                                                                                                                                                                                                                                                                                |
| **upskill**                                 | `upskill-command.ts`       | Install skills from GitHub, the Tessl registry, or browse.sh; suggest skills for open browser tabs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `upskill owner/repo`, `upskill tessl:<name>`, `upskill browse:<host>/<task>`, `upskill search "query"`, `upskill tabs [--json]`                                                                                                                                                                                                                 |
| **sprinkle**                                | `sprinkle-command.ts`      | Manage `.shtml` sprinkle panels and inline chat UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `sprinkle list`, `sprinkle open <name>`, `sprinkle chat '<html>'`                                                                                                                                                                                                                                                                               |
| **cost**                                    | `cost-command.ts`          | Show session cost breakdown per scoop/cone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `--json`, `-h`                                                                                                                                                                                                                                                                                                                                  |
| **models**                                  | `models-command.ts`        | List available LLM models with pricing and benchmarks. The `► ` marker and the `Currently using:` footer report the model the agent **actually resolves** (`resolveCurrentModel()`), not the raw selected id — so a fallback shows the real model and flags a divergence from the selection. The active model is never hidden by version-family dedup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `--all`, `--all-versions`, `--json`, `--provider <id>`, `--refresh`, `--no-benchmarks`                                                                                                                                                                                                                                                          |
| **secret**                                  | `secret-command.ts`        | Manage secrets (API keys, tokens) with domain-scoped injection, folded into the sudo model. `set <name> <value>` creates an in-memory **session-only** secret (no approval, never persisted); `get`/`read`/`peek`/`list`/`test` need no approval. Persisting (`--persist`), editing scope (`scope`), and changing an existing secret's value each raise a native sudo prompt (deny blocks; "Always" skips future prompts for that op this session). `peek` shows only the first/last chars of the unmasked value. `set` also reads the value from stdin (`echo "$TOKEN" \| secret set NAME --domain ...`) so the literal never lands in the agent's tool-call argv; on a successful set the masked replacement is injected into the owning shell's live env (POSIX-name secrets only — parity with `fetchSecretEnvVars`).                                           | `set <name> [<value>] [--domain <patterns>] [--persist]` (value via arg OR stdin), `get`/`read <name>`, `peek <name>`, `scope <name> --domain <patterns>`, `list`, `delete <name>`, `test <name> <url>`, `edit`                                                                                                                                 |
| **sudo**                                    | `sudo-command.ts`          | Request human approval to run a single command verbatim. The cone (or any agent shell) can call `sudo <cmd> [args...]` to explicitly route a sensitive action through the sudo broker; "Allow" runs the inner command once, "Always" persists a `NOPASSWD Cmnd` grant in `/etc/sudoers.d/granted` (no future prompt), "Deny" exits `1` with `sudo: approval denied`. The inner argv is forwarded verbatim (no re-parsing) and the one-shot bypass keyed by canonical subject prevents a double prompt when the inner command is itself policy-gated. Exits `1` with `sudo: command-level approval is not configured` in floats without a broker (e.g. panel terminal). See [docs/approvals.md — Sudo policy](./approvals.md#sudo--etcsudoers-policy).                                                                                                               | `sudo <cmd> [args...]`, `-h`/`--help`                                                                                                                                                                                                                                                                                                           |
| **mount**                                   | (MountCommands class)      | Mount local directories or remote storage (S3 / S3-compatible / DA) into the VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `mount [--source <url>] [--profile <name>] <path>`, `mount unmount [--clear-cache] <path>`, `mount list`, `mount refresh [--bodies] <path>`                                                                                                                                                                                                     |
| **mcp**                                     | `mcp-command.ts`           | Manage Model Context Protocol servers. Persists to `/workspace/.mcp/servers.json`, registers each as an `mcp:<name>` OAuth provider when auth is required, auto-writes a `.jsh` alias shim at `/workspace/.mcp/aliases/<name>.jsh`, and materializes MCP Apps as sprinkles under `/workspace/.mcp/sprinkles/<name>/`. Registration is lazy (re-registers from `servers.json` on the first subcommand call). OAuth discovery prefers RFC 9728 Protected Resource Metadata at `<server>/.well-known/oauth-protected-resource`, but transparently falls back to RFC 8414 Authorization Server Metadata at the server's own origin (`<server>/.well-known/oauth-authorization-server`) when PRM is absent — matching `mcp-remote` / Cloudflare-worker MCP servers.                                                                                                      | `mcp add <url> [name]`, `mcp list`, `mcp delete <name>`, `mcp invoke <name> [tool] [--flag value]`, `mcp refresh <name>`                                                                                                                                                                                                                        |
| **usb**                                     | `usb-command.ts`           | WebUSB access from the shell. Opaque device handles (`usb1`, `usb2`, …) back a page-side registry; control + bulk/interrupt transfers round-trip via panel-RPC. `usb request` needs a real user gesture. Chromium-only; unavailable in the cloud / hosted-leader float.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `usb list`, `usb request [--vid 0x.. --pid 0x.. --class N --serial S]`, `usb open\|close\|reset <handle>`, `usb claim\|release <handle> <iface>`, `usb control-in\|control-out`, `usb transfer-in\|transfer-out`, `--raw`                                                                                                                       |
| **serial**                                  | `serial-command.ts`        | Web Serial access from the shell. Same handle-registry + panel-RPC bridge as `usb`. `serial request` needs a real user gesture. Chromium-only; unavailable in the cloud / hosted-leader float.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `serial list`, `serial request [--vid 0x.. --pid 0x..]`, `serial open <handle> [--baud N …]`, `serial close <handle>`, `serial read <handle> [--bytes N --until <hex> --timeout-ms N --hex]`, `serial write <handle>`, `serial signals <handle> get\|set`                                                                                       |
| **hid**                                     | `hid-command.ts`           | WebHID access from the shell. Same handle-registry + panel-RPC bridge as `usb`. `hid request` needs a real user gesture and registers every granted interface as a separate handle (multi-interface devices like VIA/QMK keyboards stay reachable); I/O subcommands (`watch`/`send`/`query`/`feature-*`) auto-open closed devices. `hid query` is the VIA-style request/response verb: subscribe, send, await the first input report, unsubscribe. Chromium-only; unavailable in the cloud / hosted-leader float.                                                                                                                                                                                                                                                                                                                                                   | `hid list`, `hid request [--vid 0x.. --pid 0x.. --usage-page N --usage N]`, `hid open\|close <handle>`, `hid send <handle> <report-id>`, `hid query <handle> <report-id> [--timeout <ms>]`, `hid feature-send <handle> <report-id>`, `hid feature-get <handle> <report-id> <length>`, `hid watch <handle>`, `--raw`                             |
| **esptool**                                 | `esptool-command.ts`       | Flash ESP32 / ESP8266 chips via esptool-js, layered on the `serial` handle namespace. Without `--port` the Web Serial picker opens (needs a user gesture). esptool-js loads lazily via dynamic `import()` (CSP-safe). Chromium-only; unavailable in the cloud / hosted-leader float.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `esptool chip_id`, `esptool read_mac`, `esptool flash_id`, `esptool read_reg <addr>`, `esptool read_flash <addr> <size> <outfile>`, `esptool erase_flash`, `esptool erase_region <addr> <size>`, `esptool write_flash <addr> <file>...`, `esptool run`, `--port <handle>`, `--baud N`, `--vid 0x..`, `--pid 0x..`, `--erase`                    |
| **git**                                     | (isomorphic-git)           | Browser-native Git subset, not the full system Git CLI. Includes symbolic-ref inspection and mutation without reflog persistence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Existing subcommands plus `git symbolic-ref <name>`, `git symbolic-ref <name> <ref>`, and `git symbolic-ref -d <name>`/`--delete <name>`; read flags: `-q`/`--quiet`, `--short`, `--recurse`, `--no-recurse`. `-m` is rejected because reflogs are not persisted.                                                                               |
| **agent**                                   | `agent-command.ts`         | Spawn an ephemeral one-shot sub-scoop via `globalThis.__slicc_agent`. Shell surface for scoop delegation from any float. Inherits the parent's model when invoked from inside a scoop shell. Three positional args (no `--cwd`): `cwd`, `allowed-commands` glob, and the prompt. `--read-only` is pure-replace for `visiblePaths` — pass `--read-only "/docs/,$(pwd)"` to keep the cwd visible alongside read-only roots.                                                                                                                                                                                                                                                                                                                                                                                                                                           | `agent <cwd> <allowed-commands> "<prompt>"`, `--model <id>`, `--thinking <off\|low\|medium\|high>` (alias `--effort`), `--read-only <comma-separated-paths>`                                                                                                                                                                                    |
| **discover**                                | `discover-command.ts`      | Fetch a URL and surface RFC 8288 / RFC 9727 link-discovery results as JSON. Routes through the proxied fetch (CORS bypass + forbidden-header bridging). Output: `{ url, status, links[], handoff, discovery? }`. With `--follow`, also fetches P0 capability docs (api-catalog, service-desc, service-meta, status, llms.txt) and includes them under `discovery`. See [link-discovery.md](link-discovery.md). For listing installed skills, use `upskill --list` or read `/workspace/skills/`.                                                                                                                                                                                                                                                                                                                                                                     | `discover <url>`, `discover --follow <url>`                                                                                                                                                                                                                                                                                                     |
| **tsc**                                     | `tsc-command.ts`           | Single-file TypeScript compiler over the bundled `typescript` package. Walks up from `ctx.cwd` to merge nearest `tsconfig.json`'s `compilerOptions` over `ES2022`/`ESNext` defaults. No cross-file program-level type checking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tsc [files...]`, `--noEmit`, `--outDir`, stdin → stdout                                                                                                                                                                                                                                                                                        |
| **test**                                    | `test-command.ts`          | Test runner over the [tst](https://github.com/dy/tst) library. Discovers `*.test.{js,ts}` in `ctx.cwd`, TS-transpiles each, runs each file in its own realm. Reporters: `tap` (default), `--reporter=spec` → tst `pretty`. Fork mode disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `test [glob]`, `--reporter=<tap\|spec>`                                                                                                                                                                                                                                                                                                         |
| **biome**                                   | `biome-command.ts`         | Biome linter/formatter via the wasm-nodejs build. Walks directories filtered to known extensions (JS/TS/JSON/CSS/GraphQL/HTML/Svelte/Vue/Astro, plus `.jsh`/`.bsh` shell scripts). Because those run as an `AsyncFunction` body (top-level `await` **and** `return` are valid), their content is wrapped in `async function __slicc() { … }` before Biome parses it — both map to a virtual `.js` path; diagnostic spans are shifted back so line/column point at the real file, and `format --write` unwraps + de-indents the result (with a re-format round-trip guard that leaves a file unchanged rather than corrupt tab-prefixed multi-line template literals). The real path is kept for write-back and diagnostics. The 33 MB wasm binary is fetched on demand and Cache Storage-backed.                                                                    | `biome lint <path>`, `biome format <path>`, `biome check <path>`, `--write`, `--apply`, `--apply-unsafe`, `--stdin-file-path`                                                                                                                                                                                                                   |
| **esbuild**                                 | `esbuild-command.ts`       | esbuild bundler / transpiler. The 10 MB wasm binary is fetched on demand. A VFS plugin routes local paths through `ctx.fs` and bare specifiers through `https://esm.sh/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `esbuild <entry>`, `--bundle`, `--transform`, `--format`, `--minify`, `--sourcemap`, `--target`, `--loader`, `--outfile`                                                                                                                                                                                                                        |
| **ffmpeg**                                  | `ffmpeg-command.ts`        | ffmpeg.wasm — audio/video transcoding and processing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `ffmpeg -i input.mp4 -vcodec libx264 output.mp4`                                                                                                                                                                                                                                                                                                |
| **fswatch**                                 | `fswatch-command.ts`       | Watch a VFS path for changes via `globalThis.__slicc_fs_watcher` and route each change through `globalThis.__slicc_lick_handler` to a target scoop. Maintains an in-process `activeWatches` map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `fswatch create --path <path> --pattern <glob> [--scoop <name>] [--name <name>]`, `fswatch list`, `fswatch delete <id>`                                                                                                                                                                                                                         |
| **ps**                                      | `ps-command.ts`            | List active processes from `ProcessManager` — scoop turns, tool calls, shell execs, jsh/python scripts. Equivalent to inspecting `/proc/` directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `ps`, `--all`                                                                                                                                                                                                                                                                                                                                   |
| **kill**                                    | `kill-command.ts`          | Send a signal to a `ProcessManager`-tracked process. `SIGKILL` is uncatchable (worker.terminate() / iframe.remove(), exit 137).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `kill <pid>`, `kill -<SIGNAL> <pid>` (`SIGINT`/`SIGTERM`/`SIGKILL`/`SIGSTOP`/`SIGCONT`)                                                                                                                                                                                                                                                         |
| **rsync**                                   | `rsync-command.ts`         | Diff-aware copy between VFS paths (or mounted backends). Used for syncing workspace state into a mount, or vice versa.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `rsync <src> <dst>`, `--dry-run`, `--delete`                                                                                                                                                                                                                                                                                                    |
| **man**                                     | `man-command.ts`           | Print the embedded man-page for a given command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `man <command>`                                                                                                                                                                                                                                                                                                                                 |
| **dig**                                     | `dig-command.ts`           | DNS lookup via DoH (DNS-over-HTTPS). Uses a fixed Cloudflare resolver (`https://cloudflare-dns.com/dns-query`) and its JSON API, routed through the proxied fetch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `dig <name> [type]`, `+short`, `--json`                                                                                                                                                                                                                                                                                                         |
| **nuke**                                    | `nuke-command.ts`          | Wipe SLICC state. Clears IndexedDB (VFS, sessions, scoops, mounts, all five DBs) and reloads. Destructive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `nuke`, `--yes` (skip confirmation)                                                                                                                                                                                                                                                                                                             |
| **say**                                     | `say-command.ts`           | macOS `say`-equivalent — speak the text via the Web Speech API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `say "Hello"`, `-v <voice>`                                                                                                                                                                                                                                                                                                                     |
| **afplay / chime**                          | `afplay-command.ts`        | Play a sound file. `chime` is a convenience alias for the bundled notification sounds in `/shared/sounds/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `afplay <path>`, `chime [done\|alert\|...]`                                                                                                                                                                                                                                                                                                     |
| **pbcopy / pbpaste / xclip / xsel**         | `clipboard-commands.ts`    | Copy stdin to the clipboard / paste clipboard to stdout via the browser Clipboard API. All four aliases share the same implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `echo hi \| pbcopy`, `pbpaste`                                                                                                                                                                                                                                                                                                                  |

**Example usage**:

```bash
# List all available commands
commands

# Resolve a command path
which node
# Output: /usr/bin/node

# Print the current browser user agent
uname

# Show the current leader tray status, launch URL, and join URL
host

# In a leader runtime, launch_url is the tray URL itself
# In non-leader/error runtimes with a saved session, it stays the local app launch URL
# join_url exposes the tray join capability directly when a session exists

# Follow another browser's tray as a follower. Paste the https://…/join/<token>
# URL the leader shows under "Copy tray join URL". Works in both the
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

# View an image (agent can see it in the response)
open --view /workspace/screenshot.png

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

---

## playwright-cli

Browser automation is also exposed as shell commands: `playwright-cli`, `playwright`, and `puppeteer`.

- **Shared state across aliases**: all three names operate on the same current tab, snapshot cache, cookies/storage context, and `/.playwright/session.md` history.
- **Default targeting**: `open` / `tab-new` open in the background by default, but if there is no current browser target yet, the first opened tab becomes current so `snapshot` works immediately.
- **Fresh refs required**: `click`, `fill`, `goto`, `go-back`, `go-forward`, `reload`, and similar state-changing commands invalidate prior snapshot refs. After history navigation or reload, run `snapshot` again before using refs.
- **Cookie convenience forms**: `cookie-set <name> <value>` and `cookie-delete <name>` use the current page URL when `--domain` and `--path` are omitted.
- **Teleport restores auth state**: arm it explicitly with `playwright teleport --start=<regex> --return=<regex>` or implicitly with `--teleport-start` / `--teleport-return` on `open`, `tab-new`, or `goto` / `navigate`. When the leader hits `--start`, the intercepted auth URL opens on a follower for the human to finish login; when the follower hits `--return`, teleport restores both cookies and page storage (`localStorage` + `sessionStorage`) back to the leader. For cross-origin SSO flows, teleport hydrates the captured app origin first, then lands on the best matching app URL. Teleport needs a follower with `Network.*` (cookie/storage) access, so a cherry host target is never eligible — auto-selection skips it and an explicit `teleport --runtime <id>` naming a cherry host is rejected at arm time.
- **Unexpected dialogs**: attached pages auto-dismiss unexpected JavaScript dialogs so a stray `alert()` or similar modal does not stall automation indefinitely.
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

## upskill

Skill package manager. Installs into `/workspace/skills/<name>/` from three registries:

| Install ref                        | Registry                                                                                                                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upskill <owner>/<repo>[@branch]`  | GitHub. Supports `--skill <name>` (repeatable), `--all`, `--path <subfolder>`, `--branch/-b`, `--list`, `--force`.                                                                           |
| `upskill tessl:<name>`             | Tessl registry (resolves to a GitHub source under the hood).                                                                                                                                 |
| `upskill browse:<hostname>/<task>` | [browse.sh](https://browse.sh) site-specific skills. Equivalent URL form: `upskill https://browse.sh/skills/<hostname>/<task>`. Installs into `/workspace/skills/browse-<hostname>-<name>/`. |

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

| Form                                               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mount <path>`                                     | Local FS Access mount. Opens a directory picker (cone-only — fails fast in scoops, which have no UI gesture).                                                                                                                                                                                                                                                                                           |
| `mount --source s3://<bucket>[/<prefix>] <path>`   | S3 / S3-compatible mount. Reads creds from `s3.<profile>.*` secrets (`--profile` selects the namespace; defaults to `default`). Allowed in scoops.                                                                                                                                                                                                                                                      |
| `mount --source da://<org>/<repo>[/<path>] <path>` | Adobe da.live mount. Reuses the existing Adobe provider's IMS bearer token; `--profile` is accepted for symmetry but has a single global identity in v1. Allowed in scoops.                                                                                                                                                                                                                             |
| `mount list`                                       | List active mounts with each mount's index state: `indexed: <n> entries`, `indexing: <n> entries...`, `pending index`, or — when the index was skipped — a distinct cause line (depth-exceeded, entries-exceeded, cycle-detected, or a generic index error; see [Index bounds and skip states](#index-bounds-and-skip-states)). A skipped index still serves reads via the slow per-`readDir` fallback. |
| `mount unmount [--clear-cache] <path>`             | Tear down a mount. `--clear-cache` also drops cached listings + bodies for that mount; without it, cache entries persist until TTL or the next session.                                                                                                                                                                                                                                                 |
| `mount refresh [--bodies] <path>`                  | Re-walk the source and diff against the cache. Prints `Refreshed <path>: +<added> -<removed> ~<changed> (<unchanged> unchanged, <errors> errors)`. Without `--bodies` only the listing is rechecked; with `--bodies` changed files are conditionally re-fetched.                                                                                                                                        |

### Mount-time flags

| Flag                | Applies to    | Effect                                                                                                                                                                                 |
| ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source <url>`    | mount         | Selects a remote backend by URL scheme (`s3://`, `da://`). Without `--source`, the local picker is used.                                                                               |
| `--profile <name>`  | mount         | Profile name resolved against `s3.<profile>.*` secrets (S3) or used as a label (DA). Defaults to `default`.                                                                            |
| `--no-probe`        | mount         | Skip the mount-time `HEAD` bucket / `GET /list` round-trip. Use when latency matters and you trust the source URL is well-formed and accessible.                                       |
| `--max-body-mb <n>` | mount         | Override the per-mount maximum body size for read/write. Defaults: S3 25 MB, DA 5 MB. Files exceeding the threshold throw `EFBIG` before any body bytes flow.                          |
| `--clear-cache`     | mount unmount | Drop the `RemoteMountCache` entries (listings + bodies) for this mount.                                                                                                                |
| `--bodies`          | mount refresh | After the listing diff, conditionally re-fetch bodies for paths whose ETag changed. Without this flag a refresh is one paginated list (or one DA recursive walk) plus zero body bytes. |

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

# S3 (AWS) — first store creds, then mount
secret set s3.aws.access_key_id      # follow printed instructions
secret set s3.aws.secret_access_key  # follow printed instructions
mount --source s3://my-bucket/site --profile aws /mnt/aws

# Cloudflare R2 (S3-compatible — uses --source s3:// with a custom endpoint in the profile)
secret set s3.r2.access_key_id
secret set s3.r2.secret_access_key
secret set s3.r2.endpoint            # https://<account>.r2.cloudflarestorage.com
mount --source s3://my-r2-bucket/path --profile r2 /mnt/r2

# Adobe da.live — uses the Adobe provider's existing IMS identity
mount --source da://my-org/my-repo /mnt/da

# Inspect, refresh, unmount
mount list
mount refresh /mnt/r2                # listing-only diff
mount refresh --bodies /mnt/r2       # also revalidates changed bodies
mount unmount --clear-cache /mnt/r2  # drops cache as well
```

### Approval flow

Local mounts surface a one-click approval card; S3 / DA mounts have none. The full gesture-bridge and trust-boundary model is documented in [`docs/approvals.md` — Local mount picker](./approvals.md#local-mount-picker). Local mounts are cone-only because the directory picker requires a real user gesture; S3 / DA mounts work from scoops because their credentials come from the secret store.

---

## serve

Mint a worker-hosted preview URL for a VFS directory, served through the Cloudflare Durable Object tray hub. Plain `serve` serves read-only HTML/assets; `serve --bridge` makes the preview **driveable** — visitor tabs auto-connect as live synthetic-CDP targets the leader can navigate/click/evaluate/screenshot via playwright.

```bash
serve <dir>                           # Read-only preview
serve --bridge <dir>                  # Driveable preview (opt-in)
serve --bridge --max-tabs 10 <dir>    # Cap concurrent bridge connections (default 20)
serve --bridge --quiet <dir>          # Suppress connect/disconnect licks
serve --no-bridge <dir>               # Force read-only (wins over everything)
serve --stop <token>                  # Revoke preview + delete auto-provisioned webhook
```

### Flags

- `--bridge` — Make the preview driveable. Visitors auto-connect as synthetic-CDP targets (`preview:<token>:<connId>`); the leader drives them via playwright. Auto-provisions a webhook for page→cone `window.slicc.emit()` events. **Security:** Cross-subdomain cookie risk accepted and documented — host-only cookies isolated, but `Domain=.sliccy.now` cookies readable across previews. Opt-in only per serve; never implied by `allowLive` or Cherry follower attachment.
- `--no-bridge` — Force read-only. Wins over `--bridge` and Cherry-follower default.
- `--max-tabs <N>` — Cap concurrent bridged tabs per preview (default 20). DO rejects bridge upgrades when cap reached; the over-cap tab still loads as a normal (non-driveable) preview and the leader is not told it exists.
- `--quiet` — Suppress `'preview'` lifecycle licks (connect/disconnect). Webhook licks the page emits still flow.
- `--stop <token>` — Revoke the preview: closes bridge sockets, rejects new connections, deletes the auto-provisioned webhook.

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

**Visibility**: Connect/disconnect licks surface every attachment in the cone transcript (rate-limited; `--quiet` to mute). The bootstrap may render an optional subtle "live" badge (not a prompt — respects the automatic choice).

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

### Subcommands

| Form                                      | Behavior                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `serial list`                             | List currently-granted ports as `handle  vid:pid [open]`.               |
| `serial request [--vid 0x.. --pid 0x..]`  | Open the port picker (needs a user gesture); prints the granted handle. |
| `serial open <handle> [open flags]`       | Open a port with the given line settings.                               |
| `serial close <handle>`                   | Close a port.                                                           |
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

## .jsh Script Commands

JavaScript shell scripts auto-discovered anywhere on the VirtualFS. Executable like any shell command.

**Discovery**: `jsh-discovery.ts` scans VFS with priority roots:

```
Priority: /workspace/skills/
Then: / (full filesystem scan)

Rule: First basename wins (no conflicts)
```

`script-catalog.ts` is the shared lookup layer used by `AlmostBashShell`, `which`, and browser-script matching. When an `FsWatcher` is present it caches discovery results and clears them on filesystem changes; mounted directories bypass the cache because external edits inside File System Access mounts are not observable through the watcher.

**Execution**: Via `jsh-executor.ts` (dual-mode):

- CLI: `AsyncFunction` constructor with Node-like globals
- Extension: Sandbox iframe (CSP-compliant), VFS via postMessage

### Globals API

#### process

```typescript
process.argv: string[]                       // ['node', 'script.jsh', ...args]
process.env: object                          // Environment variables
process.cwd(): string                        // Current working directory
process.exit(code?: number)                  // Exit with code (0 default)
process.stdout.write(s)                      // Write to stdout
process.stderr.write(s)                      // Write to stderr
process.stdin.read(): string | null          // Buffered piped stdin; null after EOF
process.stdin.isTTY: false                   // Always false in this environment
process.stdin[Symbol.asyncIterator]()        // Yields the buffered string once
String(process.stdin)                        // Non-consuming view of the buffer
```

#### stdin (via `process.stdin`)

Stdin from upstream pipelines is buffered fully before the script runs — there is **no streaming**. `read()` drains the buffer with Node-like EOF semantics:

```typescript
// echo "a,b,c" | parse-csv
const data = process.stdin.read(); // 'a,b,c\n'
const again = process.stdin.read(); // null — buffer was drained
```

The async iterator shares that consumed state with `read()`, so re-iterating yields nothing after the first pass (and yields nothing at all if you called `read()` first):

```typescript
let total = '';
for await (const chunk of process.stdin) total += chunk;
```

For a non-consuming view, use `String(process.stdin)` or `process.stdin.toString()`. If no input is piped, the first `read()` returns `''` and subsequent calls return `null`.

Stdin is intentionally NOT exposed as a top-level identifier — user scripts are free to declare their own `const stdin = …` without colliding with the runtime.

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
sync forms (`execSync` / `spawnSync` / `execFileSync`) and `fork` throw — no
synchronous or long-lived process model. `.bsh` scripts run in the target page
(no shell bridge), so `child_process` is unavailable there.

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
}): Promise<{ ok: boolean; status: number; headers: Record<string, string>; body: unknown }>
```

Runs inside the tab's origin, so session cookies and same-origin headers are automatic. Response body is JSON-parsed when content-type permits.

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

**Files**: `packages/webapp/src/ui/sprinkle-bridge.ts` (sprinkles), `packages/webapp/src/ui/dip.ts` (dips), `packages/chrome-extension/sprinkle-sandbox.html` (extension-mode `postMessage` relay).

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

### CLI Mode

Express server provides `/api/fetch-proxy`:

```bash
curl -X POST /api/fetch-proxy \
  -H "X-Target-URL: https://api.example.com/data" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

All `fetch()` and `curl` calls route through proxy (CLI: `/api/fetch-proxy`, extension: `fetch-proxy.fetch` SW Port handler). Both modes now provide full secret-injection coverage.

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

| Module                                           | Status                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `fs`                                             | ✅ VFS bridge (readFile, writeFile, readDir, exists, stat, mkdir, rm)                             |
| `process`                                        | ✅ Shim (argv, env, cwd, exit, stdout, stderr)                                                    |
| `buffer`                                         | ✅ Browser polyfill                                                                               |
| `path`                                           | ✅ Via esm.sh (browser polyfill)                                                                  |
| `url`, `querystring`, `util`, `events`, `assert` | ✅ Via esm.sh                                                                                     |
| `child_process`                                  | ✅ Realm shim over the `exec.start` bridge (`exec`/`execFile`/`spawn`; sync forms + `fork` throw) |
| `http`, `https`, `crypto`, `net`, etc.           | ❌ Not available in browser                                                                       |

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

# Show instructions for adding a new secret
secret set API_KEY

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

## References

- **just-bash**: https://github.com/jotaen/just-bash
- **Supplemental commands**: `packages/webapp/src/shell/supplemental-commands/`
- **JSH executor**: `packages/webapp/src/shell/jsh-executor.ts`
- **Binary cache**: `packages/webapp/src/shell/binary-cache.ts`
- **Argument parser**: `packages/webapp/src/shell/parse-shell-args.ts`
- **Discovery**: `packages/webapp/src/shell/script-catalog.ts`, `packages/webapp/src/shell/jsh-discovery.ts`
