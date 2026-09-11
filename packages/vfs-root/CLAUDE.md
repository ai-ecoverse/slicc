# CLAUDE.md

This file covers the default virtual filesystem payload in `packages/vfs-root/`.

## What This Package Contains

`packages/vfs-root/` is copied into the app's virtual filesystem on init/reset. It is content, not runtime code.

## Directory Structure

| Path                                    | Purpose                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/vfs-root/shared/`             | Shared content that becomes `/shared/` in the VFS                                          |
| `packages/vfs-root/workspace/`          | Default workspace content that becomes `/workspace/` in the VFS                            |
| `packages/vfs-root/shared/CLAUDE.md`    | Agent-facing runtime instructions bundled into `/shared/CLAUDE.md`                         |
| `packages/vfs-root/shared/MEMORY.md`    | User-editable memory curator config bundled as `/shared/MEMORY.md`                         |
| `packages/vfs-root/shared/DREAMING.md`  | User-editable memory dreamer config bundled as `/shared/DREAMING.md`                       |
| `packages/vfs-root/shared/GELATIERE.md` | User-editable gelatiere pass instructions + config bundled as `/shared/GELATIERE.md`       |
| `packages/vfs-root/shared/wiki/`        | Shared knowledge-base scaffold (`WIKI.md` schema, empty `index.md`/`log.md`)               |
| `packages/vfs-root/shared/sprinkles/`   | Built-in sprinkle UIs                                                                      |
| `packages/vfs-root/shared/sounds/`      | Shared notification sounds                                                                 |
| `packages/vfs-root/workspace/skills/`   | Default installable workspace skills                                                       |
| `packages/vfs-root/etc/`                | System config seeded into `/etc/` (`models`, `sudoers`, `APPROVALS.md`, `slicc/keys.json`) |

## Adding Default Content

### Gelatiere

- `shared/GELATIERE.md` is the gelatiere's twin of `MEMORY.md`: the store's build-time fallback
  and the seeded `/shared/GELATIERE.md`, seeded only when absent, user-edited only. Same
  frontmatter dialect (`base/instruction-frontmatter.ts`); keys are `intervalHours`, `nightly`
  (5-field cron) and `maxSuggestions` (capped at 10). No placeholders: the unit `cat`s the file at
  the start of every pass, so keep it self-contained (literal paths, `date` for today).
- The gelatiere is a persistent SCOOP under a synthetic owner (folder `gelatiere`,
  `scoops/gelatiere-unit.ts`), not a spawned agent: its charter is the record's `systemPromptAppend`, the pass recipe is this file.
  Its deliverable is `gelatiere suggest <candidates.json> && gelatiere deliver`; the command owns
  the store and the addressing. Keep the recipe's commands on `GELATIERE_ALLOWED_COMMANDS` (a child
  escalates anything else) and its cross-pass memory in `/shared/.gelatiere/notes.md`. Design:
  `docs/gelatiere.md`.
- `shared/sprinkles/suggestions/suggestions.shtml` is the gelatiere's suggestion stream (flat
  entries read through the dip bridge's `slicc.readFile`), split from the onboarding-only
  `shared/sprinkles/welcome/welcome.shtml` so follower/extension handling of the welcome dip can
  never mask or restart the stream. The cone re-posts it as a dip on every delivery (per
  `workspace/skills/gelatiere/SKILL.md`) and it is rail-pickable under Memory v2. The card buttons
  lick `gelatiere-install` / `gelatiere-try` (settled page-side, then the cone acts per the skill)
  and `gelatiere-dismiss` (settled page-side).

### Memory curator

- `shared/MEMORY.md` is the single source for the runner's build-time fallback and the seeded
  `/shared/MEMORY.md` file.
- The file is seeded only when absent, so user and skill customizations survive later boots.
- `MEMORY.md` is user-edited only; the curator intentionally cannot rewrite its own instructions.
- Frontmatter uses a strict YAML subset: block-array items may have `#` comment tails; inline
  entries containing commas must be quoted. A bare `/` is rejected from `writablePaths`.
- Frontmatter `allowedCommands` entries extend the curator's built-in base set; they do not
  replace or remove base commands.
- The curator may rewrite the entire memory file, and the hard character budget
  applies to the entire file with no protected region.
- **The curator edits a staged draft, never the live file.** `{{MEMORY_PATH}}` resolves to
  `/sessions/.curation/<archive>/draft.md`, seeded (with a `base.md` snapshot) from the live
  memory when the pass spawns; the agent bridge three-way-merges base→draft onto the live file
  on exit 0, before the success receipt (`mergeOnSuccess`). Concurrent live edits survive;
  conflicting regions resolve to the curator. A killed or failed run leaves the live memory
  untouched. The bridge also writes `/sessions/.curation/<archive>/status.json` on both exit
  paths (`outcomeReceiptPath`) — the durable ledger of which sessions completed vs failed
  curation; the index entry mirrors it as `memoryCuratedAt` / `memoryFailed`. Per-archive
  keying means parallel per-cone curators (#1666) never share staging state.
- Every `##`/`###` memory section ends with a `YYYY-MM-DD` last-verified date, in UTC to match
  archive timestamps. Each pass re-verifies the oldest sections first; undated sections are
  maximally stale.
- Entries follow the provenance/supersession grammar (MEMORY.md "Entry grammar"): `human:` /
  `process:` actor prefixes, version pins instead of confidence scores, `stale_after: YYYY-MM-DD`
  as an absolute instant, corrections that REPLACE claims, and a `## Not true` block
  (`- not: … — why … — instead …`) for refuted claims worth keeping as traps. The dreamer
  (`DREAMING.md`) enforces the grammar on old entries and reports contradiction-pair counts
  before/after so a pass that cannot reduce them is visible.
- The curator's write grant is `/workspace/CLAUDE.md` alone, not `/workspace/`. It can run `upskill`
  to look up a skill for a pitfall it found, and a directory-wide grant would also let it install
  into `/workspace/skills/`. Reads still cover `/workspace/`. Single-file entries in
  `writablePaths` work because `generateScoopSudoers` emits both the bare path and the `/**` form.
- The pass is detached, so it spawns with `notifyOnComplete`. Its closing message reaches the cone
  on the `scoop-notify` channel; that is where a skill suggestion lands. Without it the report is
  discarded and the cone never learns the pass ran.
- Turn count is what a pass costs, because every turn re-reads the whole context as a cache read.
  Two things keep it down, and both belong to the prompt rather than the runtime: `thinkingLevel`
  (default `medium`; spawned agents otherwise resolve to `off`) so the curator plans the cut
  instead of converging by trial and error, and the archive reading recipes so it never `cat`s a
  multi-megabyte archive whose `slicc:session-data` block is a single line holding half the file.

### Approver agent

- `etc/APPROVALS.md` is the single source for the runner's build-time fallback and
  the seeded `/etc/APPROVALS.md`, exactly like `shared/MEMORY.md` is for the curator.
  `SudoManager.ensureDefaults()` does the seeding, when absent, on the ungated
  handle — the same place `/etc/sudoers` is seeded, and for the same reason: the
  file is self-protected, so anything else that had to create it (the `upgrade
apply` merge) would prompt the owner to approve the default already in force (#2686).
- It lives in `/etc/` because it is POLICY, next to `sudoers` — not in `/shared/`,
  which is agent-visible content. Writes to it are self-protected in
  `base/sudoers.ts` (`isSelfProtectedWrite`) for the same reason writes to
  `/etc/sudoers` are: it decides what a GUEST may do, and a cone acting on a
  guest's message must not rewrite the rules gating that guest without the owner
  seeing a prompt.
- Re-read on EVERY decision, not cached: an owner who tightens it after a bad
  call expects the next decision to use it. Missing or unreadable falls back to
  the bundled default rather than wedging approvals shut.
- The optional ```yaml block tunes `timeoutSeconds` (clamped — a guest, and for
  a tool gate the cone's turn, is blocked on the decision), `model`, and
  `thinkingLevel`. Unreadable values fall back rather than becoming real.
- The approver never reads this file itself; the runtime reads it and puts it in
  the prompt. The agent holds no write grant at all.

### Skills

- Add new built-in workspace skills under `packages/vfs-root/workspace/skills/<skill-name>/`.
- Include `SKILL.md` and any companion assets or `.jsh` scripts the skill needs.

### Wiki

- `shared/wiki/` seeds the shared knowledge base at `/shared/wiki/`: `WIKI.md` is the schema
  contract (upgrade-merged like `MEMORY.md`), `index.md` and `log.md` are user data seeded once.
- The read-only CLI is `workspace/skills/wiki/wiki.jsh`, adapted from `ai-ecoverse/skills` →
  `skills/llm-wiki/wiki.jsh` with the wiki root pinned to `/shared/wiki`; keep the body in sync
  with upstream when refreshing, and keep the Tier-0 behavior (fs bound via `require`, zero scans
  fail loudly) — `tests/shell/wiki-jsh.test.ts` pins both.
- The nightly dreamer (`shared/DREAMING.md`) holds the write path: over-budget reference knowledge
  moves from memory files into wiki pages, leaving a pointer line behind.

### Keyboard shortcuts

- `etc/slicc/keys.json` is the user's OVERRIDE file for keyboard mode, seeded on first boot by
  `ui/wc/wc-shortcut-config.ts`. It ships with `"trigger": "auto"` and `"bindings": {}` — the
  keymap itself is `DEFAULT_KEYMAP` in `ui/wc/wc-shortcuts.ts`, and a test asserts the file binds
  nothing. `trigger` is `auto` | `esc` | `null` (Theme settings switches it live).
- **Never list a binding here again.** v1 wrote its whole keymap into the seed, and because the
  file is applied OVER the defaults that pinned every install to v1 forever: no later map, and no
  key for any command added since, could reach anyone who had booted once. An empty bindings object
  is what makes the shipped map — and every future change to it — inheritable.
- The one write beyond seeding is that migration: a file still holding the v1 map exactly
  (`isUntouchedV1Document`) is replaced once. Anything else, including v1 with one line changed,
  is the user's and is left alone — an edited config must survive every later boot. Theme settings
  may also rewrite `trigger` in place.
- The `//` comment must name every `CommandId` (a test asserts it) and carries the v1 keymap as a
  paste-back block for anyone who wants the old keys. `s` maps to `sprinkles` there, not to a
  cycle command: `p`/`s` opens the first and the step keys walk the rest.

### Sprinkles

- Add built-in sprinkles under `packages/vfs-root/shared/sprinkles/<name>/`.
- Keep the main file named `<name>.shtml` to match discovery and sprinkle naming conventions.

### Sounds

- Add shared sounds under `packages/vfs-root/shared/sounds/`.
- Prefer stable filenames because shell commands and docs may reference them directly.

## External Handoffs

- Mechanism: RFC 8288 `Link` response header carrying `https://www.sliccy.ai/rel/handoff` or `https://www.sliccy.ai/rel/upskill` on a main-frame document response → `navigate` lick → cone approval card.
- Agent-facing flow: `packages/vfs-root/workspace/skills/handoff/SKILL.md` (bundled to `/workspace/skills/handoff/SKILL.md`); the agent reaches it through the injected skill index, not through `shared/CLAUDE.md`, which only states that handoffs are human-gated.
- Protocol reference: `docs/slicc-handoff.md`.
- When handoff behavior changes, keep the skill and `docs/slicc-handoff.md` aligned — do not duplicate their content here or in `shared/CLAUDE.md`.

## Important Distinction

`packages/vfs-root/shared/CLAUDE.md` is **agent-facing runtime content** bundled into the virtual filesystem.

It is different from the developer-facing `CLAUDE.md` files in the repository. Do not merge those roles together.
