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
  8. Determines output: last `send_message` callback text if any; else last assistant text from `ctx.getAgentMessages()`
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
  - Walks the reachable word-bearing nodes conservatively and rejects any `CommandSubstitutionPart` / `ArithmeticExpansionPart` / `ProcessSubstitutionPart` at any nesting depth. Plain parameter expansion without nested word operands is not itself a command head, but parameter-expansion defaults/assignments still carry nested `WordNode`s that matter for allow-list safety.
  - `StatementNode.background === true` (bare `&`) is NOT grounds to reject — every pipeline head has already been checked.
- Preserves wildcard `*` passthrough, case-sensitive matching, duplicate-entry tolerance, and atomic rejection (no partial run) from the original design.

#### just-bash AST gotchas

- `&&` / `||` chains stay within a single `StatementNode`; for example, `ls -la | wc -l && echo done` parses as **one** statement with multiple `PipelineNode`s, not two top-level statements.
- Security-sensitive traversal cannot stop at top-level args and redirection targets: just-bash also nests executable `WordNode`s inside `AssignmentNode.value`, `ParameterExpansion.operation.word` (for defaults/assignments such as `${X:-$(...)}` and `${X:=...}`), and `BraceExpansion.items[].word`.
- If a future allow-list change needs CI-backed confidence about parser shape, keep at least one assertion on a `tsc`-covered path rather than relying solely on Vitest `.test.ts` files.

### 5. RestrictedFS extension (MODIFICATION)

The existing `RestrictedFS` already supports multiple R/W and R/O prefixes. The agent bridge supplies custom prefix arrays — no change to `RestrictedFS` internals needed.

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
