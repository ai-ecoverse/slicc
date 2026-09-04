/**
 * The leader-only seam under the shared chat wiring (#2382 PR D2b).
 *
 * `attachWcChat` renders a unit from a {@link WorkUnitClient} and nothing
 * else — that protocol is the same on both transports. Four things it needs
 * are NOT on the protocol and never will be, because only a leader can do
 * them: routing an inline dip's lick, answering a tool-UI card, cancelling a
 * backend queue entry, and publishing an agent error onto the kernel's own
 * event stream.
 *
 * They are gathered here rather than left as `if (client instanceof …)`
 * branches inside the chat wiring. A follower supplies
 * {@link createFollowerChatHost}, whose members are deliberate no-ops and
 * rejections with the reason stated at each one — so the difference between
 * the two floats is a small readable object, not a scattering of null checks
 * in the code both of them run.
 */

import type { RegisteredScoop } from '../../scoops/types.js';
import type { WorkUnitId } from '../../work-unit/client/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { AgentEvent, ChatMessage } from '../types.js';
import type { WelcomeInterceptHolder } from './wc-live-controller.js';

/** The record fields a leader reads at the leaf; a follower has no records. */
export type WcChatRecord = Pick<RegisteredScoop, 'thinking' | 'config'>;

/** What the shared chat wiring needs that the client protocol cannot answer. */
export interface WcChatHost {
  /**
   * The agent EVENT stream (streaming text, tool cues, errors).
   *
   * Both transports have one — the leader's kernel handle, the follower's
   * sync manager — so this is a transport FACT, not a leader capability. It
   * stays on the host because it is the one thing `WorkUnitClient` does not
   * carry: `subscribe` is per-unit snapshot/message state, while this is the
   * live turn.
   */
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  /**
   * Route an inline dip's lick (a ```shtml block's button) to the cone.
   *
   * LEADER-ONLY in the sense that only a leader can HANDLE it; a follower
   * still forwards one over the tray, which is why its host implements this
   * rather than dropping it.
   */
  sendSprinkleLick(name: string, body: unknown, targetScoop?: string): void;
  /** Answer a tool-UI card's button. A follower renders those read-only. */
  sendToolUiAction(requestId: string, action: string, data: unknown): void;
  /**
   * Cancel a queued message in the BACKEND queue. A follower's queue is the
   * leader's, and the tray has no verb for it, so a follower rejects instead
   * of resolving — a silent success would leave the pile out of step with
   * the backend that still holds the entry.
   */
  deleteQueuedMessage(unitId: WorkUnitId, messageId: string): Promise<void>;
  /** Publish an agent error (a failed send) onto the transport's stream. */
  emitAgentError(error: string): void;
  /**
   * The record behind a unit, for the ONE field the summary does not carry:
   * the reasoning level behind the thinking pill (#2382 D2a). Absent on a
   * follower, which has no records — and the pill then keeps its previous
   * value rather than being told reasoning is off.
   */
  getRecord?(id: WorkUnitId): WcChatRecord | undefined;
  /**
   * The unit a SEND is addressed to, when the float narrows it.
   *
   * A leader addresses whatever is selected. A follower must not: until its
   * leader has named a unit for THIS session there is nothing to address, and
   * a send would be dropped after the controller had already rendered the
   * bubble and cleared the input.
   */
  addressableUnitId?(): WorkUnitId | null;
  /**
   * This float speaks assistant replies after a dictated turn.
   *
   * A leader does (the whisper/kokoro pipeline is its own). A follower arms
   * push-to-talk but has no reply voice wired, and turning one on here would
   * make every panel start talking — a behaviour change, not a mount change.
   */
  speaksReplies?: boolean;
  /**
   * Staged attachments to ride the next submit, if the float stages any.
   *
   * Both do, from different places: the leader's add-menu reads the VFS
   * (files, skills, past conversations), a follower's stages base64 payloads
   * only. The STAGE is the float's; taking it on submit is not.
   */
  takeAttachments?(): ChatMessage['attachments'] | undefined;
  /** The float's turn-finished hook (placeholder, stats, the avatar's eyes). */
  onTurnIdle?(): void;
  /**
   * Decorate a rendered message BEFORE its dips hydrate.
   *
   * The extension side panel swaps onboarding welcome dips for a hand-off
   * card: they drive provider connect, which cannot run in a cross-origin
   * panel iframe. Removing them before hydration is what keeps a dead OAuth
   * wizard from being built at all.
   */
  onMessageRendered?(messageHost: HTMLElement): void;
  /**
   * What this float reads off a rendered replay, beyond the messages.
   *
   * A follower derives the turn state from it: its leader's `onStatus` frame
   * is a separate message that a fresh join may not have received yet, so a
   * replay still carrying a streaming message is how it learns the turn is
   * live. A leader has the kernel's own status events and derives nothing.
   */
  onSnapshotRendered?(messages: readonly ChatMessage[]): void;
  /**
   * Run after a selection has applied its chrome.
   *
   * A follower's composer answers to more than the selection: it stays shut
   * while the channel is down or the leader has not named a unit, and that
   * decision outranks "this unit is writable".
   */
  onSelectionApplied?(): void;
  /**
   * This float writes the model pill itself, from its own catalog.
   *
   * True on a follower, whose catalog is the leader's `models.list` rather
   * than this page's provider settings (see `wc-follower-model-surface.ts`).
   */
  ownsModelPill?: boolean;
  /** Leader-only: the welcome flow's lick interceptor, once it is wired. */
  welcome?: WelcomeInterceptHolder;
  /**
   * Tool-UI cards render as a static "waiting on the leader" placeholder.
   * A follower mounts no permissions surface and installs no tool-UI
   * handling, so its buttons would silently no-op.
   */
  readOnlyToolUi?: boolean;
}

/**
 * A leader's host, with the two slots its workbench fills in later.
 *
 * The chat surface is wired before the workbench is (the workbench needs a
 * mounted shell), but two of its inputs are the workbench's: the attachment
 * stage the VFS-backed add-menu fills, and the turn-finished hook that
 * refreshes the placeholder and the session stats. They are slots rather than
 * constructor arguments so the ONE mount order holds for both floats.
 */
export interface LeaderChatHost extends WcChatHost {
  /** Where the composer's staged attachments come from, once its menu exists. */
  setAttachmentSource(take: () => ChatMessage['attachments'] | undefined): void;
  /** The turn-finished hook, once the stats poller exists. */
  setTurnIdleHook(hook: () => void): void;
}

/**
 * A leader's host: the kernel client answers every member directly.
 *
 * The one piece of work here is the agent EVENT stream — `createAgentHandle`
 * mints a fresh handle, so it is created ONCE and shared, or each listener
 * would sit on its own handle.
 */
export function createLeaderChatHost(
  client: Pick<
    OffscreenClient,
    | 'createAgentHandle'
    | 'deleteQueuedMessage'
    | 'emitAgentError'
    | 'getScoops'
    | 'sendSprinkleLick'
    | 'sendToolUiAction'
  >
): LeaderChatHost {
  const kernelEvents = client.createAgentHandle();
  let takeAttachments: (() => ChatMessage['attachments'] | undefined) | null = null;
  let turnIdle: (() => void) | null = null;
  return {
    onAgentEvent: (listener) => kernelEvents.onEvent(listener),
    sendSprinkleLick: (name, body, targetScoop) => client.sendSprinkleLick(name, body, targetScoop),
    sendToolUiAction: (requestId, action, data) => client.sendToolUiAction(requestId, action, data),
    deleteQueuedMessage: (unitId, messageId) => client.deleteQueuedMessage(unitId, messageId),
    emitAgentError: (error) => client.emitAgentError(error),
    // The reasoning level, read at the leaf from the roster this float owns —
    // off `getScoops()`, the same roster every other leader-side read uses.
    getRecord: (id) => client.getScoops().find((scoop) => scoop.jid === id),
    speaksReplies: true,
    takeAttachments: () => takeAttachments?.(),
    onTurnIdle: () => turnIdle?.(),
    // The welcome flow installs its lick interceptor into this holder once it
    // loads; the chat wiring reads it on every dip lick.
    welcome: { intercept: null },
    setAttachmentSource: (take) => {
      takeAttachments = take;
    },
    setTurnIdleHook: (hook) => {
      turnIdle = hook;
    },
  };
}

/**
 * The host a shell has before anything attaches: nothing to route to.
 *
 * `prepareWcShell` builds the frame and can render a selection before any
 * transport exists (a test drives it directly; a leader's roster event lands
 * in the same task as `spawnKernelWorker`). Selection chrome does not depend
 * on a transport, so it renders — and the four verbs, which do, are dropped
 * rather than crashing on a null.
 */
export const DETACHED_CHAT_HOST: WcChatHost = {
  onAgentEvent: () => () => undefined,
  sendSprinkleLick: () => undefined,
  sendToolUiAction: () => undefined,
  deleteQueuedMessage: () => Promise.resolve(),
  emitAgentError: () => undefined,
};

/** What a follower's `deleteQueuedMessage` rejects with. */
export const FOLLOWER_QUEUE_CANCEL_UNSUPPORTED =
  'A follower cannot cancel the leader’s queued message';

/**
 * A follower's host: the tray for the two verbs it can forward, and honest
 * refusals for the two it cannot.
 */
export function createFollowerChatHost(deps: {
  /** The live sync manager, or `null` while the channel is down. */
  getSync(): {
    sendSprinkleLick(name: string, body: unknown, targetScoop?: string): void;
  } | null;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  /** Surface a failed send where the user is looking (the leader shows a card). */
  onAgentError(error: string): void;
}): WcChatHost {
  return {
    onAgentEvent: deps.onAgentEvent,
    // Forwarded, not handled: the cone's lick router runs on the leader.
    sendSprinkleLick: (name, body, targetScoop) =>
      deps.getSync()?.sendSprinkleLick(name, body, targetScoop),
    // A follower has no `installLeaderPermissionsSurface` and no tool-UI
    // wiring, so a card's buttons are rendered read-only (see
    // `readOnlyToolUi`) and this is never reached from the UI.
    sendToolUiAction: () => undefined,
    deleteQueuedMessage: () => Promise.reject(new Error(FOLLOWER_QUEUE_CANCEL_UNSUPPORTED)),
    // The leader's error card is a kernel event; here the caller renders the
    // failure into the thread itself.
    emitAgentError: deps.onAgentError,
    readOnlyToolUi: true,
  };
}
