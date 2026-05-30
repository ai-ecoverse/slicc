/**
 * @slicc/cherry — embed a SLICC follower in an iframe on a host page and lend
 * the host page to a remote cloud-cone leader as a driveable CDP target.
 */

import { mountSliccImpl } from './mount.js';

export interface HostCapabilities {
  /** Allow the leader to navigate the host page top-level frame. */
  navigate: boolean;
  /** Screenshot strategy. 'html2canvas' lazy-loads the lib; 'none' disables. */
  screenshot: 'html2canvas' | 'none';
  /** Allow the leader to request opening URLs in new host tabs/windows. */
  openUrl: boolean;
}

export interface HostHooks {
  /** Called when the follower asks the host to open a URL (openUrl capability). */
  onOpenUrl?: (url: string) => void;
  /** Called for slicc.event envelopes the host opts to observe (telemetry). */
  onSliccEvent?: (name: string, detail: unknown) => void;
  /** Gate each synthetic CDP domain the leader tries to use. Return false to deny. */
  onPermissionRequest?: (domain: string) => boolean | Promise<boolean>;
}

export interface MountSliccOptions {
  /** Element the follower iframe is appended to. Required. */
  container: HTMLElement;
  /** Origin serving the worker-hosted webapp, e.g. https://app.sliccy.ai */
  sliccOrigin: string;
  /** Capabilities the host lends to the leader. */
  capabilities: HostCapabilities;
  /** Optional host-side hooks. */
  hooks?: HostHooks;
  /**
   * IMS bearer forwarded into the iframe over the handshake for same-origin
   * /api/cloud provisioning. Browser-resident only; never forwarded to
   * third-party or E2B. The SDK does NOT call /api/cloud itself — the iframe
   * (same-origin with the worker) does (`main-cherry.ts:resolveCherryJoinUrl`).
   */
  imsToken?: string;
  /** Target cone name to resume/start during iframe-side provisioning. */
  coneName?: string;
  /** When true and no matching cone exists, the iframe starts a new one. */
  createIfMissing?: boolean;
  /** Existing tray/session join URL to use, bypassing provisioning entirely. */
  joinToken?: string;
}

export interface SliccHandle {
  /** The mounted iframe element. */
  iframe: HTMLIFrameElement;
  /** Tear down the channel and remove the iframe. */
  destroy(): void;
}

export function mountSlicc(options: MountSliccOptions): SliccHandle {
  if (!options || !options.container) {
    throw new Error('mountSlicc: options.container is required');
  }
  return mountSliccImpl(options);
}
