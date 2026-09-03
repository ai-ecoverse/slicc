/**
 * `WorkUnitClient` — one client protocol for local and remote presentation
 * (#2274, phase 5 of #1666).
 *
 * The WC shell renders the same five things — a tab strip, a transcript, a
 * queued pile, a model pill, a composer — from two unrelated sources today:
 * an `OffscreenClient` (MessagePort to the kernel) on a leader, a
 * `FollowerSyncManager` (tray / WebRTC) on a follower. Every row of that
 * mapping is one concept with two implementations, and they have drifted
 * before — three switcher orderings existed at once before #2317, and a
 * follower's model pill latched an empty catalog for a whole session (#2329)
 * because nothing on that side shared the leader's notion of "this unit's
 * model".
 *
 * This module is the protocol both transports implement. It knows about work
 * units, not about the DOM, floats, transports or the tray wire: the adapters
 * (`ui/work-unit-client/`) translate, and the presentation helpers
 * (`presentation.ts`) render — once, for both.
 *
 * Design record: `docs/work-unit-client.md`.
 */

import type { WorkUnitModel } from '../../scoops/types.js';
import type { TurnGuestGate } from '../../sudo/types.js';
import type { Unsubscribe, WorkUnitId, WorkUnitRole } from '../types.js';

export type { Unsubscribe, WorkUnitId, WorkUnitRole } from '../types.js';

/**
 * Rendered lifecycle state of a unit — the shell's four values, which are
 * also the wire's closed `ScoopSummary.state` union. Distinct from
 * {@link import('../types.js').WorkUnitStatus}, which is the RUNTIME
 * lifecycle (`creating`/`ready`/`running`/`failed`/`closed`): a follower
 * never sees runtime states, only what the leader was rendering.
 */
export type WorkUnitPresentationState = 'initializing' | 'idle' | 'working' | 'broken';

/** What a `working` unit is busy with. Refines {@link WorkUnitPresentationState}. */
export type WorkUnitPhase = 'thinking' | 'tool';

/**
 * One unit as the switcher, the model pill and the read-only rule need it.
 *
 * This is a PRESENTATION projection, not the runtime
 * {@link import('../types.js').WorkUnitDescriptor}: it carries no policy, no
 * workspace and no completion mode, because a follower has none of those and
 * the shell renders none of them.
 */
export interface WorkUnitSummary {
  id: WorkUnitId;
  /**
   * Ownership edge. `null` is a root (a cone), a jid is the owning unit, and
   * `undefined` means the OWNER IS UNKNOWN — a leader too old to send the
   * edge (`ScoopSummary.parentId` is optional on the wire). An unknown owner
   * is never invented: {@link WorkUnitSummary.role} still answers what the
   * unit is, and the ordering keeps such units in leader order at the tail.
   */
  parentId: WorkUnitId | null | undefined;
  /**
   * Presentation role. CARRIED rather than derived by the reader, because the
   * two transports answer it from different fields on different record
   * shapes. Each adapter resolves it once — `isRootUnit` on a record,
   * `summaryIsRoot` on a wire summary — so nothing downstream branches on the
   * transport's shape. `summaryIsRoot` reads the ownership edge wherever the
   * remote sends it and falls back to the deprecated `ScoopSummary.isCone`
   * flag only when the edge is absent entirely — the one case #2358 stage 3
   * will delete along with the field.
   */
  role: WorkUnitRole;
  name: string;
  folder: string;
  /** Assistant label shown for a root (`sliccy` for the primary cone). */
  assistantLabel: string;
  state: WorkUnitPresentationState;
  /** Only meaningful while `working`. */
  phase?: WorkUnitPhase;
  /** Idle because the turn ended and the composer is the user's. */
  awaiting?: boolean;
  /** Context-window fullness, 0–100 — the agent tabs' scale on both sides. */
  fill: number;
  /**
   * The model THIS unit runs on (#2310), provider-qualified. Absent means
   * "not pinned / not known yet", never "the global selection": an empty
   * catalog is warm-up, not an answer (#2329), so a reader must not latch on
   * the absence.
   */
  model?: WorkUnitModel;
  trigger?: string;
  /**
   * When the unit was registered, as the record's ISO `addedAt`. Present only
   * where the transport carries it: the strip orders ROOTS by it (oldest
   * first) and falls back to the transport's own order when it is missing, so
   * a leader too old to send it renders exactly as it does today.
   *
   * It is on the protocol because it is the one ordering input the two sides
   * did not share: the leader sorted its cones by `addedAt` while the
   * follower took them in wire (registry) order, so two cones registered out
   * of order rendered in a different order on the two screens.
   */
  addedAt?: string;
}

/** One chat message as both transports already deliver it to the shell. */
export interface WorkUnitChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

/**
 * Point-in-time view of one unit as the shell renders it: the strip
 * descriptor, the transcript, and the backend's pending queue.
 */
export interface WorkUnitSnapshot {
  summary: WorkUnitSummary;
  messages: readonly WorkUnitChatMessage[];
  /**
   * The backend's pending queue for this unit, in delivery order (#2362).
   *
   * **Absent is not empty.** `undefined` means nobody could answer and the
   * held order stands; `[]` is a real answer meaning the queue is genuinely
   * empty. A follower always answers `undefined` — its leader does not send a
   * queue and its own orchestrator is idle by construction, so reporting `[]`
   * would reorder the pile against a lie.
   *
   * It rides the SAME snapshot as `messages` for the reason it rides the same
   * `scoop-messages-replaced` envelope: the two must describe one instant of
   * backend state, or the reconcile races the consume.
   */
  queuedIds?: readonly string[];
}

/** A prompt delivered through the client. */
export interface WorkUnitClientInput {
  text: string;
  /**
   * The CALLER's id for this message, which both transports key real
   * behaviour on: the leader's backend queue is cancelled by it
   * (`delete-queued-message`) and a follower suppresses its own echo by it
   * (`sentMessageIds`). A client that minted its own would orphan the queue
   * entry the shell shows and double-render the send.
   *
   * Absent lets the adapter mint one, which is only correct for a caller that
   * never has to name the message again.
   */
  messageId?: string;
  /** Steer the running turn instead of queueing behind it. */
  steer?: boolean;
  attachments?: readonly unknown[];
  /**
   * Turn-scoped guest gate for a message a biscotto sent: approving the
   * MESSAGE is not approving the actions it provokes, so a guest-caused turn
   * carries its own tool gate.
   *
   * LOCAL ONLY, and deliberately so. The gate is minted by a leader from its
   * own seat record; a client that could put one on the wire would be a guest
   * granting itself a gate. A remote client therefore REJECTS a gated send
   * rather than delivering it ungated — silently dropping the gate is the one
   * outcome that must not happen, so it is a rejection and not a fallback.
   */
  guestGate?: TurnGuestGate;
}

/**
 * What a subscriber to one unit receives.
 *
 * **Ordering is part of the contract**: a `snapshot` supersedes every
 * `message` delivered before it, and a subscriber that attaches mid-turn
 * receives a `snapshot` before any incremental event. Today the leader gets a
 * replay and the follower gets `onSnapshot`, and nothing states they must
 * agree — the conformance suite is where that is now pinned.
 *
 * There is no `error` variant: neither transport reports a per-unit failure
 * as anything but a status (`broken` locally, nothing at all remotely), and a
 * variant no adapter can produce is a promise the protocol cannot keep.
 */
export type WorkUnitClientEvent =
  | { type: 'status'; state: WorkUnitPresentationState }
  | { type: 'snapshot'; snapshot: WorkUnitSnapshot }
  | { type: 'message'; message: WorkUnitChatMessage };

/**
 * Signals a client can deliver to a unit.
 *
 * The RFC wrote `signal(id, processId, signal)`. There is no process-level
 * signal on EITHER transport — not on the panel⇄kernel protocol, not on the
 * tray wire — so the protocol ships the one both sides can honour today.
 * Per-process signalling arrives with the supervisor APIs (#2278), which is
 * also where a process group gets an addressable identity; a `processId`
 * argument neither adapter could route would be a lie in the type.
 */
export type WorkUnitSignal = 'stop';

/** The protocol the WC shell mounts against, whatever the transport. */
export interface WorkUnitClient {
  /** Every unit this client can present, in protocol order. */
  list(): Promise<readonly WorkUnitSummary[]>;
  /**
   * Roster pushes: registration, drop, status, phase, fill and model changes.
   * Fires ONCE immediately with the roster as it stands, so a subscriber never
   * has to render an empty strip while waiting for the first change — the
   * shell's publish path is synchronous and this is what keeps it that way.
   */
  subscribeList(listener: (units: readonly WorkUnitSummary[]) => void): Unsubscribe;
  /**
   * Select `id` and resolve with what the shell renders for it. Selection is
   * part of the call on both transports: a leader replays into the panel for
   * the selected unit, a follower only receives the selected unit's snapshot.
   */
  snapshot(id: WorkUnitId): Promise<WorkUnitSnapshot>;
  /** Deliver a prompt to `id`. */
  send(id: WorkUnitId, input: WorkUnitClientInput): Promise<void>;
  /**
   * Pin the model `id` itself runs on (#2310). Naming a CHILD is legal and is
   * not pre-resolved here: both backends resolve a child to the cone that owns
   * it, and resolving it client-side would put a third owner walk next to the
   * two that already disagree.
   *
   * Resolves with whether the backend CONFIRMED the write:
   *
   * - `true` — applied to that unit's record.
   * - `false` — refused; the backend does not know the unit.
   * - `undefined` — nobody could answer. A remote client ALWAYS answers this:
   *   the tray's `model.select` is a fire-and-forget frame with no ack, so
   *   `false` there would claim a refusal that never happened. Same
   *   absent-is-not-empty rule as {@link WorkUnitSnapshot.queuedIds}.
   *
   * The answer is about the WRITE only. What a unit currently runs on is read
   * from `summary.model` off {@link WorkUnitClient.subscribeList} — an absent
   * model is warm-up, never a latched answer (#2329).
   */
  setModel(id: WorkUnitId, model: WorkUnitModel): Promise<boolean | undefined>;
  /** Per-unit event stream. See {@link WorkUnitClientEvent} for the ordering rule. */
  subscribe(id: WorkUnitId, listener: (event: WorkUnitClientEvent) => void): Unsubscribe;
  /** Interrupt `id`'s current turn. */
  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void>;
}
