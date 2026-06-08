# Shell Reference

Complete reference for SLICC's shell capabilities, including supplemental commands, .jsh scripts, and binary handling.

---

## Overview

SLICC uses `just-bash` (WASM Bash interpreter v2.14.3) as its core shell runtime. This provides the standard Unix builtins (cd, ls, cat, grep, find, sed, awk, head, tail, etc.) plus ~50 custom supplemental commands registered by `packages/webapp/src/shell/supplemental-commands/index.ts` and `packages/webapp/src/shell/wasm-shell-headless.ts`, and any auto-discovered `.jsh` script commands on the VFS.

**Entry point**: Via the `bash` agent tool. All shell features available to agents.

---

## Supplemental Commands

Custom commands implemented in TypeScript and registered in just-bash.

| Command                                     | File                       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Key Arguments                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **commands**                                | `help-command.ts`          | List all available commands (built-ins + .jsh)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | None                                                                                                                                                                                                                                                                                                                                            |
| **which**                                   | `which-command.ts`         | Resolve a command path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `<command>` — returns `/usr/bin/<name>` or VFS path                                                                                                                                                                                                                                                                                             |
| **uname**                                   | `uname-command.ts`         | Print the current browser user agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | None                                                                                                                                                                                                                                                                                                                                            |
| **host**                                    | `host-command.ts`          | Print the current leader tray status plus `launch_url` and `join_url`; `host reset` recycles the leader session; `host leave` exits the tray (or switches to leader on `--leader <url>`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `host`, `host reset`, `host leave`, `host leave --leader <worker-url>`                                                                                                                                                                                                                                                                          |
| **oauth-token**                             | `oauth-token-command.ts`   | Get an OAuth access token for a provider. Returns the **masked** Bearer token (in both CLI and extension modes). The proxy/SW unmasks at the network boundary. `oauth-token --renew [<id>]` is a diagnostic — normal renewal happens automatically on token expiry; this forces a silent renewal now via the provider's `onSilentRenew` hook (bypasses the expiry gate), reporting success and the new expiry, for verifying renewal without waiting for natural expiry.                                                                                                                                                                                                                                                                                       | `<providerId>`, `--provider <id>`, `--list`, `--renew [<id>]`, no args = selected provider; auto-triggers login if needed                                                                                                                                                                                                                       |
| **oauth-domain**                            | `oauth-domain-command.ts`  | Manage per-provider extra allowed domains for OAuth-issued tokens. Provider hardcoded `oauthTokenDomains` stay immutable; entries here layer on top. Stored in `localStorage` (`slicc_oauth_extra_domains`); also editable from the extension options page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `list [<providerId>]`, `add <providerId> <domain>`, `remove <providerId> <domain>`, `clear <providerId>`                                                                                                                                                                                                                                        |
| **local-llm**                               | `local-llm-command.ts`     | Inspect / configure the Local LLM provider (Ollama, LM Studio, llama.cpp, vLLM, mlx, Jan, LocalAI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `local-llm` or `local-llm status` — verify connection; `local-llm discover` — probe `/v1/models` and save the list to Settings                                                                                                                                                                                                                  |
| **serve**                                   | `serve-command.ts`         | Mint a worker-hosted preview URL for a VFS app directory, broadcast `preview.open` to all connected followers, and open the URL in the leader's tab. Two mint paths: in-realm `getPreviewMinter()` (extension agent + panel terminal) or panel-RPC `tray-open-preview` (standalone). Requires an active leader tray.                                                                                                                                                                                                                                                                                                                                                                                                                                           | `[--entry <relative-path>] [--bridge \| --no-bridge] [--stop <token>] [--list] <directory>` — defaults to `index.html`; `--bridge` opts into leader-managed live updates (Cherry-attached followers default-on); `--no-bridge` forces off; `--stop` and `--list` parse but are deferred to a follow-up. `--project` is an obsolete no-op alias. |
| **open**                                    | `open-command.ts`          | Open URL or VFS file in browser tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `<url\|path>` — serves VFS files via preview SW; `--download` / `-d` forces download; `--view` / `-v` returns image inline for agent vision                                                                                                                                                                                                     |
| **imgcat**                                  | `imgcat-command.ts`        | Display image inline in terminal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `<path>` — base64 + ansi escape codes                                                                                                                                                                                                                                                                                                           |
| **zip**                                     | `zip-command.ts`           | Create ZIP archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `<archive.zip> <file1> [file2...]`                                                                                                                                                                                                                                                                                                              |
| **unzip**                                   | `unzip-command.ts`         | Extract ZIP archive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `<archive.zip> [-d output-dir]`                                                                                                                                                                                                                                                                                                                 |
| **sqlite3**                                 | `sqlite-command.ts`        | Execute SQLite queries                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `-c "SELECT * FROM table" db.sqlite`                                                                                                                                                                                                                                                                                                            |
| **node**                                    | `node-command.ts`          | Execute JavaScript code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `-e "console.log(1+1)"` with fs bridge                                                                                                                                                                                                                                                                                                          |
| **python3 / python**                        | `python-command.ts`        | Execute Python code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `-c "print([i**2 for i in range(5)])"` with Pyodide                                                                                                                                                                                                                                                                                             |
| **webhook**                                 | `webhook-command.ts`       | Manage webhooks for event-driven licks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `webhook create <endpoint>`, `webhook list`, `webhook delete <id>`                                                                                                                                                                                                                                                                              |
| **websocat**                                | `websocat-command.ts`      | Minimal WebSocket client (netcat/curl for ws://). Sends stdin lines as messages, prints received messages. Client-only — server mode and advanced specifiers (`exec:`, `tcp:`, `broadcast:`, `ws-l:`) are not supported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `websocat ws://URL`, `-1` one-shot, `-b` binary, `--jsonrpc`/`--jsonrpc-omit-jsonrpc`, `--base64`, `--protocol`, `--max-messages`                                                                                                                                                                                                               |
| **crontask**                                | `crontask-command.ts`      | Schedule cron jobs that dispatch licks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `crontask add <name> "0 9 * * *" scoop-name "instructions..."`                                                                                                                                                                                                                                                                                  |
| **pdftk / pdf**                             | `pdftk-command.ts`         | PDF manipulation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `pdf burst input.pdf`, `pdf cat input.pdf output output.pdf`                                                                                                                                                                                                                                                                                    |
| **convert / magick**                        | `convert-command.ts`       | Image conversion (ImageMagick style)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `convert -resize 800x600 input.jpg output.jpg`                                                                                                                                                                                                                                                                                                  |
| **playwright-cli / playwright / puppeteer** | `playwright-command.ts`    | Browser automation shell CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `snapshot`, `click <ref>`, `cookie-set`, `tab-list`                                                                                                                                                                                                                                                                                             |
| **screencapture**                           | `screencapture-command.ts` | Capture user's screen via browser screen sharing API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `<output.png>`, `-c` (clipboard), `-v` / `--view` (agent vision)                                                                                                                                                                                                                                                                                |
| **upskill**                                 | `upskill-command.ts`       | Install skills from GitHub, the Tessl registry, or browse.sh; suggest skills for open browser tabs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `upskill owner/repo`, `upskill tessl:<name>`, `upskill browse:<host>/<task>`, `upskill search "query"`, `upskill tabs [--json]`                                                                                                                                                                                                                 |
| **sprinkle**                                | `sprinkle-command.ts`      | Manage `.shtml` sprinkle panels and inline chat UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `sprinkle list`, `sprinkle open <name>`, `sprinkle chat '<html>'`                                                                                                                                                                                                                                                                               |
| **cost**                                    | `cost-command.ts`          | Show session cost breakdown per scoop/cone                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `--json`, `-h`                                                                                                                                                                                                                                                                                                                                  |
| **models**                                  | `models-command.ts`        | List available LLM models with pricing and benchmarks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `--all`, `--json`, `--provider <id>`, `--refresh`                                                                                                                                                                                                                                                                                               |
| **secret**                                  | `secret-command.ts`        | Manage secrets (API keys, tokens) with domain-scoped injection. CLI: prints `~/.slicc/secrets.env` / Keychain edit instructions. Extension: writes to `chrome.storage.local` directly, or open the Options page (form UI) via `secret edit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `list`, `set <name> [<value>] --domain <patterns>`, `delete <name>`, `test <name> <url>`, `edit` (extension only — opens Options page)                                                                                                                                                                                                          |
| **mount**                                   | (MountCommands class)      | Mount local directories or remote storage (S3 / S3-compatible / DA) into the VFS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `mount [--source <url>] [--profile <name>] <path>`, `mount unmount [--clear-cache] <path>`, `mount list`, `mount refresh [--bodies] <path>`                                                                                                                                                                                                     |
| **mcp**                                     | `mcp-command.ts`           | Manage Model Context Protocol servers. Persists to `/workspace/.mcp/servers.json`, registers each as an `mcp:<name>` OAuth provider when auth is required, auto-writes a `.jsh` alias shim at `/workspace/.mcp/aliases/<name>.jsh`, and materializes MCP Apps as sprinkles under `/workspace/.mcp/sprinkles/<name>/`. Registration is lazy (re-registers from `servers.json` on the first subcommand call). OAuth discovery prefers RFC 9728 Protected Resource Metadata at `<server>/.well-known/oauth-protected-resource`, but transparently falls back to RFC 8414 Authorization Server Metadata at the server's own origin (`<server>/.well-known/oauth-authorization-server`) when PRM is absent — matching `mcp-remote` / Cloudflare-worker MCP servers. | `mcp add <url> [name]`, `mcp list`, `mcp delete <name>`, `mcp invoke <name> [tool] [--flag value]`, `mcp refresh <name>`                                                                                                                                                                                                                        |
| **git**                                     | (isomorphic-git)           | Full git support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `git clone`, `git commit`, `git push`, etc.                                                                                                                                                                                                                                                                                                     |
| **agent**                                   | `agent-command.ts`         | Spawn an ephemeral one-shot sub-scoop via `globalThis.__slicc_agent`. Shell surface for scoop delegation from any float. Inherits the parent's model when invoked from inside a scoop shell. Three positional args (no `--cwd`): `cwd`, `allowed-commands` glob, and the prompt. `--read-only` is pure-replace for `visiblePaths` — pass `--read-only "/docs/,$(pwd)"` to keep the cwd visible alongside read-only roots.                                                                                                                                                                                                                                                                                                                                      | `agent <cwd> <allowed-commands> "<prompt>"`, `--model <id>`, `--thinking <off\|low\|medium\|high>` (alias `--effort`), `--read-only <comma-separated-paths>`                                                                                                                                                                                    |
| **discover**                                | `discover-command.ts`      | Fetch a URL and surface RFC 8288 / RFC 9727 link-discovery results as JSON. Routes through the proxied fetch (CORS bypass + forbidden-header bridging). Output: `{ url, status, links[], handoff, discovery? }`. With `--follow`, also fetches P0 capability docs (api-catalog, service-desc, service-meta, status, llms.txt) and includes them under `discovery`. See [link-discovery.md](link-discovery.md). For listing installed skills, use `upskill --list` or read `/workspace/skills/`.                                                                                                                                                                                                                                                                | `discover <url>`, `discover --follow <url>`                                                                                                                                                                                                                                                                                                     |
| **tsc**                                     | `tsc-command.ts`           | Single-file TypeScript compiler over the bundled `typescript` package. Walks up from `ctx.cwd` to merge nearest `tsconfig.json`'s `compilerOptions` over `ES2022`/`ESNext` defaults. No cross-file program-level type checking.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `tsc [files...]`, `--noEmit`, `--outDir`, stdin → stdout                                                                                                                                                                                                                                                                                        |
| **test**                                    | `test-command.ts`          | Test runner over the [tst](https://github.com/dy/tst) library. Discovers `*.test.{js,ts}` in `ctx.cwd`, TS-transpiles each, runs each file in its own realm. Reporters: `tap` (default), `--reporter=spec` → tst `pretty`. Fork mode disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `test [glob]`, `--reporter=<tap\|spec>`                                                                                                                                                                                                                                                                                                         |
| **biome**                                   | `biome-command.ts`         | Biome linter/formatter via the wasm-nodejs build. Walks directories filtered to known extensions (JS/TS/JSON/CSS/GraphQL/HTML/Svelte/Vue/Astro). The 33 MB wasm binary is fetched on demand and Cache Storage-backed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `biome lint <path>`, `biome format <path>`, `biome check <path>`, `--write`, `--apply`, `--apply-unsafe`, `--stdin-file-path`                                                                                                                                                                                                                   |
| **esbuild**                                 | `esbuild-command.ts`       | esbuild bundler / transpiler. The 10 MB wasm binary is fetched on demand. A VFS plugin routes local paths through `ctx.fs` and bare specifiers through `https://esm.sh/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `esbuild <entry>`, `--bundle`, `--transform`, `--format`, `--minify`, `--sourcemap`, `--target`, `--loader`, `--outfile`                                                                                                                                                                                                                        |
| **ffmpeg**                                  | `ffmpeg-command.ts`        | ffmpeg.wasm — audio/video transcoding and processing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `ffmpeg -i input.mp4 -vcodec libx264 output.mp4`                                                                                                                                                                                                                                                                                                |
| **fswatch**                                 | `fswatch-command.ts`       | Watch a VFS path for changes via `globalThis.__slicc_fs_watcher` and route each change through `globalThis.__slicc_lick_handler` to a target scoop. Maintains an in-process `activeWatches` map.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `fswatch create --path <path> --pattern <glob> [--scoop <name>] [--name <name>]`, `fswatch list`, `fswatch delete <id>`                                                                                                                                                                                                                         |
| **ps**                                      | `ps-command.ts`            | List active processes from `ProcessManager` — scoop turns, tool calls, shell execs, jsh/python scripts. Equivalent to inspecting `/proc/` directly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `ps`, `--all`                                                                                                                                                                                                                                                                                                                                   |
| **kill**                                    | `kill-command.ts`          | Send a signal to a `ProcessManager`-tracked process. `SIGKILL` is uncatchable (worker.terminate() / iframe.remove(), exit 137).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `kill <pid>`, `kill -<SIGNAL> <pid>` (`SIGINT`/`SIGTERM`/`SIGKILL`/`SIGSTOP`/`SIGCONT`)                                                                                                                                                                                                                                                         |
| **rsync**                                   | `rsync-command.ts`         | Diff-aware copy between VFS paths (or mounted backends). Used for syncing workspace state into a mount, or vice versa.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `rsync <src> <dst>`, `--dry-run`, `--delete`                                                                                                                                                                                                                                                                                                    |
| **man**                                     | `man-command.ts`           | Print the embedded man-page for a given command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `man <command>`                                                                                                                                                                                                                                                                                                                                 |
| **dig**                                     | `dig-command.ts`           | DNS lookup via DoH (DNS-over-HTTPS). Uses a fixed Cloudflare resolver (`https://cloudflare-dns.com/dns-query`) and its JSON API, routed through the proxied fetch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `dig <name> [type]`, `+short`, `--json`                                                                                                                                                                                                                                                                                                         |
| **nuke**                                    | `nuke-command.ts`          | Wipe SLICC state. Clears IndexedDB (VFS, sessions, scoops, mounts, all five DBs) and reloads. Destructive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `nuke`, `--yes` (skip confirmation)                                                                                                                                                                                                                                                                                                             |
| **say**                                     | `say-command.ts`           | macOS `say`-equivalent — speak the text via the Web Speech API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `say "Hello"`, `-v <voice>`                                                                                                                                                                                                                                                                                                                     |
| **afplay / chime**                          | `afplay-command.ts`        | Play a sound file. `chime` is a convenience alias for the bundled notification sounds in `/shared/sounds/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `afplay <path>`, `chime [done\|alert\|...]`                                                                                                                                                                                                                                                                                                     |
| **pbcopy / pbpaste / xclip / xsel**         | `clipboard-commands.ts`    | Copy stdin to the clipboard / paste clipboard to stdout via the browser Clipboard API. All four aliases share the same implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `echo hi \| pbcopy`, `pbpaste`                                                                                                                                                                                                                                                                                                                  |

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
serve /workspace/app

# Same, with a custom entry file
serve --entry pages/home.html /workspace/app

# Opt into leader-managed live updates (Phase 2). Cherry-attached followers
# default-on; --no-bridge always wins over both --bridge and the default.
serve --bridge /workspace/app

# Open a VFS file in a browser tab (legacy local preview service worker —
# unified worker preview takes over via `serve`; this path stays for
# direct one-off file opens pre-Phase-3 SW deletion)
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

## playwright-cli

Browser automation is also exposed as shell commands: `playwright-cli`, `playwright`, and `puppeteer`.

- **Shared state across aliases**: all three names operate on the same current tab, snapshot cache, cookies/storage context, and `/.playwright/session.md` history.
- **Default targeting**: `open` / `tab-new` open in the background by default, but if there is no current browser target yet, the first opened tab becomes current so `snapshot` works immediately.
- **Fresh refs required**: `click`, `fill`, `goto`, `go-back`, `go-forward`, `reload`, and similar state-changing commands invalidate prior snapshot refs. After history navigation or reload, run `snapshot` again before using refs.
- **Cookie convenience forms**: `cookie-set <name> <value>` and `cookie-delete <name>` use the current page URL when `--domain` and `--path` are omitted.
- **Teleport restores auth state**: arm it explicitly with `playwright teleport --start=<regex> --return=<regex>` or implicitly with `--teleport-start` / `--teleport-return` on `open`, `tab-new`, or `goto` / `navigate`. When the leader hits `--start`, the intercepted auth URL opens on a follower for the human to finish login; when the follower hits `--return`, teleport restores both cookies and page storage (`localStorage` + `sessionStorage`) back to the leader. For cross-origin SSO flows, teleport hydrates the captured app origin first, then lands on the best matching app URL. Teleport needs a follower with `Network.*` (cookie/storage) access, so a cherry host target is never eligible — auto-selection skips it and an explicit `teleport --runtime <id>` naming a cherry host is rejected at arm time.
- **Unexpected dialogs**: attached pages auto-dismiss unexpected JavaScript dialogs so a stray `alert()` or similar modal does not stall automation indefinitely.
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

Implementation lives outside `supplemental-commands/`: `packages/webapp/src/fs/mount-commands.ts` is the dispatcher, registered via the `MountCommands` class consumed by `wasm-shell.ts`. Backends are under `packages/webapp/src/fs/mount/`.

### Subcommands

| Form                                               | Behavior                                                                                                                                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mount <path>`                                     | Local FS Access mount. Opens a directory picker (cone-only — fails fast in scoops, which have no UI gesture).                                                                                                                                                    |
| `mount --source s3://<bucket>[/<prefix>] <path>`   | S3 / S3-compatible mount. Reads creds from `s3.<profile>.*` secrets (`--profile` selects the namespace; defaults to `default`). Allowed in scoops.                                                                                                               |
| `mount --source da://<org>/<repo>[/<path>] <path>` | Adobe da.live mount. Reuses the existing Adobe provider's IMS bearer token; `--profile` is accepted for symmetry but has a single global identity in v1. Allowed in scoops.                                                                                      |
| `mount list`                                       | Show all active mounts with their kind, source, and profile (where applicable).                                                                                                                                                                                  |
| `mount unmount [--clear-cache] <path>`             | Tear down a mount. `--clear-cache` also drops cached listings + bodies for that mount; without it, cache entries persist until TTL or the next session.                                                                                                          |
| `mount refresh [--bodies] <path>`                  | Re-walk the source and diff against the cache. Prints `Refreshed <path>: +<added> -<removed> ~<changed> (<unchanged> unchanged, <errors> errors)`. Without `--bodies` only the listing is rechecked; with `--bodies` changed files are conditionally re-fetched. |

### Mount-time flags

| Flag                | Applies to    | Effect                                                                                                                                                                                 |
| ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--source <url>`    | mount         | Selects a remote backend by URL scheme (`s3://`, `da://`). Without `--source`, the local picker is used.                                                                               |
| `--profile <name>`  | mount         | Profile name resolved against `s3.<profile>.*` secrets (S3) or used as a label (DA). Defaults to `default`.                                                                            |
| `--no-probe`        | mount         | Skip the mount-time `HEAD` bucket / `GET /list` round-trip. Use when latency matters and you trust the source URL is well-formed and accessible.                                       |
| `--max-body-mb <n>` | mount         | Override the per-mount maximum body size for read/write. Defaults: S3 25 MB, DA 5 MB. Files exceeding the threshold throw `EFBIG` before any body bytes flow.                          |
| `--clear-cache`     | mount unmount | Drop the `RemoteMountCache` entries (listings + bodies) for this mount.                                                                                                                |
| `--bodies`          | mount refresh | After the listing diff, conditionally re-fetch bodies for paths whose ETag changed. Without this flag a refresh is one paginated list (or one DA recursive walk) plus zero body bytes. |

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

Only **local** mounts render an approval card. The card is not a consent gate — it's the click that satisfies Chrome's user-gesture rule for the File System Access API, since `showDirectoryPicker()` must be invoked from inside a user event handler. In the extension, the click also routes through a popup window because Chrome crashes if the picker is invoked from side-panel context for system directories.

**S3** and **DA** mounts have no approval card. The trust boundary lives at the credential profile resolver in node-server (`/api/s3-sign-and-forward`, `/api/da-sign-and-forward`) or the SW signing path in extension mode — not in the chat. The probe at mount time will fail with an actionable error if the profile is misconfigured.

Local mounts are gated to cone context only because the directory picker requires a real user gesture. S3 and DA mounts are allowed from scoops since their credentials come from the secret store and no UI gesture is required.

---

## .jsh Script Commands

JavaScript shell scripts auto-discovered anywhere on the VirtualFS. Executable like any shell command.

**Discovery**: `jsh-discovery.ts` scans VFS with priority roots:

```
Priority: /workspace/skills/
Then: / (full filesystem scan)

Rule: First basename wins (no conflicts)
```

`script-catalog.ts` is the shared lookup layer used by `WasmShell`, `which`, and browser-script matching. When an `FsWatcher` is present it caches discovery results and clears them on filesystem changes; mounted directories bypass the cache because external edits inside File System Access mounts are not observable through the watcher.

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

// Example: get an OAuth token
const r = await exec('oauth-token adobe');
const token = r.stdout.trim();

// Example: list files
const ls = await exec('ls -la /workspace');
console.log(ls.stdout);
```

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

- **Command startup**: <100ms (just-bash WASM initialization)
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

| Module                                                  | Status                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `fs`                                                    | ✅ VFS bridge (readFile, writeFile, readDir, exists, stat, mkdir, rm) |
| `process`                                               | ✅ Shim (argv, env, cwd, exit, stdout, stderr)                        |
| `buffer`                                                | ✅ Browser polyfill                                                   |
| `path`                                                  | ✅ Via esm.sh (browser polyfill)                                      |
| `url`, `querystring`, `util`, `events`, `assert`        | ✅ Via esm.sh                                                         |
| `http`, `https`, `crypto`, `net`, `child_process`, etc. | ❌ Not available in browser                                           |

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

# Show instructions for adding a new secret
secret set API_KEY
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
