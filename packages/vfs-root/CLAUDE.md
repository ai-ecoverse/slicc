# CLAUDE.md

`packages/vfs-root/` is the default VFS payload — content, not runtime code — copied into the app's
VFS on init/reset. Paths below are relative to this package.

## Directory Structure

| Path                  | Becomes / purpose                                                              |
| --------------------- | ------------------------------------------------------------------------------ |
| `shared/`             | `/shared/` — shared content                                                    |
| `workspace/`          | `/workspace/` — default workspace content                                      |
| `shared/CLAUDE.md`    | Agent-facing runtime instructions → `/shared/CLAUDE.md`                        |
| `etc/MEMORY.md`       | User-editable memory pass (curator + dreamer) config → `/etc/MEMORY.md`        |
| `shared/GELATIERE.md` | User-editable gelatiere pass instructions + config → `/shared/GELATIERE.md`    |
| `shared/wiki/`        | Shared KB scaffold (`WIKI.md` schema, empty `index.md`/`log.md`)               |
| `shared/sprinkles/`   | Built-in sprinkle UIs                                                          |
| `shared/sounds/`      | Shared notification sounds                                                     |
| `workspace/skills/`   | Default installable workspace skills                                           |
| `etc/`                | `/etc/` system config (`models`, `sudoers`, `APPROVALS.md`, `slicc/keys.json`) |

## Adding Default Content

### Gelatiere

Design, pieces table, sprinkle details: `docs/gelatiere.md`.

- `shared/GELATIERE.md` is the gelatiere's twin of `MEMORY.md`: build-time fallback and seeded
  `/shared/GELATIERE.md`, seeded only when absent, user-edited only. Same frontmatter dialect
  (`base/instruction-frontmatter.ts`); keys `intervalHours`, `nightly` (5-field cron),
  `maxSuggestions` (≤10), `allowedCommands` (bare names, ADDITIVE). No placeholders — the unit `cat`s
  it each pass, so keep it self-contained (literal paths, `date`).
- The gelatiere is a persistent SCOOP under a synthetic owner (`scoops/gelatiere-unit.ts`), not a
  spawned agent: charter is the record's `systemPromptAppend`, the pass recipe is this file.
  Deliverable is `gelatiere suggest <candidates.json> && gelatiere deliver`. Keep recipe commands on
  `GELATIERE_BASE_ALLOWED_COMMANDS` (`allowedCommands` extends it, re-applied at boot / `gelatiere
init`); cross-pass memory `/shared/.gelatiere/notes.md`.
- `shared/sprinkles/suggestions/suggestions.shtml` is the suggestion stream, split from
  onboarding-only `shared/sprinkles/welcome/welcome.shtml` so follower/extension welcome-dip handling
  can't mask or restart it; re-posted as a dip on every delivery, rail-pickable under Memory v2. Card
  buttons and lick verbs (`gelatiere-install`/`-try`/`-dismiss`): the doc.

### Memory curator

- `etc/MEMORY.md` is the single source for the build-time fallback and seeded `/etc/MEMORY.md`,
  seeded only when absent so customizations survive later boots. ONE document drives both passes —
  per-session curation and nightly consolidation ("dreaming"); the runtime fills `{{TASK}}` with
  which one this is, and `timeoutSeconds` / `dreamTimeoutSeconds` bound them separately (the dream
  gets the long one). User-edited only: it cannot rewrite its own instructions. It may rewrite the
  whole memory file; the hard char budget covers the file — no protected region. The pre-merge
  `/shared/MEMORY.md` + `/shared/DREAMING.md` are no longer read; `memory status` flags a survivor.
- Frontmatter is a strict YAML subset: block-array items may have `#` comment tails; inline entries
  with commas must be quoted; a bare `/` is rejected from `writablePaths`. `allowedCommands` extend
  the base set.
- **The curator edits a staged draft, never the live file.** `{{MEMORY_PATH}}` resolves to
  `/sessions/.curation/<archive>/draft.md`; the agent bridge three-way-merges it onto the live file
  on exit 0, so a killed/failed run leaves live memory untouched and per-archive keying keeps parallel
  curators from sharing state. Merge/ledger mechanics (`mergeOnSuccess`, `status.json`,
  `memoryCuratedAt`/`memoryFailed`): `docs/webapp-details.md`.
- Every `##`/`###` section ends with a `YYYY-MM-DD` last-verified date (UTC, matching archive
  timestamps). Each pass re-verifies oldest first; undated sections count as maximally stale.
- Entries follow the provenance/supersession grammar in MEMORY.md's "Entry grammar" (`human:`/
  `process:` prefixes, version pins, `stale_after: YYYY-MM-DD`, corrections that REPLACE claims, a
  `## Not true` block of refuted traps). Every pass enforces it and reports contradiction-pair counts
  before/after.
- Write grant is `/workspace/CLAUDE.md` alone, not `/workspace/`: a directory-wide grant would also
  let it install into `/workspace/skills/` (it can still `upskill`). Reads still cover `/workspace/`.
  Single-file `writablePaths` work because `generateScoopSudoers` emits the bare path + `/**`.
- The pass is detached, so it spawns with `notifyOnComplete`; its closing message reaches the cone on
  `scoop-notify` after `status.json` is written (where skill suggestions land) — a non-zero exit
  headlines as `failed` with the reason and receipt path, else the report is lost.
- Turn count is the cost (every turn re-reads the whole context). Two prompt-side levers cut it:
  `thinkingLevel` (default `medium`; spawned agents otherwise resolve to `off`) so the curator plans
  the cut, and archive-reading recipes so it never `cat`s a huge archive whose `slicc:session-data`
  is one line.

### Approver agent

Full policy reference: `docs/approvals.md`.

- `etc/APPROVALS.md` is the single source for the build-time fallback and seeded `/etc/APPROVALS.md`.
  `SudoManager.ensureDefaults()` seeds it when absent, on the ungated handle — same as `/etc/sudoers`:
  it is self-protected, so anything else creating it (`upgrade apply`) would prompt the owner to
  approve a default already in force.
- It lives in `/etc/` because it is POLICY, next to `sudoers` — not `/shared/` (agent-visible
  content). Writes are self-protected in `base/sudoers.ts` (`isSelfProtectedWrite`): it decides what a
  GUEST may do, so a cone acting on a guest's message must not rewrite the rules gating that guest.
- Re-read on EVERY decision, not cached; missing/unreadable falls back to the bundled default rather
  than wedging approvals shut. The optional ```yaml block tunes `timeoutSeconds` (clamped), `model`,
  `thinkingLevel`; unreadable values fall back. The approver never reads the file (the runtime puts it
  in the prompt); the agent has no write grant.

### Skills, Sprinkles, Sounds

- **Skills**: add under `workspace/skills/<skill-name>/` with a `SKILL.md` plus companion assets or
  `.jsh` scripts.
- **Sprinkles**: add under `shared/sprinkles/<name>/`; name the main file `<name>.shtml` to match
  discovery.
- **Sounds**: add under `shared/sounds/`; prefer stable filenames — shell commands and docs
  reference them.

### Wiki

- `shared/wiki/` seeds the shared KB at `/shared/wiki/`: `WIKI.md` is the schema contract
  (upgrade-merged like `MEMORY.md`); `index.md`/`log.md` are user data seeded once.
- The read-only CLI is `workspace/skills/wiki/wiki.jsh`, adapted from `ai-ecoverse/skills` →
  `skills/llm-wiki/wiki.jsh` with the wiki root pinned to `/shared/wiki`; keep it synced with upstream
  and keep the Tier-0 behavior (fs bound via `require`, zero scans fail loudly) — both pinned by
  `tests/shell/wiki-jsh.test.ts`.
- The memory pass (`etc/MEMORY.md`, consolidation step 5) holds the write path: over-budget reference
  knowledge moves from memory files into wiki pages, leaving a pointer.

### Keyboard shortcuts

- `etc/slicc/keys.json` is the user's OVERRIDE file for keyboard mode, seeded on first boot by
  `ui/wc/wc-shortcut-config.ts` with `"trigger": "auto"` and `"bindings": {}` — the keymap itself is
  `DEFAULT_KEYMAP` in `ui/wc/wc-shortcuts.ts` (a test asserts the file binds nothing). `trigger` is
  `auto`|`esc`|`null`, switched live from Theme settings.
- **Never list a binding in the seed again.** An empty bindings object is what makes the shipped map
  — and every future change to it — inheritable; a seed pinning the whole map would freeze every
  install to it.
- The one write beyond seeding is a one-shot migration: a file still holding the v1 map exactly
  (`isUntouchedV1Document`) is replaced once; anything else is the user's and left alone. Theme may
  rewrite `trigger`.
- The `//` comment must name every `CommandId` (a test asserts it) and carries the v1 keymap as a
  paste-back block (`s` → `sprinkles`).

## External Handoffs

Protocol reference: `docs/slicc-handoff.md`. Agent-facing flow: `workspace/skills/handoff/SKILL.md`
(bundled to `/workspace/skills/handoff/SKILL.md`), reached through the injected skill index — not
through `shared/CLAUDE.md`, which only states handoffs are human-gated. Mechanism: RFC 8288 `Link`
header carrying `https://www.sliccy.ai/rel/handoff` or `.../rel/upskill` on a main-frame response →
`navigate` lick → cone approval card. On behavior changes keep skill and doc aligned; don't duplicate
them here or in `shared/CLAUDE.md`.

## Important Distinction

`packages/vfs-root/shared/CLAUDE.md` is **agent-facing runtime content** bundled into the VFS —
distinct from the developer-facing `CLAUDE.md` files in the repo. Don't merge the roles.
