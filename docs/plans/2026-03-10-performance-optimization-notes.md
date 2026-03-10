# Migration Performance Optimization Notes

Findings from investigating end-to-end page migration duration.

## Bottlenecks Identified

### 1. Scoop Creation — Sequential LLM Turns (FIXED)

**Problem:** Each `scoop_scoop` + `feed_scoop` required a separate LLM turn.
6 blocks = 12 LLM turns (~5-10s each) = ~60-120s just for scoop setup.

**Fix applied:**
- Non-blocking scoop init (`registerScoop` no longer awaits `createScoopTab`)
- Skill instructs cone to batch all `scoop_scoop` calls in one response,
  then all `feed_scoop` calls in the next → ~3 LLM turns instead of ~12
- Polling interval reduced from 2000ms to 500ms

### 2. Browser Tool — Single Session Serialization (NOT FIXED)

**Problem:** All scoops share ONE `BrowserAPI` instance with ONE CDP session.
Every browser operation requires detach + reattach to the target tab.
6 scoops using browser = serialized through single session.

**Impact:** ~15-20s total across a migration. Noticeable but not dominant
(most time is LLM thinking).

**Options considered:**
- A: Multiple BrowserAPI instances (one per scoop) — medium effort,
  CDP supports multiple sessions over one WebSocket
- B: Session pool on existing BrowserAPI — high effort, API surface refactor
- C: Skip it — browser calls are bursty (navigate → extract → done for a
  while → preview at end), not constantly contending

**Decision:** Skipped for now. Browser serialization adds ~15-20s across
a 15-30 minute migration. ROI doesn't justify the refactor risk.

### 3. LLM Thinking Budget — Potential Optimization (NOT IMPLEMENTED)

**Finding:** pi-ai has a built-in thinking budget system for extended thinking:

| Reasoning Level | Thinking Budget |
|----------------|----------------|
| `minimal` | 1,024 tokens |
| `low` | 2,048 tokens |
| `medium` | 8,192 tokens |
| `high` | 16,384 tokens |

Opus 4.1/4.6 has `reasoning: true` in the model definition. The budget is
set by `adjustMaxTokensForThinking(baseMaxTokens, modelMaxTokens, reasoningLevel)`.

**Current state:** slicc doesn't explicitly set a reasoning level. It likely
defaults to whatever pi-agent-core uses internally.

**Optimization opportunity:** Different tasks need different thinking levels:

| Task | Ideal Level | Reasoning |
|------|-------------|-----------|
| Cone: decomposition | `medium`/`high` | Needs to reason about page structure |
| Cone: Phase 4 assembly | `low` | Mostly mechanical file assembly |
| Scoop: content extraction | `low` | Navigate + evaluate, straightforward |
| Scoop: CSS/JS generation | `medium` | Creative code generation |
| Scoop: visual verification | `low` | Compare screenshots, surgical CSS edits |

If per-scoop or per-turn reasoning levels were configurable, scoops could
use `low` for extraction/verification and `medium` for code generation.
This would reduce token spend and latency significantly (6 scoops × ~5
turns × difference between 8K and 2K thinking tokens).

**Dependency:** Requires pi-agent-core to expose reasoning level configuration
at the Agent or prompt level. Need to check if the API supports this.

### 4. LLM Provider Rate Limits

6 scoops make parallel API calls. Provider limits:
- Anthropic direct: typically 50 req/min
- Azure AI Foundry: varies by deployment (often higher)
- No orchestrator-level rate limiting in slicc

**Status:** Not a practical bottleneck with current scoop counts (~6).
Would become relevant with 10+ scoops.

### 5. Message Queue Polling (FIXED)

**Problem:** 2-second polling interval added up to 1.5s latency per scoop.

**Fix:** Reduced to 500ms. Scoops react 4x faster.

## Applied Optimizations Summary

| # | Optimization | Status | Impact |
|---|-------------|--------|--------|
| 1 | Non-blocking scoop init | ✅ Done | ~5s saved (parallel init) |
| 2 | Batch create+feed in skill | ✅ Done | ~60s saved (fewer LLM turns) |
| 3 | Faster polling (500ms) | ✅ Done | ~9s saved (6 scoops × 1.5s) |
| 4 | Browser session pooling | Skipped | ~15-20s (low ROI) |
| 5 | Per-task reasoning levels | Not implemented | Potentially significant |
