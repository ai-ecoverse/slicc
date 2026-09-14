import type { AgentEvent, AgentHandle } from '../../core/agent-types.js';
import type { WorkUnitClient, WorkUnitId } from '../../work-unit/client/types.js';

export interface WorkUnitAgentHandleDeps {
  getSelectedId(): WorkUnitId | null;

  onEvent(listener: (event: AgentEvent) => void): () => void;

  onError?(error: string): void;
}

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
