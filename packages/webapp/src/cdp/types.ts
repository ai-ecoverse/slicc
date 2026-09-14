import type { CDPPayload } from '@slicc/shared-ts';

export type { TargetInfo } from '@slicc/shared-ts';

export interface CDPCommand {
  id: number;
  method: string;

  params?: CDPPayload;
  sessionId?: string;
}

export interface CDPResponse {
  id: number;

  result?: CDPPayload;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
  sessionId?: string;
}

export interface CDPEvent {
  method: string;

  params?: CDPPayload;
  sessionId?: string;
}

export type CDPMessage = CDPResponse | CDPEvent;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export type CDPEventListener = (params: CDPPayload) => void;

export interface PageInfo {
  targetId: string;
  title: string;
  url: string;

  active?: boolean;

  kind?: 'browser' | 'cherry' | 'preview';

  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}

export interface CDPConnectOptions {
  url: string;

  timeout?: number;

  protocols?: string | string[];
}

export interface EvaluateOptions {
  awaitPromise?: boolean;

  returnByValue?: boolean;
}

export interface FrameEvaluateOptions extends EvaluateOptions {
  world?: 'isolated' | 'main';
}

export interface WaitForSelectorOptions {
  timeout?: number;

  interval?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameInfo {
  frameId: string;
  parentFrameId?: string;
  url: string;
  name: string;
  securityOrigin?: string;
}

export interface AccessibilityNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];

  backendNodeId?: number;
}
