export type TrayBootstrapState = 'pending' | 'offered' | 'connected' | 'failed';

export interface TraySessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface TrayIceCandidate {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface TrayBootstrapFailure {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
  failedAt: string;
}

export type TrayBootstrapEvent =
  | {
      sequence: number;
      sentAt: string;
      type: 'bootstrap.offer';
      offer: TraySessionDescription;
    }
  | {
      sequence: number;
      sentAt: string;
      type: 'bootstrap.ice_candidate';
      candidate: TrayIceCandidate;
    }
  | {
      sequence: number;
      sentAt: string;
      type: 'bootstrap.failed';
      failure: TrayBootstrapFailure;
    };

export interface TrayBootstrapStatus {
  controllerId: string;
  bootstrapId: string;
  attempt: number;
  state: TrayBootstrapState;
  expiresAt: string;
  cursor: number;
  maxRetries: number;
  retriesRemaining: number;
  retryAfterMs: number | null;
  failure: TrayBootstrapFailure | null;
}

export interface TurnIceServer {
  urls: string[];
  username: string;
  credential: string;
}

export interface FollowerJoinRequestedMessage {
  type: 'follower.join_requested';
  trayId: string;
  controllerId: string;
  runtime?: string;
  bootstrapId: string;
  attempt: number;
  expiresAt: string;
  iceServers?: TurnIceServer[];
}

export interface BootstrapAnswerMessage {
  type: 'bootstrap.answer';
  trayId: string;
  controllerId: string;
  bootstrapId: string;
  answer: TraySessionDescription;
}

export interface BootstrapIceCandidateMessage {
  type: 'bootstrap.ice_candidate';
  trayId: string;
  controllerId: string;
  bootstrapId: string;
  candidate: TrayIceCandidate;
}

export interface WebhookEventMessage {
  type: 'webhook.event';
  webhookId: string;
  headers: Record<string, string>;
  body: unknown;
  timestamp: string;
}

export type WorkerToLeaderControlMessage =
  | {
      type: 'leader.connected';
      trayId: string;
      controllerId: string;
    }
  | {
      type: 'pong';
      trayId: string;
    }
  | FollowerJoinRequestedMessage
  | BootstrapAnswerMessage
  | BootstrapIceCandidateMessage
  | WebhookEventMessage;

export interface LeaderBootstrapOfferMessage {
  type: 'bootstrap.offer';
  controllerId: string;
  bootstrapId: string;
  offer: TraySessionDescription;
}

export interface LeaderBootstrapIceCandidateMessage {
  type: 'bootstrap.ice_candidate';
  controllerId: string;
  bootstrapId: string;
  candidate: TrayIceCandidate;
}

export interface LeaderBootstrapFailedMessage {
  type: 'bootstrap.failed';
  controllerId: string;
  bootstrapId: string;
  code: string;
  message: string;
  retryable?: boolean;
  retryAfterMs?: number | null;
}

export type LeaderToWorkerControlMessage =
  | { type: 'ping' }
  | LeaderBootstrapOfferMessage
  | LeaderBootstrapIceCandidateMessage
  | LeaderBootstrapFailedMessage;

export interface TrayLeaderSummary {
  controllerId: string;
  connected: boolean;
  reconnectDeadline: string | null;
}

export interface FollowerJoinRequest {
  controllerId?: string;
  runtime?: string;
}

export type FollowerAttachResult =
  | {
      action: 'wait';
      code: 'LEADER_NOT_ELECTED' | 'LEADER_NOT_CONNECTED';
      retryAfterMs: number;
    }
  | {
      action: 'signal';
      code: 'LEADER_CONNECTED';
      bootstrap: TrayBootstrapStatus;
    }
  | {
      action: 'fail';
      code: 'INVALID_JOIN_CAPABILITY' | 'TRAY_EXPIRED';
      error: string;
    };

export interface FollowerAttachResponse {
  trayId: string;
  controllerId: string;
  role: 'follower';
  leader: TrayLeaderSummary | null;
  participantCount: number;
  result: FollowerAttachResult;
  iceServers?: TurnIceServer[];
}

export interface FollowerBootstrapResponse {
  trayId: string;
  controllerId: string;
  role: 'follower';
  leader: TrayLeaderSummary | null;
  participantCount: number;
  bootstrap: TrayBootstrapStatus;
  events: TrayBootstrapEvent[];
  iceServers?: TurnIceServer[];
}