# WorkUnitClient — one client protocol for local and remote presentation

Design record for [#2274](https://github.com/ai-ecoverse/slicc/issues/2274),
phase 5 of [#1666](https://github.com/ai-ecoverse/slicc/issues/1666). Code:
`packages/webapp/src/work-unit/client/` (protocol + presentation) and
`packages/webapp/src/ui/work-unit-client/` (the two adapters — they wrap
`ui/`-layer transports, so they live in `ui/`; the layer stack forbids
`work-unit/` importing up into it). The runtime-side decisions live in
[`work-unit.md`](work-unit.md); this file is about the **presentation** edge.

## The problem

The WC shell renders the same five things — a tab strip, a transcript, a
queued pile, a model pill, a composer — from two unrelated sources:

|                | Leader (local)                                             | Follower (remote)                                       |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| roster         | `OffscreenClient.getScoops()` + `onScoopListUpdate`        | `FollowerSyncManager.onScoopsList(scoops, activeJid)`   |
| runtime state  | page-side `Map`s in `WcLiveWiring` (statuses/fills/phases) | `ScoopSummary.state` + `activity` + `fill` on the wire  |
| ordering       | `orderForSwitcher` (`wc-unit-context.ts`)                  | `toFollowerSwitcherScoops` → `orderByOwner` (both gone) |
| descriptors    | `toSwitcherScoops` (`wc-live-callbacks.ts`)                | `toFollowerSwitcherScoops` (`wc-tray-scoops.ts`, gone)  |
| transcript     | `requestScoopMessages` → `onScoopMessagesReplaced`         | `selectScoop` → `onSnapshot`                            |
| queue          | `queuedIds` on the replay envelope (#2362)                 | not sent (a follower's local queue says nothing)        |
| model          | `modelFor(record)`                                         | `ScoopSummary.model` + the catalog retry (#2329/#2330)  |
| role/read-only | `unitRoleFor(scoop)`                                       | `summaryRole(summary)`                                  |
| owning root    | `rootForSelection`                                         | `rootOfSummary`                                         |
| stop           | `OffscreenClient.stopScoop`                                | `FollowerSyncManager.stop`                              |

Every row is one concept with two implementations. They have drifted before
and will again: three switcher orderings existed at once before #2317, and the
follower's model pill latched an empty catalog for a whole session (#2329)
because nothing on that side shared the leader's notion of "this unit's
model". Review-patterns category 8 ("follower wiring parity") exists because
this table exists.

## The decision

One protocol — `WorkUnitClient` — that both transports implement, and one
presentation module the shell renders from. **Adapters first: wrap, don't
rewrite.** `OffscreenClient` and `FollowerSyncManager` keep every method they
have; the adapters translate their vocabulary into the protocol. Deleting the
old paths is explicitly out of scope (that is #2279's leftover and #2365).

```ts
interface WorkUnitClient {
  /** Every unit this client can present, in protocol order (see below). */
  list(): Promise<readonly WorkUnitSummary[]>;
  /** Roster pushes. Fires on registration, drop, status, fill and model changes. */
  subscribeList(listener: (units: readonly WorkUnitSummary[]) => void): Unsubscribe;
  /** Select `id` and resolve with what the shell renders for it. */
  snapshot(id: WorkUnitId): Promise<WorkUnitSnapshot>;
  /** Deliver a prompt to `id`. */
  send(id: WorkUnitId, input: WorkUnitClientInput): Promise<void>;
  /** Pin `id`'s own model (#2310). See `setModel` below for the tri-state answer. */
  setModel(id: WorkUnitId, model: WorkUnitModel): Promise<boolean | undefined>;
  /** Per-unit event stream (status, replays, incoming messages — no errors). */
  subscribe(id: WorkUnitId, listener: (event: WorkUnitClientEvent) => void): Unsubscribe;
  /** Interrupt `id`'s current turn. */
  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void>;
}
```

### `WorkUnitSummary` — what the strip needs

```ts
interface WorkUnitSummary {
  id: WorkUnitId;
  /** `null` = root, a jid = owned, `undefined` = a leader too old to send the edge. */
  parentId: WorkUnitId | null | undefined;
  role: WorkUnitRole; // 'primary' | 'child', never stored
  name: string;
  folder: string;
  assistantLabel: string;
  state: 'initializing' | 'idle' | 'working' | 'broken';
  phase?: 'thinking' | 'tool';
  awaiting?: boolean;
  fill: number; // 0–100, percent of the context window
  model?: WorkUnitModel; // provider-qualified (#2310)
  trigger?: ScoopTrigger;
}
```

`role` is carried rather than derived by the reader, because the two transports
answer it from different fields on different record shapes. The adapters
resolve that once — `isRootUnit(record)` locally, `summaryIsRoot(summary)`
remotely — so nothing downstream branches on the wire shape, and
`parentId: undefined` means exactly "owner unknown", which the ordering rule
below already has a place for. `summaryIsRoot` reads the ownership edge
wherever the leader sends it and falls back to the deprecated `isCone` flag
only when the edge is absent entirely — the last `.isCone` read in TypeScript,
which #2358 stage 3 deletes with the field.

`state`/`phase`/`awaiting`/`fill` are the shell's expression model, not the
wire's. The remote adapter expands `state` + `activity` through the existing
`fromWire` in `wc-tray-scoops.ts` (unchanged, still the only place the two
grammars convert); the local adapter reads the page-side maps it reads today.

### `WorkUnitSnapshot` — what the transcript needs

```ts
interface WorkUnitSnapshot {
  summary?: WorkUnitSummary; // absent when the transport cannot describe the unit
  messages: readonly WorkUnitChatMessage[];
  /** #2362: the backend's pending queue in delivery order. ABSENT ≠ EMPTY. */
  queuedIds?: readonly string[];
}
```

`summary` is optional because a transport can be mirroring a unit it genuinely
cannot describe, and that state is permanent rather than a race: a **biscotto
seat is pinned to one thread and is deliberately never sent `scoops.list`**
(`sendScoopsListToFollower` refuses it — the inventory's labels would leak what
else the owner is working on), so no roster entry for its unit will ever
arrive. Holding such a snapshot back until a summary showed up left every guest
with a blank thread. The transcript is the part that matters; a reader that
needs the strip's view asks `list()`.

`queuedIds` rides the snapshot for the same reason it rides
`scoop-messages-replaced`: the replay and the queue must describe **one
instant** of backend state, or the reconcile races the consume. `undefined`
("nobody could answer") keeps the held order; `[]` is a real answer. A
follower always reports `undefined` — its leader does not send a queue and its
own orchestrator is idle by construction — and the protocol says so in the
type rather than in a comment on one branch.

### `WorkUnitClientEvent`

```ts
type WorkUnitClientEvent =
  | { type: 'status'; state: WorkUnitSummary['state'] }
  | { type: 'snapshot'; snapshot: WorkUnitSnapshot } // wholesale replay
  | { type: 'message'; message: WorkUnitChatMessage }; // routed / lick arrival
```

There is no `error` variant: neither transport reports a per-unit failure as
anything but a status, and a variant no adapter can produce is a promise the
protocol cannot keep — the same rule that trimmed `signal`.

Ordering is part of the contract: **a `snapshot` supersedes every `message`
delivered before it**, and a subscriber that attaches mid-turn receives a
`snapshot` before any incremental event — the adapters make that true rather
than assuming it. Each caches the last snapshot it published and seeds a new
subscriber with it; when it holds none the LOCAL adapter asks the kernel for a
replay (side-effect-free: the panel applies one only for the unit it shows),
while the remote one does not — a follower receives only the SELECTED unit's
transcript, so asking would change what the leader mirrors, and a subscription
must not do that. `snapshot(id)` is that call.

**A snapshot can arrive before the roster does.** `LeaderSyncManager.addFollower()`
sends the initial transcript ahead of `scoops.list`, and the kernel can answer
for a unit the page has not listed yet. The two adapters answer that
differently, and the difference is the transports': the LOCAL one holds the
orphan and publishes it once the roster names the unit, because a kernel
roster always arrives; the REMOTE one publishes immediately with no `summary`,
because for a guest seat the roster never arrives at all. Neither drops it —
that would leave a subscriber with no transcript until some later selection
asked for one.

### `send` — what a prompt carries

```ts
interface WorkUnitClientInput {
  text: string;
  messageId?: string; // the CALLER's id
  steer?: boolean; // interrupt the running turn instead of queueing
  attachments?: readonly unknown[];
  guestGate?: TurnGuestGate; // LOCAL ONLY
}
```

`messageId` is on the protocol because both transports key real behaviour on
it: the leader's backend queue is cancelled by it (`delete-queued-message`)
and a follower suppresses its own echo by it (`sentMessageIds`). An adapter
that minted its own would orphan the queue entry the shell is showing and
double-render the send. It stays OPTIONAL — a caller that never has to name
the message again lets the adapter mint one.

`guestGate` is the one field a remote client **refuses**. A turn-scoped guest
gate (#2535) is minted by a leader from its own seat record; a client that
could put one on the tray wire would be a guest granting itself a gate.
`RemoteWorkUnitClient.send` therefore rejects a gated send rather than
delivering it ungated — silently dropping the gate is the outcome that must
not happen, so it is a rejection and not a fallback.

### `setModel`

```ts
setModel(id, model): Promise<boolean | undefined>
```

Local → `OffscreenClient.setScoopModel` (`set-scoop-model`); remote →
`FollowerSyncManager.selectModel(qualifiedId, unitId)`. Both backends resolve
a CHILD to the cone that owns it (#2310), so the client does not pre-resolve
the owner — a third owner walk beside the two that already disagree is exactly
what this protocol exists to remove.

The answer is tri-state, following the same absent-is-not-empty rule as
`queuedIds`: `true` applied, `false` refused (the backend does not know the
unit), `undefined` nobody could answer. A remote client always answers
`undefined` — `model.select` is a fire-and-forget frame with no ack, so
`false` there would claim a refusal that never happened. It is about the WRITE
only; what a unit currently runs on is read from `summary.model`.

### One `AgentHandle` for both composers

`createWorkUnitAgentHandle(client, { getSelectedId, onEvent, onError })`
(`ui/work-unit-client/agent-handle.ts`) is the chat controller's handle over
the protocol. There were two: `OffscreenClient.createAgentHandle()` on a
leader and the `FollowerSyncManager` itself on a follower. Send and stop are
exactly `send` and `signal(id, 'stop')`, so they are written once; a send with
no selection is REPORTED, never guessed at, because the protocol names the
unit and there is no "current" one to fall back on.

**The agent event stream stays with the transport.** `AgentEvent` is the agent
loop's vocabulary (deltas, tool calls, turn boundaries) and
`WorkUnitClientEvent` is the shell's presentation vocabulary (status,
snapshot, message). Folding one into the other would put the whole agent wire
on a protocol whose job is the strip and the transcript, so the caller passes
its own `onEvent`. `onError` is the same argument from the other side: the
protocol has no error variant (no adapter can produce one), so the float that
CAN show one is handed the job — on a leader that is
`OffscreenClient.emitAgentError`, on a follower a log line.

### `signal`

The RFC wrote `signal(id, processId, signal)`. **There is no process-level
signal on either transport** — not on the panel⇄kernel protocol, not on the
tray wire — so the protocol ships the signal both sides can honour today:

```ts
type WorkUnitSignal = 'stop'; // abort the current turn
```

Local → `OffscreenClient.stopScoop(id)`; remote → `FollowerSyncManager.stop()`.
Per-process signalling arrives with the supervisor APIs (#2278), which is also
where the process group gets an addressable identity. Inventing a `processId`
argument neither adapter could route would be a lie in the type.

## Presentation: one ordering, one descriptor

`work-unit/client/presentation.ts` becomes the single implementation of what
`orderForSwitcher` and `orderByOwner` both do:

```ts
orderUnits(units, selectedId): readonly WorkUnitSummary[]
toSwitcherDescriptors(units, selectedId): SwitcherScoop[]
ownerRootOf(units, id): WorkUnitSummary | undefined
```

**The ordering that wins is the follower's owner-grouped one**: every root
first (oldest first), then the selected root's descendants depth-first, then
every other root's descendants in root order, then anything whose owner is
unknown, in leader order. The leader's `orderForSwitcher` splits the same
roster into "selected subtree" and "the rest" but keeps registry order inside
each half — which is the documented intent ("cone, its scoops, next cone") only
as long as registry order happens to be owner-grouped.

The two orderings are **identical for every roster with one cone and no nested
grant**: a single cone reduces both to "cone, then its scoops in registry
order". Depth-first descendants already cover a `canCreateChildren` grant.
The change is only observable with several cones _and_ a scoop registered out
of owner order, which is exactly the case the two implementations disagreed
about.

`ownerRootOf` replaces `rootForSelection` (leader) and `rootOfSummary`
(follower) — the same bounded walk, written once. Approval routing keeps its
leader-side home (`Orchestrator.ownerRootOrDefault`, #2312): the client
protocol does not settle approvals, it only agrees on who owns whom.

Read-only chrome stays one rule, and it moved onto the protocol:
`isReadOnlyUnit(summary)` states it over `role`, and `isReadOnlyRole` (the
UI's `cone`/`scoop` spelling) delegates there. Both shells reach one answer.

## Adapters

### `LocalWorkUnitClient` (`ui/work-unit-client/local.ts`)

Wraps an `OffscreenClient` plus the page-side state the live shell already
keeps (`WcLiveWiring.statuses` / `fills` / `phases` / `awaitingInput`).

| Protocol         | Adapted from                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `list`           | `getScoops()` joined with the page-side maps                                                                           |
| `subscribeList`  | `onScoopListUpdate` / `onScoopCreated` / `onStatusChange` / `onScoopPhaseChange`                                       |
| `snapshot`       | `setSelectedScoopJid` + `requestScoopMessages` → the next `scoop-messages-replaced` for that jid, `queuedIds` included |
| `send`           | `sendRaw({ type: 'user-message' })`, carrying the caller's `messageId`                                                 |
| `setModel`       | `setScoopModel` (the kernel acks, so this transport never answers `undefined`)                                         |
| `subscribe`      | `onStatusChange` / `onScoopMessagesReplaced` / `onIncomingMessage`                                                     |
| `signal('stop')` | `stopScoop`                                                                                                            |

The CLI and extension floats both go through this adapter — they already share
`OffscreenClient` and differ only in transport (`MessageChannel` vs
`chrome.runtime`), which the protocol never sees.

**Both adapters decorate a callback bag rather than subscribing to one.**
`OffscreenClient` and `FollowerSyncManager` take their callbacks in the
constructor, so an adapter built alongside them cannot attach after the fact:
`wrapCallbacks` / `wrapOptions` return the same bag with three or four handlers
wrapped, and every base handler still runs with its original arguments.

The leader's wrapper runs the base handler **first**, because the page-side
status/fill/phase maps it projects from are mutated by those handlers — emitting
before them would publish a roster describing the previous instant. The
follower's roster wrapper runs **before**, because there the frame IS the state
and the shell's handler publishes the strip from it.

**A status frame updates the roster too.** `subscribeList` promises a push for
a status change on both transports; the remote adapter folds the frame into
its held roster (clearing the `phase` / `awaiting` refinements the new state
does not describe) so `list()` cannot lag the face until the next
`scoops.list`.

**The strip's repaint reads the roster synchronously** (`currentUnits()`, the
sync twin of `list()`). A held copy is wrong on the leader: `awaitingInput` and
the selection change with no kernel event behind them, so a cached roster would
render one instant late.

### `RemoteWorkUnitClient` (`ui/work-unit-client/remote.ts`)

Wraps a `FollowerSyncManager` and the small state machine in `wc-follower.ts`
(`followerScoops`, `followerSelectedScoop`).

| Protocol         | Adapted from                                                                   |
| ---------------- | ------------------------------------------------------------------------------ |
| `list`           | the last `onScoopsList` payload, expanded through `fromWire`                   |
| `subscribeList`  | `onScoopsList`                                                                 |
| `snapshot`       | `selectScoop(id)` → the next `onSnapshot` for that jid; `queuedIds: undefined` |
| `send`           | `sendMessage` (rejects a `guestGate`; selects the unit first when it differs)  |
| `setModel`       | `selectModel(qualifiedId, unitId)` — no ack frame, so always `undefined`       |
| `subscribe`      | `onSnapshot` / `onStatus` (through `shouldApplyFollowerStatus`) / `onEvent`    |
| `signal('stop')` | `stop()`                                                                       |

Cherry and hosted followers ride this adapter unchanged — they are the same
follower path. iOS is untouched: it speaks the tray wire directly, and this
change adds no wire fields.

## Conformance

`tests/work-unit/client/conformance.ts` — one suite, run against both adapters
over a fake kernel (a scripted `OffscreenClient` transport) and a fake tray (a
scripted `FollowerSyncManager` callback set). It pins the rows that have
drifted:

1. **list/order parity** — the same roster, fed to both adapters in the two
   transports' native shapes, produces byte-identical `SwitcherScoop[]`:
   cones-first, selected cone's scoops next, unknown owners at the tail.
2. **read-only role parity** — a child resolves to `role: 'child'` and
   `isReadOnlyRole` on both sides, from a leader that sends both fields, from
   one that has already stopped projecting `isCone` for a v8 peer, and from an
   old one that sends only `isCone` (#2358).
3. **model surface parity** — `summary.model` is the unit's own
   provider-qualified model on both sides; an empty catalog is warm-up, not an
   answer (#2329), so a summary with no model never latches.
4. **queue snapshot consistency** — `queuedIds` and `messages` come from one
   snapshot; `undefined` and `[]` are distinguished; the remote adapter always
   answers `undefined`.
5. **event ordering on subscribe-during-turn** — a subscriber attaching while
   a turn is running gets `snapshot` before any `message`, and a later
   `snapshot` supersedes messages delivered before it.
6. **composer parity** — a send names its unit and carries the caller's
   `messageId` and the `steer` flag; a gated send is carried or refused, never
   delivered ungated; `stop` names its unit and sends nothing to get there.
7. **transcript parity** — a queue answer is reconciled only from an answer
   the transport actually made (`[]` locally, `undefined` remotely); a second
   snapshot for the same unit supersedes the first; a snapshot that precedes
   the roster is still delivered; and a subscribe that joins an in-flight
   snapshot does not make the transport answer twice.
8. **model write parity** — `setModel` reaches the transport naming the unit
   the caller named, including a child, and answers `true` or `undefined` but
   never a refusal the transport did not hear.

## Mounting the shell on the client (#2382)

**PR A** put the composer, the stop and the model write on the protocol.
**PR B** does the transcript and the selection:

- Selection IS `snapshot(id)` on both sides. It was
  `setSelectedScoopJid` + `requestScoopMessages` on the leader and
  `sync.selectScoop` on the follower; those calls are what the adapters make.
- The transcript is rendered from `subscribe(id)`, not from the awaited
  `snapshot(id)`. Awaiting it would paint the SAME replay the subscription
  already delivers, and the local adapter's no-answer fallback resolves with an
  empty transcript — which must never be allowed to wipe a live thread. The
  subscription only ever sees snapshots the transport really published.
- `onScoopMessagesReplaced` is gone from the leader's callback bag entirely.
  The follower's `onSnapshot` handler SURVIVES, but only for the selection
  bookkeeping the frame also carries — the leader names the unit it is
  mirroring, and on a fresh join that frame is how the follower first learns
  which unit it has. It no longer reads the transcript. The adapters consume
  both callbacks; that is where a kernel envelope or a tray frame becomes a
  snapshot event.
- **All three follower paths now read the protocol** (the third since PR D1).
  The dedicated follower mount (`wc-follower.ts`), the leader mount
  (`wc-live.ts`) and the leader-capable float's own follower role (`wc-tray.ts`
  `buildFollowerOptions`) each render from a client. What is still separate is
  the MOUNT: that float already has a leader shell, so a follower role there
  decorates the existing chrome and returns a disposer instead of building its
  own. Collapsing the three mounts is PR D2b.
- **The leader suppresses the seeded snapshot on a re-point; the follower takes
  it.** `subscribe` seeds a new listener synchronously with the last snapshot
  it published. On the leader that seed is the previous transcript of a unit
  being re-selected, and painting it would consume the one-shot held-queue
  restore against a stale `queuedIds` (#2354). On the follower there is no
  backend queue to mis-reconcile, and the seed is often the only snapshot that
  unit will get (see the guest-seat case above).
- **A subscriber that joins an in-flight `snapshot(id)` neither re-asks nor
  takes the cached seed.** Both would produce a second wholesale render of a
  transcript that is about to be replaced — dips disposed and rehydrated, a
  flash of stale history, and the one-shot held-queue restore consumed against
  a stale `queuedIds` (#2354). That single rule lives in the adapters, so a
  mount decides nothing: a tab click asks first and therefore sees only the
  fresh replay, while a fresh join and a guest seat have nothing in flight and
  still get their seed.
- **An unanswered request is recovered, once.** Because `subscribe` suppresses
  its own ask while a snapshot is in flight, that ask is the only one and
  nothing else would re-issue it — so a dropped request would leave the
  PREVIOUS unit's transcript on screen while the composer, the thread context
  and the navbar attention already belong to the new one. The local adapter
  re-asks once on timeout, and if that is dropped too it publishes the unit's
  OWN last-known transcript (or an empty one) with `queuedIds` absent, so the
  held pile stands. That answer is emitted, never cached: it is the client's,
  not the transport's.
- **`resetSelection` drops the dead channel's transcripts.** A reconnect
  re-sends a snapshot and the roster back to back and the roster can win that
  race, so a seed from the previous session could paint a transcript the leader
  has since frozen or cleared.

### The model pill: one per-unit read (PR C)

`summary.model` is the only place the shell asks what model a unit runs on.
`modelForUnit(units, id, previous)` in `presentation.ts` is that read, and it
carries the two rules each call site used to re-derive:

- **The owning cone answers** (#2310). Selecting a scoop shows its cone's
  model, because the cone is what the picker writes to. A unit whose chain is
  unknown answers for itself.
- **Absent is "not known yet", never "no model"** (#2329). A roster can
  legitimately arrive without the field — a leader too old to send
  `ScoopSummary.model`, a record not yet backfilled, a catalog still warming
  up — and reading that as an answer is what latched a follower's pill empty
  for a whole session. `previous` is carried forward instead.

Four reads moved onto it: the leader's pill (`wc-live-thinking-hydration.ts`),
its telemetry context (`wc-live-controller.ts`), a new cone's seed
(`wc-cone-actions.ts`) and the `model.state` a follower is sent
(`wc-tray.ts`) — so that frame and the leader's own pill cannot drift.

`toScoopSummaries` keeps `modelFor(record)` and is the only one left in `ui/`:
it is the leader PROJECTING a record onto the wire, the thing that _produces_
`ScoopSummary.model`, so reading a summary there would be circular. It sits
upstream of the protocol exactly as `recordToWorkUnitSummary` does.

**The catalog stays off the protocol.** `summary.model` is an identity
(`{ provider, id }`); the display NAME and the reasoning capability come from
a catalog that is leader-global on both sides — `resolveModelById` locally,
`models.list` remotely. That is why `wc-follower-model-surface.ts` still
exists: it is the catalog, and nothing else.

### The selection surface: summaries, not records (PR D2a)

`WcShellBoot.selectScoop` / `getSelected` and everything downstream of them
speak `WorkUnitSummary`. They took a `RegisteredScoop` — a leader-only record
that a follower simply does not have — which is what blocked one mount path:
`attachWcChat` could not hand a follower's unit to a shell whose selection type
only a leader can produce.

Nothing in the rendering changed; the fields did:

- `unit.jid` → `unit.id`, `unit.parentJid === null` → `isRootSummary(unit)`,
  and the switcher label reads the carried `role` instead of re-deriving it.
- `wc-unit-context.ts`'s helpers (`orderForSwitcher`, `rootForSelection`,
  `rootForConeFolder`, `defaultRootOf`) are typed on summaries, and their
  callers pass the client's roster — the shell's `getUnits()`, which reads
  `LocalWorkUnitClient.currentUnits()` — instead of
  `OffscreenClient.getScoops()`. (`chatSessionIdFor` stays on
  `work-unit/record.ts`: it keys off `folder` alone, which both shapes carry.)
- **Record-only fields are read at the LEAF, never by re-widening the
  selection.** Two survive on the leader: the reasoning level behind the
  thinking pill (`applyThreadContext`'s optional `getRecord`) and the session
  archive's folder work in the freezer rail, which resolves its cone summary
  back to a record with a single lookup. A follower passes neither and renders
  correctly without them — it has no thinking pill and no freezer.
- **`defaultRootOf` orders roots the way the STRIP does** (`orderRoots`:
  `addedAt` ascending when every root carries one, then id). Reading the first
  root in roster order would make boot selection, the sprinkle stop, the
  freezer fallback and a bare `?ctx=cone` disagree with the leftmost tab — the
  restore walks IndexedDB key order, so after the original cone is dropped
  those orders differ.
- **A selection is never dropped because the client's roster is a tick
  behind.** The record roster and the client's are two views of one
  `scoop-list` event, and either can arrive first: a new cone landing
  (`wc-cone-actions.ts`) and the first cone of a fresh boot
  (`onScoopCreated`) both project the record they are already holding when
  the summary is not there yet. Waiting for the roster silently loses the
  selection the user just asked for.

### What a follower's summary may not carry (the D2b contract)

Three fields are optional on the protocol, and every one of them changes
behaviour when a follower's summary starts arriving at this surface. The rule
is the same in all three rows: **absent is "not known", never a value.**

| Field                          | Absent means                                                                           | What the shell does                                                                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parentId`                     | A leader too old to send the ownership edge, while `role` still says the unit is owned | `rootForSelection` answers `undefined` rather than the default root. Inventing an owner would freeze, re-model or stop the WRONG cone on a scoop's behalf. A child whose named parent is merely missing from the roster keeps the historical default-root fallback — that is a render race, not an absent edge. |
| `addedAt`                      | The transport does not carry registration time                                         | `orderRoots` is all-or-nothing: with any root missing it, roots keep transport order, and `defaultRootOf` reads that same order — so the default selection and the strip cannot disagree.                                                                                                                       |
| the record behind `getRecord?` | The caller has no records at all (a follower)                                          | The thinking pill keeps the value it had. `metaThinkingForScoop` answers `off` for an unknown level, and writing that would report reasoning as DISABLED on every selection — the #2329 latch bug in a second place.                                                                                            |

The mount collapse itself (`attachWcChat` / `attachWcWorkbench` /
`mountWcShell`) is PR D2b.

## Sequencing and scope

This lands in two steps:

1. **This PR** — protocol, both adapters, the shared presentation module, the
   conformance suite, and the tab strip cut over to it on both sides. Both
   shells build their strip from `toTabDescriptors` over the protocol's roster;
   `toSwitcherScoops` / `orderForSwitcher` /
   `rootForSelection` / `isReadOnlyRole` survive as thin delegations, so no
   caller moves and no export disappears. `orderByOwner` and `rootOfSummary`
   are gone — they were private, and the shared implementation IS them.
2. **A follow-up (#2382)** — the mount cutover, landing as four PRs. **PR A
   (this one)** puts the composer, stop and the model write on the protocol:
   `setModel` joins it, and one `createWorkUnitAgentHandle` replaces the two
   `AgentHandle`s. **PR B** moves the transcript and selection onto
   `snapshot`/`subscribe`. **PR C** makes `summary.model` the only per-unit
   model read. **PR D** collapses the three mounts. In full: the transcript, the queued pile, the
   composer, selection (`selectScoop` → `client.snapshot`) and the model pill
   move onto the client too, and `mountWcUiLive` / `mountWcUiFollower` /
   `mountWcUiExtension` collapse onto one mount path that takes a
   `WorkUnitClient`, which is where the transcript, queued pile, composer
   availability and model pill stop having two wirings. That is a large,
   behaviour-visible change to `attachWcClient` (VFS, terminal, monitor,
   sprinkles and permissions are all bound to `OffscreenClient` inside it) and
   does not belong in the same PR as the protocol it consumes.

The RFC exit criteria are therefore met across the pair: step 1 gives leader
and follower one protocol and one renderer for the strip and the snapshot;
step 2 removes the parallel UI state machine. Legacy path deletion stays with
#2365.
