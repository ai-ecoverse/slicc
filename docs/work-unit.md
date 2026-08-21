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

| File            | Purpose                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`      | `WorkUnitDescriptor`, `WorkUnitPolicy`, `CompletionPolicy`, `WorkUnitStatus` (`creating → ready ⇄ running`, `* → failed`, `* → closed`), events, `statusFromTab`    |
| `policy.ts`     | `interactiveRootPolicy`, `delegatedChildPolicy`, `derivePolicy`, `deriveCompletion`, `isRootUnit`, `isPolicySubset`, `childrenOf`, `rootsOf`                        |
| `descriptor.ts` | `toDescriptor(scoop, tab?)`, `workspaceFor` — pure projections                                                                                                      |
| `runtime.ts`    | `WorkUnitRuntime` contract + `ScoopContextWorkUnit`, the Phase 1 adapter over `ScoopContext` / `ScoopLifecycleManager`                                              |
| `manager.ts`    | `WorkUnitManager` — `create / list / get / getParent / getChildren / roots / rootOf / resolveDefaultRoot / abort / close`; exposed as `Orchestrator.getWorkUnits()` |

Tests: `packages/webapp/tests/work-unit/`. `conformance.ts` is a reusable suite any `WorkUnitRuntime` implementation must pass.

## Migration phases

A strangler migration, each phase a separate PR with deletion criteria:

| Phase | Scope                                                                                                                                                                                                                                                                                                     | Status                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1     | Types, required `parentJid` + restore backfill, adapter, manager facade, conformance tests. No behaviour change.                                                                                                                                                                                          | done                      |
| 2     | Lifecycle ownership: the runtime owns context, tab, observers, timers; `close()` is the single teardown; lifecycle tested as one state machine.                                                                                                                                                           | planned                   |
| 3     | Replace `isCone` with hierarchy and policy, one category at a time: filesystem, approvals, child tools, shared memory, completion, default-target routing, presentation. Add a CI ratchet that forbids new `isCone` reads outside presentation files. Prove two independent roots with children in tests. | planned                   |
| 4–9   | `WorkUnitClient` for local/remote UI, one persistence store, `CapabilityBroker`, explicit workspace sharing modes, generic parallel APIs, deletion of legacy paths.                                                                                                                                       | deferred; separate issues |

### Phase 1 detail

- `RegisteredScoop.parentJid: string | null` is required. Creation paths set it: `bootstrapCone` / `handleConeCreate` → `null`; `scoop_scoop` → the creating unit; the `agent` command → `options.parentJid`, else the default root.
- `Orchestrator.init()` backfills records saved before the field existed (`backfillParent`): cones → `null`, scoops → the single restored cone. Unlike `migrateScoopConfig` the result is written back, because later phases route on it.
- The legacy `groups → scoops` IndexedDB migration sets the edge too.
- Follower-side records built from `scoop-list` messages (`OffscreenClient.msgScoopToRegistered`) adopt the list's cone until the wire carries `parentId`.

## Non-goals

No rewrite, no per-unit worker, no removal of cone/scoop vocabulary, no tray/cloud protocol redesign, no shared-live filesystem collaboration by default.
