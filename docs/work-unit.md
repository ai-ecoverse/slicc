# WorkUnit — one runtime primitive for cones and scoops

Architecture decision record for [#1666](https://github.com/ai-ecoverse/slicc/issues/1666). Code: `packages/webapp/src/work-unit/`.

## Decision

The **cone** (the user's root agent) and every **scoop** (a delegated child) are the same kernel primitive, a `WorkUnit`:

> one LLM conversation + one filesystem view + one shell/process group + one agent runtime + an explicit policy and lifecycle.

They differ in exactly one structural fact — the ownership edge — and in what is derived from it:

|                                                                                                   | Root (cone)                    | Child (scoop)                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `RegisteredScoop.parentJid`                                                                       | `null`                         | jid of the owning unit                                       |
| `display.role`                                                                                    | `primary`                      | `child`                                                      |
| `policy.filesystem`                                                                               | `full-workspace` (`VirtualFS`) | `restricted` (`RestrictedFS` over the config paths)          |
| `policy.approvalAuthority`                                                                        | `user`                         | `{ parentId }`                                               |
| `policy.canCreateChildren` / `canManageChildren` / `canWriteSharedMemory` / `canResolveApprovals` | `true`                         | `false`                                                      |
| `policy.sudoDefaultDisposition`                                                                   | `allow`                        | `require-approval`                                           |
| `completion.mode`                                                                                 | `interactive`                  | `notify-parent` (`silent` when `notifyOnComplete === false`) |
| `workspace.root`                                                                                  | `/workspace`                   | `/scoops/<folder>/workspace`                                 |

Cone and scoop stay the product vocabulary (UI, prompts, tool names, skills). They are no longer kernel types.

### Decisions taken (2026-08-21)

1. **Name**: `WorkUnit`. Neutral and architecture-facing; `AgentContext` collided with `ScoopContext`.
2. **Root test**: `parentJid === null`, nothing else. `isCone` / `type` on `RegisteredScoop` are presentation fields kept on the wire for followers and will be derived from the edge, then deleted in the final phase.
3. **Field name**: the edge stays `parentJid` (jid is this codebase's id vocabulary) but is **required** `string | null`. `WorkUnitDescriptor.parentId` maps to it.
4. **Ordering**: structural cleanup first. Multiple concurrent roots are the payoff of Phases 1–3, not a UI deliverable of them.
5. **Default root**: `WorkUnitManager.resolveDefaultRoot()` receives unaddressed events. Since #2273 it is the user's pick from the Cones rail (persisted `slicc-default-root`), falling back to the primary cone and then the oldest root — resolution lives in `work-unit/default-root.ts` (`pickDefaultRoot`) so kernel, orchestrator and UI agree.
6. **Grandchildren**: children keep `canCreateChildren: false`. The flag exists so an explicit grant is a policy change, not a runtime type.

## Invariants (adopted from the RFC)

1. Every conversation belongs to exactly one work unit.
2. Every child has an explicit parent unless promoted to a root.
3. Child capabilities ⊆ parent capabilities (`isPolicySubset`) unless the user grants more.
4. Cone and scoop are roles over one runtime; `scoops/` and `kernel/` code routes on `parentJid` / policy, never on `isCone`.
5. Closing a unit tears down everything it owns — turns, tools, realm workers, shell processes, observers, subscriptions — in one place.
6. Runtime detection (float, extension, follower) happens at composition time, not in unit logic.

## Module map

| File              | Purpose                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`        | `WorkUnitDescriptor`, `WorkUnitPolicy`, `CompletionPolicy`, `WorkUnitStatus` (`creating → ready ⇄ running`, `* → failed`, `* → closed`), events, `statusFromTab`          |
| `policy.ts`       | `interactiveRootPolicy`, `delegatedChildPolicy`, `derivePolicy`, `deriveCompletion`, `isRootUnit`, `isPolicySubset`, `childrenOf`, `rootsOf`                              |
| `descriptor.ts`   | `toDescriptor(scoop, tab?)`, `workspaceFor` — pure projections                                                                                                            |
| `runtime.ts`      | `WorkUnitRuntime` contract + `ScoopContextWorkUnit`, the Phase 1 adapter over `ScoopContext` / `ScoopLifecycleManager`                                                    |
| `live-unit.ts`    | `LiveWorkUnit` — the owning runtime: holds the `ScoopContext`, tab record and observer set; `transition()` enforces `LEGAL_TRANSITIONS`; `close()` is the single teardown |
| `record.ts`       | `normalizeScoopRecord` (derives `isCone`/`type` from the edge on register/restore), `chatSessionIdFor`, `processOwnerKindFor`, `sourceLabelFor`                           |
| `live-unit.ts`    | `LiveWorkUnit` — the owning runtime: holds the `ScoopContext`, tab record and observer set; `transition()` enforces `LEGAL_TRANSITIONS`; `close()` is the single teardown |
| `record.ts`       | `normalizeScoopRecord` (derives `isCone`/`type` from the edge on register/restore), `chatSessionIdFor`, `processOwnerKindFor`, `sourceLabelFor`                           |
| `manager.ts`      | `WorkUnitManager` — `create / list / get / getParent / getChildren / roots / rootOf / resolveDefaultRoot / abort / close`; exposed as `Orchestrator.getWorkUnits()`       |
| `default-root.ts` | `pickDefaultRoot` (configured → primary → oldest) + the persisted `slicc-default-root` accessors — the one answer to "where do unaddressed events go?"                    |
| `lick-target.ts`  | `resolveLickTarget` — a `targetScoop` alias (unit `name`, `folder` incl. `cone-<slug>`, or `<name>` for a `<name>-scoop` folder) → a record                               |

Tests: `packages/webapp/tests/work-unit/`. `conformance.ts` is a reusable suite any `WorkUnitRuntime` implementation must pass.

## Migration phases

A strangler migration, each phase a separate PR with deletion criteria:

| Phase | Scope                                                                                                                                                                                                                                                                                                         | Status                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1     | Types, required `parentJid` + restore backfill, adapter, manager facade, conformance tests. No behaviour change.                                                                                                                                                                                              | done                      |
| 2     | Lifecycle ownership: `ScoopLifecycleManager` hosts one `LiveWorkUnit` per scoop (its context, tab, observers); `getContexts()` / `getTabsMap()` are derived views; `close()` is the single teardown; transitions tested as one state machine.                                                                 | done                      |
| 3     | `isCone` replaced by hierarchy and policy in `scoops/` and `kernel/` (filesystem, approvals, child tools, shared memory, completion, default-target routing, presentation); `check-iscone-ratchet.mjs` forbids new reads outside `ui/`; two independent roots proven in `tests/work-unit/multi-root.test.ts`. | done                      |
| 4     | Add / switch / remove cones in the UI: `Cones` section of the freezer rail, `cone-create` allocates `cone-<slug>` folders and per-folder chat sessions, `scoop-drop` of a root cascades and refuses the last root, `cone:<folder>` URL contexts.                                                              | done                      |
| 5–9   | `WorkUnitClient` for local/remote UI, one persistence store, `CapabilityBroker`, explicit workspace sharing modes, generic parallel APIs, deletion of legacy paths.                                                                                                                                           | deferred; separate issues |

### Phase 4 detail

- Behind the `multiple-cones` feature flag (Settings → Experimental; off by default). The last cone can never be removed: the rail hides ✕ and ignores a stale confirm, `OffscreenClient.unregisterScoop` rejects, `Bridge.handleScoopDrop` refuses, and `ScoopLifecycleManager.unregister` throws.
- The panel's existing `cone-create` message now creates _additional_ roots: `Bridge.handleConeCreate` allocates the folder with `coneFolderFor` (`cone` for the first root, `cone-<slug>` afterwards, de-duplicated) and labels extra cones by the user's name; the primary keeps `sliccy`.
- Chat sessions are keyed per folder (`chatSessionIdFor` → `session-<folder>`), so the primary cone keeps `session-cone` and every other cone gets its own history. The welcome flow, Freezer and "New chat" operate on the primary cone.
- `scoop-drop` of a root goes through `WorkUnitManager.close()` (cascades to its scoops, forgets every dropped buffer/session) and refuses the last root; the rail hides ✕ on the last cone for the same rule.
- The tray wire carries the edge: `ScoopSummary.parentId` / `ScoopListMsg.scoops[].parentId` (`null` for a cone; absent from leaders older than this). Browser followers group each cone with its own scoops (`toFollowerSwitcherScoops`), the extension panel takes ownership from the wire (`OffscreenClient`) and only infers it for legacy leaders; iOS decodes the field and keeps `isCone` as its root test.
- Presentation lives in `ui/wc/wc-unit-context.ts`: chip label = `assistantLabel` for roots, thread/URL context `cone` (primary) / `cone:<folder>` (extra) / `scoop:<name>`, default root = primary else oldest. Followers render every cone from the unchanged wire.
- Extra cones share `/workspace` and `/workspace/CLAUDE.md`; per-cone workspaces are a later phase.

#### Addressing and the default root (#2273)

- A cone is a lick target like any other unit: `resolveLickTarget` (`work-unit/lick-target.ts`) matches a `targetScoop` against `name`, `folder` (`cone`, `cone-research`) or the bare name of a `<name>-scoop` folder, and is shared by `kernel/host.ts routeFormattedLickToCone` and `KernelFacade.routeSprinkleLick`. The two differ only in what an unmatched alias means: a lick is dropped (its scoop is gone; it must not surface in another chat), a sprinkle route falls through to the default root (the user raised it on a panel and must see it somewhere).
- A unit's own events come back to it. `ScoopContext` stamps `targetScoop: <its folder>` on background `bash` licks for roots as well as children, and `fswatch` adopts the creating unit's folder when `--scoop` is omitted (`getUnitFolder` on the shell). `webhook` and `crontask` persist their target instead of resolving it per fire, so they must name it — `--scoop cone-research` now does; the `automation` skill tells the agent to name its own unit. Wiring the same implicit default into `crontask-command.ts` is deferred: the boy-scout gate would require clearing `lick-surface.ts`'s layer-back-edge debt, which needs `core/float-topology.ts` and `scoops/lick-manager-proxy.ts` to move down the stack.
- The default root is an explicit setting, not registry order: the Cones rail's ★ writes `localStorage['slicc-default-root']`, which reaches the kernel worker's storage shim through `kernel/page-storage-sync.ts` (no new message type). `pickDefaultRoot` falls back to the primary cone and then the oldest root, and ignores a jid that is no longer a registered root, so dropping the default cone cannot strand events. It is deliberately ONE concept: the same pick decides the boot `activeScoopJid` (`ScoopPresentation.buildStateSnapshot`) and an absent/unrecognised `?ctx=` (`ui/wc/wc-unit-context.ts defaultRootOf`), so the cone that receives unaddressed events is also the one you land on — splitting "default for events" from "default for the UI" is how the singleton-cone assumption grew back last time. Every context `threadContextFor` emits still round-trips exactly, though: the literal `cone` names the PRIMARY root, so sharing or reloading the primary cone's own URL never opens the starred one.

### Phase 3 detail

- `ScoopContext` holds a `WorkUnitDescriptor` built once in its constructor and reads `unit.policy.*`, `unit.workspace.*`, `unit.completion.mode` and `unit.display.role` where it used to branch on `isCone` (filesystem reach, sudo wiring, memory paths, scratch dir, process owner, stale-asset resubmit, overflow escalation, system prompt).
- `ScoopLifecycleManager` picks `VirtualFS` vs `RestrictedFS` from `policy.filesystem`, gates every privileged callback on the policy (`canCreateChildren`, `canManageChildren`, `canWriteSharedMemory`, `canResolveApprovals`, `approvalAuthority`), and routes fatal errors to the unit's parent.
- Completion, idle notices and sudo requests take a `findParent` / `findApprover` dependency: the child's parent, falling back to the default (oldest) root when the parent is gone, so a delegated result always lands somewhere a user can see it.
- Unaddressed events (licks, sprinkles, workflow completions, follower snapshots) resolve the default root through `pickDefaultRoot(...)` / `WorkUnitManager.resolveDefaultRoot()`; `bootstrapCone` only seeds a root when none exists.
- `normalizeScoopRecord` rewrites `isCone` / `type` from `parentJid` on register and restore; `ScoopPresentation` projects `isCone` for the wire from `isRootUnit`. UI code (`packages/webapp/src/ui/`) may still read the derived flag; `npm run lint:iscone-ratchet` fails on any new read elsewhere.
- `WorkUnitManager.close(id)` cascades to the unit's children first; closing root A leaves root B's subtree untouched.

### Phase 2 detail

- `LiveWorkUnit` (`work-unit/live-unit.ts`) owns a scoop's `ScoopContext`, `ScoopTabState` and observers. A unit may exist before its context (an observer subscribed ahead of spawn, or a boot-time error tab).
- `transition(next)` applies `LEGAL_TRANSITIONS` (`initializing → ready|error`, `ready → processing|error|initializing`, `processing → ready|error`, `error → initializing|ready|processing`); illegal moves and anything on a closed unit are logged and ignored, so a stale callback from a disposed context cannot resurrect a unit.
- `teardown()` runs in a fixed order — idle timer, stop turn, dispose context (realm workers + shell processes), drop observers, release `scoop_wait` callers — and is idempotent. `destroyTab` and `unregister` both end in it. `close()` (the `WorkUnitRuntime` contract) unregisters through the host, so the active-licks guard and record deletion apply exactly as for `drop_scoop`.
- `detachContext()` (filesystem reset) stops without disposing and keeps observers; `disposeContext()` (re-spawn after a failed init) disposes and keeps observers.
- `WorkUnitManager.get()` returns the live unit when the host has one (`Orchestrator.getLiveUnit`), else the Phase 1 read-through adapter.

### Phase 2 detail

- `LiveWorkUnit` (`work-unit/live-unit.ts`) owns a scoop's `ScoopContext`, `ScoopTabState` and observers. A unit may exist before its context (an observer subscribed ahead of spawn, or a boot-time error tab).
- `transition(next)` applies `LEGAL_TRANSITIONS` (`initializing → ready|error`, `ready → processing|error|initializing`, `processing → ready|error`, `error → initializing|ready|processing`); illegal moves and anything on a closed unit are logged and ignored, so a stale callback from a disposed context cannot resurrect a unit.
- `teardown()` runs in a fixed order — idle timer, stop turn, dispose context (realm workers + shell processes), drop observers, release `scoop_wait` callers — and is idempotent. `destroyTab` and `unregister` both end in it. `close()` (the `WorkUnitRuntime` contract) unregisters through the host, so the active-licks guard and record deletion apply exactly as for `drop_scoop`.
- `detachContext()` (filesystem reset) stops without disposing and keeps observers; `disposeContext()` (re-spawn after a failed init) disposes and keeps observers.
- `WorkUnitManager.get()` returns the live unit when the host has one (`Orchestrator.getLiveUnit`), else the Phase 1 read-through adapter.

### Phase 1 detail

- `RegisteredScoop.parentJid: string | null` is required. Creation paths set it: `bootstrapCone` / `handleConeCreate` → `null`; `scoop_scoop` → the creating unit; the `agent` command → `options.parentJid`, else the default root.
- `Orchestrator.init()` backfills records saved before the field existed (`backfillParent`): cones → `null`, scoops → the single restored cone. Unlike `migrateScoopConfig` the result is written back, because later phases route on it.
- The legacy `groups → scoops` IndexedDB migration sets the edge too.
- Follower-side records built from `scoop-list` messages (`OffscreenClient.msgScoopToRegistered`) adopt the list's cone until the wire carries `parentId`.

## Non-goals

No rewrite, no per-unit worker, no removal of cone/scoop vocabulary, no tray/cloud protocol redesign, no shared-live filesystem collaboration by default.
