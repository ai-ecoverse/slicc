import type { SliccPermissions } from '@slicc/webcomponents';

import type { PageInfo } from '../cdp/types.js';
import {
  getNavigatorHid,
  getSharedHidRegistry,
  type HidDevice,
} from '../kernel/hid-device-registry.js';
import * as hidOps from '../kernel/hid-operations.js';
import type {
  PanelRpcHandlers,
  PanelRpcPayloadFor,
  PanelRpcResults,
  PermissionRpcGrant,
  PermissionRpcKind,
} from '../kernel/panel-rpc.js';
import type {
  CameraCaptureRequest,
  CameraCaptureResult,
} from '../kernel/panel-rpc-camera-types.js';
import * as serialOps from '../kernel/serial-operations.js';
import {
  getNavigatorSerial,
  getSharedSerialRegistry,
  type SerialPort,
} from '../kernel/serial-port-registry.js';
import {
  DEFAULT_USB_OWNER,
  getNavigatorUsb,
  getSharedUsbRegistry,
  type UsbDevice,
} from '../kernel/usb-device-registry.js';
import * as usbOps from '../kernel/usb-operations.js';
import type { LeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import type {
  SidecarAttachmentInfo,
  SidecarPromptOptions,
  SidecarRunOptions,
  SidecarRunResult,
  SidecarWatchOptions,
} from '../scoops/tray-sidecar.js';
import { apiHeaders, resolveApiUrl } from '../shell/proxied-fetch.js';
import { getAllExtraOAuthDomains, setExtraOAuthDomains } from './provider-settings.js';
import type { RemoteCdpPageBridge } from './remote-cdp-page-bridge.js';

export interface StandalonePanelRpcHandlerOptions {
  resetTray?: () => Promise<LeaderTrayRuntimeStatus>;

  rotateWebhook?: () => Promise<{ webhookUrl: string }>;
  revokeWebhook?: (webhookId: string) => Promise<void>;

  mintBiscotto?: (
    payload: PanelRpcPayloadFor<'tray-mint-biscotto'>
  ) => Promise<PanelRpcResults['tray-mint-biscotto']>;
  revokeBiscotto?: (
    payload: PanelRpcPayloadFor<'tray-revoke-biscotto'>
  ) => Promise<PanelRpcResults['tray-revoke-biscotto']>;
  listBiscotti?: () => Promise<PanelRpcResults['tray-list-biscotti']>;
  mintPreview?: (payload: {
    entryPath: string;
    servedRoot: string;
    bridge: boolean;
    noBridge: boolean;
    maxTabs?: number;
    quiet?: boolean;
    webhookId?: string;
    ttlMs?: number;
    snapshotFiles?: Array<{ path: string; content: Uint8Array; mime: string }>;
  }) => Promise<{ url: string; pushed: number; previewToken: string }>;

  revokePreview?: (payload: {
    previewToken: string;
  }) => Promise<{ revoked: boolean; webhookId?: string }>;

  listPreviews?: () => Promise<PanelRpcResults['tray-list-previews']>;

  getPreviewLifecycleRecords?: (previewToken?: string) => PanelRpcResults['tray-preview-logs'];

  truncatePreviewLifecycleRecords?: (
    previewToken?: string
  ) => PanelRpcResults['tray-preview-truncate'];

  leaveTray?: (opts: {
    workerBaseUrl: string | null;
    requestId?: string;
  }) => Promise<PanelRpcResults['tray-leave']> | PanelRpcResults['tray-leave'];

  joinTray?: (opts: {
    joinUrl: string;
    requestId?: string;
  }) => Promise<PanelRpcResults['tray-join']> | PanelRpcResults['tray-join'];

  emitEvent?: (channel: string, payload: unknown) => void;

  emitCherrySliccEvent?: (runtimeId: string, name: string, detail?: unknown) => boolean;

  execOnRemote?: (payload: {
    runtimeId: string;
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    execToken: string;
    timeoutMs?: number;
    stdin?: string;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number; error?: string }>;

  computerNative?: (
    payload: PanelRpcPayloadFor<'tray-computer-native'>
  ) => Promise<PanelRpcResults['tray-computer-native']>;

  sliccSidecar?: SidecarRegistryLike;
  signalRemoteExec?: (payload: { execToken: string }) => void;

  listRemoteTargets?: () => Promise<PageInfo[]> | PageInfo[];

  remoteCdp?: RemoteCdpPageBridge;

  getPermissionsSurface?: () => SliccPermissions | null;

  delegateOAuthLogin?: (
    url: string
  ) => Promise<
    { delegated: false } | { delegated: true; redirectUrl: string | null; error?: string }
  >;

  shouldDelegateOAuth?: () => Promise<boolean> | boolean;
}

export interface SidecarRegistryLike {
  attach(opts: {
    joinUrl: string;
    name?: string;
    connectTimeoutMs?: number;
  }): Promise<SidecarAttachmentInfo>;
  detach(name: string): boolean;
  list(): SidecarAttachmentInfo[];
  prompt(name: string, text: string, options?: SidecarPromptOptions): Promise<SidecarRunResult>;
  exec(
    name: string,
    command: string,
    options?: SidecarRunOptions & { cwd?: string; env?: Record<string, string>; stdin?: string }
  ): Promise<SidecarRunResult>;
  watch(name: string, options: SidecarWatchOptions): Promise<SidecarRunResult>;
}

export function createStandalonePanelRpcHandlers(
  options: StandalonePanelRpcHandlerOptions = {}
): PanelRpcHandlers {
  const hidSubscriptions = new Map<string, () => void>();
  ensureScreenSessionEndedRelay(options.emitEvent);

  return {
    ...buildPageAudioHandlers(),
    ...buildClipboardCaptureHandlers(options),
    ...buildHearHandlers(),
    ...buildTrayOauthHandlers(options),
    ...buildSliccSidecarHandlers(options),
    ...buildUsbHandlers(options),
    ...buildHidHandlers(options, hidSubscriptions),
    ...buildSerialHandlers(),
    ...buildEsptoolHandlers(options),
    ...buildRemoteCdpHandlers(options),
    ...buildPermissionRequestHandler(options),
    ...buildProxiedFetchHandler(),
    ...buildSudoRequestHandler(),
    ...buildSecretRequestHandler(),
    ...buildSecretsBridgeHandler(),
    ...buildMountBridgeHandler(),
    ...buildThemeHandler(),
    ...buildLayoutHandler(),
    ...buildComputerTabHandlers(),
  };
}

function buildSecretsBridgeHandler() {
  return {
    'secrets-bridge': async ({ type, payload }) => {
      const { callSecretsBridge } = await import('../core/secrets-bridge-client.js');
      const response = await callSecretsBridge(type, payload);
      return { response };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildMountBridgeHandler() {
  return {
    'mount-sign-and-forward': async ({ type, envelope }) => {
      const { callMountBridge } = await import('../fs/mount/mount-bridge-client.js');
      const response = await callMountBridge(type, envelope);
      return { response };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildSudoRequestHandler() {
  return {
    'sudo-request': async ({ request, mode }) => {
      const { resolveSudoApprovalInPage } = await import('../sudo/page-approval-service.js');
      return resolveSudoApprovalInPage(request, mode ?? 'resolve');
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildSecretRequestHandler() {
  return {
    'secret-request': async (payload) => {
      const { getSecretRequestSurface } = await import('../base/secret-request-registry.js');
      const surface = getSecretRequestSurface();
      if (!surface) return { stored: false, reason: 'unavailable' };
      return surface(payload);
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildProxiedFetchHandler() {
  return {
    'proxied-fetch': async ({ url, method, headers, body }) => {
      const { collectViaExtensionDelegate } = await import('../shell/proxied-fetch.js');
      const { head, body: respBody } = await collectViaExtensionDelegate(url, {
        method,
        headers,

        body: body as string | undefined,
      });
      return { head, body: respBody };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

async function handleScreencaptureRpc(payload: {
  mimeType: string;
  quality: number;
  mode?: 'image' | 'video' | 'session';
  durationMs?: number;
  audio?: boolean;
  session?: 'start' | 'frame' | 'stop' | 'record';
  handle?: string;
  maxWidth?: number;
}): Promise<{
  bytes: ArrayBuffer;
  width: number;
  height: number;
  mimeType: string;
  durationMs?: number;
  handle?: string;
}> {
  const { captureDisplayMedia, sessionCaptureRequest } = await import(
    '../shell/supplemental-commands/screencapture-media.js'
  );
  const { mimeType, quality, mode, durationMs, audio, session, handle, maxWidth } = payload;
  const captured = await captureDisplayMedia(
    mode === 'session'
      ? sessionCaptureRequest({ session, handle, mimeType, quality, durationMs, maxWidth })
      : mode === 'video'
        ? {
            mode: 'video',
            mimeType,
            durationMs: durationMs ?? 5_000,
            audio: !!audio,
          }
        : { mode: 'image', mimeType, quality }
  );
  const buffer = captured.bytes.buffer.slice(
    captured.bytes.byteOffset,
    captured.bytes.byteOffset + captured.bytes.byteLength
  ) as ArrayBuffer;
  return {
    bytes: buffer,
    width: captured.width,
    height: captured.height,
    mimeType: captured.mimeType,
    ...(captured.durationMs !== undefined ? { durationMs: captured.durationMs } : {}),
    ...(captured.handle !== undefined ? { handle: captured.handle } : {}),
  };
}

function buildPageAudioHandlers() {
  return {
    'page-info': () => ({
      origin: window.location.origin,
      href: window.location.href,
      title: document.title || '',
    }),

    screencapture: (payload) => handleScreencaptureRpc(payload),

    'speak-text': async ({ text, lang, voice, rate, pitch, volume }) => {
      const { speak } = await import('../speech/speak.js');
      await speak({ text, lang, voice, rate, pitch, volume });
      return { done: true };
    },

    'list-voices': async () => {
      const { kokoroVoicesIfReady } = await import('../speech/speak.js');
      const kokoro = kokoroVoicesIfReady().map((v) => ({
        name: v.id,
        lang: v.lang,
        default: false,
        onDevice: v.onDevice,
      }));
      if (typeof speechSynthesis === 'undefined') {
        if (kokoro.length > 0) return { voices: kokoro };
        throw new Error('speechSynthesis is unavailable in this page');
      }
      const ready = speechSynthesis.getVoices();
      if (ready.length > 0) return { voices: [...kokoro, ...ready.map(toVoiceInfo)] };

      const voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
        const onChange = () => {
          speechSynthesis.removeEventListener('voiceschanged', onChange);
          resolve(speechSynthesis.getVoices());
        };
        speechSynthesis.addEventListener('voiceschanged', onChange);

        setTimeout(() => {
          speechSynthesis.removeEventListener('voiceschanged', onChange);
          resolve(speechSynthesis.getVoices());
        }, 1000);
      });
      return { voices: [...kokoro, ...voices.map(toVoiceInfo)] };
    },

    'speak-status': async () => {
      const { kokoroStatus } = await import('../speech/speak.js');
      return kokoroStatus();
    },

    'speak-warmup': async () => {
      const { kokoroWarmup } = await import('../speech/speak.js');
      return kokoroWarmup();
    },

    'synthesize-to-wav': async ({ text, lang, voice, rate }) => {
      const { synthesizeToWav } = await import('../speech/speak.js');
      const wav = await synthesizeToWav({
        text,
        ...(lang !== undefined ? { lang } : {}),
        ...(voice !== undefined ? { voice } : {}),
        ...(rate !== undefined ? { rate } : {}),
      });

      const buf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
      return { bytes: buf };
    },

    'play-audio': async ({ bytes, volume }) => {
      if (typeof AudioContext === 'undefined') {
        throw new Error('Web Audio API is unavailable in this page');
      }
      const ctx = new AudioContext();
      try {
        const buffer = await ctx.decodeAudioData(bytes.slice(0));
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        if (volume !== undefined) {
          const gain = ctx.createGain();
          gain.gain.value = Math.max(0, Math.min(1, volume));
          src.connect(gain);
          gain.connect(ctx.destination);
        } else {
          src.connect(ctx.destination);
        }
        await new Promise<void>((resolve) => {
          src.onended = () => resolve();
          src.start();
        });
      } finally {
        try {
          await ctx.close();
        } catch {}
      }
      return { done: true };
    },

    'play-chime': async ({ tone }) => {
      const freqs: Record<string, [number, number]> = {
        success: [880, 1320],
        error: [440, 220],
        notify: [660, 660],
      };
      const [f1, f2] = freqs[tone ?? 'notify'] ?? freqs.notify;
      if (typeof AudioContext === 'undefined') {
        throw new Error('Web Audio API is unavailable in this page');
      }
      const ctx = new AudioContext();
      try {
        const start = ctx.currentTime;
        for (const [i, f] of [f1, f2].entries()) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = f;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.0001, start + i * 0.18);
          gain.gain.exponentialRampToValueAtTime(0.2, start + i * 0.18 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + i * 0.18 + 0.18);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start + i * 0.18);
          osc.stop(start + i * 0.18 + 0.2);
        }
        await new Promise((r) => setTimeout(r, 450));
      } finally {
        try {
          await ctx.close();
        } catch {}
      }
      return { done: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildClipboardCaptureHandlers(options: StandalonePanelRpcHandlerOptions = {}) {
  return {
    'clipboard-read-text': async () => {
      if (!navigator.clipboard?.readText) {
        throw new Error('clipboard API unavailable');
      }
      return { text: await navigator.clipboard.readText() };
    },

    'clipboard-write-text': async ({ text }) => {
      if (!navigator.clipboard?.writeText) {
        throw new Error('clipboard API unavailable');
      }
      await whenDocumentFocused();
      await navigator.clipboard.writeText(text);
      return { done: true };
    },

    'clipboard-write-image': async ({ bytes, mimeType }) => {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('clipboard image API unavailable');
      }
      let pngBlob: Blob;
      const src = new Blob([bytes], { type: mimeType });
      if (mimeType === 'image/png') {
        pngBlob = src;
      } else {
        pngBlob = await reencodeAsPng(src);
      }

      await whenDocumentFocused();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      return { done: true };
    },

    'window-open': async ({ url, target, features }) => {
      const win = window.open(url, target ?? '_blank', features ?? 'noopener,noreferrer');
      return { opened: win !== null };
    },

    'oauth-popup': async ({ url }) => {
      const delegated = await options.delegateOAuthLogin?.(url);
      if (delegated?.delegated) {
        return { redirectUrl: delegated.redirectUrl, error: delegated.error };
      }
      const redirectUrl = await openOAuthPopup(url, options.getPermissionsSurface);
      return { redirectUrl };
    },

    'oauth-route': async () => ({ delegate: (await options.shouldDelegateOAuth?.()) === true }),

    'capture-camera': async (payload) => {
      const result = await captureCamera(payload);
      return result;
    },

    'enumerate-media-devices': async () => {
      if (!navigator.mediaDevices?.enumerateDevices) {
        throw new Error('enumerateDevices is not supported in this browser');
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      const toInfo = (d: MediaDeviceInfo): { deviceId: string; label: string; groupId?: string } =>
        ({
          deviceId: d.deviceId,
          label: d.label || '',
          ...(d.groupId ? { groupId: d.groupId } : {}),
        }) as { deviceId: string; label: string; groupId?: string };
      return {
        videoinputs: all.filter((d) => d.kind === 'videoinput').map(toInfo),
        audioinputs: all.filter((d) => d.kind === 'audioinput').map(toInfo),
      };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildHearHandlers() {
  return {
    'hear-capture': async (payload) => {
      const { hearCapture } = await import('../speech/hear.js');
      return await hearCapture(payload ?? {});
    },

    'hear-transcribe': async ({ bytes, lang }) => {
      const { hearTranscribe } = await import('../speech/hear.js');
      return await hearTranscribe(bytes, lang);
    },

    'hear-status': async () => {
      const { hearStatus } = await import('../speech/hear.js');
      return hearStatus();
    },

    'hear-warmup': async () => {
      const { hearWarmup } = await import('../speech/hear.js');
      return hearWarmup();
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildTrayOauthHandlers(options: StandalonePanelRpcHandlerOptions) {
  return {
    'tray-reset': async () => {
      if (!options.resetTray) {
        throw new Error('host reset: no active tray session to reset');
      }
      return await options.resetTray();
    },

    'tray-webhook-rotate': async () => {
      if (!options.rotateWebhook) {
        throw new Error('webhook rotate: no active leader tray');
      }
      return await options.rotateWebhook();
    },

    'tray-webhook-revoke': async (payload) => {
      if (!options.revokeWebhook) throw new Error('webhook delete: no active leader tray');
      await options.revokeWebhook(payload.webhookId);
      return { ok: true };
    },

    'tray-open-preview': async (payload) => {
      if (!options.mintPreview) {
        throw new Error('serve: no active leader tray; cannot mint preview');
      }
      return await options.mintPreview(payload);
    },

    'tray-revoke-preview': async (payload) => {
      if (!options.revokePreview) {
        throw new Error('serve: no active leader tray; cannot revoke preview');
      }
      return await options.revokePreview(payload);
    },

    'tray-list-previews': async () => {
      if (!options.listPreviews) {
        throw new Error('serve: no active leader tray; cannot list previews');
      }
      return await options.listPreviews();
    },

    'tray-mint-biscotto': async (payload) => {
      if (!options.mintBiscotto) {
        throw new Error('biscotto: no active leader tray; cannot mint a seat');
      }
      return await options.mintBiscotto(payload);
    },

    'tray-revoke-biscotto': async (payload) => {
      if (!options.revokeBiscotto) {
        throw new Error('biscotto revoke: no active leader tray; cannot revoke a seat');
      }
      return await options.revokeBiscotto(payload);
    },

    'tray-list-biscotti': async () => {
      if (!options.listBiscotti) {
        throw new Error('biscotti: no active leader tray; cannot list seats');
      }
      return await options.listBiscotti();
    },

    'tray-preview-logs': async ({ previewToken }) => {
      if (!options.getPreviewLifecycleRecords) {
        throw new Error('serve --logs: no active leader tray; cannot read preview logs');
      }
      return options.getPreviewLifecycleRecords(previewToken);
    },

    'tray-preview-truncate': async ({ previewToken }) => {
      if (!options.truncatePreviewLifecycleRecords) {
        throw new Error('serve --truncate: no active leader tray; cannot truncate preview logs');
      }
      return options.truncatePreviewLifecycleRecords(previewToken);
    },

    'tray-leave': async ({ workerBaseUrl, requestId }) => {
      if (!options.leaveTray) {
        throw new Error('host leave: tray leave is not available in this environment');
      }
      return await options.leaveTray({ workerBaseUrl, requestId });
    },

    'tray-join': async ({ joinUrl, requestId }) => {
      if (!options.joinTray) {
        throw new Error('host join: tray join is not available in this environment');
      }
      return await options.joinTray({ joinUrl, requestId });
    },

    'cherry-emit': async ({ runtimeId, name, detail }) => {
      if (!options.emitCherrySliccEvent) {
        throw new Error('cherry-emit: not available in this environment');
      }
      return { delivered: options.emitCherrySliccEvent(runtimeId, name, detail) };
    },

    'tray-exec': async (payload) => {
      if (!options.execOnRemote) {
        throw new Error('ssh: no active leader tray in this environment');
      }
      return await options.execOnRemote(payload);
    },

    'tray-exec-signal': ({ execToken }) => {
      options.signalRemoteExec?.({ execToken });
      return { ok: true };
    },

    'tray-computer-native': async (payload) => {
      if (!options.computerNative) {
        throw new Error('computer native: no active leader tray in this environment');
      }
      return await options.computerNative(payload);
    },

    'oauth-extras-set': ({ providerId, domains }) => {
      setExtraOAuthDomains(providerId, domains);
      return { storeAfter: getAllExtraOAuthDomains() };
    },

    'silent-renew': async ({ providerId }) => {
      const { getRegisteredProviderConfig } = await import('../providers/index.js');
      const cfg = getRegisteredProviderConfig(providerId);
      if (!cfg?.onSilentRenew) return { accessToken: null };
      return { accessToken: await cfg.onSilentRenew() };
    },

    'save-oauth-accounts': ({ accountsJson }) => {
      localStorage.setItem('slicc_accounts', accountsJson);
      const storedJson = localStorage.getItem('slicc_accounts') ?? accountsJson;
      return { storedJson };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildSliccSidecarHandlers(options: StandalonePanelRpcHandlerOptions) {
  const runAborters = new Map<string, AbortController>();

  const requireSidecar = (): SidecarRegistryLike => {
    if (!options.sliccSidecar) {
      throw new Error('slicc: sidecar attachments are not available in this environment');
    }
    return options.sliccSidecar;
  };

  const withRun = async <T>(
    runToken: string,
    run: (sidecar: SidecarRegistryLike, signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const sidecar = requireSidecar();
    const controller = new AbortController();
    runAborters.set(runToken, controller);
    try {
      return await run(sidecar, controller.signal);
    } finally {
      runAborters.delete(runToken);
    }
  };

  return {
    'slicc-attach': async ({ joinUrl, name, connectTimeoutMs }) =>
      await requireSidecar().attach({ joinUrl, name, connectTimeoutMs }),

    'slicc-detach': ({ name }) => ({ detached: requireSidecar().detach(name) }),

    'slicc-list': () => ({ attachments: requireSidecar().list() }),

    'slicc-prompt': async ({ name, text, runToken, steer, timeoutMs }) =>
      await withRun(
        runToken,
        async (sidecar, signal) => await sidecar.prompt(name, text, { steer, timeoutMs, signal })
      ),

    'slicc-exec': async ({ name, command, runToken, cwd, env, timeoutMs, stdin }) =>
      await withRun(
        runToken,
        async (sidecar, signal) =>
          await sidecar.exec(name, command, { cwd, env, timeoutMs, stdin, signal })
      ),

    'slicc-watch': async ({ name, runToken, durationMs, scoopJid, untilIdle }) =>
      await withRun(
        runToken,
        async (sidecar, signal) =>
          await sidecar.watch(name, { durationMs, scoopJid, untilIdle, signal })
      ),

    'slicc-cancel': ({ runToken }) => {
      runAborters.get(runToken)?.abort();
      return { ok: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildUsbHandlers(options: StandalonePanelRpcHandlerOptions) {
  ensureUsbClaimEventRelay(options.emitEvent);
  return {
    'usb-list': async () => ({ devices: await usbOps.usbList(usbRegistry(), requireUsb()) }),

    'usb-request': async ({ filters }) => ({
      device: await usbOps.usbRequest(usbRegistry(), requireUsb(), filters),
    }),

    'usb-device-info': ({ handle }) => ({
      device: usbOps.usbDeviceInfo(usbRegistry(), handle),
    }),

    'usb-open': async ({ handle }) => {
      await usbOps.usbOpen(usbRegistry(), handle);
      return { done: true };
    },

    'usb-close': async ({ handle, owner, force }) => {
      await usbOps.usbClose(usbRegistry(), handle, { owner, force });
      return { done: true };
    },

    'usb-select-configuration': async ({ handle, configurationValue }) => {
      await usbOps.usbSelectConfiguration(usbRegistry(), handle, configurationValue);
      return { done: true };
    },

    'usb-claim-interface': async ({ handle, interfaceNumber, owner, wait }) => {
      await usbOps.usbClaimInterface(usbRegistry(), handle, interfaceNumber, { owner, wait });
      return { done: true };
    },

    'usb-release-interface': async ({ handle, interfaceNumber, owner }) => {
      await usbOps.usbReleaseInterface(usbRegistry(), handle, interfaceNumber, { owner });
      return { done: true };
    },

    'usb-cancel-claim-wait': async ({ handle, interfaceNumber, owner }) => {
      await usbOps.usbCancelClaimWait(
        usbRegistry(),
        handle,
        interfaceNumber,
        owner ?? DEFAULT_USB_OWNER
      );
      return { done: true };
    },

    'usb-drop-owner': async ({ owner }) => {
      await usbOps.usbDropOwner(usbRegistry(), owner);
      return { done: true };
    },

    'usb-control-transfer-in': async ({ handle, setup, length }) =>
      usbOps.usbControlTransferIn(usbRegistry(), handle, setup, length),

    'usb-control-transfer-out': async ({ handle, setup, bytes }) =>
      usbOps.usbControlTransferOut(usbRegistry(), handle, setup, bytes),

    'usb-transfer-in': async ({ handle, endpointNumber, length }) =>
      usbOps.usbTransferIn(usbRegistry(), handle, endpointNumber, length),

    'usb-transfer-out': async ({ handle, endpointNumber, bytes }) =>
      usbOps.usbTransferOut(usbRegistry(), handle, endpointNumber, bytes),

    'usb-reset': async ({ handle, owner, force }) => {
      await usbOps.usbReset(usbRegistry(), handle, { owner, force });
      return { done: true };
    },

    'usb-clear-halt': async ({ handle, direction, endpointNumber }) => {
      await usbOps.usbClearHalt(usbRegistry(), handle, direction, endpointNumber);
      return { done: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildHidHandlers(
  options: StandalonePanelRpcHandlerOptions,
  hidSubscriptions: Map<string, () => void>
) {
  return {
    'hid-list': async () => ({ devices: await hidOps.hidList(hidRegistry(), requireHid()) }),

    'hid-request': async ({ filters }) => ({
      devices: await hidOps.hidRequest(hidRegistry(), requireHid(), filters),
    }),

    'hid-device-info': ({ handle }) => ({
      device: hidOps.hidDeviceInfo(hidRegistry(), handle),
    }),

    'hid-open': async ({ handle }) => {
      await hidOps.hidOpen(hidRegistry(), handle);
      return { done: true };
    },

    'hid-close': async ({ handle }) => {
      await hidOps.hidClose(hidRegistry(), handle);
      return { done: true };
    },

    'hid-send-report': async ({ handle, reportId, bytes }) => {
      await hidOps.hidSendReport(hidRegistry(), handle, reportId, bytes);
      return { done: true };
    },

    'hid-send-feature-report': async ({ handle, reportId, bytes }) => {
      await hidOps.hidSendFeatureReport(hidRegistry(), handle, reportId, bytes);
      return { done: true };
    },

    'hid-receive-feature-report': async ({ handle, reportId }) =>
      hidOps.hidReceiveFeatureReport(hidRegistry(), handle, reportId),

    'hid-subscribe-input-reports': async ({ handle }) => {
      hidSubscriptions.get(handle)?.();
      const unsubscribe = await hidOps.hidSubscribeInputReports(hidRegistry(), handle, (report) => {
        options.emitEvent?.('hid-input-report', {
          handle,
          reportId: report.reportId,
          bytes: report.bytes,
        });
      });
      hidSubscriptions.set(handle, unsubscribe);
      return { done: true };
    },

    'hid-unsubscribe-input-reports': ({ handle }) => {
      hidSubscriptions.get(handle)?.();
      hidSubscriptions.delete(handle);
      return { done: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildSerialHandlers() {
  return {
    'serial-list': async () => ({
      devices: await serialOps.serialList(serialRegistry(), requireSerial()),
    }),

    'serial-request': async ({ filters }) => ({
      device: await serialOps.serialRequest(serialRegistry(), requireSerial(), filters),
    }),

    'serial-device-info': ({ handle }) => ({
      device: serialOps.serialDeviceInfo(serialRegistry(), handle),
    }),

    'serial-open': async ({ handle, options }) => {
      await serialOps.serialOpen(serialRegistry(), handle, options);
      return { done: true };
    },

    'serial-close': async ({ handle }) => {
      await serialOps.serialClose(serialRegistry(), handle);
      return { done: true };
    },

    'serial-read': async ({ handle, maxBytes, until, timeoutMs }) => {
      const bytes = await serialOps.serialRead(serialRegistry(), handle, {
        maxBytes,
        until: until ? new Uint8Array(until) : undefined,
        timeoutMs,
      });
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      return { bytes: buffer };
    },

    'serial-write': async ({ handle, bytes }) => ({
      bytesWritten: await serialOps.serialWrite(serialRegistry(), handle, new Uint8Array(bytes)),
    }),

    'serial-get-signals': async ({ handle }) => ({
      signals: await serialOps.serialGetSignals(serialRegistry(), handle),
    }),

    'serial-set-signals': async ({ handle, signals }) => {
      await serialOps.serialSetSignals(serialRegistry(), handle, signals);
      return { done: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildEsptoolHandlers(options: StandalonePanelRpcHandlerOptions) {
  return {
    'esptool-chip-info': async ({ handle, baudRate }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      return esptool.esptoolChipInfo(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
    },

    'esptool-read-mac': async ({ handle, baudRate }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      return esptool.esptoolReadMac(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
    },

    'esptool-erase-flash': async ({ handle, baudRate }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      await esptool.esptoolEraseFlash(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
      return { done: true };
    },

    'esptool-flash': async ({ handle, baudRate, eraseAll, segments }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      await esptool.esptoolFlash(
        serialRegistry(),
        handle,
        baudRate,
        eraseAll,
        segments.map((s) => ({ address: s.address, data: new Uint8Array(s.bytes) })),
        (line) => options.emitEvent?.('esptool-progress', { handle, line })
      );
      return { done: true };
    },

    'esptool-read-flash': async ({ handle, baudRate, address, size }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      const bytes = await esptool.esptoolReadFlash(
        serialRegistry(),
        handle,
        baudRate,
        address,
        size,
        (line) => options.emitEvent?.('esptool-progress', { handle, line })
      );
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      return { bytes: buffer };
    },

    'esptool-read-reg': async ({ handle, baudRate, address }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      return esptool.esptoolReadReg(serialRegistry(), handle, baudRate, address, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
    },

    'esptool-flash-id': async ({ handle, baudRate }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      return esptool.esptoolFlashId(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
    },

    'esptool-erase-region': async ({ handle, baudRate, address, size }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      await esptool.esptoolEraseRegion(serialRegistry(), handle, baudRate, address, size, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
      return { done: true };
    },

    'esptool-run': async ({ handle, baudRate }) => {
      const esptool = await import('../kernel/esptool-operations.js');
      await esptool.esptoolRun(serialRegistry(), handle, baudRate, (line) =>
        options.emitEvent?.('esptool-progress', { handle, line })
      );
      return { done: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function buildRemoteCdpHandlers(options: StandalonePanelRpcHandlerOptions) {
  return {
    'list-remote-targets': async () => {
      if (!options.listRemoteTargets) return { targets: [] };
      const all = await options.listRemoteTargets();

      const remote = all.filter((p) => p.targetId.includes(':'));
      return {
        targets: remote.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url })),
      };
    },

    'remote-cdp-send': async ({ runtimeId, localTargetId, method, params, sessionId, timeout }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.send({
        runtimeId,
        localTargetId,
        method,
        params,
        sessionId,
        timeout,
      });
    },

    'remote-cdp-subscribe': async ({ runtimeId, localTargetId, event }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.subscribe({ runtimeId, localTargetId, event });
    },

    'remote-cdp-unsubscribe': async ({ runtimeId, localTargetId, event }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.unsubscribe({ runtimeId, localTargetId, event });
    },

    'remote-cdp-detach': async ({ runtimeId, localTargetId }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.detach({ runtimeId, localTargetId });
    },

    'remote-open-tab': async ({ runtimeId, url }) => {
      if (!options.remoteCdp) throw new Error('remote-cdp bridge not available');
      return options.remoteCdp.openTab({ runtimeId, url });
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function skipIfGrantedForPermissionRpc(kinds: PermissionRpcKind[], explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return kinds.length > 0 && kinds.every((kind) => kind === 'camera' || kind === 'microphone');
}

function buildPermissionRequestHandler(options: StandalonePanelRpcHandlerOptions) {
  return {
    'permission-request': async (payload) => {
      const surface = options.getPermissionsSurface?.() ?? null;
      if (!surface) {
        throw new Error('permission-request: permission surface unavailable');
      }
      const result = await surface.prompt({
        kinds: payload.kinds,
        description: payload.description,
        heading: payload.heading,
        grantLabel: payload.grantLabel,
        cancelLabel: payload.cancelLabel,
        skipIfGranted: skipIfGrantedForPermissionRpc(payload.kinds, payload.skipIfGranted),
      });
      if (result.status !== 'granted') {
        const detail = result.message ? `: ${result.message}` : '';
        throw new Error(`permission-request: ${result.reason ?? result.status}${detail}`);
      }
      const out: PermissionRpcGrant[] = [];
      for (const grant of result.grants) {
        switch (grant.kind) {
          case 'usb': {
            const handle = usbRegistry().register(grant.device as UsbDevice);
            out.push({ kind: 'usb', handle });
            break;
          }
          case 'hid': {
            const handle = hidRegistry().register(grant.device as HidDevice);
            out.push({ kind: 'hid', handle });
            break;
          }
          case 'serial': {
            const handle = serialRegistry().register(grant.port as SerialPort);
            out.push({ kind: 'serial', handle });
            break;
          }
          case 'filesystem': {
            const { storePendingHandle } = await import('../fs/mount-picker-popup.js');
            const idbKey = `pendingMount:rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
            await storePendingHandle(idbKey, grant.handle);
            out.push({ kind: 'filesystem', idbKey, dirName: grant.handle.name });
            break;
          }
          case 'camera':
          case 'microphone':
          case 'screenshare': {
            for (const track of grant.stream.getTracks()) track.stop();
            out.push({ kind: grant.kind, ok: true });
            break;
          }
        }
      }
      return { grants: out };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function usbRegistry() {
  return getSharedUsbRegistry();
}

let usbClaimRelay: (() => void) | null = null;
let usbClaimEmit: ((channel: string, payload: unknown) => void) | undefined;
let screenEndedRelay: (() => void) | null = null;
let screenEndedEmit: ((channel: string, payload: unknown) => void) | undefined;

function ensureUsbClaimEventRelay(emitEvent?: (channel: string, payload: unknown) => void): void {
  usbClaimEmit = emitEvent;
  if (usbClaimRelay || !emitEvent) return;
  void import('../kernel/usb-claim-broker.js').then((m) => {
    if (usbClaimRelay) return;
    usbClaimRelay = m.addClaimListener(usbRegistry(), (event) => {
      usbClaimEmit?.('usb-claim-event', event);
    });
  });
}

function ensureScreenSessionEndedRelay(
  emitEvent?: (channel: string, payload: unknown) => void
): void {
  screenEndedEmit = emitEvent;
  if (screenEndedRelay || !emitEvent) return;
  void import('../shell/supplemental-commands/screencapture-media.js').then((m) => {
    if (screenEndedRelay) return;
    screenEndedRelay = m.displaySessions.onEnded((handle) => {
      screenEndedEmit?.(m.SCREENCAPTURE_SESSION_ENDED_CHANNEL, { handle });
    });
  });
}

function requireUsb() {
  const usb = getNavigatorUsb();
  if (!usb) throw new Error('WebUSB is unavailable in this browser');
  return usb;
}

function hidRegistry() {
  return getSharedHidRegistry();
}

function requireHid() {
  const hid = getNavigatorHid();
  if (!hid) throw new Error('WebHID is unavailable in this browser');
  return hid;
}

function serialRegistry() {
  return getSharedSerialRegistry();
}

function requireSerial() {
  const serial = getNavigatorSerial();
  if (!serial) throw new Error('Web Serial is unavailable in this browser');
  return serial;
}

export type { CameraCaptureRequest, CameraCaptureResult };

const DEFAULT_PHOTO_WARMUP_MS = 1500;

export async function captureCamera(req: CameraCaptureRequest): Promise<CameraCaptureResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia is not supported in this browser');
  }

  const wantVideo = req.mode === 'photo' || req.captureVideo !== false;
  const wantAudio = !!req.captureAudio && req.mode === 'video';
  if (!wantVideo && !wantAudio) {
    throw new Error('camera capture: at least one of video or audio must be requested');
  }
  const resolvedDeviceId = wantVideo
    ? await resolveDeviceId(req.deviceId, 'videoinput')
    : undefined;
  const resolvedAudioId = wantAudio
    ? await resolveDeviceId(req.audioDeviceId, 'audioinput')
    : undefined;

  const stream = await getStreamWithFallback({
    wantVideo,
    videoDeviceId: resolvedDeviceId,
    audioDeviceId: resolvedAudioId,
    wantAudio,
    width: req.width,
    height: req.height,
    frameRate: req.frameRate,
    exact: !!req.exactSize,
  });

  try {
    let video: HTMLVideoElement | null = null;
    let width = 0;
    let height = 0;
    if (wantVideo) {
      video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      const v = video;
      await new Promise<void>((resolve, reject) => {
        v.onloadedmetadata = () =>
          v
            .play()
            .then(() => resolve())
            .catch(reject);
        v.onerror = () => reject(new Error('Failed to load camera stream'));
      });

      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      width = v.videoWidth;
      height = v.videoHeight;
    }

    if (req.mode === 'photo') {
      if (!video) throw new Error('photo capture requires a video track');

      const warmupMs = req.warmupMs ?? DEFAULT_PHOTO_WARMUP_MS;
      if (warmupMs > 0) {
        await new Promise<void>((r) => setTimeout(r, warmupMs));
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');
      ctx.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to encode photo'))),
          req.mimeType,
          req.quality
        );
      });
      const buffer = await blob.arrayBuffer();
      return { bytes: buffer, mimeType: blob.type || req.mimeType, width, height };
    }

    const durationMs = Math.max(100, Math.min(req.durationMs ?? 5000, 60_000));
    const supported =
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(req.mimeType)
        ? req.mimeType
        : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType: supported });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    await new Promise<void>((r) => setTimeout(r, durationMs));
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: supported });
    const buffer = await blob.arrayBuffer();
    return {
      bytes: buffer,
      mimeType: blob.type || supported,
      width,
      height,
      durationMs,
    };
  } finally {
    stream.getTracks().forEach((t) => {
      t.stop();
    });
  }
}

async function resolveDeviceId(
  idOrIndex: string | undefined,
  kind: 'videoinput' | 'audioinput'
): Promise<string | undefined> {
  if (idOrIndex === undefined || idOrIndex === '') return undefined;
  if (!/^\d+$/.test(idOrIndex)) return idOrIndex;
  if (!navigator.mediaDevices?.enumerateDevices) return undefined;
  const idx = parseInt(idOrIndex, 10);
  const all = await navigator.mediaDevices.enumerateDevices();
  const filtered = all.filter((d) => d.kind === kind);
  return filtered[idx]?.deviceId;
}

interface StreamSpec {
  wantVideo: boolean;
  videoDeviceId: string | undefined;
  audioDeviceId: string | undefined;
  wantAudio: boolean;
  width?: number;
  height?: number;
  frameRate?: number;
  exact: boolean;
}

async function getStreamWithFallback(spec: StreamSpec): Promise<MediaStream> {
  const buildVideo = (mode: 'exact' | 'ideal'): MediaTrackConstraints | boolean => {
    if (!spec.wantVideo) return false;
    const c: MediaTrackConstraints = {};
    if (spec.videoDeviceId) c.deviceId = { exact: spec.videoDeviceId };
    if (spec.width) c.width = mode === 'exact' ? { exact: spec.width } : { ideal: spec.width };
    if (spec.height) c.height = mode === 'exact' ? { exact: spec.height } : { ideal: spec.height };
    if (spec.frameRate)
      c.frameRate = mode === 'exact' ? { exact: spec.frameRate } : { ideal: spec.frameRate };
    return Object.keys(c).length > 0 ? c : true;
  };
  const audioConstraint = (): MediaTrackConstraints | boolean => {
    if (!spec.wantAudio) return false;
    if (spec.audioDeviceId) return { deviceId: { exact: spec.audioDeviceId } };
    return true;
  };

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: buildVideo(spec.exact ? 'exact' : 'ideal'),
      audio: audioConstraint(),
    });
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (!spec.exact || (name !== 'OverconstrainedError' && name !== 'NotReadableError')) {
      throw err;
    }

    console.warn(
      `panel-rpc:capture-camera: exact ${spec.width ?? '?'}x${spec.height ?? '?'}@${spec.frameRate ?? '?'} unmet, falling back to ideal`
    );
    return await navigator.mediaDevices.getUserMedia({
      video: buildVideo('ideal'),
      audio: audioConstraint(),
    });
  }
}

async function openOAuthPopup(
  authorizeUrl: string,
  getPermissionsSurface?: () => SliccPermissions | null
): Promise<string | null> {
  const ua = (typeof navigator !== 'undefined' ? navigator.userActivation : undefined) as
    | { isActive?: boolean }
    | undefined;
  if (ua?.isActive === true) {
    const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
    return runOauthPopupRace(popup);
  }
  const surface = getPermissionsSurface?.() ?? null;
  if (surface) {
    const popup = await openOAuthPopupViaSurface(surface, authorizeUrl);
    if (popup === undefined) return null;
    return runOauthPopupRace(popup);
  }

  const popup = window.open(authorizeUrl, '_blank', 'width=500,height=700,popup=yes');
  return runOauthPopupRace(popup);
}

function runOauthPopupRace(popup: Window | null): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
    };

    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'oauth-callback') return;

      if (event.origin !== window.location.origin) return;
      if (popup && event.source !== popup) return;
      cleanup();
      if (event.data.error) {
        console.error('[panel-rpc:oauth-popup] OAuth error:', event.data.error);
        resolve(null);
        return;
      }
      const redirectUrl = event.data.redirectUrl;
      if (typeof redirectUrl !== 'string' && redirectUrl !== null && redirectUrl !== undefined)
        return;
      resolve(redirectUrl ?? null);
    };

    window.addEventListener('message', handler);

    pollTimer = setInterval(async () => {
      if (resolved) return;
      try {
        const res = await fetch(resolveApiUrl('/api/oauth-result'), {
          headers: apiHeaders(),
        });
        if (res.status === 204) return;
        if (!res.ok) return;
        const data = (await res.json()) as { redirectUrl?: string; error?: string };
        if (resolved) return;
        cleanup();
        if (data.error) {
          console.error('[panel-rpc:oauth-popup] Server relay OAuth error:', data.error);
          resolve(null);
          return;
        }
        resolve(data.redirectUrl ?? null);
      } catch (err) {
        console.warn(
          '[panel-rpc:oauth-popup] Poll failed:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }, 1000);

    const timer = setTimeout(() => {
      cleanup();
      try {
        popup?.close();
      } catch {}
      resolve(null);
    }, 120_000);
  });
}

async function openOAuthPopupViaSurface(
  surface: SliccPermissions,
  authorizeUrl: string
): Promise<Window | null | undefined> {
  const result = await surface.prompt({
    kinds: ['popup'],
    description: 'Continue to sign in. A new window will open to the provider.',
    grantLabel: 'Continue',
    requestOptions: { popup: { url: authorizeUrl } },
  });
  if (result.status !== 'granted') return undefined;
  const popupGrant = result.grants.find((g) => g.kind === 'popup');
  return popupGrant && popupGrant.kind === 'popup' ? popupGrant.window : null;
}

function toVoiceInfo(v: SpeechSynthesisVoice): {
  name: string;
  lang: string;
  default: boolean;
  onDevice: boolean;
} {
  return { name: v.name, lang: v.lang, default: v.default, onDevice: false };
}

async function reencodeAsPng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to load image for clipboard conversion'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get canvas context');
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('PNG re-encode failed'))),
        'image/png'
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function whenDocumentFocused(timeoutMs = 5 * 60_000): Promise<void> {
  if (typeof document === 'undefined') return;

  if (typeof document.hasFocus !== 'function') return;
  if (document.hasFocus()) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      clearTimeout(timer);
    };
    const onFocus = () => {
      if (document.hasFocus()) {
        cleanup();
        resolve();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for window focus'));
    }, timeoutMs);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
  });
}

function buildThemeHandler() {
  return {
    'theme-apply': async ({
      themeJson,
      action,
    }: {
      themeJson?: string;
      action: 'apply' | 'reset';
    }) => {
      const {
        importTheme,
        saveCustomTheme,
        setActiveTheme,
        clearActiveTheme,
        applyThemeOverrides,
      } = await import('./theme-engine.js');
      if (action === 'reset') {
        clearActiveTheme();
        applyThemeOverrides();
        return { applied: null };
      }
      if (themeJson) {
        const theme = importTheme(themeJson);
        saveCustomTheme(theme);
        setActiveTheme(theme.id);
        applyThemeOverrides();
        return { applied: theme.id };
      }
      return { applied: null };
    },
  };
}

function buildLayoutHandler() {
  return {
    'layout-apply': async (
      msg: import('../shell/supplemental-commands/layout-command.js').LayoutApplyMsg
    ) => {
      const { getLayoutApplier } = await import('./wc/layout-apply-registry.js');
      const applier = getLayoutApplier();
      if (!applier) return { applied: false, error: 'no layout is mounted' };

      const result = await applier(msg);
      return result ?? { applied: true };
    },
  } satisfies Partial<PanelRpcHandlers>;
}

function pageBrowser(): import('../cdp/browser-api.js').BrowserAPI {
  const g = globalThis as { __slicc_browser?: import('../cdp/browser-api.js').BrowserAPI };
  if (!g.__slicc_browser) throw new Error('no browser API on this page');
  return g.__slicc_browser;
}

function buildComputerTabHandlers() {
  return {
    'computer-tab-screenshot': async (payload) => {
      const { screenshotTab } = await import('../computers/adapters/tab.js');
      return screenshotTab(pageBrowser(), payload.targetId, {
        maxWidth: payload.maxWidth,
        format: payload.format,
      });
    },
    'computer-tab-input': async (payload) => {
      const { inputTab } = await import('../computers/adapters/tab.js');
      await inputTab(pageBrowser(), payload.targetId, payload.events);
      return { ok: true as const };
    },
  } satisfies Partial<PanelRpcHandlers>;
}
