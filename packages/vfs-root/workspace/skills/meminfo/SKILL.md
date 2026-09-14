---
name: meminfo
description: |
  Use this when investigating memory pressure, suspected leaks, or
  out-of-memory crashes in the SLICC runtime (kernel worker, realms,
  WASM commands like vpod/ffmpeg/python3). Covers the `meminfo` shell
  command, how to read its breakdown, and its isolation prerequisite.
allowed-tools: bash
---

# meminfo — agent-cluster memory diagnostics

`meminfo` measures real memory usage across the agent cluster — the kernel worker plus its dedicated workers (script realms, vpod pods, ffmpeg, speech) — via the browser's `performance.measureUserAgentSpecificMemory()`.

## When to reach for it

- A command died with an out-of-memory error, or the kernel feels degraded after heavy WASM work.
- Before/after comparisons: measure, run the suspect workload, measure again, diff the attribution rows.
- Deciding whether to `vpod stop` / `kill` a heavy background unit before starting another.

## Usage

```bash
meminfo           # human-readable: total + per-attribution rows, largest first
meminfo --json    # raw measurement for scripted diffing
```

Rows attribute bytes to a scope and URL (e.g. `DedicatedWorkerGlobalScope …/kernel-worker.js`), with types like `JavaScript`, `DOM`, `Shared`. Zero-byte rows are dropped; only `--json` shows them.

## Expectations and limits

- Requires a cross-origin-isolated runtime. The hosted leader is one; embedded floats (Cherry, Electron overlay) are not and report why instead — that error is expected there, not a bug.
- The browser randomizes measurement timing (anti-fingerprinting), so a call may take a few seconds — do not treat the delay as a hang.
- The measurement covers the calling agent cluster, not the whole browser; other tabs and cross-origin iframes are out of scope.
