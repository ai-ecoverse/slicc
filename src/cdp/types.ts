/**
 * Chrome DevTools Protocol message types.
 */

/** Outgoing CDP command message. */
export interface CDPCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** Incoming CDP response for a command. */
export interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
    data?: string;
  };
  sessionId?: string;
}

/** Incoming CDP event notification. */
export interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** A raw CDP message (response or event). */
export type CDPMessage = CDPResponse | CDPEvent;

/** Connection state of the CDP client. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Listener callback for CDP events. */
export type CDPEventListener = (params: Record<string, unknown>) => void;

/** Target info returned by Target.getTargets. */
export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
  /** True if this is the user's active tab (extension mode only). */
  active?: boolean;
}

/** Page info exposed by the high-level API. */
export interface PageInfo {
  targetId: string;
  title: string;
  url: string;
  /** True if this is the user's currently active/focused tab (extension mode only). */
  active?: boolean;
}

/** Options for connecting the CDP client. */
export interface CDPConnectOptions {
  /** WebSocket URL, e.g. ws://localhost:3000/cdp. */
  url: string;
  /** Timeout for the initial connection in ms. Default: 5000. */
  timeout?: number;
}

/** Options for evaluate(). */
export interface EvaluateOptions {
  /** Whether to await the returned promise. Default: true. */
  awaitPromise?: boolean;
  /** Whether to return the result by value. Default: true. */
  returnByValue?: boolean;
}

/** Options for waitForSelector(). */
export interface WaitForSelectorOptions {
  /** Timeout in ms. Default: 30000. */
  timeout?: number;
  /** Polling interval in ms. Default: 100. */
  interval?: number;
}

/** Bounding box of a DOM element. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Accessibility tree node. */
export interface AccessibilityNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
}
