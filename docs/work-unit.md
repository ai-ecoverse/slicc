# WorkUnit — one runtime primitive for cones and scoops

Architecture decision record for [#1666](https://github.com/ai-ecoverse/slicc/issues/1666). Code: `packages/webapp/src/work-unit/`.

## Decision

The **cone** (the user's root agent) and every **scoop** (a delegated child) are the same kernel primitive, a `WorkUnit`:

> one LLM conversation + one filesystem view + one shell/process group + one agent runtime + an explicit policy and lifecycle.

They differ in exactly one structural fact — the ownership edge — and in what is derived from it:

|                                                                                                   | Root (cone)                                                            | Child (scoop)                                                          |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `RegisteredScoop.parentJid`                                                                       | `null`                                                                 | jid of the owning unit                                                 |
| `display.role`                                                                                    | `primary`                                                              | `child`                                                                |
| `policy.filesystem`                                                                               | `full-workspace` (`VirtualFS`)                                         | `restricted` (`RestrictedFS` over the config paths + isolation `mode`) |
| `policy.approvalAuthority`                                                                        | `user`                                                                 | `{ parentId }`                                                         |
| `policy.canCreateChildren` / `canManageChildren` / `canWriteSharedMemory` / `canResolveApprovals` | `true`                                                                 | `false` (unless an explicit grant, below)                              |
| `policy.sudoDefaultDisposition`                                                                   | `allow`                                                                | `require-approval`                                                     |
| `completion.mode`                                                                                 | `interactive`                                                          | `notify-parent` (`silent` when `notifyOnComplete === false`)           |
| `workspace.root`                                                                                  | `/workspace` (primary cone) / `/cones/<folder>/workspace` (extra cone) | `/scoops/<folder>/workspace`                                           |

Cone and scoop stay the product vocabulary (UI, prompts, tool names, skills). They are no longer kernel types.

### Decisions taken (2026-08-21)

1. **Name**: `WorkUnit`. Neutral and architecture-facing; `AgentContext` collided with `ScoopContext`.
2. **Root test**: `parentJid === null`, nothing else. `isCone` / `type` were deleted from `RegisteredScoop` in #2279 — the compiler now enforces the rule, because a role branch has no field to read. `isCone` survives only on the tray wire (`ScoopSummary`), projected write-only from `isRootUnit` and, since #2358, sent only to peers below protocol version 8.
3. **Field name**: the edge stays `parentJid` (jid is this codebase's id vocabulary) but is **required** `string | null`. `WorkUnitDescriptor.parentId` maps to it.
4. **Ordering**: structural cleanup first. Multiple concurrent roots are the payoff of Phases 1–3, not a UI deliverable of them.
5. **Default root**: the oldest root (`WorkUnitManager.resolveDefaultRoot()`) receives unaddressed events. A UI-selected root comes with the client protocol phase.
6. **Grandchildren**: children default to `canCreateChildren: false`. The flag exists so an explicit grant (`ScoopConfig.canCreateChildren: true`) is a policy change, not a runtime type. `WorkUnitManager.create` and `scoop_scoop` refuse a child whose derived policy is not ⊆ its parent's (`assertChildPolicyAllowed`). See [Nested delegation](#nested-delegation).
7. **Copy-on-write snapshots (RFC open question 4, #2277)**: deferred. Child creation names `private` or `shared-readonly`; `snapshot` and `shared-live` are typed stubs that throw. Private + shared-readonly are enough initially — a COW view of parent state is a later, separate implementation.

## Invariants (adopted from the RFC)

1. Every conversation belongs to exactly one work unit.
2. Every child has an explicit parent unless promoted to a root (`WorkUnitManager.promote` / `detach`).
3. Child capabilities ⊆ parent capabilities (`isPolicySubset`) unless the user grants more.
4. Cone and scoop are roles over one runtime; `scoops/` and `kernel/` code routes on `parentJid` / policy, never on `isCone`.
5. Closing a unit tears down everything it owns — turns, tools, realm workers, shell processes, observers, subscriptions — in one place. Descendants **cascade** by default; a child (or the `close` call) may opt into **detach-on-close**, which promotes survivors instead of tearing them down.
6. Runtime detection (float, extension, follower) happens at composition time, not in unit logic.

## Module map

| File                | Purpose                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`          | `WorkUnitDescriptor`, `WorkUnitPolicy`, `CompletionPolicy`, `OnParentClose`, `WorkUnitStatus` (`creating → ready ⇄ running`, `* → failed`, `* → closed`), `WorkspaceHandle`, `WorkspaceIsolationMode`, events, `statusFromTab`                                                                                                                 |
| `workspace-mode.ts` | `parseWorkspaceMode` / `resolveWorkspaceMode`, unimplemented-mode errors, `includeMountsForMode`, sharing rank for `isPolicySubset`                                                                                                                                                                                                            |
| `policy.ts`         | `interactiveRootPolicy`, `delegatedChildPolicy`, `derivePolicy`, `deriveCompletion`, `deriveOnParentClose`, `isRootUnit`, `isPolicySubset`, `assertChildPolicyAllowed`, `childrenOf`, `rootsOf`                                                                                                                                                |
| `descriptor.ts`     | `toDescriptor(scoop, tab?)`, `workspaceFor`, `workspaceHandleFor`, `defaultChildPathsForMode`, `PRIMARY_WORKSPACE`, `SKILLS_LIBRARY_DIR` — pure projections; the ONE place the per-unit directory layout is decided                                                                                                                            |
| `runtime.ts`        | `WorkUnitRuntime` contract + the `WorkUnitHost` slice (`getScoop`, `ensureLiveUnit`) a manager resolves units through                                                                                                                                                                                                                          |
| `live-unit.ts`      | `LiveWorkUnit` — the owning runtime: holds the `ScoopContext`, tab record and observer set; `transition()` enforces `LEGAL_TRANSITIONS`; `close()` is the single teardown                                                                                                                                                                      |
| `record.ts`         | `normalizeScoopRecord` (strips the pre-#2279 `isCone`/`type`, sanitizes a root), `legacyRecordIsCone`, `chatSessionIdFor`, `isPrimaryRoot`, `coneFolderFor`, `processOwnerKindFor`, `sourceLabelFor`                                                                                                                                           |
| `manager.ts`        | `WorkUnitManager` — `create / createMany / list / get / getParent / getChildren / roots / rootOf / resolveDefaultRoot / join / abort / promote / detach / close`; exposed as `Orchestrator.getWorkUnits()`                                                                                                                                     |
| `client/`           | The presentation protocol (#2274): `WorkUnitClient`, `WorkUnitSummary` / `WorkUnitSnapshot` / `WorkUnitClientEvent`, the record and wire projections, and `presentation.ts` — the ONE strip ordering and descriptor builder both shells render from. Adapters live in `ui/work-unit-client/`. See [`work-unit-client.md`](work-unit-client.md) |
| `capability/`       | The privileged-capability protocol (#2276): `CapabilityBroker` with per-operation allowlists, `CapabilityUnavailable` / `CapabilityFailure`, and one adapter per float topology (`node-rest`, `extension-direct`, `extension-delegate`, `connect`). Composed once in `kernel/host.ts`. See Phase 6 below                                       |
| `conversation/`     | The canonical conversation record (#2275): entry types, identity, ingest, the four derivations, the `slicc-work-units` store and its resumable migration — see below                                                                                                                                                                           |

Tests: `packages/webapp/tests/work-unit/`. `conformance.ts` is a reusable suite any `WorkUnitRuntime` implementation must pass. `capability-broker.conformance.ts` is the same for every `CapabilityBroker` adapter.

### Promote / detach (#2278)

`WorkUnitManager.promote(id)` turns a child into an independent root by setting `parentJid = null` and persisting the record. Policy, completion and presentation then derive as for any other root (`interactiveRootPolicy`, `completion.mode: 'interactive'`, `display.role: 'primary'`). Unknown ids throw; a unit that is already a root is a no-op.

`detach` is the RFC name for the **same** operation — there is no "detach from parent without taking root policy" API. A restricted-root preset is not introduced: `parentJid === null` continues to mean the interactive-root preset, so the root test stays one field.

The unit keeps its folder (and therefore its chat session key). `workspaceFor` then treats it as an extra cone (`/cones/<folder>/workspace`); files under `/scoops/<folder>/` are not moved, the same non-migration extra cones got in #2271. The canonical conversation record is **rekeyed** (`/scoops/…` → `/cones/…`) after persist and before the live runtime is rebuilt, so history is not orphaned under the old workspace identity. A spawned unit is then torn down and `createTab`'d so the live `ScoopContext` is a root: `this.unit` is re-derived, RestrictedFS is replaced with the shared `VirtualFS`, and the child-management tools / sudo wiring match `interactiveRootPolicy`. A unit that has never spawned is persist-only; the next spawn already sees the new edge.

When a cone is dropped through `KernelFacade.handleScoopDrop`, detach survivors (and their grandchildren) stay registered — panel cleanup only forgets units that `close` actually removed.

**Parent close** still **cascades** by default (`close(id)` tears down children first). A child may opt out with `onParentClose: 'detach'` on the record, or the call may pass `{ descendants: 'detach' }` to promote every direct child instead of closing it. An explicit `{ descendants: 'cascade' }` overrides a child that asked to detach. Grandchildren of a detached child stay with that child (now a root).

End to end, the multi-cone product surface is covered by the fake-LLM Playwright suite ([#2313](https://github.com/ai-ecoverse/slicc/issues/2313)), which runs the real shell with the `multiple-cones` flag on:

| Spec (`packages/webapp/tests/e2e/`) | Covers                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `multiple-cones.test.ts`            | create a cone from a brief → chat → `scoop_scoop` → switch → drop; the last-cone guard; oldest-survivor promotion; the rail's session actions and their freezer outcomes (`memorySkipped` on drop, cone attribution on the entry, the `Frozen chat · from cone …` caption)                             |
| `multiple-cones-licks.test.ts`      | lick addressing: an untargeted `fswatch` created from an extra cone's shell returns to that cone, one addressed `--scoop <cone name>` resolves by name, and neither reaches the oldest root                                                                                                            |
| `multiple-cones-follower.test.ts`   | leader + follower joined through a real `wrangler dev` tray hub: strip mirroring (one ordering since #2274), a follower changing one cone's model while the leader sits in another (#2310); and a scoop rendering read-only on BOTH sides (#2312 — no composer for a scoop, the owning cone keeps one) |

Topology helpers live in `tests/e2e/two-instance-helpers.ts`.

## Migration phases

A strangler migration, each phase a separate PR with deletion criteria:

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1     | Types, required `parentJid` + restore backfill, adapter, manager facade, conformance tests. No behaviour change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | done                      |
| 2     | Lifecycle ownership: `ScoopLifecycleManager` hosts one `LiveWorkUnit` per scoop (its context, tab, observers); `getContexts()` / `getTabsMap()` are derived views; `close()` is the single teardown; transitions tested as one state machine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | done                      |
| 3     | `isCone` replaced by hierarchy and policy in `scoops/` and `kernel/` (filesystem, approvals, child tools, shared memory, completion, default-target routing, presentation); two independent roots proven in `tests/work-unit/multi-root.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | done                      |
| 9a    | Deletion (#2279): `RegisteredScoop.isCone` / `type` gone, the `ui/` reads migrated to `isRootUnit` / `summaryIsRoot`, the `isCone` ratchet retired (the type is the gate), the Phase 1 `ScoopContextWorkUnit` adapter removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | done                      |
| 9b    | Wire removal of `isCone` (#2358), stages 1–2: Swift decodes it optionally, `TRAY_SYNC_PROTOCOL_VERSION` is 8, every TS read collapses to the edge but `summaryIsRoot`'s absent-edge fallback, the panel wire drops the field outright, and the leader strips it per peer (`scoopsListForPeer`). Stage 3 — deleting the field, the projection and the gate — waits on the native support window.                                                                                                                                                                                                                                                                                                                                                                                                                            | stages 1–2 done           |
| 4     | Add / switch / drop cones in the UI: new-cone / drop-cone in the freezer rail's action row, the tab strip as the only switcher, `cone-create` allocates `cone-<slug>` folders and per-folder chat sessions, `scoop-drop` of a root cascades and refuses the last root, `cone:<folder>` URL contexts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | done                      |
| 5a    | One canonical conversation record per work unit (#2275): `ConversationEntry`, the `slicc-work-units` store, the four derivations, and a resumable migration behind a read-old/write-new window. Legacy stores still written; their deletion is a follow-up.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | done                      |
| 6a    | CapabilityBroker protocol + composition-time injection (#2276 slice A): per-operation allowlists, `CapabilityUnavailable`, page/Node stubs, one host-injected broker, one migrated scoops call site (`network.localNodeServer`), conformance suite. Full Node/Swift/extension/hosted adapters and remaining call sites are follow-ups.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | done                      |
| 6b    | Real adapters keyed by float topology (#2276 slice B): `node-rest` (one REST adapter for BOTH the Node and Swift servers), `extension-direct` / `extension-delegate` over the service-worker Ports, `connect` (nothing privileged). Page-gesture ops become an injected channel; `CapabilityFailure` joins `CapabilityUnavailable`; a shared REST contract fixture is replayed by the browser adapter and both servers.                                                                                                                                                                                                                                                                                                                                                                                                    | done                      |
| 6c    | `scoops/` loses its only float/topology read (#2276 slice C, network domain, review-patterns category 10): `createTrayFetch` moved to `shell/tray-fetch.ts`, a sibling of `proxied-fetch.ts` — deciding raw fetch vs `/api/fetch-proxy` is a transport decision, not `scoops/` business logic. `redirect-uri.ts` takes `topology` by injection; its `shell/` callers keep resolving it (topology is owned there). None of the three became a `network.crossOriginFetch` broker call — none is a privileged operation behind an allowlist.                                                                                                                                                                                                                                                                                  | done (#2829)              |
| 8a    | Generic parallel APIs, slice A (#2278): `WorkUnitManager.createMany` (atomic, fail closed if any parent is missing) and `join` (reuses the scoop-wait completion bus). `scoop_wait` / `feed_scoop` stay product aliases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | done                      |
| 7a    | Explicit workspace isolation modes (#2277): `private` + `shared-readonly` on child create; `snapshot` / `shared-live` typed stubs; `RestrictedFS` mount gating; `scoop_scoop` / `agent --workspace-mode`. Copy-on-write snapshots deferred (RFC open question 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | done                      |
| 8c    | Promote / detach (#2278 slice C): `WorkUnitManager.promote` / `detach`, `onParentClose: 'detach'`, `close({ descendants })`; live reinit + conversation rekey on promote. Nested `canCreateChildren` is #2784.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | done                      |
| 5b    | Mount the WC shell on `WorkUnitClient` (#2382), PR A: `setModel` joins the protocol and one `createWorkUnitAgentHandle` replaces the leader's `OffscreenClient.createAgentHandle()` and the follower's sync-manager-as-`AgentHandle`, so the composer send, the stop and the model write name their unit on both sides — including a follower's prompt and abort, which the leader now routes by that peer's own `scoops.select` (`follower.selectedScoopJid`) instead of by whatever unit the leader was displaying, and the follower's Stop button, which had no listener at all. The one documented exception was the leader-capable float's own follower wiring (`ui/wc/wc-tray.ts` `buildFollowerOptions`), closed in PR D1. Transcript/selection (PR B), the model pill (PR C) and the mount collapse (PR D) follow. | done (#2803)              |
| 5c    | Mount the WC shell on `WorkUnitClient` (#2382), PR B: the transcript and the selection. Selection IS `snapshot(id)` on both sides, the thread is rendered from `subscribe(id)`, and neither mount handles `onScoopMessagesReplaced` / `onSnapshot` any more. `WorkUnitSnapshot.summary` became optional so a guest seat — never sent `scoops.list` — still gets its transcript.                                                                                                                                                                                                                                                                                                                                                                                                                                            | done (#2820)              |
| 5d    | Mount the WC shell on `WorkUnitClient` (#2382), PR C: `summary.model` is the only per-unit model read. `modelForUnit` carries the owning-cone rule (#2310) and the absent-is-not-known rule (#2329) once; the leader's pill, its telemetry, a new cone's seed and the `model.state` a follower is sent all use it. `toScoopSummaries` keeps `modelFor` — it is the projection that produces the wire field.                                                                                                                                                                                                                                                                                                                                                                                                                | done (this PR)            |
| 5–9   | Remaining `WorkUnitClient` mount slices, the remaining capability call-site migrations, snapshot COW / `shared-live`, deletion of legacy paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | deferred; separate issues |

New rows go here, in their own blank-line-separated table, so a sibling PR editing the block above does not collide with one editing this one.

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Status         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 6d    | Secrets domain call-site migration (#2276 slice C): `scoops/scoop-context/shell-and-skills.ts` gets masked secrets from `broker.secrets.listMaskedEnv()` (a genuinely privileged op, already implemented by every adapter in slice B) instead of `core/secret-env.ts`'s topology-branching `fetchSecretEnvVars()`; `buildEnvFromMaskedEntries` (the POSIX-name filter + GitHub-token alias) is exported and reused as-is. `fetchSecretEnvVars()` itself is unchanged and stays exported for `ui/wc/wc-live.ts` (`ui/` is not a banned layer). `shell/supplemental-commands/secret-command.ts` keeps reading `resolveFloatTopology()` directly — that file lives in `shell/`, which owns topology (same precedent as `redirect-uri.ts`'s callers in 6c), and none of its seven CRUD operations has a `broker.secrets` equivalent, so no new allowlist op was added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | done (#2834)   |
| 6e    | Mounts domain call-site migration (#2276 slice C): `fs/mount/signed-fetch.ts`'s S3/DA sign-and-forward transport now calls `broker.mounts.signRequest({ backend, envelope })` instead of re-implementing the same extension-direct / extension-delegate / node-rest branch every slice-B adapter already carries; `envelopeToResponse`'s error-code → `FsError` mapping is unchanged, since a server-encoded refusal travels as a `SignAndForwardReply` value inside a successful `CapabilityResult`. The broker itself is a module-level fact (`fs/mount/capability-broker.ts`, mirroring `base/api-endpoint.ts`'s idiom), set once by `kernel/host.ts` right next to `orchestrator.setCapabilityBroker` — `fs/` sits at the bottom of the layer stack and mount construction happens far from any composition root, so constructor injection would fan out through `VirtualFS`, `mount-commands.ts` and `mount-recovery.ts`. Round-1 review: an unset broker now fails closed to `CapabilityUnavailable` rather than silently defaulting to `node-rest` (a composition miss on an extension topology must never POST a signed envelope to the hosted origin's REST routes), and `mounts.signRequest` carries its own 120s object-transfer deadline (`node-rest` and `extension-direct`) rather than inheriting the 10s control-plane budget — `extension-delegate` already had this via `mount-bridge-client.ts`. `fs/mount-commands.ts`'s extension-popup-vs-direct-picker branch and `fs/picker-popup.ts`'s shared 4-kind popup launcher both stay on `isExtensionRealm()`: both are the picker's REQUIRED page gesture, exactly what `CapabilityBroker`'s `PageGestureChannel` / `mounts.pickDirectory()` was designed for, but no real `PageGestureChannel` implementation exists anywhere yet (`kernel/host.ts`'s `config.pageGestures` is never supplied in production) — routing through it now would make local-mount picking unconditionally unavailable, not migrate it. Wiring one is separate follow-up work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | done (#2836)   |
| 6f    | Approvals domain call-site migration (#2276 slice C): `sudo/index.ts`'s `createSudoBroker` now takes the float's ONE composed `CapabilityBroker` as a required parameter and wraps its `approvals.request` (`sudo/capability-gesture-broker.ts`, new) as the raw native-gesture leg, instead of probing `isExtensionRealm()` / an extension-delegate id to pick one of three deleted topology-specific brokers (`http-broker.ts`, `extension-broker.ts`, `panel-rpc-broker.ts`) — every slice-B adapter already implements that op, including the SAME fail-closed decision normalization those three duplicated. `approvals.request` is ONLY the gesture hop; tray-first delegation to a follower's human (#2062, unchanged — it sets `attestation` for Face ID/Touch ID entirely on its own, before ever reaching the raw leg) wraps every adapter except the two extension ones (which already relay to the panel), and the 5-minute `withApprovalTimeout` budget wraps everything, both unchanged POLICY. `Orchestrator` threads its own composed broker into both `SudoManager` constructions; `shell/supplemental-commands/secret-command.ts` now reuses that SAME broker (via `options.sudoCommand?.broker`) instead of constructing its own independent one; the page-realm standalone test hook builds a `node-rest` broker directly (that topology IS what "standalone" means, not a probe). An unset broker fails closed to `deny`, never guesses a transport.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | done (#2837)   |
| 5e    | Mount the WC shell on `WorkUnitClient` (#2382), PR D2a: the shell's selection surface is re-typed from `RegisteredScoop` to `WorkUnitSummary` — `WcShellBoot.selectScoop` / `getSelected`, the `wc-unit-context.ts` helpers, the freezer rail, the nav, the sprinkles' default-root read and the thinking hydration. The roster they read is the client's (`getUnits()`), not `OffscreenClient.getScoops()`. Record-only leader fields (the reasoning level, the session archive's folder work) are read at the leaf from `getScoop`-style lookups, so a follower's summary can go through the same surface in PR D2b. No mount changes, no rendering changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 6g    | Browser + leftovers, the LAST slice C domain PR (#2276): `kernel/telemetry.ts`'s `getModeLabel` takes `isExtensionRealm` as a boolean parameter instead of calling the probe itself — `ui/main.ts` passes the SAME `isExtension` local it already resolves once for its own routing (`ui/` is not a banned layer; `kernel/` outside `kernel/host.ts` is). `kernel/host.ts`'s `shouldStartLickWsBridge` takes `capabilityBroker.adapter` — the topology `bootOrchestrator` already resolved once — instead of re-calling `hasLocalNodeServer()` a second time. `shell/supplemental-commands/crontask-command.ts` had the one genuine live probe import left in this domain; it now mirrors `webhook-command.ts`'s established `WebhookCommandOptions` shape as a new `CrontaskCommandOptions`, threaded through `SupplementalCommandsConfig.crontask` → `HeadlessShellOptions.crontask` → `shell-and-skills.ts`, reusing the SAME `hasLocalNodeServer` closure already built there for `webhook`. `webhook-command.ts` itself needed no change — it was already fully compliant, verified by a guard test rather than left as an unverified claim. `shell/supplemental-commands/playwright/handlers/snapshot.ts`'s `pdfHandler` KEEPS its `isExtensionRealm()` read: `shell/` owns topology and there is no `browser.*` CapabilityBroker op to route through (browser automation rides `/cdp` on every adapter, not one of the four broker transports), and the read only picks which error STRING to print after a CDP call already failed — documented in place with a one-sentence rationale. `work-unit/capability/index.ts`'s remaining-domains inventory is now empty except `ui/` sites and this documented `shell/` topology owner; slice D (the lint gate) is the follow-up PR. Round-1 review (Grok + human) caught a P1 regression this migration introduced: `kernel/panel-terminal-host.ts` — the one production human-typed shell, built by `kernel-worker.ts` — never threaded `crontask` at all and still imported `hasLocalNodeServer` as a webhook fallback, so once `crontask-command.ts` stopped reading the raw probe itself, an unwired panel terminal silently assumed `node-rest` on every float (a 404 REST POST on `extension-delegate` where the worker LickManager should have run, and a skipped `--filter` CSP gate). Fixed in two parts: `crontask-command.ts`'s own default (used only by an unwired caller) now fails CLOSED to `() => false` — the LickManager path works on every float, REST is the privileged one and must be opted into — and `kernel-worker.ts` now supplies both `webhook` and `crontask` from the ONE resolved `capabilityBroker.adapter`, removing `panel-terminal-host.ts`'s own probe import entirely. | done (this PR) |
| 5f    | Mount the WC shell on `WorkUnitClient` (#2382), PR D2b: ONE mount path. `mountWcShell(app, log, { floatKind, connect })` builds the frame, asks the float for its transport and wires `attachWcChat` — strip, transcript, queued pile, composer submit/stop, selection and model pill — for every float; `attachWcWorkbench` is the leader-only half (VFS, terminal, monitor, sprinkles, permissions, transcript export, sudo, stats). `WcChatHost` is the seam for the four verbs a client protocol cannot carry, with a follower host whose refusals are stated at each member. `mountWcUiLive` / `mountWcUiExtension` / `mountWcUiFollower` are gone; what is left are three connectors (`bootLeaderFloat` / `bootExtensionFloat` / `bootFollowerFloat`), each a prelude and a `mountWcShell` call. `currentUnits()` joined the protocol; the frame builder is now `buildWcShellFrame`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | done (this PR) |
| 6h    | Slice D, the lint gate (#2276): `check-no-float-probes.mjs` bans ten float/topology identifiers — `isExtensionRealm`, `isChromeExtensionRealm`, `hasLocalNodeServer`, `resolveFloatTopology`, `getChromeExtensionRealm`, `setChromeExtensionRealm`, `hasChromeRuntimeConnect`, `canConnectToChromeRuntime`, `getExtensionDelegateId`, `setExtensionDelegateId` (the `FLOAT_PROBE_NAMES` list) — plus the raw `__slicc_connect_mode` global-bag key, under `scoops/`, `tools/`, `kernel/` except three composition roots (`kernel/host.ts`, `kernel/kernel-worker.ts`, and `kernel/port-bridge-client.ts` — the extension-delegate Port/panel-RPC transport factory, kept out of `shell/` because moving it there would add a `shell/` → `kernel/` `PanelRpcOp` type dependency against the stack's direction), mirroring `check-layer-back-edges.mjs`'s baseline-ratchet shape. Round-1 review (Grok + human) planted a batch of evasions against the first cut and every one passed silently, so the design is now two layers: a MODULE-PATH ban (any import form — named, default, namespace, dynamic, `export *`, type-only) for `shell/float-topology.ts`, `core/float-topology.ts`, `base/runtime-env.ts`, `core/runtime-env.ts` (100% probe surface), and a NAMED-clause scan (line-anchored against the statement's own start, so a string literal containing import-shaped text can't match) for everything else, including the mixed-surface `base/api-endpoint.ts` / `shell/proxied-fetch.ts` and `@slicc/shared-ts`'s two probe exports (never the package). A discovery pass folds three alias shapes repo-wide into the named scan — a bare value re-export, a renamed `export { … as … }`, and a THIN wrapper whose entire body is `return PROBE(...)` — narrow enough that `shell/tray-fetch.ts`'s `createTrayFetch` (a substantive function that merely reads topology as one statement, already reviewed in the network-domain slice) is not mistaken for a probe-identity wrapper. Baseline `float-probe-baseline.json` starts EMPTY — verified against a tree containing 6a–6g — and `--update` refuses to WRITE a larger baseline than the one already on disk without an explicit `--allow-growth`. Wired into `npm run lint` / `lint:ci` and the boy-scout debt gate (`check-touched-exemptions.mjs`, whose own "list must not grow" check had the same empty-baseline blind spot — fixed there too, general to all three ratcheted debt lists, not just this one).                                                                                                                                                                                                                                                                         | done           |

### Phase 4 detail

- On by default since #2280, when the `multiple-cones` flag left Settings → Experimental (`userToggleable: false`). Two switches remain, neither user-facing: the bundled `floatDefaults` carve-out that keeps a **Cherry** embed single-cone, and the worker's central `FEATURE_FLAGS` — which, being central, outranks the bundled Cherry default, so a `base` entry for this flag needs a matching `floats.cherry` one. When it resolves off the rail never learns a cone count. `ui/wc/wc-cone-actions.ts` reports the cone count to `<slicc-freezer-new>` (`cones` attribute), whose expanded action row then offers **New cone** and — only while more than one cone exists — **Drop cone**. The last cone can never be dropped: the row hides the action and a stale confirm is ignored, `OffscreenClient.unregisterScoop` rejects, `Bridge.handleScoopDrop` refuses, and `ScoopLifecycleManager.unregister` throws.
- There is no cone list in the rail — the top tab strip (`<slicc-agent-tabs>`) is the only switcher: every cone first (oldest first), then the **selected** cone's scoops, then every other scoop (`orderForSwitcher(scoops, selectedJid)`; followers mirror it through the same `toTabDescriptors` over the client protocol's roster). Both actions open a `<slicc-dialog>` on the body; nothing is ever inserted into the rail, so the frozen cards never move. **New cone** asks for a name and one optional brief ("What should it work on?"). The brief is sent as both `description` and `prompt` on `cone-create`: `Bridge.handleConeCreate` keeps it as `config.systemPromptAppend` (`This cone is for: …`, so the cone still knows its job after its chat is frozen) and routes it through the ordinary user-message path, so the first turn starts at once. **Drop cone** confirms in one line.
- **Drop cone** freezes the cone's chat first (`runNewSessionArchiveOnly` → `freezeConeSession({ mode: 'quick', memory: 'skip' })`, archive marked `memorySkipped` so the catch-up enriches title/icon only and never mines memory), then `unregisterScoop`. Its frozen cards stay; the oldest surviving root is the primary, so dropping the oldest moves the list up.
- The panel's existing `cone-create` message now creates _additional_ roots: `Bridge.handleConeCreate` allocates the folder with `coneFolderFor` (`cone` for the first root, `cone-<slug>` afterwards, de-duplicated) and labels extra cones by the user's name; the primary keeps `sliccy`.
- Chat sessions are keyed per folder (`chatSessionIdFor` → `session-<folder>`), so the primary cone keeps `session-cone` and every other cone gets its own history. Session-level actions follow the **selected** cone — see "Per-cone sessions" below.
- `scoop-drop` of a root goes through `WorkUnitManager.close()` (cascades to its scoops, forgets every dropped buffer/session) and refuses the last root; the rail hides ✕ on the last cone for the same rule.
- The tray wire carries the edge: `ScoopSummary.parentId` (`null` for a cone) and, on the panel wire, the REQUIRED `ScoopListMsg.scoops[].parentId` — required there because kernel and panel ship as one bundle from one origin, so that boundary has no version skew to tolerate. Browser followers group each cone with its own scoops (`toTabDescriptors` over the client roster), the extension panel takes ownership straight from the wire (`OffscreenClient`); iOS derives the role from the edge in `ScoopSummary.isRootUnit`, with `isCone` only as the fallback for a leader that predates `parentId`. See "Retiring `isCone` from the wire" below.
- Presentation lives in `ui/wc/wc-unit-context.ts`: chip label = `assistantLabel` for roots, thread/URL context `cone` (primary) / `cone:<folder>` (extra) / `scoop:<name>`, default root = primary else oldest. Followers render every cone from the unchanged wire.
- Per-cone workspaces landed separately (#2271) — see below.

### Retiring `isCone` from the wire ([#2358](https://github.com/ai-ecoverse/slicc/issues/2358))

The record lost its role field in #2279, but `ScoopSummary.isCone` stayed on the
tray wire. It cannot simply be deleted: `swift-trayfollower`'s `ScoopSummary`
decoded it as a REQUIRED `Bool`, so a leader that stopped sending it would make
every already-installed iOS / Sliccstart build fail to decode the whole
`scoops.list` — not degrade, lose the roster. Every TS float loads the webapp
from the hosted origin, so only the native followers can be out of date here.

Three stages:

| Stage | What                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Make removal survivable. `isCone` becomes `Bool?` in Swift and `isCone?: boolean` (`@deprecated`) in TS; `isRootUnit` reads `parentId == nil && (isCone ?? true)`. `TRAY_SYNC_PROTOCOL_VERSION` → 8 (Swift and Go mirrors with it), meaning "this peer derives the role from `parentId` and does not need the flag". Every TS read collapses to the edge except `summaryIsRoot`'s absent-edge fallback. |
| 2     | Gate the projection per peer. `toScoopSummaries` still projects the flag, but `BroadcastManager` strips it for a follower whose `hello` reported version ≥ 8 (`scoopsListForPeer`). A peer that never said `hello`, or said < 8, keeps receiving it.                                                                                                                                                    |
| 3     | Remove. Delete the field from `ScoopSummary`, the Swift struct, the corpus entry, the projection and the stage-2 gate. A native build older than stage 1 stops seeing scoops — the accepted cost, which is why stage 3 waits for the support window.                                                                                                                                                    |

Stages 1 and 2 shipped together; **stage 3 is a separate PR** and is blocked on
an iOS TestFlight build and a Sliccstart release carrying the stage-1 optional
decode.

Consequences already banked:

- `summaryIsRoot` / `summaryRole` (`ui/wc/wc-tray-scoops.ts`) read `parentId`
  wherever the leader sends it and fall back to `isCone` only when the edge is
  absent entirely — the exact mirror of the Swift rule, so the TS and native
  followers cannot disagree about one payload. That fallback is **the last
  `.isCone` read in TypeScript**; stage 3 deletes it together with the field.
  A summary carrying neither field is an unknown owner, never a second root.
- The PANEL wire (`kernel/messages.ts` `ScoopListMsg`) dropped `isCone`
  outright and made `parentId` required. Kernel and panel are one bundle from
  one origin, so there is no skew to tolerate — which also retired
  `OffscreenClient`'s `coneJidFromWire` inference and its `unknown-parent`
  sentinel.
- `broadcastScoopsList` is a per-follower loop (`broadcastPerFollower`) rather
  than one `broadcast()`, because the payload now differs per peer. It keeps
  the registry's failure reporting and throttling.
- After stage 3 the compiler is the ratchet again: a `summaries.find(s => s.isCone)`
  will not typecheck.

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

**Clearing goes through the same owner.** "New chat" / `clear-chat` calls
`ScoopContext.clearSession()` → `SessionPersistence.clear()`, which cancels
any pending checkpoint and deletes BOTH representations. Deleting only the
legacy session would leave the canonical record standing, and since a restore
prefers the record, the next reload would resurrect the conversation the user
just cleared.

**A write never overwrites a record it did not understand.** `store.read()`
distinguishes `absent` / `malformed` / `incompatible` / `error`, and only the
first two may be written over. A record from a NEWER schema (a rollback, where
that build's history may live in a shape this one cannot express) and a read
that merely FAILED are both left exactly where they are — the lossy `load()`
that answers `null` for all four is for READERS, whose `null` means "fall back
to the legacy store".

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
- **It heartbeats.** The pass runs at boot BEFORE any context spawns, so it
  fires `onBootProgress` after every unit — a profile with many large
  histories would otherwise sit silent through the page's kernel-ready
  watchdog (#2007) on a boot that is provably advancing.
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

### Explicit workspace isolation modes (#2277)

Child creation names a sharing policy instead of relying on the `/scoops/`
convention plus implicit `/shared`, mount, `visiblePaths` and `writablePaths`
behaviour.

`WorkUnitDescriptor.workspaceHandle` is `{ workspaceId, root, access }`.
`workspaceId` is the unit's own workspace root (`workspaceFor().root`). Roots
project as `shared-live` (unrestricted live VFS). Children default to
`shared-readonly`.

| Mode              | Status      | Default visible                        | Default writable                | Mounts auto-readable |
| ----------------- | ----------- | -------------------------------------- | ------------------------------- | -------------------- |
| `shared-readonly` | implemented | owning cone workspace + skills library | `/scoops/<folder>/`, `/shared/` | yes (today)          |
| `private`         | implemented | none                                   | `/scoops/<folder>/` only        | no                   |
| `snapshot`        | typed stub  | —                                      | —                               | —                    |
| `shared-live`     | typed stub  | —                                      | —                               | —                    |

Selecting `snapshot` or `shared-live` throws: copy-on-write snapshots are
deferred (RFC open question 4). `/tmp/` stays ambient scratch for every scoop
(`ALWAYS_WRITABLE_PREFIXES`) — that is documented shared space, not a silent
expansion of the caller's grant list.

`scoop_scoop({ workspaceMode })` and `agent --workspace-mode` pick the mode.
Omitted, both keep today's sandbox (`shared-readonly`). Explicit
`visiblePaths` / `writablePaths` still replace the mode's path defaults; the
mode still controls mount auto-inclusion, so a private scoop cannot gain a
mount just because one was added to the VFS.

`CreateWorkUnitOptions.workspace = { mode, from? }` is the kernel form. `from`
is the parent workspaceId a `shared-readonly` child inspects (defaults to the
parent's own root, so extra-cone children still read that cone).

### Per-cone workspace and memory (#2271)

`workspaceFor` (`work-unit/descriptor.ts`) is the single source for a unit's
directory layout. Every consumer reads it — `ScoopContext` (dirs, cwd, memory
file, system prompt), `ConeMemoryStore` / `appendConeMemory`, `scoop_scoop`'s
and the `agent` command's path defaults, and through those the generated
per-scoop sudoers.

| Unit                         | Workspace                    | Memory                       | Scratch (`workspaceFor`) | `$TMPDIR` (`tmpDirFor`) |
| ---------------------------- | ---------------------------- | ---------------------------- | ------------------------ | ----------------------- |
| primary cone (folder `cone`) | `/workspace`                 | `/workspace/CLAUDE.md`       | `/tmp`                   | `/tmp/cone`             |
| extra cone (`cone-<slug>`)   | `/cones/<folder>/workspace`  | `/cones/<folder>/CLAUDE.md`  | `/tmp`                   | `/tmp/<folder>`         |
| scoop                        | `/scoops/<folder>/workspace` | `/scoops/<folder>/CLAUDE.md` | `/scoops/<folder>`       | `/tmp/<cone>/<folder>`  |

`workspaceFor().scratch` is the unit's private _storage_ root (bash overflow,
agent archives, the per-scoop sudoers). `tmpDirFor()` is the _shell-visible_
`$TMPDIR` that `mktemp` resolves against. They are deliberately different
questions and deliberately different answers.

- **The primary cone never moves.** `/workspace` is named by mounts, deep
  links, skills, `upskill`, workflow discovery and every existing profile;
  `isPrimaryRoot` (folder `cone`) keeps it exactly where it was.
- **Per-unit `$TMPDIR`, under a still-shared `/tmp`** ([#2267](https://github.com/ai-ecoverse/slicc/issues/2267), [#2568](https://github.com/ai-ecoverse/slicc/issues/2568)). Every unit's shell
  publishes `$TMPDIR` pointing at a directory of its own, created by
  `ensureDirectoryStructure` before the first turn, and a scoop's nests inside
  its owning cone's. Living UNDER `/tmp` is the point: `ALWAYS_WRITABLE_PREFIXES`
  (`fs/restricted-fs.ts`), `BUILTIN_SCOOP_GRANTS` (`base/sudoers.ts`) and every
  scoop record already persisted with `writablePaths: ['/tmp/']` all keep
  working untouched, where a path beside the workspace would have needed new
  prefixes in two layers that gate independently. **It is a convention, not a
  sandbox** — the grants still expose all of `/tmp` to everyone; narrowing them
  is a separate decision. What it buys is a disposal boundary: "New chat" on a
  cone sweeps that cone's subtree (its scoops included) instead of the shared
  root a sibling cone may be writing to right now, which is the design cause of
  the incident fixed in [#2566](https://github.com/ai-ecoverse/slicc/pull/2566).
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
  switching cones re-points both (`WcWorkbenchDeps.getWorkspace`). Neither has
  a poller to correct it — the tree refreshes on VFS change events (#2409) and
  memory once per activation — so a selection change pushes
  `WorkbenchActivator.refreshFiles()` + `refreshMemory()`. A selection change
  is not a filesystem change, and without the push an open panel would keep
  showing the previous cone's files and memory indefinitely.
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
- Licks a cone produces come back to it: every unit except the untargeted default carries `SLICC_LICK_TARGET=<folder>` in its shell (`buildScoopShellEnv`), and every producer a unit's shell can start falls back to it — see "Addressing licks to a cone" below. That default is `rootsOf(scoops)[0]` — the **oldest** root, which is what `routeFormattedLickToCone` falls back to — resolved by jid against the live roster, _not_ by asking who holds the reserved `cone` folder: after the original primary is dropped, `coneFolderFor` hands that freed folder to the next new cone, which would then look primary while an older root is still the untargeted destination.
- `clear-chat` carries an optional `scoopJid`; `Bridge.handleClearChat` clears that root's live context and deletes `chatSessionIdFor(target)`. An unknown or absent jid falls back to the default root and `session-cone`.
- **The `/tmp` sweep never gates the clear.** `wc-live-freezer.ts` splits "New chat" into an archive half (`archiveConeSession`) and a clear half (`clearConeSession`); `resetNewSessionTmp` runs at the top of the clear half and its failure is caught and warned, never propagated. Aborting on a failed sweep is not a safe abort: by then the archive is durable and, on the `agentic-memory` path, the background curator is already spawned and billing — so the user would get a frozen, curated archive and a chat that never cleared. `resetNewSessionTmp` also tolerates a per-entry `ENOENT` (something else already removed it) while still propagating real faults like `EIO`. Both layers matter because `/tmp` is scratch space **shared across every cone and scoop**: a sibling cone running `npm install` there is enough to delete an entry between the sweep's `readDir` and its `rm`. That is a real incident, not a hypothetical — one aborted a "New chat" after the archive and the curator had both completed.
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
    `parentId` alone since #2358) — one flag, no second code path. On the
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
  - **The held pile is reconciled against the backend on the way home**
    ([#2354](https://github.com/ai-ecoverse/slicc/issues/2354)). The snapshot
    the panel is holding is a guess about a queue it stopped watching. The
    authority is the orchestrator's own pending list, which now rides the
    `scoop-messages-replaced` envelope as `queuedIds` — the same envelope as
    the replay, so the two describe one instant of backend state rather than
    two round trips that can disagree. `Orchestrator.getQueuedMessageIds` →
    `ScoopMessageRouter.getQueuedMessageIds` reads `messageQueues` in
    delivery order; ids only, since the panel already owns the content of
    everything it queued and cannot draw a card for an id it has never seen.
    `#applyPendingQueueRestore` then runs three passes: drop what the replay
    already shows **unless the backend still lists it** — presence in the
    replay does not mean consumed, because `Bridge.handleUserMessage` buffers
    every prompt the moment it is sent (which is why
    `handleDeleteQueuedMessage` has to scrub `messageBuffers` too), so a
    still-pending prompt keeps its card and `loadMessages` drops it from the
    RENDERED transcript instead, or it would show as both a bubble and a
    card — re-sort the rest onto the backend's order (a lick or
    a tray-side prompt that slotted in while the user was reading is no
    longer rendered behind prompts that run after it), and place what the
    backend does not list — while a turn is **running** that is the
    mid-restore consume race, so it flushes into the thread as an ordinary
    bubble; while idle nothing can be mid-consumption, so it is an unacked
    local draft and keeps its card, appended last. This is why
    `selectScoop` publishes `setProcessing` **before** the replay lands: the
    reconcile needs the turn state to read, and the rising edge itself
    correctly finds an empty pile — a prompt the backend still lists belongs
    to the _next_ turn.
  - **`queuedIds` absent ≠ empty.** A tray follower's local orchestrator is
    deliberately idle (`handleUserMessage` hands the prompt to
    `followerSync` and returns), so its empty queue says nothing about what
    the leader still holds; the bridge omits the field there, and the panel
    reads the omission as "no authoritative answer" and keeps the held order.
    An empty array is a real answer. Without one the panel keeps the older
    replay-wins reading rather than guessing a card into existence — a
    follower cannot tell a queued prompt from a consumed one, and inventing
    the difference would re-create the phantom card #2312 removed.
  - `feed_scoop` from the cone stays the only way to send a scoop input, and
    the `scoop:<name>` URL context still opens this read-only view.
  - **iOS is not wired yet.** The wire already carries what it needs
    (`ScoopSummary.parentId`); the app still renders its composer
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

**An EXPLICIT `--scoop` is resolved at create time, and an unresolvable one is
refused** (#2524). `webhook create`, `crontask create` and `fswatch create` ask
`LickManager.resolveLickTarget` (the same alias matching, over the roster the
orchestrator injects with `setUnitRosterProvider`) and exit 1 naming the valid
targets rather than persisting an entry whose every delivery is dropped —
`LickManager.init` deletes such an entry on the next boot anyway. Two limits are
deliberate: only a value the user TYPED is checked (the `defaultLickTarget`
fallback is out of scope, #2525), and a roster that cannot be consulted reports
`unverifiable`, which accepts the target rather than rejecting a name nothing can
check.

**A dropped webhook delivery no longer answers a success receipt** (#2524).
`LickManager.handleWebhookEvent` returns a `WebhookDeliveryDisposition`
(`delivered` | `filtered` | `unknown-webhook` | `unresolved-target`), which
travels back to whoever is holding the HTTP request open: the tray worker asks
for it with a `deliveryId` on `webhook.event` and reads the leader's
`webhook.delivery`, and the node-server sends `webhook_event` as a lick-bridge
REQUEST instead of a broadcast. Only the failure receipts are new — `404
WEBHOOK_NOT_REGISTERED`, `422 WEBHOOK_TARGET_UNRESOLVED`, `500
WEBHOOK_DISPATCH_FAILED` — and each leg keeps its own pre-#2524 success receipt
(the tray worker's `202 {"ok":true,"accepted":true}`, the node-server's `200
{"ok":true,"received":true}`), so no healthy caller has to be re-taught. That
success receipt also still covers `filtered` — a `--filter` dropping an event is
the filter working — and silence, because a leader too old to answer is not
evidence of a drop.

**Every producer a unit's shell can start follows the invoking unit**, so an
extra cone's (or a scoop's) events come back to it rather than to the oldest
root:

| Producer            | How it picks a target                                                               |
| ------------------- | ----------------------------------------------------------------------------------- |
| background `bash`   | `ownLickTargetFor` stamps `targetScoop` (#2272)                                     |
| `fswatch create`    | `--scoop`, else `defaultLickTarget(…, ctx.env)` (#2272)                             |
| `crontask create`   | `--scoop`, else `defaultLickTarget(…, ctx.env)`                                     |
| `webhook create`    | `--scoop`, else `defaultLickTarget(…, ctx.env)` (#2525)                             |
| workflow completion | `getStartingRoot(parentJid)` in `kernel/host.ts` stamps the starting root's folder  |
| `sprinkle open`     | claims an **unrouted** sprinkle for the opening unit; an existing route always wins |

**All three lick-producing commands treat an omitted `--scoop` the same way**,
and that uniformity is the contract callers write against. `webhook create`
alone used to reject it (`--scoop is required`), a rule inherited from a time
when an untargeted lick had nowhere to go and would have been silently dropped;
#2311 gave untargeted licks a destination and left the rejection behind
(#2525). Its only remaining effect was to make the one gesture that is correct
in a multi-cone workspace — name no target, let the runtime route the lick back
to whoever asked — inexpressible for webhooks, which pushed skills into
hardcoding the literal folder `cone` and delivering another cone's callbacks
into the default root's chat.

`SLICC_LICK_TARGET` is absent from **exactly one** shell, the default root's —
its folder is not worth spending as an alias when an untargeted lick already
lands there, and reading it from a folder test rather than from the live roster
is the bug described in the bullet above. Only that shell omits `--scoop` and
gets `undefined`, whereupon `routeFormattedLickToCone` delivers to
`rootsOf(scoops)[0]`. Skills should never hardcode `cone`: that folder is
reassigned to the next new cone once the original primary is dropped, so the
literal names the wrong unit in exactly the workspaces where naming matters.

**Scoops carry it too** (Codex P1 on #2525). `ownLickTargetFor` has always
answered `scoop.folder` for a child, and `tools.ts` has always stamped that on
the licks background `bash` produces — but `buildScoopShellEnv` used to drop it
for a non-cone unit, so the env-driven producers in the SAME shell disagreed
with `bash` in it: `fswatch`/`crontask`/`webhook` fell through to the default
root and delivered a scoop's own callbacks into an unrelated cone's chat,
payload included. Whoever set the watcher up is who hears about it. This is
distinct from "users never talk to a scoop" (#2312), which governs what a scoop
needs from a **human** — that still escalates to the owning cone; an automation
event is work for the scoop that registered it, not a question for anyone.

**From outside the cone's shell**, the same handles work as an explicit flag:
`webhook create --scoop <cone>`, `crontask create --scoop <cone>`,
`fswatch create --scoop <cone>` and `sprinkle route <name> --scoop <cone>` all
accept a cone's `name` or its `folder` (`cone-<slug>`). The extension /
side-panel path resolves them identically: `lick-manager-proxy.ts` forwards the
target string verbatim over `BroadcastChannel`, and resolution happens once, in
the kernel host, for every float.

### Phase 8a detail — `createMany` + `join` (#2278 slice A)

Supervisor APIs on `WorkUnitManager`, not a second orchestrator. Cone/scoop stay the product vocabulary; `scoop_wait` remains the non-blocking lick-delivering tool and `feed_scoop` the feed path. Nested `canCreateChildren` grants, detach/promote, workspace isolation modes, and `CapabilityBroker` are later slices.

- `createMany(options[])` registers many units in one call. Every `parentId` must already exist **or** be an explicit `id` elsewhere in the same batch; a missing parent, a duplicate id, an id already in the registry, a duplicate folder (within the batch or against the live roster — folders key `workspaceFor` / `chatSessionIdFor`), or a cycle throws **before** anything is registered (`create` applies the same existing-id guard — `registerScoop` would otherwise overwrite via `Map.set`; single `create` still leaves folder uniqueness to the caller / UI). Intra-batch edges are applied parent-before-child; the returned array matches the caller's order. A `registerScoop` failure rolls back every unit already created in this call via `close()`, so the registry is left as it was (all-or-nothing).
- `join(ids, { timeoutMs? })` waits until each unit settles or the timeout fires. It is a thin map over `ScoopCompletionService.waitForScoops` — the same bus `scoop_wait` uses. Unknown ids are reported as `timedOut` immediately (they never hang). `timeoutMs: 0` is an explicit immediate timeout; omit to wait indefinitely. Completions from children of different roots resolve independently on that one bus. **Known limitation (slice A):** interactive roots (`completion.mode === 'interactive'`) never call `notifyCompletion`, and silent children (`notifyOnComplete === false`) return before waiters are resolved — so `join` on those ids only ends via timeout (or hangs if unbounded). Join is for delegated children that publish on the scoop-wait bus; observing root/silent turns is out of this slice.

### Phase 3 detail

- `ScoopContext` holds a `WorkUnitDescriptor` built once in its constructor and reads `unit.policy.*`, `unit.workspace.*`, `unit.completion.mode` and `unit.display.role` where it used to branch on `isCone` (filesystem reach, sudo wiring, memory paths, scratch dir, process owner, stale-asset resubmit, overflow escalation, system prompt).
- `ScoopLifecycleManager` picks `VirtualFS` vs `RestrictedFS` from `policy.filesystem` (and `includeMounts` from the isolation `mode`), gates every privileged callback on the policy (`canCreateChildren`, `canManageChildren`, `canWriteSharedMemory`, `canResolveApprovals`, `approvalAuthority`), and routes fatal errors to the unit's parent.
- Completion, idle notices and sudo requests take a `findParent` / `findApprover` dependency: the child's parent, falling back to the default (oldest) root when the parent is gone, so a delegated result always lands somewhere a user can see it.
- Unaddressed events (licks, sprinkles, workflow completions, follower snapshots) resolve the default root through `rootsOf(...)[0]` / `WorkUnitManager.resolveDefaultRoot()`; `bootstrapCone` only seeds a root when none exists.
- `normalizeScoopRecord` sanitizes a root's trigger fields on register and restore; `ScoopPresentation` projects the wire's `isCone` from `isRootUnit`. Since #2279 the record has no role field at all, so nothing — `ui/` included — can branch on one.
- `WorkUnitManager.close(id)` cascades to the unit's children first; closing root A leaves root B's subtree untouched. A child with `onParentClose: 'detach'` (or `close(id, { descendants: 'detach' })`) is promoted instead of torn down; default remains cascade.
- `WorkUnitManager.promote(id)` / `detach(id)` (aliases — RFC "detach" is the same operation) turn a child into an independent root: `parentJid = null`, so `interactiveRootPolicy` applies. Unknown ids throw. Already-a-root is a no-op. A restricted-root preset is **not** introduced: `parentJid === null` continues to mean the interactive-root preset, so the root test stays one field. The unit keeps its folder (and chat session); `workspaceFor` then treats it as an extra cone (`/cones/<folder>/…`) and files under `/scoops/<folder>/` are not moved — the same non-migration extra cones got in #2271. The canonical conversation is rekeyed to the new workspace identity before the live runtime is rebuilt. A spawned unit is then torn down and `createTab`'d so `ScoopContext.unit`, the filesystem and the tool set match the new root policy. Cone-drop panel cleanup skips detach survivors that remain registered after `close`.
- Name-based child resolution in the scoop-management tools (`feed_scoop`, `drop_scoop`, `scoop_mute`, `scoop_unmute`, `scoop_wait`, `list_scoops`, `scoop_scoop`'s duplicate check) runs against `subtreeOf(roster, caller.jid)` — the caller plus what it transitively owns. An unmatched name is an error naming the caller's subtree; it never widens to a global match, so cone A's `scoop_wait helper` cannot capture cone B's `helper` (#2360). Scoop _folders_ stay globally unique (suffixed on collision) because `/scoops/<folder>/` is one shared VFS path. Cross-subtree operations wait on #2278's supervisor APIs (`createMany` / `join` / detach / promote).

### Nested delegation

A child may create grandchildren only when granted. `ScoopConfig.canCreateChildren: true` (the `scoop_scoop` `canCreateChildren` argument, or `CreateWorkUnitOptions.config`) is the grant; `derivePolicy` turns on `canCreateChildren` **and** `canManageChildren` so the child can feed / drop / wait on what it spawns. The grandchild is still a delegated child: restricted FS, parent-mediated approvals, `canCreateChildren: false` unless the grant is passed on, and `parentJid` names the granting scoop — not the cone.

Create-time enforcement (`assertChildPolicyAllowed` in `WorkUnitManager.create` and the `onScoopScoop` callback):

1. Child capabilities ⊆ parent (`isPolicySubset`). A leaf cannot grant nested delegation; a granted scoop cannot mint an approver grandchild it does not itself hold.
2. The parent must have `canCreateChildren`. Without the grant, `WorkUnitManager.create` refuses even a default child. Tool registration already hides `scoop_scoop` when the flag is false.

The one-shot `agent` shell command is a different primitive and is not gated on this flag.

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

### Phase 6: CapabilityBroker (#2276)

Privileged operations (browser, network, secrets, devices, mounts, approvals) flow through one injected `CapabilityBroker`. A work unit never asks "am I running in the extension?"; it asks the broker and receives a typed result or `CapabilityUnavailable` (never a thrown string). Runtime detection happens at `createKernelHost` composition time.

Slice A (this phase's protocol PR):

- Explicit per-operation allowlists on each domain — no generic handler maps.
- Page adapter stub + Node-shaped adapter stub. Unimplemented ops return `CapabilityUnavailable`.
- One broker composed in `kernel/host.ts` and injected into the orchestrator before `init()`.
- One migrated scoops call site: `scoop-context/shell-and-skills.ts` webhook topology uses `network.localNodeServer`. Remaining sites are listed in `work-unit/capability/index.ts`.
- Conformance: `packages/webapp/tests/work-unit/capability-broker.conformance.ts`.

Slice B (real adapters):

**Topology is the capability axis.** The adapters are keyed by `shell/float-topology.ts`'s `FloatTopology`, not by product float names, because that is the axis the transports actually differ on. `kernel/host.ts` calls `resolveFloatTopology()` exactly once and hands the answer to `createCapabilityBrokerForTopology`; the annotation there (`const topology: CapabilityAdapterId = resolveFloatTopology()`) is the compile-time check that the two unions stay in sync.

| Adapter                                   | Transport                                                                                                                | Live operations                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `node-rest`                               | `/api/*` on the local privileged server                                                                                  | `network.localNodeServer`, `network.crossOriginFetch`, `secrets.*`, `mounts.signRequest`, `approvals.request` |
| `extension-direct` / `extension-delegate` | service-worker `chrome.runtime` messages / the named `secrets.crud`, `mount.sign-and-forward`, `fetch-proxy.fetch` Ports | `network.crossOriginFetch`, `secrets.*`, `mounts.signRequest`, `approvals.request`                            |
| `connect`                                 | none                                                                                                                     | none — a hosted `?connect=1` cone genuinely has no privileged surface                                         |

There is no separate Swift adapter. `packages/node-server` and `packages/swift-server` expose the same privileged routes, so `node-rest` serves both; the wire is pinned by `packages/shared-ts/fixtures/capability-rest-contract.json`, replayed three ways — the browser adapter's emitted requests (`packages/webapp/tests/work-unit/capability-rest-adapter.test.ts`), the Express routes (`packages/node-server/tests/routes/capability-rest-contract.test.ts`) and the Hummingbird routes (`packages/swift-server/Tests/CapabilityRestContractTests.swift`). The fixture also records the one route that is NOT universal today: `POST /api/secrets` (persisted secret creation) exists on the Node server only, so a `secrets.set` with the default `persisted` scope is unavailable on a Swift float. Session-scoped sets work on both.

Three protocol facts fall out of making the adapters real:

- **`CapabilityFailure` is not `CapabilityUnavailable`.** "This float has no transport for that" is a permanent shape fact a caller can branch on once at composition; "that attempt failed" (HTTP 5xx, a disconnected Port, a malformed reply) is retryable and worth showing the user. Both are `ok: false`, so a caller that only checks `ok` still fails closed.
- **Page-gesture ops are a channel, not an adapter.** A directory picker and the WebUSB / WebSerial / WebHID choosers need a page-realm user gesture in EVERY topology, so `kernel/host.ts` injects one `PageGestureChannel` that all four adapters layer on. Omitted (the state today) leaves `mounts.pickDirectory` and `devices.*` unavailable — unchanged from before.
- **Allowlists are derived, not declared.** `composeCapabilityBroker` builds each domain from the operations an adapter supplied by name, so "listed but unimplemented" and "implemented but unlisted" are both unrepresentable. The conformance suite enforces the two-way agreement: an unlisted op must answer `CapabilityUnavailable`, and a listed one never may.

**`approvals.request` is the native-gesture hop and nothing more.** It asks "put this in front of whoever decides on this float, and give me their answer". Everything around that hop is policy and stays in `sudo/`, above the broker: tray-first delegation to a follower's human, the 5-minute human-decision budget and its `reason: 'user-timeout'` deny (`withApprovalTimeout`), cone/scoop/agent routing, and pattern suggestion. Slice C's approvals PR (6f) WRAPS this capability inside `createSudoBroker`; it does not replace `createSudoBroker` with it — `capability-gesture-broker.ts` is the raw gesture leg `createSudoBroker` wraps. The adapters carry NO deadline of their own on this op — the REST adapter passes `humanPaced: true`, which drops the machine deadline entirely — because a relay that is not there at all (a side panel that never loaded leaves MV3's callback unfired forever) must not block a turn on a prompt no human will ever see; the caller's `signal` (the sudo layer's 5-minute budget) is the only thing that can end the wait. At the `CapabilityBroker` level, a broken relay IS still a `CapabilityFailure`, distinguishable from a human's `deny` — but `SudoBroker.requestApproval` has no shape for that distinction, so `capability-gesture-broker.ts` reads it as a plain `{decision: 'deny'}` (never `reason: 'user-timeout'` — that would misreport a broken relay as an unanswered prompt). A dead relay therefore DOES read as a refusal at the sudo layer today; recovering "nobody was ever asked" would need widening `SudoDecision.reason` beyond `'user-timeout' | 'cone-timeout'`, deferred rather than done speculatively.

`browser.*` stays unavailable on every adapter in this slice: it rides the `/cdp` bridge, which is not one of these transports.

Migrating the remaining call sites is slice C (one PR per domain; the inventory lives in `work-unit/capability/index.ts`), and the lint gate that forbids a float probe under `scoops/` / `tools/` / `kernel/` is slice D. Review-patterns category 10 (layer-stack import direction) is the sibling check: float detection in `scoops/` / `tools/` is the same class of "the call site is in the wrong layer" as a back-edge.

**Slice C, network domain (6c): the goal is that `scoops/` never asks "am I in the extension?", not that every call site becomes a broker operation.** None of `scoops/tray-leader.ts` (`createTrayFetch`), `shell/proxied-fetch.ts` (`createProxiedFetch`) or `shell/mcp/redirect-uri.ts` (`resolveMcpRedirectUri`) is a privileged operation gated by an allowlist — they are `SecureFetch`-shaped transport factories called from 18+ `shell/` sites with no `CapabilityBroker` in scope at any of them, so none became a `network.crossOriginFetch` broker call. `network.crossOriginFetch` stays the broker op for a caller that DOES hold a broker (none migrated in this slice, and none need to). What changed:

- **`createTrayFetch` (and its `TrayProxyFetchError`) moved from `scoops/tray-leader.ts` to `shell/tray-fetch.ts`**, a sibling of `proxied-fetch.ts`. Deciding raw fetch vs `/api/fetch-proxy` is a transport-layer decision; caching the probe in place and reading it from `tray-leader.ts` would have been the SAME probe under a new name, still in `scoops/` — exactly what a probe-name-keyed slice-D lint gate would fail to catch. After the move, `scoops/tray-leader.ts` has no realm or topology read anywhere in the file: `LeaderTrayManager` still does `options.fetchImpl ?? createTrayFetch()`, now importing the factory from `shell/` (a downward import), and re-exports it under the established name so existing callers keep this module as their address.
- `shell/tray-fetch.ts` and `shell/proxied-fetch.ts` both read `getChromeExtensionRealm()` — `base/api-endpoint.ts`'s lazily-cached, per-realm answer, resolved once on first read and reused, mirroring the module's existing `extensionDelegateId` / `localApiBaseUrl` idiom. This read belongs where it lives now: `shell/` is where topology is OWNED (`shell/float-topology.ts`'s header says so). `getChromeExtensionRealm()` is still a probe, not a broker op — its doc comment says so explicitly, and it joins the slice-D gate's ban list for `scoops/` / `tools/` / `kernel/` (except `kernel/host.ts`) alongside `isExtensionRealm` / `hasLocalNodeServer` / `resolveFloatTopology`.
- `redirect-uri.ts`'s `resolveMcpRedirectUri` takes `topology: FloatTopology` as a required parameter; its two callers (`shell/mcp/provider.ts`, `shell/supplemental-commands/mcp-command.ts`) resolve `resolveFloatTopology()` at the point they actually need a redirect URI. Both callers are `shell/`, so this is not a relocation that needs fixing — the same ownership rule as above.

First-load impact: zero. Nothing new was added to either eager graph — this only moves an already-eager probe call between already-eager files.

**Slice C, secrets domain (6d): unlike the network domain, this one call site IS a privileged operation with a broker equivalent — `secrets.listMaskedEnv` — already implemented by every adapter in slice B.** `scoops/scoop-context/shell-and-skills.ts` used to call `core/secret-env.ts`'s `fetchSecretEnvVars()`, which resolves `resolveSecretTopology()` (a `resolveFloatTopology()` alias) and branches on it internally to reach `chrome.runtime.sendMessage`, the `secrets.crud` bridge, or `/api/secrets/masked` — the same shape of "business logic decides its own transport by float" that 6c removed from `tray-leader.ts`, just one function call deeper. It now calls `broker.secrets.listMaskedEnv()` through the same already-injected broker the file already used for `network.localNodeServer`, and reuses `buildEnvFromMaskedEntries` (now exported from `core/secret-env.ts`) to apply the identical POSIX-name filter and `GITHUB_TOKEN`/`GH_TOKEN` alias to the broker's `SecretMaskedEnvEntry[]` instead of `MaskedSecretEntry[]` — same filter, same alias, no duplicated logic. The REST adapter's `secrets.listMaskedEnv` carries the same 10s budget `MASKED_SECRETS_TIMEOUT_MS` used, via `rest-ops.ts`'s shared `CONTROL_CALL_TIMEOUT_MS`; any `CapabilityResult.ok === false` (unavailable or a failed transport) degrades to `{}`, matching the old fail-silent contract exactly — secrets stay optional and must never block shell init.

`fetchSecretEnvVars()` itself is unchanged and stays exported: `ui/wc/wc-live.ts` still calls it directly to seed the standalone terminal view's env, and `ui/` is not one of the banned layers (only `scoops/` / `tools/` / `kernel/`, except `kernel/host.ts`, are).

`shell/supplemental-commands/secret-command.ts` also reads `resolveFloatTopology()` (`buildEnv`, ~line 157) to pick `inExtension` and to select its own CRUD backend (`createDefaultSecretBackend`, in `shell/supplemental-commands/secret-backends.ts` — also `shell/`). This is not a relocation to fix, for the same reason `redirect-uri.ts`'s callers were left alone in 6c: the file lives in `shell/`, which owns topology. It is also not a broker migration: the `secret` command's backend exposes `set` / `get` / `peek` / `scope` / `list` / `delete` / `test` / `edit`, a materially larger surface than the broker's four-operation `SecretCapability` allowlist (`listMaskedEnv`, `getMasked`, `set`, `delete` — deliberately smaller, per its doc comment in `work-unit/capability/types.ts`), and none of those extra operations is needed by this slice, so no new allowlist op was added — allowlists stay minimal and explicit, per the slice-B design decision.

## Non-goals

No rewrite, no per-unit worker, no removal of cone/scoop vocabulary, no tray/cloud protocol redesign, no shared-live filesystem collaboration by default.
