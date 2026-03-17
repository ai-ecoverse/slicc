/**
 * Typed sync protocol for tray WebRTC data channels.
 *
 * Leader → Follower: snapshots of chat state + real-time agent events.
 * Follower → Leader: user input + abort requests.
 */

import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tray-sync');

// ---------------------------------------------------------------------------
// Protocol messages
// ---------------------------------------------------------------------------

export type LeaderToFollowerMessage =
  | { type: 'snapshot'; messages: ChatMessage[]; scoopJid: string }
  | { type: 'agent_event'; event: AgentEvent; scoopJid: string }
  | { type: 'user_message_echo'; text: string; messageId: string; scoopJid: string }
  | { type: 'status'; scoopStatus: string }
  | { type: 'error'; error: string }
  | { type: 'targets.registry'; targets: TrayTargetEntry[] }
  | { type: 'cdp.request'; requestId: string; localTargetId: string; method: string; params?: Record<string, unknown>; sessionId?: string }
  | { type: 'cdp.response'; requestId: string; result?: Record<string, unknown>; error?: string }
  | { type: 'tab.open'; requestId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  | { type: 'fs.request'; requestId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | { type: 'cookie.teleport.request'; requestId: string; url?: string }
  | { type: 'cookie.teleport.response'; requestId: string; cookies?: CookieTeleportCookie[]; error?: string }
  | { type: 'ping' }
  | { type: 'pong' };

export type FollowerToLeaderMessage =
  | { type: 'user_message'; text: string; messageId: string }
  | { type: 'abort' }
  | { type: 'request_snapshot' }
  | { type: 'targets.advertise'; targets: RemoteTargetInfo[]; runtimeId: string }
  | { type: 'cdp.request'; requestId: string; targetRuntimeId: string; localTargetId: string; method: string; params?: Record<string, unknown>; sessionId?: string }
  | { type: 'cdp.response'; requestId: string; result?: Record<string, unknown>; error?: string }
  | { type: 'tab.open'; requestId: string; targetRuntimeId: string; url: string }
  | { type: 'tab.opened'; requestId: string; targetId: string }
  | { type: 'tab.open.error'; requestId: string; error: string }
  | { type: 'fs.request'; requestId: string; targetRuntimeId: string; request: TrayFsRequest }
  | { type: 'fs.response'; requestId: string; response: TrayFsResponse }
  | { type: 'cookie.teleport.request'; requestId: string; targetRuntimeId: string; url?: string }
  | { type: 'cookie.teleport.response'; requestId: string; cookies?: CookieTeleportCookie[]; error?: string }
  | { type: 'ping' }
  | { type: 'pong' };

// ---------------------------------------------------------------------------
// Target advertisement types
// ---------------------------------------------------------------------------

export interface RemoteTargetInfo {
  targetId: string;
  title: string;
  url: string;
}

export interface TrayTargetEntry {
  targetId: string;       // Unique within the tray: "{runtimeId}:{localTargetId}"
  localTargetId: string;  // The original targetId on the owning runtime
  runtimeId: string;      // Which runtime owns this target
  title: string;
  url: string;
  isLocal: boolean;       // True if owned by the receiving runtime (set by consumer, not registry)
}

// ---------------------------------------------------------------------------
// Cookie teleport types
// ---------------------------------------------------------------------------

/** Chrome CDP Network.Cookie shape used for teleporting cookies between runtimes. */
export interface CookieTeleportCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  priority?: 'Low' | 'Medium' | 'High';
  sameParty?: boolean;
  sourceScheme?: 'Unset' | 'NonSecure' | 'Secure';
  sourcePort?: number;
  partitionKey?: string;
}

// ---------------------------------------------------------------------------
// VFS sync protocol types
// ---------------------------------------------------------------------------

/** A single FS operation request sent over the data channel. */
export type TrayFsRequest =
  | { op: 'readFile'; path: string; encoding?: 'utf-8' | 'binary' }
  | { op: 'writeFile'; path: string; content: string; encoding: 'utf-8' | 'base64' }
  | { op: 'stat'; path: string }
  | { op: 'readDir'; path: string }
  | { op: 'mkdir'; path: string; recursive?: boolean }
  | { op: 'rm'; path: string; recursive?: boolean }
  | { op: 'exists'; path: string }
  | { op: 'walk'; path: string };

/** A single FS operation response. Chunked responses use chunkIndex/totalChunks for large file content. */
export type TrayFsResponse =
  | { ok: true; data: TrayFsResponseData; chunkIndex?: number; totalChunks?: number }
  | { ok: false; error: string; code?: string };

/** Possible data payloads for successful FS responses. */
export type TrayFsResponseData =
  | { type: 'file'; content: string; encoding: 'utf-8' | 'base64' }
  | { type: 'stat'; stat: { type: 'file' | 'directory'; size: number; mtime: number; ctime: number } }
  | { type: 'dirEntries'; entries: Array<{ name: string; type: 'file' | 'directory' }> }
  | { type: 'exists'; exists: boolean }
  | { type: 'paths'; paths: string[] }
  | { type: 'void' };

export type TraySyncMessage = LeaderToFollowerMessage | FollowerToLeaderMessage;

// ---------------------------------------------------------------------------
// TraySyncChannel — typed send/receive wrapper around TrayDataChannelLike
// ---------------------------------------------------------------------------

export class TraySyncChannel<
  TSend extends TraySyncMessage = TraySyncMessage,
  TReceive extends TraySyncMessage = TraySyncMessage,
> {
  private readonly listeners: Array<(message: TReceive) => void> = [];
  private closed = false;

  constructor(private readonly channel: TrayDataChannelLike) {
    this.channel.addEventListener('message', (event: { data: string }) => {
      if (this.closed) return;
      try {
        const parsed = JSON.parse(event.data) as TReceive;
        for (const listener of this.listeners) {
          listener(parsed);
        }
      } catch (error) {
        log.warn('Failed to parse tray sync message', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  send(message: TSend): void {
    if (this.closed) return;
    try {
      this.channel.send(JSON.stringify(message));
    } catch (error) {
      log.warn('Failed to send tray sync message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  onMessage(callback: (message: TReceive) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  close(): void {
    this.closed = true;
    this.listeners.length = 0;
    this.channel.close();
  }

  get isOpen(): boolean {
    return !this.closed && this.channel.readyState === 'open';
  }
}

// ---------------------------------------------------------------------------
// Typed factory helpers
// ---------------------------------------------------------------------------

export function createLeaderSyncChannel(
  channel: TrayDataChannelLike,
): TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage> {
  return new TraySyncChannel(channel);
}

export function createFollowerSyncChannel(
  channel: TrayDataChannelLike,
): TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage> {
  return new TraySyncChannel(channel);
}
