/**
 * @ai-ecoverse/cherry — embed a SLICC follower in an iframe on a host page and lend
 * the host page to a remote cloud-cone leader as a driveable CDP target.
 */

import { mountSliccImpl } from './mount.js';
import type { SliccTheme } from './theme-types.js';
import type { ExportSessionOptions } from './transcript-types.js';

export type { SliccTheme, ThemeComponent, ThemeComponents } from './theme-types.js';
export type {
  ExportSessionOptions,
  TranscriptExportErrorCode,
  TranscriptExportProgress,
} from './transcript-types.js';
export { TranscriptExportError } from './transcript-types.js';

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
  /** Show the monitor panel. Default: true. */
  monitor?: boolean;
  /** Show timestamps on chat messages. Default: true. */
  showTimestamps?: boolean;
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
  /**
   * Called at most once per handshake attempt, after a short grace window,
   * when the follower iframe offered ONLY cherry protocol versions this SDK
   * build cannot speak. Never fires when a fallback succeeds: a follower that
   * also offers a version this SDK speaks completes the handshake and cancels
   * the report. When it does fire, the mount will not come up until the older
   * side (this vendored SDK or the SLICC origin) is updated — surface this to
   * telemetry instead of waiting out the handshake timeout.
   */
  onProtocolMismatch?: (peerVersion: number, sdkVersion: number) => void;
}

/** Effort / thinking level the cone should use. Locked — the UI picker is hidden. */
export type EffortLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

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
   * Optional layout to push into the follower in place of its own
   * persisted/default one. Serialized as JSON in the handshake welcome and
   * applied once at boot — static, like `theme`; there is no runtime re-layout.
   *
   * Structurally typed (not imported from `@slicc/webcomponents` — this SDK
   * ships independently), and the follower accepts EITHER shape:
   *
   *  - a **`LayoutDocument`** (has `base`) — the panel system: docked edges, a
   *    recursive `center` tree, and `floating` panels. Every piece of SLICC
   *    chrome is a panel here, so this can place or omit the rails, the scoop
   *    switcher and the runtime bar, not just the workbench.
   *  - a **`DockTreeSpec`** (has `zones`) — the older five-zone model, still
   *    honored so a vendored SDK from before the panel system keeps working.
   *
   * Set `locked: true` — tree-wide, or per panel via
   * `panels: { chat: { locked: true } }` — so the end user cannot drag, resize
   * or close what you pushed. A locked panel renders no move handle at all.
   * Per-panel `movable`/`resizable`/`hideable` allow finer control (e.g. allow
   * resizing but forbid closing).
   *
   * A pushed layout is never persisted client-side: the follower applies it
   * without a filesystem, so it cannot drift and `layout save` inside an embed
   * reports that it needs one rather than writing your arrangement into the
   * user's profile.
   *
   * @example
   * mountSlicc({
   *   layout: {
   *     version: 1,
   *     id: 'embed',
   *     locked: true,
   *     base: {
   *       docks: [{ edge: 'top', size: '36px', panels: ['floatbar'] }],
   *       center: { split: 'row', sizes: [2, 1],
   *                 children: [{ panel: 'chat' }, { panel: 'sprinkle:progress' }] },
   *     },
   *   },
   * });
   */
  layout?: unknown;
  /**
   * Existing tray/session join URL the leader was provisioned with. Required:
   * the host (or its backend) supplies a ready join URL and the follower embeds
   * against it. Cone creation/provisioning from the SDK is not yet supported.
   */
  joinToken: string;
  /**
   * UI-only mode: append `ui-only=1` AFTER `cherry=1` to the follower URL so the
   * follower renders chat/UI but advertises no CDP target. MUST stay after
   * `cherry=1` (the `?cherry=1` prefix is enforced by the worker CSP frame-ancestors).
   */
  uiOnly?: boolean;
  /**
   * Lock the cone's reasoning effort level. When set, the thinking-level picker
   * is hidden and the cone uses this level for all turns. The embedder controls
   * cost/quality tradeoff; the end user cannot override it.
   */
  effortLevel?: EffortLevel;
  /**
   * Feature-flag overrides to apply for this embed, e.g.
   * `{ 'panel-layouts': 'on' }`. Serialized as JSON in the handshake welcome
   * and applied once at boot — session-only, like `theme`/`layout`; never
   * persisted to the follower's localStorage.
   *
   * Only takes effect for flags the follower's registry marks
   * `userToggleable` and allows for the `cherry` float — the same gate a
   * local end-user override must pass. An embedder is not a trusted operator
   * of the SLICC deployment it's pointed at, so it cannot flip a flag nobody
   * decided was safe for outside control; an id that fails the gate (or isn't
   * recognized) is silently dropped rather than applied partially.
   *
   * `panel-layouts` is the flag this exists for today: it ships `off` by
   * default and, inside a Cherry embed, the "Experimental features…" dialog
   * that would otherwise let a user flip it is itself hidden (Cherry sets
   * `experimental-settings: off`) — so pushing it here is the only way to
   * turn panels on for an embed without changing the target deployment's
   * worker-level `FEATURE_FLAGS`. See `docs/layouts.md`.
   *
   * @example
   * mountSlicc({ flags: { 'panel-layouts': 'on' }, layout: { ... } });
   */
  flags?: Record<string, string>;
}

export interface SliccHandle {
  /** The mounted iframe element. */
  iframe: HTMLIFrameElement;
  /**
   * Emit a host-originated event up to the remote leader (delivered as a
   * `cherry` lick). No-ops with a warning if the handshake has not completed.
   */
  emitHostEvent(name: string, detail?: unknown): void;
  /**
   * Request a leader-approved transcript export from the embedded follower.
   *
   * Resolves with a verified `application/zip` Blob. Rejects with
   * `TranscriptExportError` on denial, abort, or corruption. Requires the
   * handshake to have completed; calling before handshake rejects immediately.
   */
  exportSession(options?: ExportSessionOptions): Promise<Blob>;
  /** Tear down the channel, reject all pending exports, and remove the iframe. */
  destroy(): void;
}

export function mountSlicc(options: MountSliccOptions): SliccHandle {
  if (!options?.container && !options?.iframe) {
    throw new Error('mountSlicc: either options.container or options.iframe is required');
  }
  return mountSliccImpl(options);
}
