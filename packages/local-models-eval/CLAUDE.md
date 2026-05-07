# CLAUDE.md

Optional eval suite that drives a SLICC-shaped agent loop against a
running SwiftLM (or any OpenAI-compatible chat completions endpoint).
TypeScript on `@mariozechner/pi-agent-core` + `pi-ai` so the call
shape and tool format are byte-identical to what SLICC sends in
production.

## Scope

`packages/local-models-eval/` is **not** a runtime dependency of any
shipped Sliccstart artifact. It exists so a developer can ask
"does the Models tab actually work end-to-end against today's SwiftLM
build?" without driving the SLICC UI by hand. Add a scenario when a
new agent capability needs continuous coverage; remove a scenario
when its behavior moves into a real test elsewhere.

## Run

```bash
# Assumes SwiftLM is already serving on 127.0.0.1:5413 (the Sliccstart
# default). Start it via the Models tab, or by running
# `~/.slicc/SwiftLM/<version>/SwiftLM --model <repo> --port 5413 ...`.
npm run eval -w @slicc/local-models-eval

# Single scenario:
npm run eval:smoke -w @slicc/local-models-eval

# List available scenarios:
npm run eval:list -w @slicc/local-models-eval
```

## Layout

```text
src/
  index.ts            CLI entry; argparse, scenario dispatch, summary print.
  runner.ts           Wraps pi-agent-core's `runAgentLoop`; collects per-turn
                      telemetry into `RunResult` for the verifier and CLI.
  swiftlm-model.ts    Constructs `Model<"openai-completions">` for SwiftLM,
                      registers pi-ai's built-in providers, probes /health
                      + /v1/models for auto model selection.
  tools.ts            SLICC-shaped `AgentTool`s (typebox schemas):
                      read_file, write_file, bash (sandboxed) plus pure
                      helpers calculator, is_prime.
  sandbox.ts          Per-scenario tempdir; `Sandbox.resolve` rejects
                      escape attempts via canonicalised path comparison.
  scenarios.ts        Scenario data: prompt + tools + verifier + setup.
```

## Adding a scenario

1. Append a `Scenario` to `SCENARIOS` in `src/scenarios.ts`.
2. Pick the smallest tool subset that exercises the capability.
3. The verifier must work on `result.finalText` (the user-visible
   answer) — never on the raw round transcript alone — because that's
   what the user sees in the SLICC chat panel. Reach into
   `result.rounds` only when the test _is_ about call shape (e.g.
   "round 1 must contain ≥2 parallel tool_calls").

## Conventions

- **No production deps.** Only `@mariozechner/pi-agent-core` and
  `@mariozechner/pi-ai` (the same pi versions the webapp uses).
  Keeping the surface narrow means the eval breaks loudly when pi
  changes shape, which is the point.
- **Sandboxed FS tools.** Every `read_file` / `write_file` / `bash`
  call resolves paths through `Sandbox.resolve` and rejects anything
  that escapes after `path.resolve()`. Don't add a tool that bypasses
  the sandbox without a comment explaining why.
- **No deletion of `~/.slicc`.** The eval reads the shared HF cache
  for /v1/models discovery but never writes there.
- **xfail discipline.** When you mark a scenario `expectedPass: false`,
  leave a comment on the line describing the failure mode so it can
  be re-evaluated when the model or SwiftLM is bumped.

## Exit codes

- `0` — every selected scenario PASS'd or XFAIL'd as expected
- `1` — one or more scenarios FAIL'd unexpectedly
- `2` — endpoint unreachable / no text-capable model at /v1/models
- `64` — usage error (bad CLI args)

## Markers (pytest convention)

- `PASS` expected pass + actual pass
- `FAIL` expected pass + actual fail → suite exits 1
- `XFAIL` expected fail + actual fail → suite stays ok (known)
- `XPASS` expected fail + actual pass → suite stays ok, message
  asks you to flip the marker

A failed `parallel_math` would be a real regression. A passing
`write_then_run` would mean Qwen 3.6's tool-arg confusion was fixed
upstream — flip `expectedPass: true` in `scenarios.ts`.
