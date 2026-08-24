# WorkUnit — one runtime primitive for cones and scoops

Architecture decision record for [#1666](https://github.com/ai-ecoverse/slicc/issues/1666). Code: `packages/webapp/src/work-unit/`.

## Decision

The **cone** (the user's root agent) and every **scoop** (a delegated child) are the same kernel primitive, a `WorkUnit`:

> one LLM conversation + one filesystem view + one shell/process group + one agent runtime + an explicit policy and lifecycle.

They differ in exactly one structural fact — the ownership edge — and in what is derived from it:

|                                                                                                   | Root (cone)                                                            | Child (scoop)                                                |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `RegisteredScoop.parentJid`                                                                       | `null`                                                                 | jid of the owning unit                                       |
| `display.role`                                                                                    | `primary`                                                              | `child`                                                      |
| `policy.filesystem`                                                                               | `full-workspace` (`VirtualFS`)                                         | `restricted` (`RestrictedFS` over the config paths)          |
| `policy.approvalAuthority`                                                                        | `user`                                                                 | `{ parentId }`                                               |
| `policy.canCreateChildren` / `canManageChildren` / `canWriteSharedMemory` / `canResolveApprovals` | `true`                                                                 | `false`                                                      |
| `policy.sudoDefaultDisposition`                                                                   | `allow`                                                                | `require-approval`                                           |
| `completion.mode`                                                                                 | `interactive`                                                          | `notify-parent` (`silent` when `notifyOnComplete === false`) |
| `workspace.root`                                                                                  | `/workspace` (primary cone) / `/cones/<folder>/workspace` (extra cone) | `/scoops/<folder>/workspace`                                 |

Cone and scoop stay the product vocabulary (UI, prompts, tool names, skills). They are no longer kernel types.

### Decisions taken (2026-08-21)

1. **Name**: `WorkUnit`. Neutral and architecture-facing; `AgentContext` collided with `ScoopContext`.
2. **Root test**: `parentJid === null`, nothing else. `isCone` / `type` were deleted from `RegisteredScoop` in #2279 — the compiler now enforces the rule, because a role branch has no field to read. `isCone` survives only on the follower wire (`ScoopSummary`), projected from `isRootUnit`.
3. **Field name**: the edge stays `parentJid` (jid is this codebase's id vocabulary) but is **required** `string | null`. `WorkUnitDescriptor.parentId` maps to it.
4. **Ordering**: structural cleanup first. Multiple concurrent roots are the payoff of Phases 1–3, not a UI deliverable of them.
5. **Default root**: the oldest root (`WorkUnitManager.resolveDefaultRoot()`) receives unaddressed events. A UI-selected root comes with the client protocol phase.
6. **Grandchildren**: children keep `canCreateChildren: false`. The flag exists so an explicit grant is a policy change, not a runtime type.

## Invariants (adopted from the RFC)

1. Every conversation belongs to exactly one work unit.
2. Every child has an explicit parent unless promoted to a root.
3. Child capabilities ⊆ parent capabilities (`isPolicySubset`) unless the user grants more.
4. Cone and scoop are roles over one runtime; `scoops/` and `kernel/` code routes on `parentJid` / policy, never on `isCone`.
5. Closing a unit tears down everything it owns — turns, tools, realm workers, shell processes, observers, subscriptions — in one place.
6. Runtime detection (float, extension, follower) happens at composition time, not in unit logic.

## Module map

| File            | Purpose                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`      | `WorkUnitDescriptor`, `WorkUnitPolicy`, `CompletionPolicy`, `WorkUnitStatus` (`creating → ready ⇄ running`, `* → failed`, `* → closed`), events, `statusFromTab`                                     |
| `policy.ts`     | `interactiveRootPolicy`, `delegatedChildPolicy`, `derivePolicy`, `deriveCompletion`, `isRootUnit`, `isPolicySubset`, `childrenOf`, `rootsOf`                                                         |
| `descriptor.ts` | `toDescriptor(scoop, tab?)`, `workspaceFor`, `PRIMARY_WORKSPACE`, `SKILLS_LIBRARY_DIR` — pure projections; the ONE place the per-unit directory layout is decided                                    |
| `runtime.ts`    | `WorkUnitRuntime` contract + the `WorkUnitHost` slice (`getScoop`, `ensureLiveUnit`) a manager resolves units through                                                                                |
| `live-unit.ts`  | `LiveWorkUnit` — the owning runtime: holds the `ScoopContext`, tab record and observer set; `transition()` enforces `LEGAL_TRANSITIONS`; `close()` is the single teardown                            |
| `record.ts`     | `normalizeScoopRecord` (strips the pre-#2279 `isCone`/`type`, sanitizes a root), `legacyRecordIsCone`, `chatSessionIdFor`, `isPrimaryRoot`, `coneFolderFor`, `processOwnerKindFor`, `sourceLabelFor` |
| `manager.ts`    | `WorkUnitManager` — `create / list / get / getParent / getChildren / roots / rootOf / resolveDefaultRoot / abort / close`; exposed as `Orchestrator.getWorkUnits()`                                  |
| `conversation/` | The canonical conversation record (#2275): entry types, identity, ingest, the four derivations, the `slicc-work-units` store and its resumable migration — see below                                 |

Tests: `packages/webapp/tests/work-unit/`. `conformance.ts` is a reusable suite any `WorkUnitRuntime` implementation must pass.

End to end, the multi-cone product surface is covered by the fake-LLM Playwright suite ([#2313](https://github.com/ai-ecoverse/slicc/issues/2313)), which runs the real shell with the `multiple-cones` flag on:

| Spec (`packages/webapp/tests/e2e/`) | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multiple-cones.test.ts`            | create a cone from a brief → chat → `scoop_scoop` → switch → drop; the last-cone guard; oldest-survivor promotion; the rail's session actions and their freezer outcomes (`memorySkipped` on drop, cone attribution on the entry, the `Frozen chat · from cone …` caption)                                                                                                                                                                                                                                                                                                                                                                                                   |
| `multiple-cones-licks.test.ts`      | lick addressing: an untargeted `fswatch` created from an extra cone's shell returns to that cone, one addressed `--scoop <cone name>` resolves by name, and neither reaches the oldest root                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `multiple-cones-follower.test.ts`   | leader + follower joined through a real `wrangler dev` tray hub: strip mirroring (`orderForSwitcher` vs `toFollowerSwitcherScoops`), a follower changing one cone's model while the leader sits in another (#2310). A read-only-scoop spec (#2312) sits beside them, `test.fixme`-gated on the `READ_ONLY_SCOOP_VIEW` constant and therefore not running, until that behaviour lands. **The mirroring/model spec runs locally only** — it is `test.skip`-gated on `CI` because a follower on a GitHub-hosted runner never receives a usable model catalog ([#2329](https://github.com/ai-ecoverse/slicc/issues/2329), a gap in the #2310 wire path rather than a flaky test) |

Topology helpers live in `tests/e2e/two-instance-helpers.ts`.

## Migration phases

A strangler migration, each phase a separate PR with deletion criteria:

| Phase | Scope                                                                                                                                                                                                                                                                                                | Status                    |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1     | Types, required `parentJid` + restore backfill, adapter, manager facade, conformance tests. No behaviour change.                                                                                                                                                                                     | done                      |
| 2     | Lifecycle ownership: `ScoopLifecycleManager` hosts one `LiveWorkUnit` per scoop (its context, tab, observers); `getContexts()` / `getTabsMap()` are derived views; `close()` is the single teardown; transitions tested as one state machine.                                                        | done                      |
| 3     | `isCone` replaced by hierarchy and policy in `scoops/` and `kernel/` (filesystem, approvals, child tools, shared memory, completion, default-target routing, presentation); two independent roots proven in `tests/work-unit/multi-root.test.ts`.                                                    | done                      |
| 9a    | Deletion (#2279): `RegisteredScoop.isCone` / `type` gone, the `ui/` reads migrated to `isRootUnit` / `summaryIsRoot`, the `isCone` ratchet retired (the type is the gate), the Phase 1 `ScoopContextWorkUnit` adapter removed.                                                                       | done                      |
| 4     | Add / switch / drop cones in the UI: new-cone / drop-cone in the freezer rail's action row, the tab strip as the only switcher, `cone-create` allocates `cone-<slug>` folders and per-folder chat sessions, `scoop-drop` of a root cascades and refuses the last root, `cone:<folder>` URL contexts. | done                      |
| 5a    | One canonical conversation record per work unit (#2275): `ConversationEntry`, the `slicc-work-units` store, the four derivations, and a resumable migration behind a read-old/write-new window. Legacy stores still written; their deletion is a follow-up.                                          | done                      |
| 5–9   | `WorkUnitClient` for local/remote UI, `CapabilityBroker`, explicit workspace sharing modes, generic parallel APIs, deletion of legacy paths.                                                                                                                                                         | deferred; separate issues |

### Phase 4 detail

- Behind the `multiple-cones` feature flag (Settings → Experimental; off by default). With it on, `ui/wc/wc-cone-actions.ts` reports the cone count to `<slicc-freezer-new>` (`cones` attribute), whose expanded action row then offers **New cone** and — only while more than one cone exists — **Drop cone**. The last cone can never be dropped: the row hides the action and a stale confirm is ignored, `OffscreenClient.unregisterScoop` rejects, `Bridge.handleScoopDrop` refuses, and `ScoopLifecycleManager.unregister` throws.
- There is no cone list in the rail — the top tab strip (`<slicc-agent-tabs>`) is the only switcher: every cone first (oldest first), then the **selected** cone's scoops, then every other scoop (`orderForSwitcher(scoops, selectedJid)`; followers mirror it in `toFollowerSwitcherScoops(summaries, selectedJid)`). Both actions open a `<slicc-dialog>` on the body; nothing is ever inserted into the rail, so the frozen cards never move. **New cone** asks for a name and one optional brief ("What should it work on?"). The brief is sent as both `description` and `prompt` on `cone-create`: `Bridge.handleConeCreate` keeps it as `config.systemPromptAppend` (`This cone is for: …`, so the cone still knows its job after its chat is frozen) and routes it through the ordinary user-message path, so the first turn starts at once. **Drop cone** confirms in one line.
- **Drop cone** freezes the cone's chat first (`runNewSessionArchiveOnly` → `freezeConeSession({ mode: 'quick', memory: 'skip' })`, archive marked `memorySkipped` so the catch-up enriches title/icon only and never mines memory), then `unregisterScoop`. Its frozen cards stay; the oldest surviving root is the primary, so dropping the oldest moves the list up.
- The panel's existing `cone-create` message now creates _additional_ roots: `Bridge.handleConeCreate` allocates the folder with `coneFolderFor` (`cone` for the first root, `cone-<slug>` afterwards, de-duplicated) and labels extra cones by the user's name; the primary keeps `sliccy`.
- Chat sessions are keyed per folder (`chatSessionIdFor` → `session-<folder>`), so the primary cone keeps `session-cone` and every other cone gets its own history. Session-level actions follow the **selected** cone — see "Per-cone sessions" below.
- `scoop-drop` of a root goes through `WorkUnitManager.close()` (cascades to its scoops, forgets every dropped buffer/session) and refuses the last root; the rail hides ✕ on the last cone for the same rule.
- The tray wire carries the edge: `ScoopSummary.parentId` / `ScoopListMsg.scoops[].parentId` (`null` for a cone; absent from leaders older than this). Browser followers group each cone with its own scoops (`toFollowerSwitcherScoops`), the extension panel takes ownership from the wire (`OffscreenClient`) and only infers it for legacy leaders; iOS decodes the field and keeps `isCone` as its root test.
- Presentation lives in `ui/wc/wc-unit-context.ts`: chip label = `assistantLabel` for roots, thread/URL context `cone` (primary) / `cone:<folder>` (extra) / `scoop:<name>`, default root = primary else oldest. Followers render every cone from the unchanged wire.
- Per-cone workspaces landed separately (#2271) — see below.

### One conversation record per work unit ([#2275](https://github.com/ai-ecoverse/slicc/issues/2275))

Before this, one conversation lived in three durable places, none of them
authoritative, and every reader repaired against the others:

| Store                  | Key                | Held                        |
| ---------------------- | ------------------ | --------------------------- |
| `agent-sessions`       | `<jid>`            | Pi's `AgentMessage[]`       |
| `browser-coding-agent` | `session-<folder>` | the chat panel's projection |
| `slicc-groups`         | `chatJid`          | routed messages / licks     |

The canonical record (`work-unit/conversation/`) is the single durable
representation of settled conversation state for one unit. Everything else is
a **derivation**, never a parallel write.

| Module         | Owns                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`     | `ConversationEntry` (`user` / `assistant` / `tool-call` / `tool-result` / `external-event` / `child-result`), the record, its version |
| `key.ts`       | identity — `<workspaceId>::<workUnitId>`, workspace root × jid                                                                        |
| `entries.ts`   | ingest from Pi messages (live path) and from a chat transcript (migration only)                                                       |
| `derive.ts`    | `toAgentMessages` (Pi), `toChatMessages` (UI), `toTranscriptText` (tray / archives), `toChildResultSummary`                           |
| `store.ts`     | the `slicc-work-units` IndexedDB store + the migration cursor                                                                         |
| `migration.ts` | the versioned, resumable pass over the legacy stores                                                                                  |

Tests: `packages/webapp/tests/work-unit/conversation/`.

**A `tool-call` entry carries no arguments.** Pi keeps tool calls inside the
assistant message that issued them, so the entry is an addressable handle
(`toolCallId`, `name`, `assistantEntryId`) and the Pi derivation skips it.
Copying a `write_file` payload onto it would double the record for nothing.

**The record is append-only, with exactly one exception.** A turn adds
entries with ascending `seq` and never edits one. Compaction (and
`clear-chat`) replaces Pi's history wholesale — that shows up as a prefix
divergence, is applied as a replace, and is counted on `rewrites`.
Interleaving the two would splice a pre-compaction conversation into a
post-compaction one.

**Two origins, because you cannot invent Pi messages.** A record built from
`agent-sessions` (`origin: 'agent-history'`) derives faithfully to both Pi
history and the UI projection. A record built from `browser-coding-agent`
(`origin: 'ui-projection'`) — a unit whose Pi history was lost — derives to
the UI projection and to **no Pi history at all**, deliberately: replaying a
reconstruction of a rendered transcript to the model is worse than restoring
from the legacy store, and an empty derivation is exactly what makes that
fallback happen.

#### The read-old/write-new window, and how to roll back

This is not a cutover. While the window is open:

- **Every write goes to both.** `SessionPersistence.persistNow` writes the
  canonical record AND `agent-sessions`; the bridge still writes
  `browser-coding-agent`.
- **Every read prefers the canonical record and falls back on absence.** The
  kill switch is DATA, not a flag: no record, an unreadable one, a record from
  a newer schema, a `ui-projection` record, or an IndexedDB that will not open
  — each derives to nothing, and nothing means "use the legacy store". A unit
  that was never migrated behaves exactly as it did before #2275.
- **The migration deletes nothing.** It reads the legacy stores and writes the
  canonical one. `agent-sessions` and `browser-coding-agent` are left
  byte-for-byte as they were.

**Rollback** is therefore complete and cheap, in two forms:

1. _Reverting the code_ — the legacy stores hold every conversation up to the
   moment of the revert, because they were written on every turn.
2. _Clearing the canonical database_ (`WorkUnitConversationStore.clearAll()`,
   or deleting `slicc-work-units` in devtools) — every read falls back, and
   the next boot re-runs the migration from the untouched legacy data.

The follow-up that deletes the legacy writes is what closes this window; it
must not land until the canonical store has been dogfooded through at least
one migration + rollback cycle.

#### Migration behaviour

- **Versioned.** `CONVERSATION_RECORD_VERSION` is part of the cursor; bumping
  the schema re-runs the pass over every unit.
- **Resumable.** The cursor is persisted after every unit, so a boot that dies
  mid-pass — a poisoned record, a killed tab, the #2007 ready-timeout —
  continues where it stopped.
- **One unit cannot break the boot.** A legacy read that throws, or a payload
  whose `messages` is not a list (the #2006 lesson: a half-written record is a
  repair job, not a delete), is recorded in the cursor's `skipped` list with
  its reason and left in place. That unit keeps reading the legacy stores.
- **The cursor advances past a skipped unit** on purpose: retrying an
  unreadable record every boot would re-spend the boot budget that made it
  unreadable. A schema bump is the sanctioned retry.
- **Pre-`parentJid` records** (#1666) are backfilled by `Orchestrator.init`
  before the pass runs; the pass coerces a missing edge to `null` anyway, so a
  legacy primary cone can never be keyed as a child under `/scoops/`.

#### What this PR did NOT make dead

The repair chain in `Bridge.handleRequestScoopMessages` stays. The canonical
record is inserted as a new step — the only one that answers for a unit whose
context has not spawned — but the buffer, the live-agent translation and the
legacy UI-store fallback are still the UI's sources until the client protocol
consolidates them in
[#2274](https://github.com/ai-ecoverse/slicc/issues/2274). Removing them now
would be removing paths this PR has not yet replaced.

### Per-cone workspace and memory (#2271)

`workspaceFor` (`work-unit/descriptor.ts`) is the single source for a unit's
directory layout. Every consumer reads it — `ScoopContext` (dirs, cwd, memory
file, system prompt), `ConeMemoryStore` / `appendConeMemory`, `scoop_scoop`'s
and the `agent` command's path defaults, and through those the generated
per-scoop sudoers.

| Unit                         | Workspace                    | Memory                       | Scratch            |
| ---------------------------- | ---------------------------- | ---------------------------- | ------------------ |
| primary cone (folder `cone`) | `/workspace`                 | `/workspace/CLAUDE.md`       | `/tmp`             |
| extra cone (`cone-<slug>`)   | `/cones/<folder>/workspace`  | `/cones/<folder>/CLAUDE.md`  | `/tmp`             |
| scoop                        | `/scoops/<folder>/workspace` | `/scoops/<folder>/CLAUDE.md` | `/scoops/<folder>` |

- **The primary cone never moves.** `/workspace` is named by mounts, deep
  links, skills, `upskill`, workflow discovery and every existing profile;
  `isPrimaryRoot` (folder `cone`) keeps it exactly where it was.
- **Shared by design**: `/shared`, `/tmp` (the float-wide scratch space
  `builtinScoopGrants` already grants every scoop), `/mnt`, `/scoops`,
  `/sessions`, and the skills library at `/workspace/skills`
  (`SKILLS_LIBRARY_DIR`). Skills are a library, not a home: `upskill` installs
  there and `PATH` / `.jsh` / workflow / sprinkle discovery all name it, so a
  private per-cone copy would only ever hold stale bundled defaults.
- **Isolation is by layout, not by enforcement.** Every cone is
  `full-workspace` (unrestricted `VirtualFS`) — two cones do not _see_ each
  other's files by default because their roots are disjoint and each starts in
  its own cwd, not because a wall stops them. A scoop IS walled: the read-only
  roots `scoop_scoop` injects are now the creating cone's workspace plus the
  skills library (`defaultChildVisibleRoots`), so a scoop spawned by an extra
  cone reads that cone's files, not the primary's. Same for the `agent`
  command, which resolves its owner through `WorkUnitManager.rootOf` — the one
  cycle-safe walk the kernel already uses — falling back to
  `resolveDefaultRoot()` so a dangling chain can never hand out a child's
  `/scoops/<folder>` as a workspace. The UI and `scoop_scoop` take the same
  answer from `ownerWorkspaceFor` (the shared `rootOwnerOf` walk) where no
  manager is in reach.
- **The UI follows the selection.** The workbench file tree and the memory
  panel take their roots from the cone that owns the current selection, so
  switching cones re-points both (`WcWorkbenchDeps.getWorkspace`). The tree
  re-reads on its own 3 s poll; memory has no poller, so a selection change
  pushes `WorkbenchActivator.refreshMemory()` — otherwise an open panel would
  keep showing the previous cone's memory indefinitely.
- **Memory**: the sink path is bound by `ScoopLifecycleManager` from the unit's
  own record (`workspaceFor(scoop).memoryPath`), never from the caller's meta,
  so an extra cone's compaction pass cannot append to the primary's file. The
  logarithmic budget pass (`applyConeMemoryBudget`) takes the same path.
- **Scoop config migration** (`ScoopConfig` schema v3): a scoop saved before
  this change keeps a `visiblePaths` list its owning cone has since moved away
  from. On restore, exactly the historical default (`['/workspace/']`) on a
  scoop owned by an extra cone is re-pointed at that cone's roots; any other
  list is a deliberate configuration and is left alone, and scoops of the
  primary cone never change.
- **Migration**: extra cones created under #2262 are NOT migrated. They used
  `/workspace` because every root did; on the first boot after this change they
  start with a fresh, empty `/cones/<folder>/workspace` and `CLAUDE.md`. Nothing
  is moved or deleted — their previous files and memory bullets stay in
  `/workspace`, which every cone can still `cd` into. Copying was rejected
  because the files of two cones that shared one directory are indistinguishable
  after the fact, and the flag is experimental and off by default.

- **The curator runs per cone.** With the `agentic-memory` flag on, compaction
  extraction is off (`shouldExtractMemories: () => !flag`) and the curator IS
  the memory path — so it runs for whichever cone was frozen, not just the
  primary: `runAgenticMemoryPass` takes a `cone: { folder, jid? }`, derives
  that cone's coordinates from `workspaceFor`, and curates
  `/cones/<folder>/CLAUDE.md` from `session-<folder>`'s archive. There is no
  fallback to compaction-time extraction; an extra cone with no curator would
  have no memory at all.
  - `cwd` is the cone's own workspace, and `writablePaths` stays the single
    memory file (an `upskill` install still escalates).
  - The frontmatter in `/shared/MEMORY.md` is written primary-relative and is
    user-editable, so it is **rebased** onto the target cone rather than taken
    verbatim — `/workspace/CLAUDE.md` → this cone's memory file, `/workspace/`
    → this cone's root. The skills library is never rebased (one library for
    every cone), and it is re-added to `visiblePaths` when rebasing moved the
    only entry that covered it.
  - The agent name is per cone (`memory-curator` for the primary,
    `memory-curator-<folder>` otherwise), so two cones curating two different
    files never collide on the name-in-use check — that check exists to stop a
    second curator clobbering the SAME file. The bridge derives the private
    scratch folder from the name, so `{{SCRATCH_DIR}}` in the prompt moves with
    it; a `MEMORY.md` predating that placeholder has the primary's literal path
    rewritten.
  - The pass is parented to the cone it curates (`cone.jid`), so escalations
    reach that cone's approval router and model inheritance follows it.
- **Legacy (flag-off) extraction is per cone too.** The freezer's own append
  and the boot catch-up's enrichment write to the frozen archive's cone —
  resolved from the `cone` provenance the archive already records — and the
  budget pass bounds that same file.

Every `agent` spawn path now leaves the read-only roots to the command, which
resolves them from the owning cone: the shell command's own default, the realm
module (`sliccy:agent`) and the workflow prelude's `agent()` all omit
`--read-only` unless the caller passes one. The flag is pure-replace, so a
hardcoded `/workspace/` in a wrapper silently overrode the owner-relative
roots — an extra cone's sub-agent read the primary cone's files and not its
own.

### Per-cone sessions ([#2272](https://github.com/ai-ecoverse/slicc/issues/2272))

"New chat", the Freezer and `clear-chat` follow the **selected** root instead of the literal `session-cone`:

- `wc-live-freezer.ts` resolves the target once, up front, with `rootForSelection(scoops, selected)` (`ui/wc/wc-unit-context.ts`): a selected root is itself, a selected scoop walks `parentJid` up to the root that owns it, nothing selected falls back to `defaultRootOf`. The resolution happens BEFORE the freeze's awaits, so a roster refresh mid-freeze cannot move the target between archive and clear, and the same root is re-selected afterwards.
- `freezeConeSession` / `runNewSessionFreeze` take a `cone: { folder, label? }` (`FreezerConeRef`). Omitted, they target the primary cone — every pre-#2272 caller is unchanged.
- The rail's expanded action row (`<slicc-freezer-new>`, `expanded`) is one fixed-height line of icon buttons with tooltips: **New chat** (freeze + extract memories, same cone), **New chat, fast** (freeze, memories extracted later), **Discard** (no freezer, no memories, same cone), then **New cone** / **Drop cone** under the flag. Collapsed, the single badge keeps its click / double-click / long-press gesture. Under `agentic-memory` the fast action is hidden (`no-skip`).
- Licks a cone produces come back to it: every root except the untargeted default carries `SLICC_LICK_TARGET=<folder>` in its shell (`buildScoopShellEnv`), and every producer a cone's shell can start falls back to it — see "Addressing licks to a cone" below. That default is `rootsOf(scoops)[0]` — the **oldest** root, which is what `routeFormattedLickToCone` falls back to — resolved by jid against the live roster, _not_ by asking who holds the reserved `cone` folder: after the original primary is dropped, `coneFolderFor` hands that freed folder to the next new cone, which would then look primary while an older root is still the untargeted destination.
- `clear-chat` carries an optional `scoopJid`; `Bridge.handleClearChat` clears that root's live context and deletes `chatSessionIdFor(target)`. An unknown or absent jid falls back to the default root and `session-cone`.
- Archives record their provenance: `cone` (the folder) plus `coneLabel` for extra cones only, in both the index entry and the archive frontmatter — so a rebuild from `/sessions/*.md` recovers it and the enrichment rename preserves it. `memorySkipped` rides the frontmatter for the same reason: `pendingEnrichment` comes back from the `pending-` filename, so an index-only marker would be dropped by a rebuild and the next catch-up would mine a chat that opted out. There is **one Freezer for all cones**: the rail card never names the cone; the thawed chat log opens with a `Frozen chat · from cone Research` caption (`frozenProvenanceEl`, a `<slicc-day-separator>` prepended to the thread column). The primary cone and legacy archives with no `cone` field read `Frozen chat` and are treated as the primary cone's.
- Thawing stays read-only, so it can never overwrite another cone's view; when a thaw fails, the fallback selection goes to the cone the archive named (`rootForConeFolder`), not blindly to the primary one.
- Boot hydration follows the URL context: `?ctx=cone:cone-research` hydrates `session-cone-research`, a bare boot the primary `session-cone`, and `scoop:` / `freezer:` contexts hydrate nothing (`rootFolderForContext`).
- **Read-only scoop view ([#2312](https://github.com/ai-ecoverse/slicc/issues/2312)).**
  Users do not talk to scoops. Selecting one in the tab strip opens its
  transcript with **no interactive chrome**: `applyComposerAvailability`
  (`ui/wc/wc-shell.ts`) puts `hidden` on the whole `<slicc-composer>` band —
  input card, queued pile, model picker + thinking pill, dictation and
  attachments all live inside it — so nothing is left and nothing is
  reserved. The 'scoop' shell mood (shader, accent, `scoop:<name>` thread
  context) is unchanged; only the chrome goes. `WcChatController.setReadOnly`
  covers what the transcript itself renders: error cards drop every CTA
  (`no-action` on `slicc-error-card`, because an actionless card would fall
  back to Retry) and an agent-driven `tool_ui` dip is refused outright.
  - **The rule is stated once**, in `isReadOnlyRole(role)`
    (`ui/wc/wc-unit-context.ts`), over the role the switcher descriptors
    already carry. The leader reaches it through `unitRoleFor(scoop)` and the
    follower through `summaryRole(summary)` (`wc-tray-scoops.ts`, over
    `parentId` / legacy `isCone`) — one flag, no second code path. On the
    follower the read-only state outranks the connection state, so a
    reconnect while a scoop is viewed cannot hand back its composer.
  - **Every request that needs a human goes to the owning cone.** `sudo_request`
    (incl. export approvals), idle / "waiting for parent" notices and
    completion reports already resolved their target through
    `findApprover` / `findParent`; interactive `tool_ui` cards now do too —
    `ScoopLifecycleManager` stamps them with `approverFor(jid)`
    (`Orchestrator.ownerRootOrDefault`: the root that owns the unit, itself
    for a root, the default root for a dangling edge). Unlike
    `parentOrDefaultRoot` a cone resolves to **itself**, so a card raised by
    cone B renders in B rather than in the oldest cone. The reply travels back
    by `requestId` alone (`ToolUIActionMsg` carries no jid), so the scoop's
    pending promise still settles where it was raised.
  - **The cone's queued pile survives the detour.** A selection change
    normally cancels the pile on the backend — the user navigated away to
    talk somewhere else. Reading a scoop is not that: there is nowhere else
    to talk. `stashQueued` / `restoreQueued` hold it across the round trip
    (re-installed after the returning unit's replay, which clears the pile of
    its own accord); landing on a _different_ cone cancels it as before.
  - `feed_scoop` from the cone stays the only way to send a scoop input, and
    the `scoop:<name>` URL context still opens this read-only view.
  - **iOS is not wired yet.** The wire already carries what it needs
    (`ScoopSummary.parentId` / `isCone`); the app still renders its composer
    for a selected scoop.
- **The welcome flow stays primary-cone-only, deliberately.** It is a first-run flow for the _user_, not a per-conversation greeting: someone creating a second cone has already been onboarded. `welcome-detection.ts` therefore reads only `chatSessionIdFor({ folder: PRIMARY_CONE_FOLDER })`, and a welcome lick in an extra cone's history neither fires nor suppresses it.

### Per-cone model ([#2310](https://github.com/ai-ecoverse/slicc/issues/2310))

Model selection is **per work unit and lives on the record**, next to `parentJid` / `folder`:

- `RegisteredScoop.model = { provider, id }` — provider-qualified, because a bare id resolved against whatever provider happens to be selected is the #2195 mis-billing. `RegisteredScoop.thinking = { level?, effortOverride? }` sits beside it; `setScoopThinkingLevel` keeps its API and writes there instead of into `config`.
- `work-unit/record.ts` owns the access: `modelFor` / `modelIdFor` / `modelProviderFor` / `thinkingFor` to read, `setUnitModel` / `setUnitThinking` to write. Runtime code never reads `config.modelId` / `config.thinkingLevel` again — those are legacy **creation input** (`scoop_scoop`, the `agent` command, hand-written config) that `normalizeScoopRecord` lifts onto the record and clears, so exactly one place holds the value. A provider-less legacy pin is the one thing left in `config`: inventing a provider for it would re-create #2195.
- **New cone** starts on the **currently selected** cone's model: the page puts it on `cone-create`, `Bridge.handleConeCreate` falls back to the default root's, and only a profile with no cone at all falls through to the global seed.
- **A scoop copies its creating unit's model once**, at `ScoopLifecycleManager.register`, and is **never retargeted**. Changing a cone's model later leaves every scoop it already spawned exactly where it was.
- **The picker changes only the selected cone.** `Orchestrator.updateModel()` / `ScoopLifecycleManager.updateModelOnAll()` are gone; `setScoopModel(jid, model)` writes one record and re-resolves that one context, and `refreshModels()` (the `refresh-model` / `set-model` messages) re-resolves every context against **its own** record after an account change or re-login — never a fleet-wide retarget. A selected scoop resolves to the root that owns it (`rootForSelection`), so a pick made while looking at a scoop lands on its cone.
- **The global `selected-model` setting has two jobs left** (`scoops/model-seed.ts`): seeding the primary cone of a fresh profile, and migrating records saved before `model` existed. The seed is only taken **once the selected provider actually has an account** — the cone is bootstrapped before the user has added one, and `getSelectedProvider()` / `resolveCurrentModel()` answer with built-in defaults until then; stamping those would pin the primary cone to a provider the user may never configure and leave it reporting `No API key configured for provider "anthropic"` even after they add a different one, since a record model beats the global selection by design. Until then the cone carries no model and resolves the global selection at run time, exactly as before. `Orchestrator.init()` backfills those on restore — a legacy `config.modelId` pin first, else the owning cone's model, else the seed — and writes the result back, because a model that only lived in memory would look like a per-cone choice that never stuck. With no account configured yet nothing is written and the next boot retries.
- **The wire.** `ScoopSummary.model` carries each unit's model to followers (optional; older leaders omit it, older followers ignore it) and the Swift mirror decodes it. `model.select` gained an optional `scoopJid`: the follower names the unit it is looking at, and a follower that doesn't (an older build) has the leader fall back to that follower's `scoops.select` — never to the leader's own selection. `TrayModelSelectionState.activeModelId` is now the named cone's model rather than one global setting, so the follower model surface (`wc-follower-model-surface.ts`) shows and changes the right cone. Panel ⇄ kernel uses `set-scoop-model` / `set-scoop-model-ack`, and `ScoopSnapshotConfig` keeps its historical shape (`modelId`, plus `modelProviderId` / `effortOverride`) projected from the record.
- **An empty catalog is warm-up, not an answer** ([#2329](https://github.com/ai-ecoverse/slicc/issues/2329)). A follower attaching while the leader's providers are still cold used to be handed `models.list: []` as a valid frame, find no entry matching its active model id and hide the picker for the whole session — nothing re-sent the catalog because it _became_ available. Three changes, each optional on the wire: the leader **skips** an empty `models.list` to a follower that has never seen a real one (an emptied catalog still goes out to one that has — that is a removed account, and news); it re-broadcasts when the catalog it resolves for itself changes (`notifyLeaderModelCatalogChanged`, on top of `slicc:accounts-changed`) and opportunistically rides any `model.state` send; and the follower re-issues `models.request` a bounded three times while its pill is still hidden. An older peer at either end simply ignores what it does not know. That third net is the **web follower only**: the Swift/iOS follower is not mirrored, deliberately — the two leader-side guards cover it against any current leader, and the only case left is an iOS follower paired with a leader too old to have them, which a leader update fixes for every follower at once.
- **Per-cone model means per-cone provider.** A cone can name a provider this device has no account for (a follower picked it, an account was removed). `ScoopContext.init()` defers exactly as it does with no key at all, and the next prompt reports the existing "no provider" state naming that provider — it does not crash.

### Addressing licks to a cone ([#2311](https://github.com/ai-ecoverse/slicc/issues/2311))

A lick's `targetScoop` names **a unit, not a species** — a scoop or a cone, by
whichever handle the author had.

**Resolution is three ordered passes** over the whole roster
(`matchLickTargetAlias`, `base/lick-target-match.ts`), used by
`routeFormattedLickToCone` (`kernel/host.ts`) and by the sprinkle-route lookup
in `kernel/facade.ts`:

1. exact `folder` (`cone`, `cone-research`, `reviewer-scoop`)
2. `<target>-scoop` folder — a scoop addressed by its bare name
3. exact `name` — a cone's display name, or a scoop's

The ordering is the whole point, and it is why this is not one `find` that ORs
the three forms: with a cone _named_ `reviewer` sitting next to a scoop in
folder `reviewer-scoop`, an OR resolves to whichever was registered first.
Passing over the roster once per form makes the more specific form win
regardless of registry order. (`lickScoopMatches` in `scoops/lick-manager.ts`
stays as it is: it answers "does THIS unit match?" for filtering, where order
cannot matter.)

**Two dispositions for a target that resolves to nothing, deliberately
different:**

| Lick                                       | Disposition                                                       |
| ------------------------------------------ | ----------------------------------------------------------------- |
| **untargeted** (no `targetScoop`)          | the default root — `rootsOf(scoops)[0]`, the oldest surviving one |
| **targeted at a unit that does not exist** | `log.warn('Lick target scoop not found', …)` and **drop**         |

A dropped targeted lick is not a bug to be papered over: the cone or scoop it
named is gone (or was misspelled), and silently redirecting it would post
someone else's automation into the default cone's chat with no way to tell
where it came from. The `discovery` guard sits after resolution and before the
lick id is minted, so a non-browsing scoop never leaves a dangling registry
entry.

**Every producer a cone's shell can start follows the invoking unit**, so an
extra cone's events come back to it rather than to the oldest root:

| Producer            | How it picks a target                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- |
| background `bash`   | `ownLickTargetFor` stamps `targetScoop` (#2272)                                         |
| `fswatch create`    | `--scoop`, else `defaultLickTarget(…, ctx.env)` (#2272)                                 |
| `crontask create`   | `--scoop`, else `defaultLickTarget(…, ctx.env)`                                         |
| `webhook create`    | `--scoop`, else `defaultLickTarget(…, ctx.env)`; still required when neither is present |
| workflow completion | `getStartingRoot(parentJid)` in `kernel/host.ts` stamps the starting root's folder      |
| `sprinkle open`     | claims an **unrouted** sprinkle for the opening cone; an existing route always wins     |

`SLICC_LICK_TARGET` is absent from the default root's shell on purpose — its
folder is not worth spending as an alias when an untargeted lick already lands
there, and reading it from a folder test rather than from the live roster is
the bug described in the bullet above.

**From outside the cone's shell**, the same handles work as an explicit flag:
`webhook create --scoop <cone>`, `crontask create --scoop <cone>`,
`fswatch create --scoop <cone>` and `sprinkle route <name> --scoop <cone>` all
accept a cone's `name` or its `folder` (`cone-<slug>`). The extension /
side-panel path resolves them identically: `lick-manager-proxy.ts` forwards the
target string verbatim over `BroadcastChannel`, and resolution happens once, in
the kernel host, for every float.

### Phase 3 detail

- `ScoopContext` holds a `WorkUnitDescriptor` built once in its constructor and reads `unit.policy.*`, `unit.workspace.*`, `unit.completion.mode` and `unit.display.role` where it used to branch on `isCone` (filesystem reach, sudo wiring, memory paths, scratch dir, process owner, stale-asset resubmit, overflow escalation, system prompt).
- `ScoopLifecycleManager` picks `VirtualFS` vs `RestrictedFS` from `policy.filesystem`, gates every privileged callback on the policy (`canCreateChildren`, `canManageChildren`, `canWriteSharedMemory`, `canResolveApprovals`, `approvalAuthority`), and routes fatal errors to the unit's parent.
- Completion, idle notices and sudo requests take a `findParent` / `findApprover` dependency: the child's parent, falling back to the default (oldest) root when the parent is gone, so a delegated result always lands somewhere a user can see it.
- Unaddressed events (licks, sprinkles, workflow completions, follower snapshots) resolve the default root through `rootsOf(...)[0]` / `WorkUnitManager.resolveDefaultRoot()`; `bootstrapCone` only seeds a root when none exists.
- `normalizeScoopRecord` sanitizes a root's trigger fields on register and restore; `ScoopPresentation` projects the wire's `isCone` from `isRootUnit`. Since #2279 the record has no role field at all, so nothing — `ui/` included — can branch on one.
- `WorkUnitManager.close(id)` cascades to the unit's children first; closing root A leaves root B's subtree untouched.

### Phase 2 detail

- `LiveWorkUnit` (`work-unit/live-unit.ts`) owns a scoop's `ScoopContext`, `ScoopTabState` and observers. A unit may exist before its context (an observer subscribed ahead of spawn, or a boot-time error tab).
- `transition(next)` applies `LEGAL_TRANSITIONS` (`initializing → ready|error`, `ready → processing|error|initializing`, `processing → ready|error`, `error → initializing|ready|processing`); illegal moves and anything on a closed unit are logged and ignored, so a stale callback from a disposed context cannot resurrect a unit.
- `teardown()` runs in a fixed order — idle timer, stop turn, dispose context (realm workers + shell processes), drop observers, release `scoop_wait` callers — and is idempotent. `destroyTab` and `unregister` both end in it. `close()` (the `WorkUnitRuntime` contract) unregisters through the host, so the active-licks guard and record deletion apply exactly as for `drop_scoop`.
- `detachContext()` (filesystem reset) stops without disposing and keeps observers; `disposeContext()` (re-spawn after a failed init) disposes and keeps observers.
- `WorkUnitManager.get()` returns the owning live unit for any registered record (`Orchestrator.ensureLiveUnit`, creating one on first reach). The Phase 1 read-through adapter is gone (#2279).

### Phase 1 detail

- `RegisteredScoop.parentJid: string | null` is required. Creation paths set it: `bootstrapCone` / `handleConeCreate` → `null`; `scoop_scoop` → the creating unit; the `agent` command → `options.parentJid`, else the default root.
- `Orchestrator.init()` backfills records saved before the field existed (`backfillParent`): cones → `null`, scoops → the single restored cone. Unlike `migrateScoopConfig` the result is written back, because later phases route on it.
- The legacy `groups → scoops` IndexedDB migration sets the edge too.
- Follower-side records built from `scoop-list` messages (`OffscreenClient.msgScoopToRegistered`) adopt the list's cone until the wire carries `parentId`.

## Non-goals

No rewrite, no per-unit worker, no removal of cone/scoop vocabulary, no tray/cloud protocol redesign, no shared-live filesystem collaboration by default.
