# CLAUDE.md

Optional eval suite that drives a SLICC-shaped agent loop against a
running SwiftLM (or any OpenAI-compatible chat completions endpoint).

## Scope

`packages/local-models-eval/` is **not** a runtime dependency of any
shipped Sliccstart artifact. It exists so a developer can ask
"does the Models tab actually work end-to-end against today's SwiftLM
build?" without driving the SLICC UI by hand. Add a scenario when a
new agent capability needs continuous coverage; remove a scenario when
its behavior moves into a real test elsewhere.

## Run

```bash
# Assumes SwiftLM is already serving on 127.0.0.1:5413 (the Sliccstart
# default). Start it via the Models tab, or by running
# `~/.slicc/SwiftLM/<version>/SwiftLM --model <repo> --port 5413 ...`.
npm run eval -w @slicc/local-models-eval

# Single scenario (≈10 s on a 35 B model, warm cache):
npm run eval:smoke -w @slicc/local-models-eval

# List available scenarios:
npm run eval:list -w @slicc/local-models-eval
```

## Layout

```text
eval/
  __main__.py     CLI entry; argparse, scenario dispatch, summary print.
  agent_loop.py   POST /v1/chat/completions, parse tool_calls, execute,
                  loop until finish_reason=stop or max_rounds.
  tools.py        SLICC-shaped tool stubs: read_file, write_file, bash,
                  calculator, is_prime. File/bash tools are sandboxed
                  to a per-scenario temp dir — they can't escape.
  scenarios.py    Scenario list. Each entry pairs a system + user prompt
                  with a tool subset, an optional sandbox setup callback,
                  and a verifier that decides pass/fail from the final
                  assistant message + the tool-call transcript.
```

## Adding a scenario

1. Append a `Scenario(...)` to `SCENARIOS` in `eval/scenarios.py`.
2. Pick the smallest tool subset that exercises the capability.
3. The verifier must work on the _content of the final assistant
   message_ — never on the raw tool transcript alone — because that's
   what the user actually sees in the SLICC chat panel.

## Conventions

- **Stdlib only.** No `requests`, no `httpx`, no `openai` package. The
  eval needs to run on a fresh `~/.slicc/mlx-venv` or even system
  Python. `urllib.request` is plenty.
- **Sandboxed FS tools.** Every `read_file` / `write_file` / `bash`
  call resolves paths through `Sandbox._resolve` and rejects anything
  that escapes the per-scenario temp dir. Don't add a tool that bypasses
  the sandbox without a comment explaining why.
- **No deletion of `~/.slicc`.** The eval reads from the shared HF
  cache for /v1/models discovery but never writes there.

## Exit codes

- `0` — every selected scenario passed
- `1` — one or more scenarios failed (asserted, max-rounds hit, or
  HTTP error)
- `2` — endpoint unreachable / model not loaded
- `64` — usage error (bad CLI args)
