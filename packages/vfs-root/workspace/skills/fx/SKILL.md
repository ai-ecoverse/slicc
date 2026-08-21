---
name: fx
description: |
  Run Vercel's fx coding agent (fx.sh) in-process on its WebAssembly build.
  fx's shell tool executes inside this SLICC shell against the VFS, model
  traffic goes to Vercel AI Gateway through SLICC's fetch proxy, and sessions
  persist under /workspace/.fx/. Use when asked to "run fx", delegate a task
  to fx, compare fx against the cone, or try a Gateway-hosted model fx offers.
allowed-tools: bash
---

# fx

`fx` hosts `fx-core.wasm` from the `libfx` npm package inside a `.jsh` realm.
Nothing leaves SLICC's sandbox: fx's `workspace.exec` is wired to
`require('sliccy:exec')`, so every command fx runs is an ordinary SLICC shell
command you could have run yourself.

## Setup (once)

```bash
ipk add esbuild-wasm@0.28.2   # libfx ships ESM; the realm transpiles it with the ipk-installed esbuild
ipk add libfx@0.0.4           # ~36 MB tarball; only fx-core.wasm (2.3 MB) + fx-sdk.js are used
```

## Credentials

fx talks to Vercel AI Gateway only. Add a **Vercel AI Gateway** account in the
provider settings and select one of its models — SLICC then seeds
`AI_GATEWAY_API_KEY` into realm scripts automatically. To use a different key
for one run:

```bash
AI_GATEWAY_API_KEY=vck_… fx "…"
```

`fx` exits 1 with guidance when no key is available. A Gateway account without
a payment method answers `HTTP 403 … requires a valid credit card on file`;
that is a Vercel-side setting, not a SLICC problem.

## Usage

```bash
fx "Summarize the files in this workspace."
fx --model anthropic/claude-sonnet-5 "Add a README to /workspace/demo"
fx --models                      # models the Gateway offers; `*` marks the current one
fx --sessions                    # stored sessions (under /workspace/.fx/sessions/)
fx --session <id> "continue…"    # resume a stored session
fx --json "…"                    # raw ACP session updates, one JSON object per line
```

Output: the agent's text streams to stdout; tool calls are announced on stderr
as `[tool] <title>`. A non-`end_turn` stop reason (e.g. `refused`) is reported
on stderr.

## Limits

- Requires WebAssembly JSPI (Chrome 137+); the kernel realm has it.
- fx's workspace is `/workspace` only, non-git, `allow-sandboxed` permissions:
  fx runs commands without asking because SLICC's own sandbox is the boundary.
- The WASM build of fx has no MCP, subagents, web search, or clipboard.
- One turn per invocation; use `--session` to continue a conversation.
