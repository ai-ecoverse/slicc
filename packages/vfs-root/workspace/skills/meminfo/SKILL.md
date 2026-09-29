---
name: meminfo
description: |
  Use this when investigating memory pressure, suspected leaks, or
  out-of-memory crashes in the SLICC runtime (kernel worker, realms,
  WASM commands like vpod/ffmpeg/python3). Covers the `meminfo` shell
  command, how to read its breakdown, and its isolation prerequisite.
allowed-tools: bash
---

# meminfo

Measures agent-cluster memory (kernel worker + dedicated workers) via `performance.measureUserAgentSpecificMemory()`.

```bash
meminfo           # total + per-attribution rows, largest first
meminfo --json    # raw measurement
```

Use after OOM/degradation, for before/after diffs, or before starting heavy WASM. Rows name scope/URL and type (`JavaScript`, `DOM`, `Shared`); zero-byte rows appear only in `--json`.

Requires cross-origin isolation (hosted leader yes; Cherry/Electron overlay no — that error is expected). Timing is randomized (may take seconds). Covers this agent cluster only, not other tabs.
