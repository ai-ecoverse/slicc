import type { RegisteredScoop } from '../../scoops/types.js';
import type { WorkUnitId } from '../../work-unit/client/types.js';
import type { OffscreenClient } from '../offscreen-client.js';
import type { AgentEvent, ChatMessage } from '../types.js';
import type { WelcomeInterceptHolder } from './wc-live-controller.js';

export type WcChatRecord = Pick<RegisteredScoop, 'thinking' | 'config'>;

export interface WcChatHost {
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;

  sendSprinkleLick(
    name: string,
    body: unknown,
    targetScoop?: string,
    originUnitId?: WorkUnitId
  ): void;

  sendToolUiAction(requestId: string, action: string, data: unknown): void;

  deleteQueuedMessage(unitId: WorkUnitId, messageId: string): Promise<void>;

  emitAgentError(error: string): void;

  getRecord?(id: WorkUnitId): WcChatRecord | undefined;

  addressableUnitId?(): WorkUnitId | null;

  speaksReplies?: boolean;

  takeAttachments?(): ChatMessage['attachments'] | undefined;

  onTurnIdle?(): void;

  onMessageRendered?(messageHost: HTMLElement): void;

  onSnapshotRendered?(messages: readonly ChatMessage[]): void;

  onSelectionApplied?(): void;

  ownsModelPill?: boolean;

  welcome?: WelcomeInterceptHolder;

  readOnlyToolUi?: boolean;
}

export interface LeaderChatHost extends WcChatHost {
  setAttachmentSource(take: () => ChatMessage['attachments'] | undefined): void;

  setTurnIdleHook(hook: () => void): void;
}

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
    sendSprinkleLick: (name, body, targetScoop, originUnitId) =>
      client.sendSprinkleLick(
        name,
        body,
        targetScoop,
        originUnitId ? { unitJid: originUnitId } : undefined
      ),
    sendToolUiAction: (requestId, action, data) => client.sendToolUiAction(requestId, action, data),
    deleteQueuedMessage: (unitId, messageId) => client.deleteQueuedMessage(unitId, messageId),
    emitAgentError: (error) => client.emitAgentError(error),

    getRecord: (id) => client.getScoops().find((scoop) => scoop.jid === id),
    speaksReplies: true,
    takeAttachments: () => takeAttachments?.(),
    onTurnIdle: () => turnIdle?.(),

    welcome: { intercept: null },
    setAttachmentSource: (take) => {
      takeAttachments = take;
    },
    setTurnIdleHook: (hook) => {
      turnIdle = hook;
    },
  };
}

export const DETACHED_CHAT_HOST: WcChatHost = {
  onAgentEvent: () => () => undefined,
  sendSprinkleLick: () => undefined,
  sendToolUiAction: () => undefined,
  deleteQueuedMessage: () => Promise.resolve(),
  emitAgentError: () => undefined,
};

export const FOLLOWER_QUEUE_CANCEL_UNSUPPORTED =
  'A follower cannot cancel the leader’s queued message';

export function createFollowerChatHost(deps: {
  getSync(): {
    sendSprinkleLick(name: string, body: unknown, targetScoop?: string): void;
  } | null;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;

  onAgentError(error: string): void;
}): WcChatHost {
  return {
    onAgentEvent: deps.onAgentEvent,

    sendSprinkleLick: (name, body, targetScoop) =>
      deps.getSync()?.sendSprinkleLick(name, body, targetScoop),

    sendToolUiAction: () => undefined,
    deleteQueuedMessage: () => Promise.reject(new Error(FOLLOWER_QUEUE_CANCEL_UNSUPPORTED)),

    emitAgentError: deps.onAgentError,
    readOnlyToolUi: true,
  };
}
