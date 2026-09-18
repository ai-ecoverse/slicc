/**
 * Chrome DevTools Protocol message types.
 */

import type { CDPPayload } from '@slicc/shared-ts';

// TargetInfo moved to @slicc/shared-ts (#2276 slice E) — the chrome extension
// needs it too. Re-exported here so no webapp-internal import path changes.
export type { TargetInfo } from '@slicc/shared-ts';

/** Outgoing CDP command message. */
export interface CDPCommand {
  id: number;
  method: string;
  /** Per-method CDP params; shape is known only to the caller that issued the method. */
  params?: CDPPayload;
  sessionId?: string;
}

/** Incoming CDP response for a command. */
export interface CDPResponse {
  id: number;
  /** Per-method CDP result; shape is known only to the caller that issued the method. */
  result?: CDPPayload;
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
  /** Per-method CDP event params; shape depends on `method`. */
  params?: CDPPayload;
  sessionId?: string;
}

/** A raw CDP message (response or event). */
export type CDPMessage = CDPResponse | CDPEvent;

/** Connection state of the CDP client. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/** Listener callback for CDP events. */
export type CDPEventListener = (params: CDPPayload) => void;

/** Page info exposed by the high-level API. */
export interface PageInfo {
  targetId: string;
  title: string;
  url: string;
  /** True if this is the user's currently active/focused tab (extension mode only). */
  active?: boolean;
  /** Distinguishes a real browser page from a cooperative cherry host page. */
  kind?: 'browser' | 'cherry' | 'preview';
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

/** Options for evaluating within a frame. */
export interface FrameEvaluateOptions extends EvaluateOptions {
  /** Execution world to use. Default: isolated. */
  world?: 'isolated' | 'main';
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

/**
 * Browser window state shared by CDP `Browser.Bounds.windowState` and
 * `chrome.windows` `state`. `minimized` / `maximized` / `fullscreen` cannot
 * be combined with geometry (left/top/width/height) on either backend.
 */
export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

/**
 * Frame geometry for a browser window. Units are **frame** DIP pixels
 * (including chrome), matching CDP `Target.createTarget` / `Browser.Bounds`
 * and `chrome.windows.create` — not the content-area sizes `window.open`
 * accepts.
 */
export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
  state: WindowState;
}

/** Partial frame geometry accepted by `setWindowBounds` / `openWindow`. */
export interface WindowBoundsInput {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  state?: WindowState;
}

/**
 * Options for {@link BrowserAPI.openWindow}. Opens a sized (and by default
 * decorated) window in one call — the combination page-context `window.open`
 * cannot obtain.
 */
export interface OpenWindowOptions {
  width?: number;
  height?: number;
  left?: number;
  top?: number;
  state?: WindowState;
  /**
   * Prefer a fully decorated window (`true`, default) vs minimal-chrome popup
   * (`false`). Extension maps this to `chrome.windows` `type` `normal`|`popup`.
   * CDP `Target.createTarget` with `newWindow` always yields a decorated
   * window — `false` is a no-op there.
   */
  decorated?: boolean;
  /** Focus the new window. Default `true`. */
  focus?: boolean;
}

/** Achieved frame bounds plus device pixel ratio (for capture sizing). */
export interface WindowBoundsInfo extends WindowBounds {
  dpr: number;
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
