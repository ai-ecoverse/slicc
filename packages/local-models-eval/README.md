# @slicc/local-models-eval

Optional end-to-end eval that drives a SLICC-shaped agent loop —
parallel tool calls, multi-round state, file ops, bash — against a
running SwiftLM (or any OpenAI-compatible) endpoint on
`127.0.0.1:5413`.

Built directly on `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`
so the call shape and tool format match what SLICC ships in
production. This is **not** part of CI. It's the manual probe that
answers "does local-models still work after the latest SwiftLM bump
or refactor?" without driving the chat panel by hand.

## Quick start

Start SwiftLM (the Models tab does this; equivalent CLI):

```bash
~/.slicc/SwiftLM/b644/SwiftLM \
  --model mlx-community/Qwen3.6-35B-A3B-4bit \
  --port 5413 --host 127.0.0.1 \
  --max-tokens 8192 --ctx-size 32768 \
  --cors '*' --turbo-kv --thinking
```

Then, from the repo root:

```bash
npm run eval -w @slicc/local-models-eval         # full suite
npm run eval:smoke -w @slicc/local-models-eval   # parallel_math only
npm run eval:list -w @slicc/local-models-eval    # show available scenarios
```

Output is one line per scenario plus a final summary. Exit code is
`0` on full pass (or known xfails), `1` on any unexpected failure,
`2` if the endpoint isn't reachable.

## Scenarios

| Name                   | Tools used               | Status                                             | What it pins                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parallel_math`        | `calculator`, `is_prime` | expected pass                                      | Multi-turn agent loop with parallel tool calls in round 1 (12·5 \|\| 3·4), sequential rounds 2–3, a final natural-language answer in round 4. `is_prime` uses strict `Type.Integer()` — if the model emits `"720"` instead of `720`, pi-ai's validator rejects (same as SLICC).                                      |
| `file_exploration`     | `bash`, `read_file`      | expected pass                                      | Discovery via `bash`, content via `read_file`, arithmetic across results. The agent has to figure out how many `.txt` files exist before it can sum their line counts. `read_file` returns numbered lines just like SLICC.                                                                                           |
| `edit_file_round_trip` | `read_file`, `edit_file` | expected pass                                      | `read_file` to inspect → `edit_file` for a single-string replacement → `read_file` to verify. Pins `edit_file`'s unique-match contract (errors when 0 or >1 occurrences).                                                                                                                                            |
| `write_then_run`       | `write_file`, `bash`     | expected **xfail** on Qwen 3.6 35B-A3B-4bit (b644) | Round-trip: create script, execute, surface stdout. ~60 % pass rate after SLICC-aligned tool wording (was 0 % before). Fail mode loops on `write_file` with the model thinking it forgot parameters. See the long log in `src/scenarios.ts` for what was tried (sampling, repeat-penalty, thinking off, alt models). |

## Outcome markers (pytest style)

- `PASS` — expected pass, actual pass.
- `FAIL` — expected pass, actual fail. The only case that exits 1.
- `XFAIL` — expected fail, actual fail. Known issue; suite stays green.
- `XPASS` — expected fail, actual pass. Surfaced as a positive signal; the suite stays green but the message tells you to flip `expectedPass: true` in `src/scenarios.ts`.

## Why TS + pi (not Python + raw HTTP)

Earlier drafts used Python with `urllib.request` straight against
`/v1/chat/completions`. That worked but tested a re-implementation of
the agent loop, not the one SLICC actually runs. Every time pi-ai or
pi-agent-core changes how tool calls or messages are encoded, a
Python eval would silently keep passing while production breaks.
Using `@mariozechner/pi-agent-core`'s `runAgentLoop` and pi-ai's
built-in `openai-completions` provider means we exercise exactly the
code path SLICC will hit when the user clicks Run on the Models tab.

## Adding a scenario

See `CLAUDE.md`.
