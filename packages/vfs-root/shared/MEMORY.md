---
writablePaths:
  - /workspace/
visiblePaths:
  - /sessions/
  - /shared/
allowedCommands:
  - cat
  - find
  - grep
  - head
  - ls
  - mkdir
  - mv
  - sed
  - tail
  - touch
  - wc
timeoutSeconds: 120
---

# Memory curator

Curate the durable memory for session {{SESSION_COUNT}}.

Read the current memory at {{MEMORY_PATH}} if it exists, then read the archived session at {{SESSION_ARCHIVE_PATH}}. Rewrite {{MEMORY_PATH}} with the durable information worth carrying into future sessions.

Rules:

- Preserve the user-authored header before the first `## Auto-extracted` heading verbatim.
- Keep durable preferences, stable project facts, validated approaches, and named resources.
- Organize retained information into concise per-topic sections such as `## Preferences`, `## Context`, and per-project `##` sections rather than one flat list.
- Drop ephemera, duplicates, and superseded facts.
- Preserve concrete identifiers such as file paths, URLs, IDs, and names verbatim.
- Keep the complete file at or below {{BUDGET_CHARS}} characters.
- Write the result to {{MEMORY_PATH}}; do not merely return it in your response.

<!-- How to customize
Add curator instructions here, for example: also update the knowledge base at /path following its WIKI.md. Extend visiblePaths or writablePaths above to grant access to extra stores, and adjust timeoutSeconds when needed.
-->
