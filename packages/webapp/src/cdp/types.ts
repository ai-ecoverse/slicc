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
  /** Distinguishes a real browser page from a cooperative cherry host page. */
  kind?: 'browser' | 'cherry';
  /**
   * Only present for kind === 'cherry'. What the host page lends to the leader,
   * expressed in the vocabulary this tray/teleport layer cares about: `network`
   * gates whether the target may serve `Network.*` CDP for teleport-pool
   * selection. NOTE: intentionally a DIFFERENT shape from the SDK handshake
   * `CherryHandshakeHello.capabilities` (`{ navigate; screenshot; openUrl }` in
   * cdp/cherry-host-protocol.ts) — `openUrl` is a sandbox-escape concern at the
   * host SDK boundary, whereas `network` is a teleport-routing concern here.
   * They are mapped, not equal.
   */
  capabilities?: { navigate: boolean; network: boolean; screenshot: boolean };
}

/** Options for connecting the CDP client. */
export interface CDPConnectOptions {
  /** WebSocket URL, e.g. ws://localhost:3000/cdp. */
  url: string;
  /** Timeout for the initial connection in ms. Default: 5000. */
  timeout?: number;
  /**
   * `Sec-WebSocket-Protocol` value(s) offered on the upgrade. Used by the
   * hosted-leader bridge path to pass the per-session token to a local
   * standalone /cdp socket without leaking it via the URL. The server MUST
   * echo back exactly one of these on the 101 (RFC 6455 §1.9) — see
   * `packages/node-server/src/bridge-security.ts` (`BRIDGE_SUBPROTOCOL_PREFIX`).
   */
  protocols?: string | string[];
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

/** Frame info returned by BrowserAPI.getFrameTree(). */
export interface FrameInfo {
  frameId: string;
  parentFrameId?: string;
  url: string;
  name: string;
  securityOrigin?: string;
}

/** Accessibility tree node. */
export interface AccessibilityNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
  /** CDP backend node ID — used to resolve this node back to a DOM element for clicking. */
  backendNodeId?: number;
}
