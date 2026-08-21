# Bash progress / ETA overlay (no just-bash patch)

Status: Tiers 1–2 shipped (`packages/webapp/src/shell/progress/`: `sleep`
ticks, generic start/end wrapper, `for` loop iteration counting, `curl`/`wget`
byte progress via `proxied-fetch.ts`, `tool_progress` agent event + chat-row
bar). Duration history (Tier 3) remains exploration.

Implementation note: just-bash's `trace` callback only fires for `find`
internals — it emits nothing per command — so loop iterations are counted at
the shell's own dispatch wrapper (`wrapCommandForDispatch`), not via `trace`.
The plan below is kept as originally written. Tracks upstream idea
[vercel-labs/just-bash#319](https://github.com/vercel-labs/just-bash/issues/319)
(no maintainer response as of 2026-08-21). This doc describes how SLICC can ship
progress-bar / ETA feedback for `bash` tool calls _today_, entirely on top of
just-bash's public API, and how that overlay would later collapse onto an
upstream protocol if one lands.

## Why no patch is needed

just-bash 3.x already exposes every seam the overlay needs:

| Seam                     | just-bash API                                                                                                                                   | What it gives us                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Shadow a bundled command | `customCommands` / `registerCommand` (registered _after_ built-ins, so they override) and `ctx.origCommand(args)` to call the shadowed original | Per-command progress wrappers for `sleep`, `curl`, … without forking their implementations     |
| Time passing             | `BashOptions.sleep?: (ms) => Promise<void>` — `sleep` calls `ctx.sleep` when set                                                                | Deterministic ETA for `sleep N` (the single most predictable command)                          |
| Network bytes            | `BashOptions.fetch` (SLICC already passes `createProxiedFetch()`)                                                                               | `curl` byte progress via `Content-Length` once the proxy streams; today: "in flight" + elapsed |
| Pre-execution shape      | `parse(script)` exported from the main entry (AST: `for` lists, `seq`/brace ranges, pipelines)                                                  | Iteration _counts_ for `for x in a b c`, `for i in {1..100}`, `for i in $(seq 1 50)`           |
| Per-command timing       | `trace?: TraceCallback` (`{category, name, durationMs}`)                                                                                        | Completion ticks per command, historical duration table for ETA of repeated commands           |
| Cancellation             | `ExecOptions.signal` (SLICC already forwards it)                                                                                                | Progress UI's cancel button maps to the existing abort path                                    |

SLICC already owns the wrapping pattern: `wrapCommandForSudo` in
`packages/webapp/src/shell/almost-bash-shell-headless.ts` rewrites every
registry entry before `new Bash(...)`. A `wrapCommandForProgress` composes the
same way.

And SLICC already has the _sink_: every tool runs under a
`ToolExecutionContext` (`packages/webapp/src/shell/tool-ui.ts`) whose
`onUpdate(partialResult)` streams partial `AgentToolResult`s to the chat UI —
`mount` uses it via `getToolExecutionContext()`. Progress events are just
another `onUpdate` payload.

## Protocol (mirrors what #319 would propose upstream)

```ts
// packages/webapp/src/shell/progress/types.ts
export interface ProgressEvent {
  /** stable id per running unit (command invocation or loop) */
  id: string;
  /** human label: "sleep 30", "curl …/big.tar.gz", "for (3 of 12)" */
  label: string;
  /** 0..1 when determinate; undefined => indeterminate spinner */
  fraction?: number;
  /** best-effort remaining ms; undefined when unknown */
  etaMs?: number;
  /** optional unit counters, e.g. bytes or iterations */
  done?: number;
  total?: number;
  unit?: 'bytes' | 'iterations' | 'ms';
  phase: 'start' | 'update' | 'end';
}
export type ProgressSink = (e: ProgressEvent) => void;
```

The sink is resolved lazily at command-execution time from the tool execution
context (same trick `mount` uses), so the shell stays ignorant of the UI and the
human terminal (no tool context) simply gets no events.

Events are throttled to ≤ 4/s per id in the emitter, never in the UI.

## Inventory: which commands are predictable

Tier 1 — deterministic, ship first:

- `sleep N` — wrap via `BashOptions.sleep`: emit `start{total:ms}`, tick every
  250 ms, `end`. Pure `fraction = elapsed/total`. Zero AST work.
- `for … in <static list>` — `parse()` the script in `runCommand` before
  `bash.exec`; for each `ForNode` whose word list is static (literals, brace
  expansions, `$(seq a b)` with literal args) precompute `total`. Iteration
  _progress_ comes from a sentinel: rewrite is **not** done (we don't mutate
  user scripts). Instead, count completed top-level commands of the loop body
  via `trace` events — the interpreter emits a trace per command; body length
  is known from the AST, so `done = floor(traceCount / bodyCommandCount)`.
  Good enough for `for f in *.md; do pandoc …; done` style loops. Only attempt
  when the loop is at top level and its body contains no nested loops/ifs
  (otherwise fall back to indeterminate "iteration k" counting isn't possible
  → skip).
- `seq`/`xargs -n1`/`while read` — indeterminate; skip for v1.

Tier 2 — determinate with streaming fetch:

- `curl -o/-O URL` and plain `curl URL` — needs `Content-Length` + streaming
  chunks. `SecureFetch` returns a fully-buffered `FetchResult`, and SLICC's
  `createProxiedFetch` collects bytes via the extension Port. The Port transport
  _does_ see chunks (`collectViaExtensionDelegate`), so progress can be emitted
  from the proxy layer keyed by URL, before just-bash ever sees the body. No
  just-bash change; the hook lives in `proxied-fetch.ts`. Until that is wired,
  `curl` shows indeterminate + elapsed time via the generic wrapper.

Tier 3 — statistical ETA for everything else:

- Keep a small per-session ring buffer of `(commandName, argsHash) → durationMs`
  fed by `trace`. On the second run of the same `git fetch`/`npm test`-style
  command, show an ETA from the median. Indeterminate bar with "~12s (last run)".
  This is where most of the perceived value is for agent workloads, which repeat
  commands constantly.

Explicitly _not_ predictable (don't pretend): `python3`, `node`, `.jsh`, `find`,
`grep -r` (could do bytes-scanned later via fs trace, but not v1).

## Where the code goes (SLICC)

```
packages/webapp/src/shell/progress/
  types.ts            ProgressEvent / ProgressSink
  emitter.ts          throttle + id allocation + sink resolution from tool ctx
  sleep-progress.ts   BashOptions.sleep implementation
  loop-progress.ts    parse() pass → planned loops; trace-driven counter
  duration-history.ts Tier-3 ring buffer
  wrap-command.ts     generic wrapCommandForProgress(cmd) => start/end events
```

Wiring in `AlmostBashShellHeadless`:

1. Constructor: `new Bash({ …, sleep: makeSleepWithProgress(emitter), trace: emitter.onTrace })`
   and `registry.commands.set(name, wrapCommandForProgress(wrapCommandForSudo(cmd)))`.
   (Sudo inner, progress outer, so a denied command never emits `start`.)
2. `runCommand`: `emitter.beginScript(parse(command))` before `bash.exec`,
   `emitter.endScript()` in `finally`. The parse is already paid by just-bash;
   the duplicate is cheap and we guard it with a try/catch so a parse error just
   disables progress for that invocation.
3. `createBashTool` (`tools/bash-tool.ts`): nothing — the emitter finds
   `onUpdate` through `getToolExecutionContext()`. The UI side adds a renderer
   for a `{type:'progress', events}` partial result next to the existing
   `tool_ui` renderer in `message-renderer.ts` / `wc-message-view.ts`.

Human terminal panel: optionally subscribe the same emitter to draw an
in-terminal `\r`-style bar on the xterm instance; out of scope for v1.

## Constraints to respect

- **Defense-in-depth**: during `bash.exec`, just-bash may patch `setTimeout`.
  The sleep ticker therefore must come from `BashOptions.sleep` (invoked by
  just-bash itself, inside its timer allowance) rather than an outer
  `setInterval`. The emitter only _calls_ `onUpdate` (a plain function); it
  schedules nothing of its own.
- **Execution limits**: trace callbacks fire per command; the emitter must be
  O(1) per event and never allocate per-iteration strings beyond the throttle.
- **Security**: labels are built from argv _after_ secret masking is already in
  env; still, run labels through the existing `scrubToolResult` path before
  `onUpdate` so a `curl -H "Authorization: …"` never leaks into the progress
  card.
- **No AST mutation**: we read the AST, we never rewrite the script.

## Relationship to upstream #319

If upstream adds a first-class protocol (likely `BashOptions.onProgress` +
`ctx.progress?.(…)` inside commands), the overlay's `types.ts` is designed to be
a superset, `wrap-command.ts` and `sleep-progress.ts` get deleted, and
`loop-progress.ts` stays only until the interpreter emits loop events itself.
Tier 3 (duration history) is SLICC-specific and stays regardless.

Suggested order: Tier 1 `sleep` + generic start/end wrapper (one PR, includes
the UI card) → loop counting → curl byte progress in `proxied-fetch.ts` →
duration history.
