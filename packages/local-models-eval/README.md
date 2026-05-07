# @slicc/local-models-eval

Optional end-to-end eval that drives a SLICC-shaped agent loop —
parallel tool calls, multi-round state, file ops, bash — against a
running SwiftLM (or any OpenAI-compatible) endpoint on
`127.0.0.1:5413`.

This is **not** part of CI. It's the manual probe that answers "does
local-models still work after the latest SwiftLM bump / template
change / Sliccstart refactor?" without driving the chat panel by hand.

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
npm run eval -w @slicc/local-models-eval
```

Output is one line per scenario plus a final summary. Exit code is `0`
on full pass, `1` on any failure, `2` if the endpoint isn't reachable.

## Scenarios

| Name               | Tools used               | Status                                             | What it pins                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parallel_math`    | `calculator`, `is_prime` | expected pass                                      | Multi-turn agent loop with parallel tool calls in round 1 (12·5 \|\| 3·4), sequential rounds 2–3, a final natural-language answer in round 4.                                                                                                                                                                                                                      |
| `file_exploration` | `bash`, `read_file`      | expected pass                                      | Discovery via `bash`, content via `read_file`, arithmetic across results. The agent has to figure out how many `.txt` files exist before it can sum their line counts.                                                                                                                                                                                             |
| `write_then_run`   | `write_file`, `bash`     | expected **xfail** on Qwen 3.6 35B-A3B-4bit (b644) | Round-trip the file system: create a script, execute it, surface the stdout. The agent loops on `write_file` because its thinking trace insists "I forgot the parameters" even when the call clearly includes them, never advancing to bash. Marked xfail — re-test on the next SwiftLM/model bump; if it passes you'll see `XPASS` and the marker can be removed. |

## Outcome markers (pytest style)

- `PASS` — expected pass, actual pass.
- `FAIL` — expected pass, actual fail. The only case that exits 1.
- `XFAIL` — expected fail, actual fail. Known issue; suite stays green.
- `XPASS` — expected fail, actual pass. Surfaced as a positive signal; the suite stays green but the message tells you to flip `expected_pass=True`.

## Adding a scenario

See `CLAUDE.md`.
