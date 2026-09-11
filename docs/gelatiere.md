# Gelatiere

SLICC's resident advisor: a persistent work unit that no cone owns, that reviews how the user
works — nightly and after a chat session ends — and suggests skills to install, use cases to try,
and habits to change. Suggestions render as cards in the suggestions sprinkle and every other cone
receives a lick when new ones land.

Feature flag: `memory-v2` (Settings → Experimental features, off by default; also in both
`wrangler.jsonc` `FEATURE_FLAGS` lists — the same flag that gates session search and scoop
pre-compaction snapshots). With the flag on the kernel host creates the unit and its nightly
crontask at boot; `gelatiere init` does the same by hand. With the flag OFF, boot removes any
nightly crontask persisted while it was on (`haltGelatiere`) — otherwise the LickManager would keep
reloading it and the unit would keep making unattended, billable passes. The unit itself stays (a
frozen transcript); flipping the flag back on reschedules the nightly, and `gelatiere status` leads
with a "Memory v2: OFF" line while the flag is off so "registered" does not read as "active".

## Why a scoop with a synthetic owner

The WorkUnit model has two roles: root (`parentJid === null`, a cone with a composer) and child (a
scoop: read-only transcript, no composer, users never talk to it). The gelatiere must not be
promptable, so it is a **child** — but no cone owns it, so its `parentJid` is the synthetic
`GELATIERE_OWNER_JID` (`system:gelatiere`), a jid that never exists in the roster. That is safe
because every consumer of a dangling ownership edge already falls back to the default root
(approvals, `tmpDirFor`, idle notices) and cascades only follow real parents, so no "Drop cone"
can take it down; the folder is claimed like any scoop's. It shows in the tab strip after the cones,
read-only. Two exceptions are carved out for it by `isGelatiereUnit`: compact-on-idle (a root-only
capability) applies to it whatever the flag says, and — because it is registered
`notifyOnComplete: false` — neither a completion notice nor the "ready for 2 minutes without work"
idle nag reaches the default root. It runs under the delegated-child policy, so its record carries
an explicit allow-list (`GELATIERE_ALLOWED_COMMANDS`), read roots (`/sessions/`, `/shared/`,
`/workspace/`, `/home/`, `/cones/`) and one write grant (`/shared/.gelatiere/`) beyond its sandbox
and `/tmp/`.

## Pieces

| Piece                                                                  | Role                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/vfs-root/shared/GELATIERE.md`                                | User-editable pass instructions + config block (`intervalHours`, `nightly`, `maxSuggestions`), seeded to `/shared/GELATIERE.md` when absent; the unit `cat`s it per pass                                                          |
| `packages/webapp/src/base/instruction-frontmatter.ts`                  | The strict YAML subset `MEMORY.md` and `GELATIERE.md` share                                                                                                                                                                       |
| `packages/webapp/src/base/gelatiere-store.ts`                          | The deterministic half: config, suggestion store (id-keyed merge, dismissal ledger), pass/delivery ledger, lick body. `base/` so shell and ui can both use it                                                                     |
| `packages/webapp/src/scoops/gelatiere-unit.ts`                         | The unit: charter, allow-list and path grants, `ensureGelatiereUnit`, the `GelatiereSeam` the host publishes on `globalThis.__slicc_gelatiere`, `bootGelatiere`                                                                   |
| `packages/webapp/src/kernel/host.ts` (`publishGelatiere`)              | Publishes the seam after the lick manager; under the flag boots the unit + nightly crontask (fire-and-forget, store module loaded lazily)                                                                                         |
| `packages/webapp/src/shell/supplemental-commands/gelatiere-command.ts` | `gelatiere init / run / suggest / deliver / list / dismiss / status`                                                                                                                                                              |
| `packages/webapp/src/ui/new-session.ts` (`onSessionSettled`)           | Fired once per freeze after the archive is durable and any background pass (curator or enrichment) is done                                                                                                                        |
| `packages/webapp/src/ui/wc/wc-gelatiere.ts`                            | The session-end hook: if the flag is on, the unit exists and a pass is due, lick the unit with `session-settled`                                                                                                                  |
| `packages/webapp/src/ui/wc/wc-message-view.ts` (`lickCardEl`)          | Gelatiere licks render with their own kind and icon (`ice-cream-cone`) and a readable body (`describeGelatiereLick`) instead of the JSON the cone reads                                                                           |
| `packages/webapp/src/ui/boot/setup-welcome-flow.ts`                    | `gelatiere-dismiss` / `-install` / `-try` card clicks settle the store page-side; install/try go on to the cone                                                                                                                   |
| `packages/webapp/src/ui/wc/wc-gelatiere-fallback.ts`                   | The same card settlement for floats without the onboarding interceptor (cherry, hosted-leader) — `wc-live.ts` wires it wherever `wireWcWelcome` is skipped                                                                        |
| `packages/vfs-root/shared/sprinkles/suggestions/suggestions.shtml`     | The stream: open suggestions as flat `.gelatiere-entry` rows (hairline separators, no nested card chrome). Split from the onboarding-only `welcome.shtml` so follower/extension welcome-dip handling can never mask or restart it |
| `packages/vfs-root/workspace/skills/gelatiere/SKILL.md`                | What a cone does with the lick and the card buttons; what the gelatiere does with its licks; the reusable single-suggestion dip                                                                                                   |

## How a pass runs

1. A lick reaches the gelatiere unit: `[Cron Event: gelatiere-nightly]` (the crontask
   `gelatiere init` registers against folder `gelatiere`, cron from `GELATIERE.md`), a
   `[Sprinkle Event: gelatiere]` with `session-settled` (from `wc-gelatiere.ts`, only when the
   newest of `lastPassAt` / `lastTriggeredAt` is older than `intervalHours`) or `run` (from
   `gelatiere run`), or a direct message. The page stamps `lastTriggeredAt` the moment it sends
   the lick — the interval gate must hold even when the pass legitimately suggests nothing and
   never reaches `gelatiere suggest`.
2. Its charter says: `cat /shared/GELATIERE.md` and follow it. The file walks it through the
   profile, the cones' memory files, the session index and the newest archives (never `cat` an
   archive), `upskill list`, its own `/shared/.gelatiere/notes.md`, the previous suggestions, then the
   catalog, the sitemap and the community repo — and how to build `install` from a catalog row
   (`upskill <repo> [--path p] --skill <name>`, never the bare name). The unit has **no `curl`**:
   for a child unit `allowedCommands` is the only network gate, and an unattended agent that reads
   third-party content while seeing `/sessions/` and every cone's memory must not hold general
   egress — one injected catalog line could otherwise exfiltrate any archive. Its whole web surface
   is `gelatiere catalog` / `gelatiere commands` / `gelatiere man <cmd>`, three pinned
   `www.sliccy.com` fetches; anything else escalates through the sudo gate.
3. On the nightly pass only, `GELATIERE.md` has it start the memory-dreaming pass first —
   `memory dream --all`, detached — which spawns one sandboxed `memory-dreamer` scoop per cone
   with a memory file to consolidate it under `/shared/DREAMING.md`'s instructions
   (`scoops/memory-dreaming.ts`, the curator machinery with a different instruction document).
   The gelatiere itself still cannot write memory files; `memory` is on its allow-list for this
   one command, and the dreamers' writes go through the staged draft + three-way merge.
4. It writes `$TMPDIR/candidates.json` and runs `gelatiere suggest <file> && gelatiere deliver`.
   `suggest` validates (`coerceSuggestions`: kind ∈ skill | use-case | tip, required id/title/body,
   ids slugged, capped at `maxSuggestions`), merges (`mergeSuggestions`: known ids — open or
   dismissed — are never replaced), and stamps `lastPassAt`. `deliver` licks every root cone except
   the gelatiere with the open suggestions created since `lastDeliveredAt`; nothing new → no lick
   (unless `--force`). An explicit `--scoop <target>` must resolve against the roster (folder, name
   or jid) — an unknown target fails before the delivery ledger is stamped, so the suggestions stay
   "new" for the next attempt. Suggestion `url` fields survive only as `http(s)` (they render as a
   live `href` in the suggestions card; every other agent-authored field renders as text), and `install`
   only as a plain `upskill` invocation — bare tokens, no shell metacharacters — because the cone
   executes it verbatim after one click and the pass reads third-party content.
5. It updates its notes file and replies in one line. Compaction trims its conversation while it
   idles.

## Stores

- `/shared/.gelatiere/suggestions.json` — every suggestion, newest first, with `createdAt` and,
  once answered, `takenAt` (Install / Try it) or `dismissedAt` (Not now / `gelatiere dismiss`).
  Capped at 40; past the cap, dismissed entries are trimmed first, then taken, then the oldest open.
- `/shared/.gelatiere/state.json` — `passes`, `lastPassAt`, `lastTriggeredAt`, `lastDeliveredAt`.
- `/shared/.gelatiere/notes.md` — the gelatiere's own cross-pass memory (free-form).
- `/cones/gelatiere/` — the unit's workspace and `CLAUDE.md`, like any extra cone.

## Delivery

One `sprinkle` lick per root cone, `sprinkleName: 'gelatiere'`, `targetScoop` = the cone's folder,
body `{ action: 'gelatiere-suggestions', data: { added, open, suggestions, path, skill } }` (at most
5 suggestions ride in the body). The body carries no prose hint: `skill` points at
`/workspace/skills/gelatiere/SKILL.md`, whose description names the event, so the instruction lives
in the skill index rather than in every lick. The suggestions card does not depend on the lick — it reads
the store through the dip bridge and renders whatever is open. Its buttons emit:

| lick                | who handles it                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `gelatiere-dismiss` | page (`setup-welcome-flow.ts`) stamps `dismissedAt`; no cone turn               |
| `gelatiere-install` | page stamps `takenAt`, then the cone runs the `install` command (per the skill) |
| `gelatiere-try`     | page stamps `takenAt`, then the cone acts on the `prompt` (per the skill)       |

The stream renders the three states differently: open suggestions are flat entries (the sidebar
panel is already a rounded container, so entries draw no box of their own — WHAT as an imperative
title with a quiet small-caps kind label, WHY as one paragraph, one primary pill plus a text-style
"Not now"), taken ones collapse into a "Done" ledger (single ellipsized line + installed/tried),
dismissed ones disappear — the store keeps them so a later pass cannot resurrect what the user
waved away. Copy contract (`GELATIERE.md`): `title` is the WHAT (imperative, ≤8 words), `body` is
the WHY (1–2 grounded sentences, no title restatement); `evidence` rides the lick for cones and is
not rendered on the entry.

Under Memory v2 the suggestions sprinkle is rail-pickable (`sprinkle-discovery.ts` un-hides it when
the flag is on; without the flag there is nothing to stream) and wears the gelatiere's
`ice-cream-cone` glyph, so the stream has a place the user can reopen when a lick announces new
cards. The cone also re-posts it as a chat dip on every delivery, per the skill. The stream lived
inside `welcome.shtml` originally; it was split out (Grok #4, PR #3005) because every surface that
special-cases onboarding took the stream down with it — follower floats restarted the wizard (the
follower sprinkle bridge hard-codes `exists()` false, so the welcomed-marker probe failed) and the
extension side panel swapped everything under the welcome src prefix for a "Set up SLICC" hand-off
card. Followers now drop the stream dip outright (it reads leader-local state) and use its presence
in the transcript as proof the leader finished onboarding, retracting a stale hand-off card.

## Why these choices

- **Licks, not a scheduler of its own.** The nightly crontask and the session-end lick are the two
  producers SLICC already has; the unit's conversation is the queue. `gelatiere run` is a third lick.
- **The unit writes nothing but candidates.** `gelatiere suggest` owns the store so ids, dismissals
  and caps stay deterministic whatever the model writes; `gelatiere deliver` owns addressing so the
  unit never needs the roster.
- **A scoop, shown in the strip.** Hiding it would mean a third role; showing it read-only costs one
  tab and lets the user read every pass transcript without being able to derail it.
- **The seam, not an import.** `shell/` may not import `scoops/`; the host publishes
  `__slicc_gelatiere` exactly as it publishes `__slicc_agent`.

## Live exercise (2026-09-10)

Run on a local harness (bridge `:5715`, local worker build) with Bedrock CAMP / Claude Sonnet 4.6,
three cones doing real work in parallel — the primary wrote and ran a Node word-count script, a
`Bakery` cone built a static site and smoke-tested it with `serve` + `playwright-cli`, a
`Research` cone read the `workflow` man page and wrote a notes file — then "New chat" on the
Bakery cone.

- **Boot**: with the flag on, the `gelatiere` unit and its nightly crontask appeared without any
  command; the unit shows as a fourth tab with no composer — the user cannot prompt it, only
  `gelatiere run` and licks reach it.
- **Root → scoop switch**: the first draft made the gelatiere a root cone. Re-registering it as a
  child under the synthetic owner failed twice on the harness — the old root still held the
  folder, and a mis-foldered twin (`gelatiere-2`) held the crontask by name — which is why
  `ensureGelatiereUnit` throws `GelatiereFolderTakenError` instead of minting a numbered folder,
  and why `gelatiere init --reset` deletes the crontasks before unregistering the units. Under
  the child policy the pass ran without approval prompts except one: the model reflowed long
  output with `fold -w 120`, the escalation landed on the default cone as a command lick, and
  the cone approved it once by itself. `fold` (and the other read-only text utilities a pass
  plausibly reaches for) is now on `GELATIERE_ALLOWED_COMMANDS`.
- **Fresh pass after a reset**: a unit whose conversation still remembers an earlier pass
  answers a `run` from memory ("same four sessions, nothing to add") even when the store was
  wiped underneath it; `gelatiere init --reset && gelatiere run` gives a clean pass. With the
  recipe's "speak to the user as _you_" rule the evidence lines came back as sentences ("Your
  bakery session leaned heavily on playwright-cli — the tool appeared more than 80 times as the
  cone iterated on the build.") rather than file-and-field dumps.
- **Rendering**: the welcome sprinkle's post-onboarding branch must _remove_ the wizard card —
  the dip host styles `.sprinkle-action-card` with its own `display`, which outranks the
  `hidden` attribute and left an empty stepper card above the stream. The seeded
  `/shared/sprinkles/welcome/welcome.shtml` is only written when absent, so an existing profile
  keeps its old copy until it is patched or the VFS is reset. Card spacing inside a dip is a
  general dip-CSS bug (#3031); the sprinkle carries a sibling-margin rule as a stopgap. The
  gelatiere's licks render as `<slicc-lick-card kind="gelatiere">` (ice-cream-cone icon, the
  action as the pill) with the headline and suggestion titles in the body.
- **Session end → pass**: the session-settled lick reached the unit ~40 s after the freeze
  (after title enrichment); the pass took 14 tool steps and about a minute, produced 3 grounded
  suggestions (one of them the bakery build–serve–screenshot loop as a workflow), wrote
  `notes.md`, and replied in one line. `install` commands came out in the repo + path form.
- **Delivery**: the Research cone answered its lick by reading the skill the body points at,
  replying in one sentence and posting the card stream — no hint in the lick body needed. The
  primary and the Bakery cone did NOT answer that first delivery: the Bakery cone was still being
  cleared and the primary was mid-turn when the lick landed. A forced `gelatiere deliver --scoop`
  to each, once idle, was answered at once. Nothing is lost when the announcement is missed — the
  store is durable and the welcome card renders it — but a lick that lands on a busy or
  clearing cone is not answered later. Open question, orchestrator-level, not gelatiere-specific.
- **Cron**: pointing `nightly` two minutes ahead and running `gelatiere init` (which replaces a
  changed expression) fired the worker-side crontask into the unit on the minute; the gelatiere
  judged nothing had changed since the pass 12 minutes earlier and said so in one line without a
  new pass. `crontask list` in the CLI float lists only the node-server's REST tasks, so the
  worker-side nightly is invisible there — `gelatiere status` is the truth. A REST crontask
  created with `crontask create --scoop gelatiere --cron "* * * * *"` in the same session never
  fired and dropped out of the list; not investigated further.
- **Not observed live**: compact-on-idle on the unit (needs an idle window on a large context;
  the gate is unit-tested), the hosted origin, the extension float.
