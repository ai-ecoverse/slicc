/**
 * Kernel facade types.
 *
 * The kernel is the agent engine: Orchestrator + scoops + WasmShell pool +
 * VirtualFS + BrowserAPI + ProcessManager. It lives in a DedicatedWorker
 * in standalone and inside the offscreen document in the extension; the
 * UI is a thin client over a typed RPC.
 *
 * This module declares the typed surface that contract has to satisfy.
 * `OffscreenBridge` implements `KernelFacade`; `OffscreenClient` implements
 * `KernelClientFacade`; the wire is a `KernelTransport` with two adapters
 * (`transport-chrome-runtime.ts` and `transport-message-channel.ts`).
 *
 * Method shapes deliberately match `OffscreenBridge` / `OffscreenClient`
 * 1:1. Names that read a bit oddly today (`registerScoop` for cone
 * bootstrap; `stopScoop` for cooperative abort) stay as-is.
 */

import type {
  AgentEventMsg,
  ErrorMsg,
  IncomingMessageMsg,
  PanelToOffscreenMessage,
  OffscreenToPanelMessage,
  ScoopCreatedMsg,
  ScoopListMsg,
  ScoopMessagesReplacedMsg,
  ScoopStatusMsg,
  StateSnapshotMsg,
  TrayFollowerStatusSnapshot,
  TrayLeaderStatusSnapshot,
  TrayRuntimeStatusMsg,
  ExtensionThinkingLevel,
} from '../../../chrome-extension/src/messages.js';
import type { ChatMessage, AgentHandle, AgentEvent as UIAgentEvent } from '../ui/types.js';
import type { FollowerSyncManager } from '../scoops/tray-follower-sync.js';
import type { Orchestrator } from '../scoops/orchestrator.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { RegisteredScoop, ThinkingLevel } from '../scoops/types.js';
import type { VirtualFS } from '../fs/index.js';

// ---------------------------------------------------------------------------
// 1. Wire — generic over today's panel/host message shapes.
//
// `KernelTransport` lives in `./transport.ts` so it can be imported by
// worker-side code without dragging in the webapp-orchestrator graph.
// We re-export it here, defaulted to the `ExtensionMessage` shapes,
// so existing imports keep working.
// ---------------------------------------------------------------------------

import type { KernelTransport as KernelTransportBase } from './transport.js';
export type { KernelTransport as KernelTransportRaw } from './transport.js';

/**
 * `In` is instantiated as the raw `ExtensionMessage` envelope on both
 * sides so the bridge can keep its source-filter and
 * sprinkle-op-response peek logic. The defaults here are convenience
 * for callers that don't override them.
 */
export type KernelTransport<
  In = PanelToOffscreenMessage,
  Out = OffscreenToPanelMessage,
> = KernelTransportBase<In, Out>;

// ---------------------------------------------------------------------------
// 2. Host surface — `OffscreenBridge` implements this.
//
// Method shapes mirror `OffscreenBridge` 1:1.
// ---------------------------------------------------------------------------

/** Follower-side AgentEvent shape that the bridge bridges into `agent-event`. */
export type FollowerAgentEvent = UIAgentEvent;

/**
 * Host-side facade. The kernel is on this side; the panel is on the other.
 * The transport is constructed at the top of `bind()` inside the bridge.
 */
export interface KernelFacade {
  /**
   * Bind the host to an orchestrator and (optionally) a BrowserAPI for CDP
   * forwarding. After `bind()` returns, the host has constructed its
   * `KernelTransport`, is actively listening on it, and can emit events.
   */
  bind(orchestrator: Orchestrator, browserAPI?: BrowserAPI): Promise<void>;

  /** Today's `state-snapshot` payload (`StateSnapshotMsg`). */
  buildStateSnapshot(): StateSnapshotMsg;

  /**
   * Fire a `tray-runtime-status` event built from the current
   * leader/follower snapshots. Triggered by tray-runtime status
   * subscriptions in `offscreen.ts:90-91` today.
   */
  emitTrayRuntimeStatus(): void;

  /**
   * Install or remove the follower sync manager. The host plumbs follower
   * snapshots/messages/statuses through this once installed.
   */
  setFollowerSync(sync: FollowerSyncManager | null): void;

  /** Apply a follower-leader snapshot to a scoop's chat history. */
  applyFollowerSnapshot(messages: ChatMessage[]): void;

  /**
   * Emit a single follower agent event into the existing per-scoop
   * `agent-event` stream. Today's bridge takes a `UIAgentEvent` directly.
   */
  emitFollowerAgentEvent(event: FollowerAgentEvent): void;

  /** Push a follower-originated user message into the scoop's chat history. */
  emitFollowerIncomingMessage(messageId: string, text: string): void;

  /** Mirror a follower-originated scoop status into the panel. */
  emitFollowerStatus(scoopStatus: string): void;

  /** Today's helper used by tray-leader to know which scoop is the cone. */
  getConeJid(): string | null;
}

// ---------------------------------------------------------------------------
// 3. Panel surface — `OffscreenClient` implements this.
//
// Method shapes mirror `OffscreenClient` 1:1 — including the
// orchestrator-compat shim (`registerScoop`, `unregisterScoop`,
// `stopScoop`) that panels use today.
// ---------------------------------------------------------------------------

/**
 * Callback bag the panel hands to the client at construction time. Mirrors
 * today's `OffscreenClientCallbacks` shape — see
 * `packages/webapp/src/ui/offscreen-client.ts:37-54`.
 */
export interface KernelClientCallbacks {
  onStatusChange: (scoopJid: string, status: ScoopStatusMsg['status']) => void;
  onScoopCreated: (scoop: RegisteredScoop) => void;
  onScoopListUpdate: (scoops: ScoopListMsg['scoops']) => void;
  onIncomingMessage: (scoopJid: string, message: IncomingMessageMsg['message']) => void;
  onScoopMessagesReplaced?: (
    scoopJid: string,
    messages: ScoopMessagesReplacedMsg['messages']
  ) => void;
  onReady?: () => void;
}

/**
 * Panel-side facade. Method shapes mirror today's `OffscreenClient` 1:1.
 *
 * The surface is broader than just RPC: the offscreen client is also the
 * orchestrator-compat shim for the scoops panel, memory panel, and chat
 * panel.
 */
export interface KernelClientFacade {
  // -------------------------------------------------------------------------
  // Selected-scoop state
  // -------------------------------------------------------------------------
  selectedScoopJid: string | null;

  // -------------------------------------------------------------------------
  // Local FS handle (read-only mirror — same IndexedDB, no mounts)
  // -------------------------------------------------------------------------
  setLocalFS(fs: VirtualFS): void;

  // -------------------------------------------------------------------------
  // Chat panel handle
  // -------------------------------------------------------------------------
  createAgentHandle(): AgentHandle;

  // -------------------------------------------------------------------------
  // Scoop registry shim
  // -------------------------------------------------------------------------
  getScoops(): RegisteredScoop[];
  getScoop(jid: string): RegisteredScoop | undefined;
  isProcessing(jid: string): boolean;
  registerScoop(scoop: RegisteredScoop): Promise<void>;
  unregisterScoop(jid: string): Promise<void>;
  createScoopTab(jid: string): void;
  stopScoop(jid: string): void;
  clearQueuedMessages(jid: string): Promise<void>;
  deleteQueuedMessage(jid: string, messageId: string): Promise<void>;

  // -------------------------------------------------------------------------
  // Memory & shared FS shim
  // -------------------------------------------------------------------------
  getGlobalMemory(): Promise<string>;
  getScoopContext(jid: string): { getFS: () => VirtualFS | null } | undefined;
  getSharedFS(): VirtualFS | null;

  // -------------------------------------------------------------------------
  // RPC operations
  // -------------------------------------------------------------------------
  updateModel(): void;
  setScoopThinkingLevel(jid: string, level: ThinkingLevel | undefined): void;
  /**
   * Cone-only chat clear, used by the "New session" flow. Resolves only
   * after the host has acknowledged the clear so the panel can safely
   * `location.reload()` without racing the offscreen agent context (in
   * extension mode the offscreen document survives the panel reload).
   */
  clearAllMessages(): Promise<void>;
  clearFilesystem(): void;
  requestState(): void;
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void;
  setSprinkleOpHandler(handler: (payload: unknown) => void): void;

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------
  isReady(): boolean;
}

// ---------------------------------------------------------------------------
// 4. Tray runtime payload re-exports — so consumers can depend on the
// kernel module instead of reaching into `chrome-extension/src/messages.ts`
// directly.
// ---------------------------------------------------------------------------

export type {
  TrayLeaderStatusSnapshot,
  TrayFollowerStatusSnapshot,
  TrayRuntimeStatusMsg,
  AgentEventMsg,
  StateSnapshotMsg,
  ScoopListMsg,
  ScoopCreatedMsg,
  IncomingMessageMsg,
  ScoopStatusMsg,
  ScoopMessagesReplacedMsg,
  ErrorMsg,
  PanelToOffscreenMessage,
  OffscreenToPanelMessage,
  ExtensionThinkingLevel,
};
