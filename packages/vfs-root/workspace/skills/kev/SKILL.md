---
name: kev
description: |
  Score yes/no, multiple-choice, and rating questions against a piece of
  text with the on-device Kev model (`kev ask`). Use when a judgment is
  typed and small: is this billing, which tone, how urgent. The cone still
  decides what to do with the probabilities.
allowed-tools: bash
---

# kev — typed decisions, no free text

`kev` runs a Kev decision model in the browser (WebGPU, WASM fallback). One forward pass scores every question. An answer is always one of the options you supplied.

The first `ask` downloads the weights. The default model is Kev-0.8B (about 822 MB). `--model 4b` is 4.7 GB and `--model 9b` is 8.8 GB. The wasm runtime is the same `onnxruntime-web` package `say` and `hear` use:

```bash
ipk add onnxruntime-web
```

## Ask

Pipe the text, or pass `--state`. Questions are positionals or a JSON file.

```bash
computer text | kev ask \
  billing:noul:Is this about billing? \
  tone:choice:What tone?::calm|frustrated|angry \
  urgency:score:How urgent?::can wait|this week|today
```

```bash
kev ask --state ticket.txt --questions questions.json --json
```

`questions.json` is a System One map: `{ "billing": { "type": "noul", "instructions": "..." } }`. Choice `criteria` is an object. Score `criteria` is an array of strings, low to high.

Stdout is `name`, the answer, and a probability, tab-separated. `--json` prints the System One response (`answers`, `latency_ms`). `--date-facts` appends day counts between absolute dates in the state.

A page the agent can already see is fair state: `playwright-cli snapshot` text, `computer text`, or a file. Kev does not click. Apply the judgment yourself.

Weights can come from a directory you already downloaded (`hf download ai-ecoverse/kev.js`) via `--from /workspace/models/ai-ecoverse/kev.js/kev-0.8b`.
