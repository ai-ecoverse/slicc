/**
 * @ai-ecoverse/cherry — embed a SLICC follower in an iframe on a host page and lend
 * the host page to a remote cloud-cone leader as a driveable CDP target.
 */

import { mountSliccImpl } from './mount.js';
import type { SliccTheme } from './theme-types.js';

export type { SliccTheme, ThemeComponent, ThemeComponents } from './theme-types.js';

export interface HostCapabilities {
  /** Allow the leader to navigate the host page top-level frame. */
  navigate: boolean;
  /**
   * Screenshot strategy. `'html2canvas'` lazy-loads the renderer (the
   * maintained `html2canvas-pro` fork, for CSS Color 4 support); `'none'`
   * disables screenshots.
   */
  screenshot: 'html2canvas' | 'none';
  /** Allow the leader to request opening URLs in new host tabs/windows. */
  openUrl: boolean;
}

export interface CherryFeatures {
  /** Show the terminal panel. Default: true. */
  terminal?: boolean;
  /** Show the files panel. Default: true. */
  files?: boolean;
  /** Show the memory panel. Default: true. */
  memory?: boolean;
  /** Show the browser CDP panel. Default: true. */
  browser?: boolean;
  /** Show the model/thinking picker in the composer footer. Default: true. */
  modelPicker?: boolean;
  /** Show the session history rail (past sessions + new chat). Default: true. */
  history?: boolean;
  /** Show the top navigation bar (scoop switcher + floatbar). Default: true. */
  nav?: boolean;
  /** Show the "new sprinkle" launcher in the dock. Default: true. */
  newSprinkle?: boolean;
  /** Show the monitor panel. Default: true. */
  monitor?: boolean;
}

export interface HostHooks {
  /** Called when the follower asks the host to open a URL (openUrl capability). */
  onOpenUrl?: (url: string) => void;
  /** Called for slicc.event envelopes the host opts to observe (telemetry). */
  onSliccEvent?: (name: string, detail: unknown) => void;
  /** Gate each synthetic CDP domain the leader tries to use. Return false to deny. */
  onPermissionRequest?: (domain: string) => boolean | Promise<boolean>;
  /** Called once the Cherry postMessage handshake completes (welcome sent to follower). */
  onHandshakeComplete?: () => void;
}

export interface MountSliccOptions {
  /** Element the follower iframe is appended to. Optional when `iframe` is provided. */
  container?: HTMLElement;
  /**
   * Caller-provided iframe to drive instead of creating one. When set, the SDK
   * uses this element (already placed in the DOM by the caller) and does not
   * create or append an iframe. Used by the extension's managed-launcher sidebar.
   */
  iframe?: HTMLIFrameElement;
  /** Origin serving the worker-hosted webapp, e.g. https://app.sliccy.ai */
  sliccOrigin: string;
  /** Capabilities the host lends to the leader. */
  capabilities: HostCapabilities;
  /** Optional host-side hooks. */
  hooks?: HostHooks;
  /** UI feature toggles. Omit for all panels visible. */
  features?: CherryFeatures;
  /**
   * Optional theme to apply inside the follower. Serialized as JSON in the
   * handshake welcome so the follower can apply it without a round-trip.
   */
  theme?: SliccTheme;
  /**
   * Existing tray/session join URL the leader was provisioned with. Required:
   * the host (or its backend) supplies a ready join URL and the follower embeds
   * against it. Cone creation/provisioning from the SDK is not yet supported.
   */
  joinToken: string;
  /**
   * UI-only mode: append `ui-only=1` AFTER `cherry=1` to the follower URL so the
   * follower renders chat/UI but advertises no CDP target. MUST stay after
   * `cherry=1` (the DNR frame-ancestors relaxation matches the `?cherry=1` prefix).
   */
  uiOnly?: boolean;
}

export interface SliccHandle {
  /** The mounted iframe element. */
  iframe: HTMLIFrameElement;
  /**
   * Emit a host-originated event up to the remote leader (delivered as a
   * `cherry` lick). No-ops with a warning if the handshake has not completed.
   */
  emitHostEvent(name: string, detail?: unknown): void;
  /** Tear down the channel and remove the iframe. */
  destroy(): void;
}

export function mountSlicc(options: MountSliccOptions): SliccHandle {
  if (!options?.container && !options?.iframe) {
    throw new Error('mountSlicc: either options.container or options.iframe is required');
  }
  return mountSliccImpl(options);
}
