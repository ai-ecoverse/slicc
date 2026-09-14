import type { CDPPayload } from '@slicc/shared-ts';

import type { CDPConnectOptions, CDPEventListener, ConnectionState } from './types.js';

export type CDPStateListener = (state: ConnectionState, reason?: string) => void;

export interface CDPTransport {
  connect(options?: CDPConnectOptions): Promise<void>;

  disconnect(): void;

  send(
    method: string,
    params?: CDPPayload,
    sessionId?: string,
    timeout?: number
  ): Promise<CDPPayload>;

  on(event: string, listener: CDPEventListener): void;

  off(event: string, listener: CDPEventListener): void;

  once(event: string, timeout?: number): Promise<CDPPayload>;

  readonly state: ConnectionState;

  onStateChange?(listener: CDPStateListener): () => void;

  readonly superseded?: boolean;

  readonly isExtensionBridge?: boolean;
}
