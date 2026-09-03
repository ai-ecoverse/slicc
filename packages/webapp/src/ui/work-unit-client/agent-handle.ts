/**
 * `createWorkUnitAgentHandle` — the composer's `AgentHandle` over a
 * {@link WorkUnitClient} (#2382).
 *
 * The chat controller talks to an `AgentHandle`, and there were two of them:
 * `OffscreenClient.createAgentHandle()` on a leader and the
 * `FollowerSyncManager` itself on a follower. Both are "send this text, stop
 * this turn, tell me what the agent did" — the first two are exactly the
 * protocol's {@link WorkUnitClient.send} and {@link WorkUnitClient.signal},
 * so they are written once here and the transport keeps only the third.
 *
 * **The event stream stays with the transport, on purpose.** `AgentEvent` is
 * the agent loop's own vocabulary (deltas, tool calls, turn boundaries);
 * `WorkUnitClientEvent` is the shell's presentation vocabulary (status,
 * snapshot, message). They are not the same stream and folding one into the
 * other would put the whole agent wire on a protocol whose job is the strip
 * and the transcript. So the caller passes its own `onEvent`.
 */

import type { AgentEvent, AgentHandle } from '../../core/agent-types.js';
import type { WorkUnitClient, WorkUnitId } from '../../work-unit/client/types.js';

export interface WorkUnitAgentHandleDeps {
  /**
   * The unit a composer send addresses. `null` means nothing is selected yet,
   * which is a dropped send rather than a guess: the protocol names the unit,
   * so there is no "current" one to fall back on.
   */
  getSelectedId(): WorkUnitId | null;
  /** The transport's own agent-event stream. See the module note. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /**
   * Report a send or stop that never reached the backend, in whatever way
   * this float surfaces one. Called for a send with no selection and for a
   * rejected `send` / `signal` — a refused guest gate is the case that must
   * never pass silently.
   */
  onError?(error: string): void;
}

/** One `AgentHandle` over the client protocol, for either transport. */
export function createWorkUnitAgentHandle(
  client: WorkUnitClient,
  deps: WorkUnitAgentHandleDeps
): AgentHandle {
  const report = (error: unknown): void => {
    deps.onError?.(error instanceof Error ? error.message : String(error));
  };
  return {
    sendMessage: (text, messageId, attachments, options) => {
      const id = deps.getSelectedId();
      if (!id) {
        deps.onError?.('No scoop selected');
        return;
      }
      void client
        .send(id, {
          text,
          ...(messageId ? { messageId } : {}),
          ...(attachments ? { attachments } : {}),
          ...(options?.steer ? { steer: true } : {}),
          ...(options?.guestGate ? { guestGate: options.guestGate } : {}),
        })
        .catch(report);
    },
    onEvent: (listener) => deps.onEvent(listener),
    stop: () => {
      const id = deps.getSelectedId();
      if (!id) return;
      void client.signal(id, 'stop').catch(report);
    },
  };
}
