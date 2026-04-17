# Architecture — `agent` supplemental shell command

High-level description of how the new `agent` command fits into SLICC.

## Summary

`agent` is a new supplemental command in the WasmShell layer. It spawns an ephemeral sub-scoop, feeds it a task, blocks until the scoop's agent loop completes, prints the scoop's final message on stdout, then cleans up the scratch folder.

It is a **parallel mechanism** to the existing `scoop_scoop` / `feed_scoop` / `drop_scoop` tool surface. Those tools remain unchanged and continue to work at the agent-tool level for the cone. The new command operates at the shell level and is available from any bash invocation — the cone's bash, any scoop's bash, or nested bash inside another `agent` call.

## Components

### 1. `agent-command.ts` (NEW)

Location: `packages/webapp/src/shell/supplemental-commands/agent-command.ts`

- Exports `createAgentCommand(): Command` factory following the existing supplemental command pattern
- Parses CLI arguments: `<cwd>` `<allowed-commands>` `<prompt>` plus `--model <id>` / `-h` / `--help`
- Resolves `cwd` against `ctx.cwd` when relative
- Reads the orchestrator bridge from `globalThis.__slicc_agent`
- Calls the bridge's `spawn(opts)` which returns a Promise resolving to `{ finalText, exitCode }`
- Returns `{ stdout: finalText + '\n', stderr: '', exitCode }` to the shell

### 2. Orchestrator bridge (NEW)

Location: `packages/webapp/src/scoops/agent-bridge.ts` (or equivalent)

- Exposes `createAgentBridge(orchestrator: Orchestrator): AgentBridge`
- `spawn({ cwd, allowedCommands, prompt, modelId?, parentJid? })`:
  1. Generates a unique folder `agent-<uid>`, builds a `RegisteredScoop` record with `isCone: false`
  2. Constructs a `RestrictedFS` with:
     - R/W: `/scoops/<folder>/`, `/shared/`, and the user-supplied `cwd`
     - R/O: `/workspace/`
  3. Instantiates a `ScoopContext` directly (not via `orchestrator.registerScoop`) so we can install our own callbacks and own the lifecycle
  4. Wraps the bash tool with an allow-list (see below) if `allowedCommands !== ['*']`
  5. Resolves the effective model with precedence `modelId` override → parent scoop/cone from `parentJid` → inherited global fallback. The real `ScoopContext` path only observes that choice if it is also copied onto `RegisteredScoop.config.modelId` before `ctx.init()`.
  6. Registers the scoop in the orchestrator's map for visibility during the run while still owning init/dispose locally
  7. Awaits `ctx.prompt(promptText)` — blocks until agent loop completes
  8. Determines output via `pickChronologicallyLastOutput(messages, captured)`: walks `ctx.getAgentMessages()` in reverse, walking each assistant message's `content` blocks in reverse, and returns the first qualifying block — either a non-empty assistant-text block or a `send_message` toolCall whose corresponding `captured[]` entry is returned. Falls back to `captured[last]` if the walk finds nothing but `captured[]` is non-empty (preserves legacy mock-driven callers), and to `''` otherwise. This implements VAL-OUTPUT-016: "whichever came LAST chronologically wins." The companion system-prompt update at `packages/webapp/src/scoops/scoop-context.ts` (the "When using send_message" section of `buildSystemPrompt`) tells agents "your last message wins" so their emit patterns align with this semantic — a `send_message("Starting.")` progress update followed by a plain-text final answer now correctly surfaces the plain-text answer as `agent` stdout.
  9. Disposes ScoopContext and deletes `/scoops/<folder>/` from the VFS
  10. Returns `{ finalText, exitCode: 0 }` on success; on agent error returns `{ finalText: errMsg, exitCode: 1 }`

### 3. Global bridge hook (NEW)

Location: published from `packages/webapp/src/ui/main.ts` (CLI) and `packages/chrome-extension/src/offscreen.ts` (extension)

- After `Orchestrator` is instantiated, set `(globalThis as any).__slicc_agent = createAgentBridge(orchestrator)`
- This lets the supplemental command reach the orchestrator without dependency-injection plumbing through `SupplementalCommandsConfig`
- Pattern matches existing hooks (`__slicc_sprinkleManager`, `__slicc_lick_handler`, `__slicc_lickManager`, etc.)
- In extension mode, publishing only from `offscreen.ts` is not sufficient for the side-panel Terminal tab: the panel shell and offscreen shell do **not** share window globals, so panel-facing `agent` support needs a relay/proxy or a panel-local hook.

### 4. Bash-tool allow-list wrapper (NEW)

Location: `packages/webapp/src/tools/bash-tool-allowlist.ts` (new helper)

- `wrapBashToolWithAllowlist(bashTool, allowedCommands)` returns a wrapped tool
- If `allowedCommands` contains `*`, returns the original tool unchanged
- Otherwise, enforcement is **AST-backed**: each bash invocation is parsed with `just-bash`'s `parse()` function (exposed via the vendored browser bundle) and the resulting `ScriptNode` is walked to validate the command. The hand-rolled character-level scanner (quote-state tracker + segment splitter + head extractor + grouped-subshell detector) has been deleted in favor of this AST walker.
- The walker:
  - Calls `parse()` in a try/catch — any `ParseException` / `LexerError` / unexpected error becomes a clean `AgentToolResult` rejection, never a thrown exception.
  - Iterates `ScriptNode.statements` → `pipelines` → `commands`.
  - Rejects any compound command (`Subshell`, `Group`, `If`, `For`, `CStyleFor`, `While`, `Until`, `Case`, `ArithmeticCommand`, `ConditionalCommand`, `FunctionDef`) — the allow-list cannot reason about their inner heads.
  - For each `SimpleCommand`: extracts the literal head by walking `WordNode.parts` and joining only `Literal` / `SingleQuoted` / `Escaped` / nested-literal `DoubleQuoted` parts. Any `ParameterExpansion`, `CommandSubstitution`, `ArithmeticExpansion`, or `ProcessSubstitution` part at the head position triggers a non-literal-head rejection.
  - For each `SimpleCommand`: iterates `cmd.assignments` and walks both `assignment.value.parts` (when set) and each element of `assignment.array` (when set). Pre-command assignments (`FOO=$(whoami) ls`, `ARR=($(whoami)) ls`, `FOO+=$(whoami) ls`) execute BEFORE the command name, so a substitution smuggled here would fire even when the head itself is allow-listed.
  - Walks the reachable word-bearing nodes conservatively and rejects any `CommandSubstitutionPart` / `ArithmeticExpansionPart` / `ProcessSubstitutionPart` at any nesting depth. Plain parameter expansion without nested word operands is not itself a command head, but parameter-expansion defaults/assignments still carry nested `WordNode`s that matter for allow-list safety.
  - Descends into every `ParameterExpansion.operation` variant that holds a nested `WordNode`: `DefaultValue`, `AssignDefault`, `ErrorIfUnset`, `UseAlternative` (`.word`), `PatternRemoval` (`.pattern`), `PatternReplacement` (`.pattern` + `.replacement`), `CaseModification` (`.pattern`). For `Substring` (which carries `ArithmeticExpressionNode`s instead of `WordNode`s), it walks the `ArithExpr` tree and rejects any `ArithCommandSubst` node. For `Indirection`, it recurses into `operation.innerOp` and re-applies the same switch.
  - Descends into `BraceExpansion.items[]` and walks `item.word.parts` whenever `item.type === 'Word'`. `Range` items (`{1..5}`) carry only numeric/string primitives and are left alone.
  - `StatementNode.background === true` (bare `&`) is NOT grounds to reject — every pipeline head has already been checked.
- Preserves wildcard `*` passthrough, case-sensitive matching, duplicate-entry tolerance, and atomic rejection (no partial run) from the original design.

#### just-bash AST gotchas

- `&&` / `||` chains stay within a single `StatementNode`; for example, `ls -la | wc -l && echo done` parses as **one** statement with multiple `PipelineNode`s, not two top-level statements.
- Security-sensitive traversal cannot stop at top-level args and redirection targets: just-bash also nests executable `WordNode`s inside `AssignmentNode.value`, `AssignmentNode.array[i]` (array assignments like `ARR=(…)`), `ParameterExpansion.operation.*` (defaults, pattern-removal/replacement, case-modification, and the recursive `Indirection.innerOp`), `Substring.offset` / `.length` (as `ArithmeticExpressionNode` trees whose `ArithCommandSubst` or `ArithBracedExpansion` leaves can encode `$(…)` inside arithmetic context), and `BraceExpansion.items[].word` (for `Word`-variant brace items). The allow-list walker covers the assignment / parameter-expansion / brace-expansion cases AND the substring-arithmetic leaf variants — `ArithCommandSubst`, `ArithBracedExpansion`, and `ArithSyntaxError` are all rejected in `walkArithExpr`.
- Two leaf-ish `ArithExpr` variants warrant explicit rejection rather than safe structural recursion:
  - `ArithBracedExpansion` — shape `{ type, content: string }` (see `packages/webapp/src/vendor/just-bash/dist/ast/types.d.ts` lines 377–380). Produced by the arithmetic parser whenever it encounters a `${…}` form it cannot further parse while decoding substring offsets/lengths (e.g., `${FOO:0:${BAR:-$(whoami)}}` parses to `length = ArithBracedExpansion{content: 'BAR:-$(whoami)'}`). Because the node carries ONLY a raw `content` string — no nested AST — the walker cannot inspect the substitution payload structurally. Conservative rejection is the right call; the wildcard `*` allow-list remains the documented escape hatch.
  - `ArithSyntaxError` — shape `{ type, errorToken, message }` (types.d.ts lines 419–423). Emitted whenever the arithmetic parser cannot lex/parse a fragment (e.g., `${FOO:0:$((1 + $(whoami)))}` parses the outer length as `ArithSyntaxError`). Bash would still evaluate the original source at runtime, so accepting it is unsafe — reject conservatively.
- `just-bash` parses `<(cmd)` as a redirection (`ParseException: Expected redirection target` when it appears at an assignment value position); the allow-list's generic parse-error rejection path catches that. By contrast, the parser treats `$(…)` inside `CaseModification.pattern` as a single `Literal` part rather than a nested `CommandSubstitution`, so that one particular bypass cannot be triggered through the parser today — but the walker still recurses into `CaseModification.pattern` as defense-in-depth.
- If a future allow-list change needs CI-backed confidence about parser shape, keep at least one assertion on a `tsc`-covered path rather than relying solely on Vitest `.test.ts` files.

### 5. RestrictedFS extension (MODIFICATION)

The existing `RestrictedFS` already supports multiple R/W and R/O prefixes. The agent bridge supplies custom prefix arrays — no change to `RestrictedFS` internals needed.

#### RestrictedFS exposes the full VfsAdapter surface (sync + async + realpath) with ancestor-symlink ACL parity

`packages/webapp/src/shell/vfs-adapter.ts` — the bridge between just-bash and our VFS — calls **synchronous fast-path methods** on its `vfs` field before falling back to async: `statSync`, `lstatSync`, `readDirSync`, plus async `realpath`. Non-cone scoops wrap the VFS in `RestrictedFS` and pass that instance to `WasmShell` (see `scoop-context.ts`: `this.shell = new WasmShell({ fs: this.fs as VirtualFS, ... })`), so `RestrictedFS` MUST implement those four methods itself with the same ACL as its async counterparts.

Historical note (2026-04-17): Before this contract was pinned down, `RestrictedFS` implemented only the async methods. `VfsAdapter` would call `undefined(...)` inside the sync branch and the resulting `TypeError` was surfaced by the shell as `No such file or directory` / exit code 2. The user-visible symptom was that every bridge-spawned scoop's bash tool shell failed on `ls`, `cat`, `find`, and friends — while `pwd`, `date`, `echo` worked because they never touch the filesystem. See VAL-FS-021 + VAL-FS-022.

The surface `RestrictedFS` now exposes (plus one caveat future workers should remember):

- **`statSync(path): Stats | null`** — returns `null` (no throw) for disallowed paths, matching `VirtualFS.statSync` null semantics. Returns `null` for allowed paths that are symlinks (forcing the adapter to fall back to the async `stat()`, which enforces symlink-escape ACL via `resolveAndCheckRead`).
- **`lstatSync(path): Stats | null`** — returns `null` (no throw) for disallowed paths. Does NOT follow the leaf symlink, but returns `null` when any ancestor is a symlink so the adapter falls back to async `lstat()`. The async `lstat()` fallback now enforces the same ancestor-symlink ACL: it resolves the PARENT directory via `vfs.realpath(dir)`, rejoins the leaf, and throws `ENOENT` if the resolved path escapes every allowed prefix. The leaf symlink itself is NOT resolved (regression-tested: `lstat('/shared/legit-symlink')` still returns Stats with `type === 'symlink'`).
- **`readDirSync(path): DirEntry[] | null`** — returns `null` for disallowed paths. Parent-only-allowed paths (e.g. `/`, `/scoops`): filters the entries to those whose child path is allowed, mirroring the async `readDir`'s ACL filter. For strict paths it now scans for ancestor/leaf symlinks first and returns `null` to force the async `readDir()` path whenever a symlink could affect resolution, closing the earlier shell `readDirSync` escape.
- **`realpath(path): Promise<string>`** — resolves symlinks through the underlying VFS; if the resolved path escapes every allowed prefix, throws `FsError('ENOENT', ...)` (consistent with VAL-FS-019 symlink-escape semantics).

Because `RestrictedFS` now exposes every member `VfsAdapter` calls into (async read/write/symlink surface + the four methods above), the `as VirtualFS` cast in `scoop-context.ts` is no longer a missing-method type lie. The former `readDirSync()` symlink-directory gap AND the async `lstat()` ancestor-symlink leak (scrutiny/core-followup round 2, 2026-04-17) are both closed — VAL-FS-019 parity now holds across sync and async paths.

### 6. Orchestrator registration handshake for bridge scoops

Bridge-spawned scoops are visible through the orchestrator's registry AND through the `tabs` map. Both must be populated at registration time and both must be kept in sync during the run. This is what makes the scoop visible to:

- `list_scoops` (reads `getScoopTabState(jid)?.status ?? 'unknown'`)
- The UI's `ScoopsPanel` and its extension mirror (refreshes on `OrchestratorCallbacks.onStatusChange`)

Required handshake (already wired in `AgentBridge.spawn()`):

1. `orchestrator.registerExistingScoop(scoop)` MUST:
   - insert into `this.scoops` and `this.messageQueues`
   - ALSO insert a well-formed `ScoopTabState` into `this.tabs` with `status: 'initializing'`, `contextId: 'bridge-<folder>'`, and a fresh `lastActivity`
   - fire `this.callbacks.onStatusChange(jid, 'initializing')` so the UI refreshes
2. Every subsequent bridge-side status transition MUST go through `orchestrator.updateBridgeTabStatus(jid, status)` (NOT direct `this.tabs` mutation) so the UI callback pipeline fires.
3. The bridge's `ScoopContextCallbacks.onStatusChange` MUST forward transitions to the orchestrator via `updateBridgeTabStatus` — a no-op callback would drop scope-context state transitions on the floor.
4. `orchestrator.unregisterScoop(jid)` MUST remove the bridge scoop from `this.tabs`, `this.scoops`, and `this.messageQueues` before firing the terminal `onStatusChange(jid, 'ready')`. Both the CLI scoop panel and the extension mirror rebuild from `orchestrator.getScoops()` during that callback, so removal-first ordering is what prevents ghost bridge-scoop rows after cleanup.

Historical note (2026-04-17): Before this handshake was codified, `registerExistingScoop` populated only `scoops` + `messageQueues` and the bridge's scope-context callback was a no-op `() => {}`. This caused two production bugs: `list_scoops` returned bridge scoops with status `'unknown'`, and the UI panel never rendered them at all. A later cleanup-ordering fix also moved bridge-scoop removal ahead of the terminal callback so the UI no longer leaves ghost rows behind. See VAL-SPAWN-014 + VAL-SPAWN-015.

### 6b. Scope-context → OrchestratorCallbacks forwarding (single-source helper)

`Orchestrator.buildForwardingScoopCallbacks(jid, folder, extras?)` is the **authoritative single-source** for wiring a scoop's `ScoopContextCallbacks` into the orchestrator's top-level `OrchestratorCallbacks` chain. Every scope-context callback (`onResponse`, `onResponseDone`, `onToolStart`, `onToolEnd`, `onToolUI`, `onToolUIDone`, `onError`, `onSendMessage`, `onStatusChange`) forwards to `this.callbacks.X(jid, ...)` — injecting `jid` as the first arg — so downstream consumers receive the events.

**Both code paths that create a `ScoopContext` MUST delegate to this helper:**

1. `Orchestrator.createScoopTab` (regular feed_scoop / user-created scoops)
2. `AgentBridge.spawn` in `packages/webapp/src/scoops/agent-bridge.ts` (ephemeral `agent`-command scoops)

**Skipping the helper means the panel/persistence layer will not see the scoop's messages.** The most important downstream consumer is `OffscreenBridge.createCallbacks` in `packages/chrome-extension/src/offscreen-bridge.ts`: its `onResponse` / `onResponseDone` / `onToolStart` / `onToolEnd` handlers emit `agent-event` messages to the side panel AND call `persistScoop(jid)` to write the scoop's message buffer to the shared UI `SessionStore` (`session-agent-<uid>` or `session-cone`). Without the forwarding chain, a scoop's row in the sidebar is clickable but the chat panel stays empty — even while the agent is actively running.

In extension mode, callback forwarding is **necessary but not sufficient** for selection-time hydration. `ChatPanel.switchToContext('session-<folder>', ...)` still hydrates from the persisted `SessionStore` snapshot, while `OffscreenClient` only receives `agent-event`s that arrive **after** the scoop is selected. If a bridge scoop already emitted partial text or a `tool-start` event before the user clicks its row, that pre-selection state remains invisible unless the offscreen buffer is either persisted immediately or explicitly replayed when the row is selected. Forwarding-only fixes can therefore leave a still-empty chat panel for active runs that already produced output before selection.

**Extras parameter**: lets callers layer LOCAL concerns on top of the forwarding chain WITHOUT dropping any forwards. Each `extras.onX` handler runs FIRST (observation phase); then the helper invokes `this.callbacks.onX(jid, ...)` (forwarding phase). Callers use extras for:

- `createScoopTab`: tab-state mutation (`lastActivity`, error tracking), response-buffer routing back to cone on completion, cone-only wiring (`onFeedScoop`, `onScoopScoop`, `onDropScoop`, `setGlobalMemory`, `getScoopTabState`).
- `AgentBridge.spawn`: `onSendMessage` captures final text into the `captured[]` ring (SLICC stdout contract); `onStatusChange` drives `orchestrator.updateBridgeTabStatus`; `onError` logs bridge-local errors.

**Guard contract**: the helper's forwarding phase is guarded by `if (!this.scoops.has(jid)) return;` so late-firing callbacks after `unregisterScoop` are safely dropped. Extras fire unconditionally (for local cleanup), then the guard checks before forwarding.

Historical note (2026-04-17): before the helper was extracted, `AgentBridge.spawn` built its own `ScoopContextCallbacks` with no-op `onResponse` / `onResponseDone` and missing `onToolStart` / `onToolEnd`. The visible symptom was VAL-SPAWN-016: clicking an agent-spawned scoop row in the sidebar showed an empty chat panel even while the agent was actively running. The fix extracts the wiring into `buildForwardingScoopCallbacks` and delegates both code paths to it — enforcing architectural parity via shared code + the `agent-bridge-callback-forwarding.test.ts` regression guard.

### 6c. SessionStore is the single source of panel hydration

`SessionStore` (`packages/webapp/src/ui/session-store.ts`, backed by the `browser-coding-agent` IndexedDB) is the **single source of panel hydration**: `ChatPanel.switchToContext('session-<folder>', ...)` reads exclusively from `SessionStore.load('session-<folder>')` and renders whatever message buffer lives there. The extension's `OffscreenClient.handleAgentEvent` additionally streams live `agent-event`s into the chat panel — but ONLY for events that arrive after the scoop is selected (the pre-selection handler early-returns when `msg.scoopJid !== selectedScoopJid`).

**Therefore, `OffscreenBridge` MUST persist every state-mutating event** — including mid-stream partials (`onResponse` with `isPartial=true`) and tool-starts (`onToolStart`) — so that post-click hydration sees the complete pre-click state. Persisting only on `onResponseDone` / `onToolEnd` / `onSendMessage` is insufficient: if a bridge scoop streams text for 5s before the user clicks its row, `onResponseDone` has not fired yet, and the chat panel hydrates from an empty `SessionStore` snapshot. The fix (core-followup-2, VAL-SPAWN-016 round-2 scrutiny) adds `bridge.persistScoop(scoopJid)` calls to both `createCallbacks().onResponse` (after buffer mutation) and `createCallbacks().onToolStart` (after pushing to `msg.toolCalls`). `persistScoop` is fire-and-forget async (`SessionStore.saveMessages` → `IDBObjectStore.put`) — per-delta writes do NOT block the hot path.

Per-event persistence is **necessary but not sufficient** for the running-scoop selection path. After `ChatPanel.switchToContext()` hydrates a persisted in-progress assistant message, the selected panel's live relay (`OffscreenClient.currentMessageId`) must also reconnect to that hydrated message ID. Otherwise post-click `text_delta` can fork a second assistant message, while `tool_end` / `response_done` can be dropped because the live relay has no current message to attach them to. Any future VAL-SPAWN-016 fix must preserve both invariants: persisted pre-click state **and** message-ID continuity across the selection boundary.

Companion rule — `Orchestrator.updateBridgeTabStatus` is a **single-purpose tab-state mutator** and does NOT broadcast `onStatusChange`. Status forwarding to `OrchestratorCallbacks.onStatusChange` is solely owned by `buildForwardingScoopCallbacks`. Before this rule was codified, `updateBridgeTabStatus` broadcast internally AND the helper's forwarding phase also broadcast, producing duplicate `onStatusChange` events for every bridge-scoop transition. Harmless today but unnecessary churn and a foot-gun for future status-sensitive behavior. Direct callers that need to drive a panel refresh without a scope-context transition should emit via `this.callbacks.onStatusChange(jid, status)` explicitly.

## Data Flow

```
User types in terminal:
  agent /home/wiki "*" "convert to mediawiki"
        |
        v
WasmShell.bash parses tokens -> calls agent-command.execute(args, ctx)
        |
        v
agent-command reads globalThis.__slicc_agent.spawn({ cwd, allowed, prompt, parentJid })
        |
        v
AgentBridge.spawn:
  1. Create RegisteredScoop
  2. Build RestrictedFS (RW: cwd + /scoops/<folder>/ + /shared/; RO: /workspace/)
  3. Construct ScoopContext
  4. Install callbacks (collect onSendMessage)
  5. Resolve the effective model; inheritance only reaches the real `ScoopContext` path if that choice is copied onto `scoop.config.modelId`
  6. Optionally wrap bash tool with allow-list
  7. await ctx.init() then await ctx.prompt(promptText)
  8. Read last send_message (or last assistant text)
  9. Dispose + delete /scoops/<folder>/
  10. Return { finalText, exitCode }
        |
        v
agent-command returns { stdout: finalText + '\n', stderr: '', exitCode }
        |
        v
User sees output in terminal
```

## Invariants

- The `agent` command MUST work identically in CLI and extension modes (dual-mode compatibility).
- The global hook `globalThis.__slicc_agent` MUST be published in both `ui/main.ts` and `offscreen.ts` bootstrap paths.
- In extension mode, the side-panel Terminal shell and offscreen agent shell are separate contexts. Publishing `globalThis.__slicc_agent` in offscreen alone does **not** make it visible to the panel shell.
- Under normal completion, error, or parent abort, the scratch folder `/scoops/<folder>/` MUST be deleted and the scoop MUST NOT remain registered.
- Allow-list enforcement MUST happen at the bash-tool layer (inside the scoop's agent loop), not at the shell-command layer — because the agent may invoke bash multiple times during its reasoning, each invocation must be checked.
- Real model inheritance depends on the spawned `RegisteredScoop` carrying the chosen model in `config.modelId`; `ScoopContext` resolves its runtime model from the scoop config, not from any transient bridge-local argument object.
- The existing cone/scoop tool surface (`scoop_scoop`, `feed_scoop`, `drop_scoop`, `list_scoops`, `update_global_memory`, `send_message`) MUST remain unchanged.
- The command SHOULD be callable from inside a scoop's bash, not just the cone's — nesting is supported because we bypass the cone-only `scoop_scoop` tool gate by calling `AgentBridge` directly.

## Key Files to Edit

| File                                                                      | Change                                       |
| ------------------------------------------------------------------------- | -------------------------------------------- |
| `packages/webapp/src/shell/supplemental-commands/agent-command.ts`        | NEW — supplemental command                   |
| `packages/webapp/src/shell/supplemental-commands/index.ts`                | Register `createAgentCommand()`              |
| `packages/webapp/src/shell/supplemental-commands/help-command.ts`         | Add `agent` to `COMMAND_CATEGORIES`          |
| `packages/webapp/src/scoops/agent-bridge.ts`                              | NEW — orchestrator-backed spawn/wait/cleanup |
| `packages/webapp/src/tools/bash-tool-allowlist.ts`                        | NEW — allow-list wrapper                     |
| `packages/webapp/src/ui/main.ts`                                          | Publish `globalThis.__slicc_agent`           |
| `packages/chrome-extension/src/offscreen.ts`                              | Publish `globalThis.__slicc_agent`           |
| `packages/webapp/tests/shell/supplemental-commands/agent-command.test.ts` | NEW — unit tests                             |
| `packages/webapp/tests/tools/bash-tool-allowlist.test.ts`                 | NEW — allow-list tests                       |
| `packages/webapp/tests/scoops/agent-bridge.test.ts`                       | NEW — integration test                       |

## Non-Goals

- This mission does NOT modify the cone's tool surface.
- This mission does NOT add first-class parent/child scoop tracking to `RegisteredScoop`.
- This mission does NOT introduce a generic scoop-level `allowedTools` filter (only a bash-command allow-list, at the tool wrapper layer).
- This mission does NOT add a timeout mechanism (per user decision).
