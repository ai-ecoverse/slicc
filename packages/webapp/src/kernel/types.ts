/**
 * Kernel facade types — Phase 0 / Phase 1.
 *
 * The kernel is the agent engine: Orchestrator + scoops + WasmShell pool +
 * VirtualFS + BrowserAPI + (later) ProcessManager. Today it lives on the
 * page main thread in standalone and inside the offscreen document in the
 * extension. The phased plan (see `docs/kernel/compat-contract.md`) moves it
 * onto a dedicated host context — a DedicatedWorker in standalone, the
 * existing offscreen document in extension — and makes the UI a thin client
 * over a typed RPC.
 *
 * This module declares the typed surface that contract has to satisfy. It is
 * intentionally **generic over today's `ExtensionMessage` shapes**: Phase 1
 * makes the existing `OffscreenBridge` and `OffscreenClient` implement these
 * interfaces with no behavior change, no new envelope, and no new state
 * owner. Later phases add a worker transport (Phase 2), a process model
 * (Phase 3+), and pause/resume + preemption (Phase 6/7) without changing the
 * shape declared here — they extend it.
 *
 * Pairing:
 *  - `KernelFacade` — host surface. `OffscreenBridge` implements this.
 *  - `KernelClientFacade` — panel surface. `OffscreenClient` implements this.
 *  - `KernelTransport` — the wire. Phase 1 has a `chrome.runtime` adapter
 *    (`transport-chrome-runtime.ts`); Phase 2 adds a `MessageChannel`
 *    adapter for the standalone worker.
 *
 * Method shapes deliberately match today's `OffscreenBridge` /
 * `OffscreenClient` 1:1 so Phase 1 is a pure rename + `implements` pass —
 * no method signatures change, no callers need updating. Names that read
 * a bit oddly today (`registerScoop` for cone bootstrap; `stopScoop` for
 * cooperative abort) stay as-is. Renames belong in a later phase.
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
// We re-export it here, defaulted to today's `ExtensionMessage` shapes,
// so existing imports keep working. Phase 2 introduces a
// `transport-message-channel.ts` that imports the leaf module directly.
// ---------------------------------------------------------------------------

import type { KernelTransport as KernelTransportBase } from './transport.js';
export type { KernelTransport as KernelTransportRaw } from './transport.js';

/**
 * Phase 1 instantiates `In` as the raw `ExtensionMessage` envelope on
 * both sides so the bridge can keep its existing source-filter and
 * sprinkle-op-response peek logic without behavior change. The defaults
 * here are convenience for callers that don't override them.
 */
export type KernelTransport<
  In = PanelToOffscreenMessage,
  Out = OffscreenToPanelMessage,
> = KernelTransportBase<In, Out>;

// ---------------------------------------------------------------------------
// 2. Host surface — `OffscreenBridge` implements this in Phase 1.
//
// Method shapes mirror today's `OffscreenBridge` 1:1 so the Phase 1
// extraction is a pure `implements` pass + a transport extraction. New
// methods come in later phases.
// ---------------------------------------------------------------------------

/** Follower-side AgentEvent shape that the bridge bridges into `agent-event`. */
export type FollowerAgentEvent = UIAgentEvent;

/**
 * Host-side facade. The kernel is on this side; the panel is on the other.
 *
 * Phase 1 keeps the existing `bind(orchestrator, browserAPI?)` shape — the
 * transport is constructed at the top of `bind()` inside the bridge. Phase
 * 2 will add a `bind(transport, orchestrator, browserAPI?)` overload when
 * the kernel host factory needs to inject a worker MessageChannel
 * transport instead.
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
// 3. Panel surface — `OffscreenClient` implements this in Phase 1.
//
// Method shapes mirror today's `OffscreenClient` 1:1 — including the
// orchestrator-compat shim (`registerScoop`, `unregisterScoop`,
// `stopScoop`) that panels use today. Renames are out of scope for
// Phase 1.
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
 * panel. Phase 1 keeps that shape; Phase 2 may split the
 * orchestrator-shim parts out into a separate `OrchestratorFacade`.
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
// directly. Phase 2 moves the canonical declaration into this module; for
// Phase 1 we just re-export.
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
