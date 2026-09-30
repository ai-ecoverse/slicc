# Read-depth analyses

Offline scripts that measure how much of an instruction file (a skill's `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, docs) an agent actually reads. They are not part of a bench run and print aggregates only: no task text and no tool output.

| Script                                                             | Input                                                                             | Output                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `skill-reads.mjs <data-dir> <out.jsonl> [run-dir …]`               | Encrypted bench traces (`run-<id>/traces/**.enc`)                                 | One row per read of a skill or `CLAUDE.md`, with the lines delivered |
| `skill-reads-report.mjs <out.jsonl> [--svg]`                       | The rows above                                                                    | Markdown tables, or the reach-curve SVG                              |
| `hf-reads.mjs fetch <cache>` / `extract <cache> <out.jsonl>`       | Public Hugging Face `format:agent-traces` datasets (Claude Code, Codex, Pi JSONL) | One row per file read                                                |
| `hf-reads.mjs extract-local ~/.claude/projects <out.jsonl> [days]` | Your own Claude Code logs                                                         | The same rows, as a same-model, other-harness control                |
| `hf-reads-report.mjs <out.jsonl> <cache>`                          | The rows above                                                                    | Markdown tables                                                      |

How it works:

- **Lines delivered, not lines requested.** `skill-reads.mjs` aligns each tool result against the skill blob the run used, so harness truncation counts.
- **Which blob a run used.** The candidates are every blob of the path at the tags, experiment pins and recent `main` commits in `REFS`. The script picks the one that explains the reads best, with ties going to `RUN_REF`.
- **Deterministic samples.** `hf-reads.mjs` spreads its sample over each dataset's sorted file list and records the revision and licence in `<cache>/<dataset>/_meta.json`.

Datasets and traces stay out of git.
