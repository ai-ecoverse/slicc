/**
 * Panel-RPC: a typed BroadcastChannel bridge that lets DOM-bound shell
 * supplemental commands run from the kernel worker.
 *
 * ## Why
 *
 * In standalone mode the agent's bash tool runs inside a
 * `DedicatedWorker` (`kernel-worker.ts`). Worker globals expose neither
 * `window`/`document` nor the DOM-only halves of `navigator` —
 * `mediaDevices`, `clipboard`, `speechSynthesis`, `AudioContext`. Any
 * supplemental command that touches those APIs directly currently
 * fails with "browser APIs are unavailable" when invoked from the
 * agent.
 *
 * The fix is to keep the DOM operations on the page (which always has
 * a DOM in every float that hosts the webapp) and route requests from
 * the worker over a single channel. This module is the channel.
 *
 * ## Shape
 *
 * - Worker side calls `createPanelRpcClient({ instanceId })` and gets
 *   a thin `{ call(op, payload, opts?) }` surface. Each `call` posts a
 *   request on the BroadcastChannel and resolves with the page-side
 *   result (or rejects with the page-side error / timeout).
 *
 * - Page side calls `installPanelRpcHandler({ handlers, instanceId })`
 *   with a record of per-op handlers, and gets back a disposer. The
 *   handler dispatches incoming requests and posts responses on the
 *   same channel. Unknown ops resolve with a clear error rather than
 *   hanging the worker.
 *
 * Mirrors `sprinkle-bridge-channel.ts` (instance-scoped channel name,
 * UUID request ids). Default timeout is 15s — long enough that the
 * page handler has plenty of room to do real DOM work (capture
 * pipelines, audio decode) without spurious timeouts, but short enough
 * that a hung handler still surfaces. Extension mode does not use
 * this bridge — the offscreen document already has a DOM, so DOM-bound
 * commands run directly there.
 */

import type { OAuthExtraDomainsStore } from '@slicc/shared-ts';
import type { LeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import type { TrayLeaveResult } from '../scoops/tray-leave.js';
import type { SudoDecision, SudoRequest } from '../sudo/types.js';
import type { HidDeviceFilter, HidDeviceInfo } from './hid-device-registry.js';
import type {
  SerialDeviceInfo,
  SerialFilter,
  SerialInputSignals,
  SerialOpenOptions,
  SerialOutputSignals,
} from './serial-port-registry.js';
import type { UsbControlSetup, UsbDeviceFilter, UsbDeviceInfo } from './usb-device-registry.js';

const PANEL_RPC_CHANNEL = 'slicc-panel-rpc';
const DEFAULT_TIMEOUT_MS = 15_000;
/** Public alias of the panel-RPC default `call()` timeout (15s). */
export const PANEL_RPC_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export function panelRpcChannelName(instanceId?: string): string {
  return instanceId ? `${PANEL_RPC_CHANNEL}:${instanceId}` : PANEL_RPC_CHANNEL;
}

// ── Op surface ──────────────────────────────────────────────────────

/**
 * The closed set of operations the worker can ask the page to perform.
 * Each branch documents the payload it takes and the result shape.
 */
export type PanelRpcRequest =
  | { op: 'page-info'; payload?: undefined }
  | {
      op: 'screencapture';
      payload: { mimeType: string; quality: number };
    }
  | {
      op: 'speak-text';
      payload: {
        text: string;
        lang?: string;
        voice?: string;
        rate?: number;
        pitch?: number;
        volume?: number;
      };
    }
  | {
      op: 'list-voices';
      payload?: undefined;
    }
  // Enhanced-voice (kokoro) diagnostics + manual warmup for the `say` command.
  // The kernel worker has no AudioContext / speech engine — these bridge to
  // the page-side synthesis stack (`src/speech/speak.ts`), parallel to the
  // `hear-status` / `hear-warmup` recognition ops. `speak-warmup` stages the
  // kokoro weights (R10) then kicks the load in the background, returning the
  // initial state without waiting.
  | { op: 'speak-status'; payload?: undefined }
  | { op: 'speak-warmup'; payload?: undefined }
  | {
      op: 'play-audio';
      payload: { bytes: ArrayBuffer; mimeType?: string; volume?: number };
    }
  | {
      op: 'play-chime';
      payload: { tone?: 'success' | 'error' | 'notify' };
    }
  | { op: 'clipboard-read-text'; payload?: undefined }
  | { op: 'clipboard-write-text'; payload: { text: string } }
  | {
      op: 'clipboard-write-image';
      payload: { bytes: ArrayBuffer; mimeType: string };
    }
  | {
      op: 'window-open';
      payload: { url: string; target?: string; features?: string };
    }
  | {
      op: 'oauth-popup';
      payload: { url: string };
    }
  | {
      op: 'capture-camera';
      payload: {
        mode: 'photo' | 'video';
        deviceId?: string;
        audioDeviceId?: string;
        captureAudio?: boolean;
        /**
         * Open a video track on the stream. Defaults to true for
         * photo / video mode; set to false for audio-only video
         * captures so `getUserMedia` doesn't request a camera.
         */
        captureVideo?: boolean;
        width?: number;
        height?: number;
        frameRate?: number;
        exactSize?: boolean;
        mimeType: string;
        quality?: number;
        durationMs?: number;
        /** Photo mode: ms to let the sensor's auto-exposure settle
         * before grabbing the frame. */
        warmupMs?: number;
      };
    }
  | { op: 'enumerate-media-devices'; payload?: undefined }
  // Speech capture / transcription for the `hear` command. The kernel
  // worker has no microphone, recognizer, or AudioContext — these bridge
  // to the page-side speech stack (`src/speech/hear.ts`). Callers pass
  // generous per-call timeouts: capture waits for the speaker to finish,
  // and transcribe may first stream the whisper model download.
  | {
      op: 'hear-capture';
      payload: {
        lang?: string;
        timeoutMs?: number;
        deviceId?: string;
        engine?: 'auto' | 'builtin' | 'enhanced';
      };
    }
  | { op: 'hear-transcribe'; payload: { bytes: ArrayBuffer; lang?: string } }
  | { op: 'hear-status'; payload?: undefined }
  | { op: 'hear-warmup'; payload?: undefined }
  | {
      // Reset the page-side multi-browser-sync leader tray. The
      // tray subsystem lives on the page (DOM, RTCPeerConnections,
      // sync-manager state), so the worker can't drive
      // `LeaderTrayManager.reset()` directly — it bridges through
      // here. Result is the new runtime status after the new session
      // is established (or an error from the leader's start flow).
      // Handler throws when no leader tray is active.
      op: 'tray-reset';
      payload?: undefined;
    }
  | {
      // Leave the multi-browser-sync tray (or switch from follower to
      // leader on the supplied worker base URL). Worker callers (the
      // `host leave` shell command) route through here; the
      // leader/follower tray handles live page-side and own
      // non-transferable WebRTC resources, so the page is the only
      // side that can stop them.
      //
      // `workerBaseUrl: null` leaves entirely; a string value switches
      // role to leader on that worker. `requestId` is forwarded into
      // failure log meta so log entries on the worker and the page can
      // be correlated across rapid retries.
      op: 'tray-leave';
      payload: { workerBaseUrl: string | null; requestId?: string };
    }
  | {
      // Write the user-configured extra-OAuth-domains store for a
      // single provider. Worker writes can't reach page localStorage
      // directly (the kernel-worker shim is page→worker only — see
      // `kernel-worker.ts:installLocalStorageShim`), so the
      // `oauth-domain` command routes writes through the page handler
      // which mutates real `localStorage`. Response carries the full
      // post-write store so the worker can mirror it into its shim
      // before resolving, avoiding the page→worker forward race.
      op: 'oauth-extras-set';
      payload: { providerId: string; domains: string[] };
    }
  | {
      // Persist the full `slicc_accounts` array (the canonical OAuth
      // login store) to real page `localStorage`. Same shim hazard as
      // `oauth-extras-set`: the kernel-worker `localStorage` shim is
      // page→worker only, so worker writes from `mcp add` /
      // `onSilentRenew` would otherwise be lost on reload. Response
      // carries the post-write serialized JSON so the worker can
      // mirror it into its shim immediately. See issue #701.
      op: 'save-oauth-accounts';
      payload: { accountsJson: string };
    }
  // ── WebUSB bridge ─────────────────────────────────────────────────
  // The kernel worker has no `navigator.usb`. These ops let the worker-
  // side `usb` command drive WebUSB through the page-side device-handle
  // registry. `USBDevice` objects are non-serializable, so every op is
  // keyed by an opaque string handle and exchanges only plain data /
  // `ArrayBuffer`s. `usb-request` and `usb-list` resolve handles; the
  // remaining ops act on an already-resolved handle.
  | { op: 'usb-list'; payload?: undefined }
  | { op: 'usb-request'; payload: { filters: UsbDeviceFilter[] } }
  | { op: 'usb-device-info'; payload: { handle: string } }
  | { op: 'usb-open'; payload: { handle: string } }
  | { op: 'usb-close'; payload: { handle: string } }
  | { op: 'usb-select-configuration'; payload: { handle: string; configurationValue: number } }
  | { op: 'usb-claim-interface'; payload: { handle: string; interfaceNumber: number } }
  | { op: 'usb-release-interface'; payload: { handle: string; interfaceNumber: number } }
  | {
      op: 'usb-control-transfer-in';
      payload: { handle: string; setup: UsbControlSetup; length: number };
    }
  | {
      op: 'usb-control-transfer-out';
      payload: { handle: string; setup: UsbControlSetup; bytes: ArrayBuffer };
    }
  | { op: 'usb-transfer-in'; payload: { handle: string; endpointNumber: number; length: number } }
  | {
      op: 'usb-transfer-out';
      payload: { handle: string; endpointNumber: number; bytes: ArrayBuffer };
    }
  | { op: 'usb-reset'; payload: { handle: string } }
  // ── WebHID bridge ─────────────────────────────────────────────────
  // Same handle-keyed pattern as the WebUSB bridge above. `HIDDevice`
  // objects are non-serializable, so every op exchanges only plain data
  // / `ArrayBuffer`s. `hid-subscribe-input-reports` attaches a page-side
  // `inputreport` listener that fans reports back to the worker over the
  // panel-RPC event channel (see `createPanelRpcEventEmitter` /
  // `PanelRpcClient.onEvent`) on the `hid-input-report` channel.
  | { op: 'hid-list'; payload?: undefined }
  | { op: 'hid-request'; payload: { filters: HidDeviceFilter[] } }
  | { op: 'hid-device-info'; payload: { handle: string } }
  | { op: 'hid-open'; payload: { handle: string } }
  | { op: 'hid-close'; payload: { handle: string } }
  | { op: 'hid-send-report'; payload: { handle: string; reportId: number; bytes: ArrayBuffer } }
  | {
      op: 'hid-send-feature-report';
      payload: { handle: string; reportId: number; bytes: ArrayBuffer };
    }
  | { op: 'hid-receive-feature-report'; payload: { handle: string; reportId: number } }
  | { op: 'hid-subscribe-input-reports'; payload: { handle: string } }
  | { op: 'hid-unsubscribe-input-reports'; payload: { handle: string } }
  // ── Web Serial bridge ─────────────────────────────────────────────
  // Same handle-keyed pattern as the WebUSB bridge above. `SerialPort`
  // objects are non-serializable, so every op is keyed by an opaque
  // string handle and exchanges only plain data / `ArrayBuffer`s.
  | { op: 'serial-list'; payload?: undefined }
  | { op: 'serial-request'; payload: { filters: SerialFilter[] } }
  | { op: 'serial-device-info'; payload: { handle: string } }
  | { op: 'serial-open'; payload: { handle: string; options: SerialOpenOptions } }
  | { op: 'serial-close'; payload: { handle: string } }
  | {
      op: 'serial-read';
      payload: { handle: string; maxBytes?: number; until?: ArrayBuffer; timeoutMs?: number };
    }
  | { op: 'serial-write'; payload: { handle: string; bytes: ArrayBuffer } }
  | { op: 'serial-get-signals'; payload: { handle: string } }
  | { op: 'serial-set-signals'; payload: { handle: string; signals: SerialOutputSignals } }
  // ── esptool bridge ─────────────────────────────────────────────────
  // High-level ESP flasher ops driven from the worker-side `esptool`
  // command. esptool-js holds a `SerialPort` (non-serializable), so each
  // op is keyed by a `SerialPort` handle from the shared serial registry
  // — the same handle namespace as the `serial` command. Firmware blobs
  // cross as `ArrayBuffer`s. While an op runs, the page fans esptool's
  // terminal output back to the worker on the `esptool-progress` event
  // channel (see `EsptoolProgressEventPayload`) so flash progress lines
  // surface on the command's stdout.
  | { op: 'esptool-chip-info'; payload: { handle: string; baudRate: number } }
  | { op: 'esptool-read-mac'; payload: { handle: string; baudRate: number } }
  | { op: 'esptool-erase-flash'; payload: { handle: string; baudRate: number } }
  | {
      op: 'esptool-flash';
      payload: {
        handle: string;
        baudRate: number;
        eraseAll: boolean;
        segments: Array<{ address: number; bytes: ArrayBuffer }>;
      };
    }
  | {
      op: 'esptool-read-flash';
      payload: { handle: string; baudRate: number; address: number; size: number };
    }
  | {
      op: 'esptool-read-reg';
      payload: { handle: string; baudRate: number; address: number };
    }
  | { op: 'esptool-flash-id'; payload: { handle: string; baudRate: number } }
  | {
      op: 'esptool-erase-region';
      payload: { handle: string; baudRate: number; address: number; size: number };
    }
  | { op: 'esptool-run'; payload: { handle: string; baudRate: number } }
  | {
      // Push a `cherry.slicc_event` (cone → host page) out through the
      // page-side LeaderSyncManager. The `cherry-emit` shell command runs
      // in the kernel worker, but the leader tray's WebRTC data channels
      // live on the page, so the worker bridges here. `runtimeId` is the
      // canonical follower id (a bare runtime id, no `:localTarget`
      // suffix). Result `delivered` is false when no leader tray is active
      // or the owning follower is not connected, letting the command
      // surface a clear failure rather than silently succeeding.
      op: 'cherry-emit';
      payload: { runtimeId: string; name: string; detail?: unknown };
    }
  | {
      // Fetch remote (follower) browser targets from the page-side
      // BrowserAPI. The tray provider is set on the page-side instance
      // only — the worker's BrowserAPI has no reference to it, so
      // listAllTargets() in the worker falls back to local CDP tabs.
      // This op bridges the gap: the page fetches its full target list
      // and returns only entries with composite targetIds (remote ones).
      op: 'list-remote-targets';
      payload?: undefined;
    }
  | {
      // Drive a remote (tray/cherry) target: relay a single CDP command
      // to the page-side RemoteCDPTransport that owns the WebRTC channel.
      // The worker's PanelRpcCdpTransport can't own an RTCDataChannel, so
      // it tunnels here. `sessionId` threads through transparently.
      op: 'remote-cdp-send';
      payload: {
        runtimeId: string;
        localTargetId: string;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
        /**
         * Per-op CDP timeout (ms) forwarded to the page-side
         * `RemoteCDPTransport.send` so a long op (e.g. `Page.printToPDF`)
         * isn't floored at the page transport's 30s default. The panel-RPC
         * `call` timeout is always layered strictly above this.
         */
        timeout?: number;
      };
    }
  | {
      // Subscribe the page-side RemoteCDPTransport to a CDP event so its
      // firings get pushed back to the worker as `remote-cdp-event`.
      // Ref-counted page-side (0→1 wires a forwarder).
      op: 'remote-cdp-subscribe';
      payload: { runtimeId: string; localTargetId: string; event: string };
    }
  | {
      // Drop one event subscription (1→0 unwires the page-side forwarder).
      op: 'remote-cdp-unsubscribe';
      payload: { runtimeId: string; localTargetId: string; event: string };
    }
  | {
      // Dispose the page-side session for a target (drops forwarders and
      // the RemoteCDPTransport). Sent by PanelRpcCdpTransport.disconnect().
      op: 'remote-cdp-detach';
      payload: { runtimeId: string; localTargetId: string };
    }
  | {
      // Open a new tab on a remote runtime; returns the composite targetId.
      op: 'remote-open-tab';
      payload: { runtimeId: string; url: string };
    }
  | {
      // Bridge a cross-origin shell fetch from the kernel-worker realm
      // (which has no `chrome`) to the page realm, which opens a
      // `chrome.runtime` Port to the thin-bridge extension (host_permissions
      // CORS bypass). Request `headers` are PLAIN — the page-side collector
      // encodes the forbidden-header transport (X-Proxy-*) exactly once.
      // `body` is the raw `SecureFetch` body string (structured-clone-safe
      // and lossless for both latin1-binary and UTF-8 text), preserving the
      // existing `prepareRequestBody` contract verbatim. The result carries
      // the streamed response head + body bytes; the worker finalizes them so
      // its own `binary-cache` (not the page's) is populated.
      op: 'proxied-fetch';
      payload: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      };
    }
  | {
      // Relay a sudo / protected-write approval request from the kernel-worker
      // realm to the page (the hosted leader tab the thin extension pins),
      // where `resolveSudoRequest` raises a genuine native modal. The worker
      // has no scriptable `window.confirm`/`window.prompt`, and in the
      // thin-bridge extension leader its leader origin (the tray-hub) exposes
      // no `/api/sudo-approve`, so the broker bridges here instead of failing
      // closed. The request already carries the worker-computed
      // `suggestedPattern`. Mirrors the `proxied-fetch` worker→page delegate.
      op: 'sudo-request';
      payload: { request: SudoRequest };
    }
  | {
      // Bridge a `secrets.crud` control message from the kernel-worker realm
      // (which has no `chrome`) to the page realm, which opens the explicit-id
      // `chrome.runtime` Port to the thin-bridge extension. Mirrors the
      // `proxied-fetch` worker→page delegate. `type` is one of the SW's
      // `SECRETS_HANDLERS` keys; `payload` is that handler's message fields.
      // `response` is the handler's `sendResponse` shape verbatim (no
      // reshaping) — secret values never cross the bridge, only HMAC-masked
      // replicas / scrubbed text. Best-effort: the worker maps an absent
      // `response` to its existing safe default so secrets never block boot.
      op: 'secrets-bridge';
      payload: { type: string; payload?: Record<string, unknown> };
    }
  | {
      // Run one or more gesture-gated pickers through the leader tab's
      // `<slicc-permissions>` surface. Worker-realm / agent-initiated
      // flows have no ambient user activation, so the page supplies it
      // via the surface's own Allow button (`SliccPermissions.prompt`).
      // Result entries carry only serializable references: usb/hid/serial
      // grants land in the shared page-side device registries and the
      // returned `handle` matches today's picker path (`usb1` / `hid1` /
      // `serial1`); filesystem grants stash via `storePendingHandle` and
      // the returned `idbKey` round-trips through `loadAndClearPendingHandle`;
      // media / screenshare grants live on the page only (their MediaStream
      // can't cross the bridge) and are reported as `{ kind, ok: true }`.
      // Rejects with a clear error on cancel / unavailable / picker error
      // so the worker-side caller surfaces a single failure rather than
      // a partial result.
      op: 'permission-request';
      payload: {
        kinds: PermissionRpcKind[];
        description: string;
        heading?: string;
        grantLabel?: string;
        cancelLabel?: string;
      };
    };

export interface PanelRpcResults {
  'page-info': { origin: string; href: string; title: string };
  screencapture: { bytes: ArrayBuffer; width: number; height: number; mimeType: string };
  'speak-text': { done: true };
  'list-voices': { voices: Array<{ name: string; lang: string; default: boolean }> };
  'speak-status': KokoroRpcStatus;
  'speak-warmup': KokoroRpcStatus;
  'play-audio': { done: true };
  'play-chime': { done: true };
  'clipboard-read-text': { text: string };
  'clipboard-write-text': { done: true };
  'clipboard-write-image': { done: true };
  'window-open': { opened: boolean };
  'oauth-popup': { redirectUrl: string | null };
  'capture-camera': {
    bytes: ArrayBuffer;
    mimeType: string;
    width: number;
    height: number;
    durationMs?: number;
  };
  'enumerate-media-devices': {
    videoinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
    audioinputs: Array<{ deviceId: string; label: string; groupId?: string }>;
  };
  'hear-capture': { transcript: string; engine: 'builtin' | 'enhanced' };
  'hear-transcribe': { transcript: string; engine: 'builtin' | 'enhanced' };
  'hear-status': HearRpcStatus;
  'hear-warmup': HearRpcStatus;
  'tray-reset': LeaderTrayRuntimeStatus;
  'tray-leave': TrayLeaveResult;
  'oauth-extras-set': { storeAfter: OAuthExtraDomainsStore };
  'save-oauth-accounts': { storedJson: string };
  'usb-list': { devices: UsbDeviceInfo[] };
  'usb-request': { device: UsbDeviceInfo };
  'usb-device-info': { device: UsbDeviceInfo };
  'usb-open': { done: true };
  'usb-close': { done: true };
  'usb-select-configuration': { done: true };
  'usb-claim-interface': { done: true };
  'usb-release-interface': { done: true };
  'usb-control-transfer-in': { status: string; bytes: ArrayBuffer };
  'usb-control-transfer-out': { status: string; bytesWritten: number };
  'usb-transfer-in': { status: string; bytes: ArrayBuffer };
  'usb-transfer-out': { status: string; bytesWritten: number };
  'usb-reset': { done: true };
  'hid-list': { devices: HidDeviceInfo[] };
  'hid-request': { devices: HidDeviceInfo[] };
  'hid-device-info': { device: HidDeviceInfo };
  'hid-open': { done: true };
  'hid-close': { done: true };
  'hid-send-report': { done: true };
  'hid-send-feature-report': { done: true };
  'hid-receive-feature-report': { reportId: number; bytes: ArrayBuffer };
  'hid-subscribe-input-reports': { done: true };
  'hid-unsubscribe-input-reports': { done: true };
  'serial-list': { devices: SerialDeviceInfo[] };
  'serial-request': { device: SerialDeviceInfo };
  'serial-device-info': { device: SerialDeviceInfo };
  'serial-open': { done: true };
  'serial-close': { done: true };
  'serial-read': { bytes: ArrayBuffer };
  'serial-write': { bytesWritten: number };
  'serial-get-signals': { signals: SerialInputSignals };
  'serial-set-signals': { done: true };
  'esptool-chip-info': EsptoolChipInfo;
  'esptool-read-mac': { mac: string };
  'esptool-erase-flash': { done: true };
  'esptool-flash': { done: true };
  'esptool-read-flash': { bytes: ArrayBuffer };
  'esptool-read-reg': { value: number };
  'esptool-flash-id': EsptoolFlashId;
  'esptool-erase-region': { done: true };
  'esptool-run': { done: true };
  'cherry-emit': { delivered: boolean };
  'list-remote-targets': {
    targets: Array<{ targetId: string; title: string; url: string }>;
  };
  'remote-cdp-send': Record<string, unknown>;
  'remote-cdp-subscribe': { ok: true };
  'remote-cdp-unsubscribe': { ok: true };
  'remote-cdp-detach': { ok: true };
  'remote-open-tab': { targetId: string };
  'proxied-fetch': {
    head: { status: number; statusText: string; headers: Record<string, string> };
    body: ArrayBuffer;
  };
  'permission-request': { grants: PermissionRpcGrant[] };
  'sudo-request': { decision: SudoDecision };
  'secrets-bridge': { response: unknown };
}

/**
 * The subset of `<slicc-permissions>` kinds bridged across panel-RPC.
 * Mirror of `PermissionKind` from `@slicc/webcomponents`, kept inline so
 * the worker-side type graph stays import-free of the page-only library.
 */
export type PermissionRpcKind =
  | 'camera'
  | 'microphone'
  | 'screenshare'
  | 'usb'
  | 'hid'
  | 'serial'
  | 'filesystem';

/**
 * Serializable grant returned by `permission-request`. The non-serializable
 * artifact (MediaStream, USBDevice, FileSystemDirectoryHandle, …) stays on
 * the page; usb/hid/serial pass back a registry `handle` (the same one
 * `--__resolved` rewrites carry), filesystem passes back an `idbKey` for
 * `loadAndClearPendingHandle`, and media / screenshare report only that
 * the grant succeeded.
 */
export type PermissionRpcGrant =
  | { kind: 'usb'; handle: string }
  | { kind: 'hid'; handle: string }
  | { kind: 'serial'; handle: string }
  | { kind: 'filesystem'; idbKey: string; dirName: string }
  | { kind: 'camera' | 'microphone' | 'screenshare'; ok: true };

/**
 * Serializable enhanced-speech-engine lifecycle snapshot returned by
 * `hear-status` / `hear-warmup`. Structural mirror of `HearStatus` in
 * `src/speech/hear.ts` (the page-side implementation) — kept import-free so
 * the worker-side type graph never references the page-only speech modules.
 */
export interface HearRpcStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

/**
 * Serializable enhanced-voice (kokoro) lifecycle snapshot returned by
 * `speak-status` / `speak-warmup`. Structural mirror of `KokoroStatus` in
 * `src/speech/speak.ts` (the page-side implementation) — kept import-free so
 * the worker-side type graph never references the page-only speech modules.
 */
export interface KokoroRpcStatus {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  loaded?: number;
  total?: number;
  etaSeconds?: number | null;
}

/**
 * Serializable chip identity returned by `esptool-chip-info`. Mirrors the
 * fields the Python `esptool chip_id` / `read_mac` flow reports.
 */
export interface EsptoolChipInfo {
  /** Short chip family name, e.g. `ESP32`, `ESP32-C3`. */
  chip: string;
  /** Full chip description string from esptool-js. */
  description: string;
  /** Decoded chip feature flags. */
  features: string[];
  /** Crystal frequency in MHz. */
  crystalMHz: number;
  /** Factory MAC address as `aa:bb:cc:dd:ee:ff`. */
  mac: string;
}

/**
 * Structured result of `esptool-flash-id`. Mirrors the fields the Python
 * `esptool flash_id` flow reports: SPI flash manufacturer + device id
 * decoded from the 24-bit RDID value, plus the size string looked up in
 * esptool-js's `DETECTED_FLASH_SIZES` map (or `null` when the byte is
 * not in the table).
 */
export interface EsptoolFlashId {
  /** Raw 24-bit RDID value. */
  flashId: number;
  /** SPI flash manufacturer id (low byte of RDID). */
  manufacturer: number;
  /** Two-byte device id (mid + high bytes of RDID, packed `(mid<<8)|high`). */
  device: number;
  /** Detected flash size string (e.g. `4MB`), or `null` if not in the lookup. */
  flashSize: string | null;
}

/**
 * Payload pushed on the `esptool-progress` event channel for each line
 * esptool-js writes to its terminal while a worker `esptool` op is in
 * flight (chip detection, erase progress, and `Writing at 0x…` flash
 * lines). `handle` keys the line to the originating port so concurrent
 * ops don't cross streams.
 */
export interface EsptoolProgressEventPayload {
  handle: string;
  line: string;
}

/**
 * Payload pushed on the `hid-input-report` event channel for each
 * `inputreport` the page-side device emits while a worker `hid watch`
 * subscription is active. `bytes` is the report's data buffer.
 */
export interface HidInputReportEventPayload {
  handle: string;
  reportId: number;
  bytes: ArrayBuffer;
}

export type PanelRpcOp = PanelRpcRequest['op'];
export type PanelRpcPayloadFor<O extends PanelRpcOp> = Extract<
  PanelRpcRequest,
  { op: O }
>['payload'];
export type PanelRpcResultFor<O extends PanelRpcOp> = PanelRpcResults[O];

/**
 * Compile-time completeness guard: every `PanelRpcOp` must have a
 * matching `PanelRpcResults` entry. Indexing `PanelRpcResults[K]` for an
 * op `K` that lacks a result entry is a type error here, so adding an op
 * to the `PanelRpcRequest` union without its result fails the build
 * (rather than silently degrading `PanelRpcResultFor` to an index error
 * only at some unrelated call site).
 */
export type PanelRpcResultsCoverage = { [K in PanelRpcOp]: PanelRpcResults[K] };

// ── Wire envelopes ──────────────────────────────────────────────────

interface PanelRpcRequestMsg {
  type: 'panel-rpc-request';
  id: string;
  op: PanelRpcOp;
  payload: unknown;
}

interface PanelRpcResponseMsg {
  type: 'panel-rpc-response';
  id: string;
  result?: unknown;
  error?: string;
}

/**
 * Page→worker push envelope. Unlike request/response, events are
 * fire-and-forget: the page emits them on a named channel (e.g.
 * `hid-input-report`) and any worker subscriber registered via
 * `PanelRpcClient.onEvent` receives them. Used for streaming device
 * input reports back to a long-lived `hid watch` command.
 */
interface PanelRpcEventMsg {
  type: 'panel-rpc-event';
  channel: string;
  payload: unknown;
}

/** Payload of a `remote-cdp-event` push (page → worker). */
export interface RemoteCdpEventPayload {
  runtimeId: string;
  localTargetId: string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * Page → worker push envelope, distinct from the request/response
 * envelopes. Relays CDP events fired on a page-side `RemoteCDPTransport`
 * back to the worker-side `PanelRpcCdpTransport` that subscribed. Posted
 * on the same instance-scoped channel; the worker client routes it to a
 * registered push target keyed by `runtimeId:localTargetId`.
 */
export interface PanelRpcPushMsg {
  type: 'panel-rpc-push';
  op: 'remote-cdp-event';
  payload: RemoteCdpEventPayload;
}

// ── Worker-side client ──────────────────────────────────────────────

export interface PanelRpcClient {
  call<O extends PanelRpcOp>(
    op: O,
    payload: PanelRpcPayloadFor<O>,
    opts?: { timeoutMs?: number }
  ): Promise<PanelRpcResultFor<O>>;
  /**
   * Subscribe to page-emitted events on a named channel. Returns an
   * unsubscribe function. Multiple subscribers per channel are
   * supported; each receives every event posted on that channel.
   */
  onEvent(channel: string, handler: (payload: unknown) => void): () => void;
  /**
   * Register a handler for `remote-cdp-event` pushes targeting a
   * composite key (`runtimeId:localTargetId`). Used by
   * `PanelRpcCdpTransport` to receive page-pushed CDP events. No-op
   * when `BroadcastChannel` is unavailable.
   */
  registerPushTarget(key: string, handler: (payload: RemoteCdpEventPayload) => void): void;
  /** Drop a previously registered push handler. */
  unregisterPushTarget(key: string): void;
  /** Close the BroadcastChannel and reject any in-flight requests. */
  dispose(): void;
}

/**
 * Build the worker-side proxy. Returns a `call(op, payload)` helper
 * and a `dispose()`. The client may be constructed in environments
 * without `BroadcastChannel` (older test runners, isolated test
 * harnesses); in that case every call rejects with a clear "bridge
 * unavailable" error.
 */
export function createPanelRpcClient(options: { instanceId?: string } = {}): PanelRpcClient {
  if (typeof BroadcastChannel !== 'function') {
    return {
      call: () => Promise.reject(new Error('panel-rpc: BroadcastChannel is unavailable')),
      onEvent: () => () => {},
      registerPushTarget: () => {},
      unregisterPushTarget: () => {},
      dispose: () => {},
    };
  }

  const channelName = panelRpcChannelName(options.instanceId);
  const channel = new BroadcastChannel(channelName);
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const pushTargets = new Map<string, (payload: RemoteCdpEventPayload) => void>();

  const eventSubscribers = new Map<string, Set<(payload: unknown) => void>>();

  const handleEventMsg = (msg: PanelRpcEventMsg): void => {
    const subs = eventSubscribers.get(msg.channel);
    if (!subs) return;
    for (const handler of subs) {
      try {
        handler(msg.payload);
      } catch (err) {
        console.warn(
          `panel-rpc: event handler for '${msg.channel}' threw:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  };

  const handlePushMsg = (msg: PanelRpcPushMsg): void => {
    if (msg.op !== 'remote-cdp-event') return;
    const p = msg.payload;
    pushTargets.get(`${p.runtimeId}:${p.localTargetId}`)?.(p);
  };

  const handleResponseMsg = (msg: PanelRpcResponseMsg): void => {
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (typeof msg.error === 'string') slot.reject(new Error(msg.error));
    else slot.resolve(msg.result);
  };

  channel.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as PanelRpcResponseMsg | PanelRpcEventMsg | PanelRpcPushMsg | undefined;
    if (msg?.type === 'panel-rpc-event') handleEventMsg(msg);
    else if (msg?.type === 'panel-rpc-push') handlePushMsg(msg);
    else if (msg?.type === 'panel-rpc-response') handleResponseMsg(msg);
  });

  function onEvent(eventChannel: string, handler: (payload: unknown) => void): () => void {
    let subs = eventSubscribers.get(eventChannel);
    if (!subs) {
      subs = new Set();
      eventSubscribers.set(eventChannel, subs);
    }
    subs.add(handler);
    return () => {
      const set = eventSubscribers.get(eventChannel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) eventSubscribers.delete(eventChannel);
    };
  }

  function call<O extends PanelRpcOp>(
    op: O,
    payload: PanelRpcPayloadFor<O>,
    opts: { timeoutMs?: number } = {}
  ): Promise<PanelRpcResultFor<O>> {
    const id = newRequestId();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<PanelRpcResultFor<O>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`panel-rpc: op '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      const req: PanelRpcRequestMsg = { type: 'panel-rpc-request', id, op, payload };
      channel.postMessage(req);
    });
  }

  function registerPushTarget(
    key: string,
    handler: (payload: RemoteCdpEventPayload) => void
  ): void {
    pushTargets.set(key, handler);
  }

  function unregisterPushTarget(key: string): void {
    pushTargets.delete(key);
  }

  function dispose(): void {
    for (const [, slot] of pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error('panel-rpc: client disposed'));
    }
    pending.clear();
    eventSubscribers.clear();
    pushTargets.clear();
    try {
      channel.close();
    } catch {
      /* noop */
    }
  }

  return { call, onEvent, registerPushTarget, unregisterPushTarget, dispose };
}

// ── Page-side event emitter ─────────────────────────────────────────

export interface PanelRpcEventEmitter {
  /** Post an event on a named channel to any worker `onEvent` subscriber. */
  emit(channel: string, payload: unknown): void;
  /** Close the underlying BroadcastChannel. */
  dispose(): void;
}

/**
 * Build a page-side emitter for the panel-RPC event channel. Worker
 * commands subscribe via `PanelRpcClient.onEvent`. Constructed on the
 * same instance-scoped channel name so the worker client receives the
 * posts (a `BroadcastChannel` never delivers a message to itself, so the
 * page emitter and the page request-handler can safely share a name).
 */
export function createPanelRpcEventEmitter(
  options: { instanceId?: string } = {}
): PanelRpcEventEmitter {
  if (typeof BroadcastChannel !== 'function') {
    return { emit: () => {}, dispose: () => {} };
  }
  const channel = new BroadcastChannel(panelRpcChannelName(options.instanceId));
  return {
    emit(eventChannel: string, payload: unknown): void {
      const msg: PanelRpcEventMsg = { type: 'panel-rpc-event', channel: eventChannel, payload };
      try {
        channel.postMessage(msg);
      } catch (err) {
        console.warn(
          `panel-rpc: failed to emit event '${eventChannel}':`,
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    dispose(): void {
      try {
        channel.close();
      } catch {
        /* noop */
      }
    },
  };
}

// ── Page-side handler ───────────────────────────────────────────────

export type PanelRpcHandlers = {
  [O in PanelRpcOp]?: (
    payload: PanelRpcPayloadFor<O>
  ) => Promise<PanelRpcResultFor<O>> | PanelRpcResultFor<O>;
};

/**
 * Install a page-side handler that listens for `panel-rpc-request`
 * messages on the bridge channel and dispatches them. Unknown ops are
 * answered with an error so the worker's `call` rejects cleanly
 * instead of hanging until the timeout. Errors raised inside a handler
 * are forwarded as `error` strings on the response.
 *
 * Returns a disposer that removes the listener and closes the channel.
 */
export function installPanelRpcHandler(options: {
  handlers: PanelRpcHandlers;
  instanceId?: string;
}): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(panelRpcChannelName(options.instanceId));

  const respond = (id: string, result?: unknown, error?: string): void => {
    const msg: PanelRpcResponseMsg = { type: 'panel-rpc-response', id };
    if (error !== undefined) msg.error = error;
    else msg.result = result;
    try {
      channel.postMessage(msg);
    } catch (err) {
      // Posting can fail if the channel was closed while we were
      // resolving — there's no useful recovery beyond logging.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`panel-rpc: failed to post response for id=${id}: ${reason}`);
    }
  };

  const listener = async (event: MessageEvent): Promise<void> => {
    const msg = event.data as PanelRpcRequestMsg | undefined;
    if (msg?.type !== 'panel-rpc-request') return;
    const handler = (options.handlers as Record<string, ((p: unknown) => unknown) | undefined>)[
      msg.op
    ];
    if (!handler) {
      respond(msg.id, undefined, `panel-rpc: no handler for op '${msg.op}'`);
      return;
    }
    try {
      const result = await handler(msg.payload);
      respond(msg.id, result);
    } catch (err) {
      respond(msg.id, undefined, err instanceof Error ? err.message : String(err));
    }
  };

  channel.addEventListener('message', listener as (ev: MessageEvent) => void);

  return () => {
    channel.removeEventListener('message', listener as (ev: MessageEvent) => void);
    try {
      channel.close();
    } catch {
      /* noop */
    }
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `prpc-${crypto.randomUUID()}`;
  }
  return `prpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ── Worker-shell consumer helper ────────────────────────────────────

/**
 * Returns the bridge client published on `globalThis.__slicc_panelRpc`
 * by `kernel-worker.ts`, or null when the current realm has a real
 * DOM and should run DOM operations directly. Commands use this to
 * pick between local-DOM and bridged execution.
 */
export function getPanelRpcClient(): PanelRpcClient | null {
  const g = globalThis as unknown as { __slicc_panelRpc?: PanelRpcClient };
  return g.__slicc_panelRpc ?? null;
}

/**
 * `true` when the current realm has a real DOM. False inside a
 * DedicatedWorker, irrespective of whether the bridge client is
 * published.
 */
export function hasLocalDom(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}
