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

|                | Leader (local)                                             | Follower (remote)                                      |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| roster         | `OffscreenClient.getScoops()` + `onScoopListUpdate`        | `FollowerSyncManager.onScoopsList(scoops, activeJid)`  |
| runtime state  | page-side `Map`s in `WcLiveWiring` (statuses/fills/phases) | `ScoopSummary.state` + `activity` + `fill` on the wire |
| ordering       | `orderForSwitcher` (`wc-unit-context.ts`)                  | `toFollowerSwitcherScoops` → `orderByOwner`            |
| descriptors    | `toSwitcherScoops` (`wc-live-callbacks.ts`)                | `toFollowerSwitcherScoops` (`wc-tray-scoops.ts`)       |
| transcript     | `requestScoopMessages` → `onScoopMessagesReplaced`         | `selectScoop` → `onSnapshot`                           |
| queue          | `queuedIds` on the replay envelope (#2362)                 | not sent (a follower's local queue says nothing)       |
| model          | `modelFor(record)`                                         | `ScoopSummary.model` + the catalog retry (#2329/#2330) |
| role/read-only | `unitRoleFor(scoop)`                                       | `summaryRole(summary)`                                 |
| owning root    | `rootForSelection`                                         | `rootOfSummary`                                        |
| stop           | `OffscreenClient.stopScoop`                                | `FollowerSyncManager.stop`                             |

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
  /** Per-unit event stream (status, replays, incoming messages, errors). */
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
  summary: WorkUnitSummary;
  messages: readonly WorkUnitChatMessage[];
  /** #2362: the backend's pending queue in delivery order. ABSENT ≠ EMPTY. */
  queuedIds?: readonly string[];
}
```

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
  | { type: 'message'; message: WorkUnitChatMessage } // routed / lick arrival
  | { type: 'error'; error: string };
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
for a unit the page has not listed yet. Both adapters HOLD such a snapshot and
publish it as soon as the roster names the unit; dropping it would leave a
subscriber with no transcript until some later selection asked for one. That is what makes
subscribe-during-turn testable on both sides — today the leader gets a replay
and the follower gets `onSnapshot`, and nothing states they must agree.

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
7. **model write parity** — `setModel` reaches the transport naming the unit
   the caller named, including a child, and answers `true` or `undefined` but
   never a refusal the transport did not hear.

## Sequencing and scope

This lands in two steps:

1. **This PR** — protocol, both adapters, the shared presentation module, the
   conformance suite, and the tab strip cut over to it on both sides. Both
   shells build their strip from `toTabDescriptors` over the protocol's roster;
   `toSwitcherScoops` / `toFollowerSwitcherScoops` / `orderForSwitcher` /
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
