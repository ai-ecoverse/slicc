# Pi 0.99.1: MCP tools, QuickJS codemode, and an `mcp` CLI shim

Status: exploration. Nothing here is wired. This note records what Pi 0.99.1
ships, what of it runs in SLICC's browser runtime, and a phased plan to adopt
Pi's MCP tools and codemode while keeping the `mcp` shell command working.

Context: Earendil's ["You said no MCP!"](https://earendil.com/posts/you-said-no-mcp/)
(2026-09-29) moved MCP into Pi core, with codemode (a QuickJS sandbox that
calls tools from model-written JavaScript) turned on by default whenever MCP is
configured.

## What 0.99.1 ships

The MCP work is split into two standalone packages. `pi-coding-agent` wires
them up as built-in extensions.

| Package                                                      | Deps                  | What it is                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@earendil-works/pi-mcp`                                     | `cross-spawn`         | MCP client without the official SDK: `McpClient`, `StreamableHttpTransport` (injectable `fetch`, `AuthProvider`, GET stream, `Last-Event-ID` resumption), `StdioTransport`, `toLlmContent()`. `./oauth` covers discovery, DCR, PKCE, refresh, and step-up. `./testing` has an in-memory transport pair.      |
| `@earendil-works/pi-codemode`                                | `quickjs-wasi@3.6.2`  | `CodemodeSandbox`: model-written JS runs in a fresh QuickJS-NG wasm VM, one worker per `execute()`. The only thing a script can do is call the injected `tools.*` / globals. `renderDeclarations()` turns tool schemas into TypeScript for the tool description, and `store`/`load` keep state across calls. |
| `pi-coding-agent/dist/extensions/{mcp,codemode,tool-search}` | Node fs/path/http/TUI | The `mcp.json` config, `mcp__<server>__<tool>` naming, exposure modes, the `codemode` and `tool_search` tools, BM25 `searchTools()`, and resource tools.                                                                                                                                                     |

Exposure modes (`docs/mcp.md` in pi-coding-agent) control how the model
reaches each server's tools:

- `codemode` (default): callable from scripts and listed in the `codemode`
  tool's description, but not declared as tools.
- `codemode-deferred`: callable from scripts; the description names only the
  server and its tool count.
- `deferred`: not declared until `tool_search` loads them.
- `direct`: declared like built-in tools.
- `hidden`: registered but not callable.

`toolExposure` overrides the mode per tool, with glob patterns.

Nested calls go through `runToolCall()` from `pi-agent-core`, so the
`beforeToolCall`/`afterToolCall` hooks (and with them permission gates) also
apply to calls a script makes.

## What runs in the browser

SLICC only instantiates `pi-agent-core`'s `Agent`
(`scoops/scoop-context/agent-factory.ts`). From `pi-coding-agent` it
deep-imports just compaction and truncate. `AgentSession` and the extension
runner are never used, so we get none of Pi's built-in MCP wiring for free.

| Piece                                            | Browser-safe? | Blocker / fix                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-mcp` `McpClient` + `StreamableHttpTransport` | Yes           | Import the deep paths (`dist/client.js`, `dist/transports/streamable-http.js`), or alias `dist/transports/stdio.js` to a stub. The package index re-exports stdio, which pulls in `node:child_process` and `cross-spawn`.                                                                                                                                                       |
| `pi-mcp/oauth`                                   | Mostly        | `callback.js` uses `node:http` (a loopback server). We keep SLICC's redirect topology (`resolveMcpRedirectUri`) and stub `callback.js`. Discovery, DCR, PKCE, and `authorizeMcp` are plain `fetch`.                                                                                                                                                                             |
| `quickjs-wasi`                                   | Yes           | Pure WASI shim plus a 637 KB `quickjs.wasm`.                                                                                                                                                                                                                                                                                                                                    |
| `pi-codemode` host/worker                        | No, but small | `runtime/host.js` and `runtime/worker.js` use `node:worker_threads` (`Worker`, `parentPort`, `workerData`). `wasm.js` uses `node:fs/promises` + `node:module#createRequire`, which is only reached through `loadQuickJSWasm()`; pass `wasm` explicitly. `node:module` is already aliased to `shims/empty.ts`, which lacks `createRequire`, so the named import fails the build. |
| `pi-codemode/declarations`, `/source`            | Yes           | Pure.                                                                                                                                                                                                                                                                                                                                                                           |
| coding-agent `codemode/tool.js`                  | Mostly        | Its description and prompt logic are portable, but `execute.js` spills output to temp files through `node:fs`/`node:os`. Re-implement the thin executor instead of importing it.                                                                                                                                                                                                |
| coding-agent `tool-search/tool.js`               | Yes           | Only depends on `typebox`. The BM25 ranker can be reused as-is through a deep-import alias.                                                                                                                                                                                                                                                                                     |
| coding-agent `mcp/*`                             | No            | fs config, TUI, and `node:http` OAuth. Don't import it; mirror the config shape instead.                                                                                                                                                                                                                                                                                        |

Protocol gap: SLICC's client already speaks `2026-07-28` (stateless
`server/discover`) and falls back to `2025-06-18`. `pi-mcp` negotiates
`2025-11-25` down to `2024-11-05` and has no `server/discover`. SLICC also
calls the non-standard `apps/list` for MCP Apps sprinkles. Until upstream
catches up, both clients sit behind one interface (Phase 1).

## Phase 0: bump the pin (0.84.4 → 0.99.1)

- Every deep path SLICC imports still exists in 0.99.1:
  - `pi-coding-agent/dist/core/compaction/compaction.js` and `core/tools/truncate.js`
  - `pi-agent-core/dist/harness/tools/edit.js`
  - `pi-ai/dist/api/{simple-options,transform-messages}.js`
  - `pi-ai/compat`
  - `pi-ai/providers/{all,openrouter.models}`
- Breaking changes that reach SLICC:
  - 0.86.0: custom provider stream inputs are now `TranscriptContext`, so
    system prompt and tools are read through `getCurrentSystemPrompt()`/`getCurrentTools()`.
    Audit every `streamFn`/custom provider under `packages/webapp/src/providers/`.
  - 0.86.0: `ToolCall.arguments` and `ToolResultMessage.details` must be
    JSON-compatible, and `ToolResultMessage` became a conditional type.
    `core/tool-adapter.ts` details and the transcript export need a typecheck pass.
  - 0.87.0: `shouldStopAfterTurn` was replaced by `finishTurn`. SLICC doesn't
    pass it today, so nothing to do; confirm with a grep.
  - `AgentState` now opens with a leading system message built from
    `systemPrompt` + `tools`. Check compaction's `sameMessages` guard and the
    transcript exporter against that extra first entry.
- The new transitive deps (`@earendil-works/chord`, `pi-telemetry`) must bundle
  cleanly in both `vite build`s. `stubPiNodeInternalsPlugin` may need new
  targets, and the same stubs go into `worker.plugins`.
- Ship this bump as its own PR with no behaviour change.

## Phase 1: MCP tools through `pi-mcp`

A new module, `packages/webapp/src/shell/mcp/connection-manager.ts`, lives in
the kernel worker and is shared by the agent tools and the shell:

- It owns one live connection per entry in `/workspace/.mcp/servers.json`.
- The interface is `McpConnection { listTools(); callTool(name, args, {signal}); listApps?() }`,
  with two implementations:
  - `PiMcpConnection` wraps `pi-mcp`'s `McpClient` +
    `StreamableHttpTransport` for servers negotiating ≤ `2025-11-25`. It gets the
    GET stream, `tools/list_changed`, progress timeout renewal, and cancellation for free.
  - `LegacySliccConnection` wraps the existing `shell/mcp/client.ts` for
    `2026-07-28` servers and for `apps/list`.
  - Selection: try the SLICC `server/discover` probe first (cheap and stateless).
    On `-32601` or a 4xx, use `PiMcpConnection`. Cache the result in `servers.json`
    as `transport: "pi" | "slicc"`. The field is additive, so `version: 1` stays.
- Fetch: adapt `createProxiedFetch()` into `pi-mcp`'s WHATWG
  `McpFetch = (input, init) => Promise<Response>`. That is the inverse of today's
  `wrapProxiedFetchAsMcpFetch`. CLI uses `/api/fetch-proxy`, and the extension
  path is unchanged. Streaming SSE bodies need the proxy to pass
  `ReadableStream`s through; verify `fetch-proxy.ts` doesn't buffer
  `text/event-stream`.
- Auth: an `AuthProvider` backed by the existing `mcp:<name>` dynamic
  provider (`provider.ts`):
  - `token()` reads the account store.
  - `onUnauthorized()` runs the existing silent-renewal path and falls back
    to the popup.
  - Tokens stay in `slicc_accounts`. We do not adopt `pi-mcp/oauth`'s state
    store, because provider registration, `oauth-token --list`, and follower
    delegation all key off the account store.
- Tools: `toAgentTools(connection, exposure)` produces `AgentTool`s named
  `mcp__<server>__<tool>` (Pi's convention, sanitized to 64 chars of
  `[A-Za-z0-9_-]`). They set `outputSchema` so `structuredContent` passes through,
  and return `toLlmContent(result)` with `isError`.
  - Text over 20 KB is cut in the middle, as Pi does. The full text is written
    to `/tmp/mcp/<id>.txt` in the VFS instead of an OS temp file.
- Exposure: add `exposure` and `toolExposure` to `McpServerEntry` with Pi's
  vocabulary. The default is `codemode`.
- Mid-session tools: `Agent.state.tools` is assignable in 0.99.1 (it copies
  the array). The manager emits `tools-changed`, and `runtime-init.ts`
  rebuilds `direct` tools plus `codemode`/`tool_search` and assigns them
  between turns, never mid-stream. Today nothing mutates tools after init, so
  this is a new invariant; guard it with a test.
- Scoops: sandboxed scoops only get MCP tools the cone grants (`feed_scoop`
  capability). Default to none. Biscotto guests: MCP tools go through
  `biscotto-gate.ts` like any other tool call.

## Phase 2: codemode on QuickJS in the browser

Don't fork `pi-codemode`. Alias its two Node imports in `vite.config.ts` (in
both `resolve.alias` and `worker.plugins`):

- `node:worker_threads` → `src/shims/worker-threads.ts`. This is a ~60-line adapter.
  - Host side: `class Worker` wraps `new globalThis.Worker(url, { type: 'module' })`
    and maps `on('message'|'error'|'exit')`. It posts `workerData` as the first
    message and emits `exit` from `terminate()`.
    - `WebAssembly.Module` and `SharedArrayBuffer` are structured-cloneable to
      a dedicated worker, so `workerData` survives the post intact.
  - Worker side: a SLICC entry file `kernel/codemode-worker.ts` waits for the
    first message and sets the shim's exported live bindings `workerData` and
    `parentPort`. Only then does it `await import('@earendil-works/pi-codemode/worker')`.
    - That module reads `parentPort`/`workerData` at top level, which is why the
      import has to be dynamic.
  - Pass `workerUrl: new URL('./codemode-worker.ts', import.meta.url)` so Vite
    emits it as a worker chunk. It is nested under the kernel worker, which
    Chrome supports.
- `node:fs/promises` / `node:module`: never reached, because we pass `wasm`. Give
  `shims/empty.ts` a `createRequire` that throws, which fixes the named import.
- Wasm: compile `quickjs.wasm` once per kernel with
  `WebAssembly.compileStreaming(fetch(url))`. Fetch the URL the same way
  magick/v86 do (a versioned CDN/package URL injected through `define`), so it
  isn't bundled. The bundle-size cost is then ~0, and a 637 KB fetch happens on
  the first codemode call.
- Interrupts: the host allocates `new SharedArrayBuffer(4)`.
  - The hosted leader has SAB through Document-Isolation-Policy
    (`cloudflare-worker/src/index.ts`, #2036), and so do its nested workers.
  - Cherry, Electron overlays, and pre-137 Chrome don't. There the shim installs
    `globalThis.SharedArrayBuffer ??= ArrayBuffer` for the pi-codemode import only.
    - That's safe because browser `worker.terminate()` does stop a thread
      spinning in wasm. The SAB flag exists for Bun.
- The `codemode` tool: SLICC's own `AgentTool`, modelled on the coding agent's
  `codemode/tool.js`.
  - Its description is built with `renderDeclarations` +
    `MCP_TYPESCRIPT_PREAMBLE`, with a token budget and `searchTools()` (BM25 from
    `tool-search/tool.js`).
  - Nested calls go through `runToolCall()` with the agent's hooks, so
    secret-scrubbing, the guest gate, and the process manager keep applying.
  - `store()` writes go into a transcript custom entry, so fork and resume see them.
- What scripts can call:
  - Every non-`hidden` MCP tool.
  - `bash`, `read_file`, and `write_file`. This makes codemode the realm-free way
    to chain shell commands and MCP calls without dumping intermediate output
    into context.
  - Scoop-management tools stay out.
- Relation to `node -e` / `.jsh`: those keep running in the full JS realm
  (V8, Node shims, VFS). Codemode is deliberately weaker: no fetch, no fs, only
  tools. That is exactly what makes it safe to enable by default for MCP.

## Phase 3: back-compat shim for the `mcp` CLI

Every existing surface keeps working. What changes is that the command
becomes a thin client of the connection manager instead of owning its own
`McpClient`.

| Command                                       | Today                                          | After                                                                                                                                                                                                              |
| --------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mcp add <url> <name>`                        | probe, OAuth, persist, alias `.jsh`, sprinkles | Same, plus `--exposure <mode>`. The manager connects and tools appear on the next turn.                                                                                                                            |
| `mcp list`                                    | table                                          | Adds `STATE`, `EXPOSURE`, `TRANSPORT`, and `TOOLS` columns, plus `--json`.                                                                                                                                         |
| `mcp invoke <n> <t> …`                        | own client, `renderToolResult`                 | Routes through `manager.get(n).callTool`, reusing the live session. Flag coercion, `--timeout`, and exit codes are unchanged. New `--json` prints the raw `CallToolResult` (`structuredContent` is dropped today). |
| `mcp search <q>`                              | substring over cached tools                    | BM25 ranker shared with `tool_search`.                                                                                                                                                                             |
| `mcp refresh` / `auth`                        | unchanged                                      | Also calls `manager.reconnect(n)`.                                                                                                                                                                                 |
| `mcp delete <n>`                              | removes all                                    | Also `manager.disconnect(n)` and fires `tools-changed`.                                                                                                                                                            |
| new `mcp exposure <n> <mode> [--tool <glob>]` | —                                              | Edits `exposure`/`toolExposure`.                                                                                                                                                                                   |
| new `mcp import <file>`                       | —                                              | Reads a Pi/Claude/Cursor `mcpServers` JSON. `url` entries are imported and `command` (stdio) entries are skipped with a warning, since there's no process spawning in the browser; see open questions.             |

- The alias shims in `/workspace/.mcp/aliases/*.jsh` stay byte-for-byte
  identical: they still `exec('mcp invoke …')`. Existing workspaces and skills
  keep working without regeneration.
- MCP Apps sprinkles keep `window.mcpInvoke`, which now lands in the manager.
- Plugin-bridged servers (`pluginOrigin`) default to `exposure: codemode`.
- Update `vfs-root/workspace/skills/*` (and the skill that documents `mcp`) to
  say that MCP tools are also native tools. Scripts should still use the CLI;
  the agent should prefer `codemode`.

## Open questions

1. Stdio servers. The browser can't spawn processes. Should node-server
   (CLI float) host a stdio-to-HTTP bridge at `/api/mcp/<name>`? It
   would reuse `pi-mcp`'s `StdioTransport` and its process-group shutdown
   server-side. That breaks "server is a stateless relay", so it would need to
   be opt-in, CLI-only, and hidden behind a flag.
2. Upstreaming. `pi-codemode` could accept an injectable `WorkerLike` factory,
   and `pi-mcp` could split stdio out of its index. Either would delete one of
   our shims. `2026-07-28` support in `pi-mcp` would delete
   `LegacySliccConnection`.
3. Should `codemode` be enabled without MCP servers too, as a generic
   tool-composition tool over `bash`/file tools? Benchmark with
   `packages/bench` before defaulting it on.
4. Follower parity. Tray followers receive tool calls from the leader. Nested
   codemode calls execute leader-side, so check that follower rails don't
   assume one tool call per model turn.

## Verification plan for the implementation PRs

- Phase 0: `npm run typecheck`, the full `test` + `test:coverage`, both builds,
  and the `cdp-smoke-test` Tier 2 agent loop.
- Phase 1: `pi-mcp/testing`'s in-memory transport pair drives
  `connection-manager` tests: list-changed, reconnect, 401 → `onUnauthorized`,
  and the 20 KB truncation. Keep the existing `tests/shell/mcp/*` green; the
  legacy client stays.
- Phase 2: run the codemode sandbox under Vitest with a real Node
  `worker_threads` (the shim isn't needed there). Add a browser test through
  `cdp-smoke-test` for the shim path. Cover the SAB-less fallback by stubbing
  `SharedArrayBuffer`, and check that a runaway `while(true){}` is terminated.
- Phase 3: `mcp-command.test.ts` golden output for `invoke`/`list`, and an
  alias shim that runs unchanged against the manager.
