import type { BrowserAPI } from '../cdp/browser-api.js';
import type { AgentHandle, AgentEvent as UIAgentEvent } from '../core/agent-types.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../scoops/agent-bridge.js';
import type { ChatMessage } from '../scoops/chat-types.js';
import type { Orchestrator } from '../scoops/orchestrator.js';
import type { FollowerSyncManager } from '../scoops/tray-follower-sync.js';
import type { RegisteredScoop, ThinkingLevel } from '../scoops/types.js';
import type { LocalVfsClient } from './local-vfs-client.js';
import type {
  AgentEventMsg,
  ErrorMsg,
  ExtensionThinkingLevel,
  IncomingMessageMsg,
  LickBackpressureMsg,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
  ScoopCreatedMsg,
  ScoopListMsg,
  ScoopMessagesReplacedMsg,
  ScoopStatusMsg,
  SprinkleLickOrigin,
  StateSnapshotMsg,
  TrayFollowerStatusSnapshot,
  TrayLeaderStatusSnapshot,
  TrayRuntimeStatusMsg,
} from './messages.js';

import type { KernelTransport as KernelTransportBase } from './transport.js';

export type { KernelTransport as KernelTransportRaw } from './transport.js';

export type KernelTransport<
  In = PanelToOffscreenMessage,
  Out = OffscreenToPanelMessage,
> = KernelTransportBase<In, Out>;

export type FollowerAgentEvent = UIAgentEvent;

export interface KernelFacade {
  bind(orchestrator: Orchestrator, browserAPI?: BrowserAPI): Promise<void>;

  buildStateSnapshot(): StateSnapshotMsg;

  emitTrayRuntimeStatus(): void;

  setFollowerSync(sync: FollowerSyncManager | null): void;

  applyFollowerSnapshot(messages: ChatMessage[]): void;

  emitFollowerAgentEvent(event: FollowerAgentEvent): void;

  emitFollowerIncomingMessage(messageId: string, text: string): void;

  emitFollowerStatus(scoopStatus: string): void;

  getConeJid(): string | null;

  hydrateBuffersFromRecords(): Promise<void>;

  publishHydratedTranscripts(): void;
}

export interface KernelClientCallbacks {
  onStatusChange: (scoopJid: string, status: ScoopStatusMsg['status']) => void;
  onScoopCreated: (scoop: RegisteredScoop) => void;
  onScoopListUpdate: (scoops: ScoopListMsg['scoops']) => void;
  onIncomingMessage: (scoopJid: string, message: IncomingMessageMsg['message']) => void;
  onMessageUpdate?: (
    scoopJid: string,
    update: {
      messageId: string;
      lickId?: string;
      lickState?: 'pending' | 'confirmed' | 'dismissed';
    }
  ) => void;
  onScoopMessagesReplaced?: (
    scoopJid: string,
    messages: ScoopMessagesReplacedMsg['messages'],

    queuedIds?: string[]
  ) => void;
  onReady?: () => void;
}

export interface KernelClientFacade {
  readonly selectedScoopJid: string | null;
  setSelectedScoopJid(jid: string | null): void;

  onScoopSelected(handler: (jid: string) => void): () => void;

  setLocalFS(fs: LocalVfsClient): void;

  createAgentHandle(): AgentHandle;

  getScoops(): RegisteredScoop[];
  getScoop(jid: string): RegisteredScoop | undefined;
  isProcessing(jid: string): boolean;

  registerScoop(
    scoop: RegisteredScoop,
    options?: { description?: string; prompt?: string }
  ): Promise<void>;
  unregisterScoop(jid: string): Promise<void>;
  createScoopTab(jid: string): void;
  stopScoop(jid: string): void;
  clearQueuedMessages(jid: string): Promise<void>;
  deleteQueuedMessage(jid: string, messageId: string): Promise<void>;

  getGlobalMemory(): Promise<string>;
  getScoopContext(jid: string): { getFS: () => LocalVfsClient | null } | undefined;
  getSharedFS(): LocalVfsClient | null;

  updateModel(): void;
  setScoopThinkingLevel(
    jid: string,
    level: ThinkingLevel | undefined,
    effortOverride?: string
  ): void;

  clearAllMessages(scoopJid?: string, options?: { discardLiveSnapshot?: boolean }): Promise<void>;
  spawnAgent(options: AgentSpawnOptions): Promise<AgentSpawnResult>;
  clearFilesystem(): void;
  requestState(): void;
  sendSprinkleLick(
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    origin?: SprinkleLickOrigin
  ): void;
  setSprinkleOpHandler(handler: (payload: unknown) => void): void;

  isReady(): boolean;
}

export type {
  AgentEventMsg,
  ErrorMsg,
  ExtensionThinkingLevel,
  IncomingMessageMsg,
  LickBackpressureMsg,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
  ScoopCreatedMsg,
  ScoopListMsg,
  ScoopMessagesReplacedMsg,
  ScoopStatusMsg,
  SprinkleLickOrigin,
  StateSnapshotMsg,
  TrayFollowerStatusSnapshot,
  TrayLeaderStatusSnapshot,
  TrayRuntimeStatusMsg,
};
