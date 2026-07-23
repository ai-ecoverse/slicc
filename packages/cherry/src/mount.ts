import { CherryUnsupportedError, createCdpHostHandler } from './cdp-host-handlers.js';
import type { MountSliccOptions, SliccHandle } from './index.js';
import {
  acceptEnvelope,
  CHERRY_PROTOCOL_VERSION,
  type CherryEnvelope,
  isCherryEnvelope,
  isCherryVersionMismatch,
} from './protocol.js';
import {
  type ExportSessionOptions,
  TranscriptExportError,
  type TranscriptExportProgress,
} from './transcript-types.js';

interface CdpResponseShape {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface PendingExport {
  resolve: (blob: Blob) => void;
  reject: (error: TranscriptExportError) => void;
  onProgress?: (progress: TranscriptExportProgress) => void;
  onAbort: () => void;
  signal?: AbortSignal;
}

export interface CherrySliccHandle extends SliccHandle {
  /** Test seam: feed a parsed envelope as if it arrived via postMessage. */
  testReceive(env: CherryEnvelope): Promise<CdpResponseShape | undefined>;
}

/** `mountSliccImpl` accepts an optional `__test_post` seam to capture outbound envelopes in tests. */
type MountSliccImplOptions = MountSliccOptions & {
  __test_post?: (env: CherryEnvelope) => void;
};

function buildWelcomeEnvelope(
  newChannelId: string,
  options: MountSliccImplOptions
): Extract<CherryEnvelope, { kind: 'handshake.welcome' }> {
  const resolvedFeatures = {
    terminal: true,
    files: true,
    memory: true,
    browser: true,
    modelPicker: true,
    history: true,
    nav: true,
    newSprinkle: true,
    monitor: true,
    showTimestamps: true,
    ...options.features,
  };
  let themeJson: string | undefined;
  if (options.theme) {
    try {
      themeJson = JSON.stringify(options.theme);
    } catch (err) {
      console.warn('[cherry] options.theme is not JSON-serializable — sending no theme', err);
    }
  }
  return {
    cherry: CHERRY_PROTOCOL_VERSION,
    channelId: newChannelId,
    kind: 'handshake.welcome',
    joinUrl: options.joinToken,
    features: resolvedFeatures,
    ...(themeJson ? { theme: themeJson } : {}),
    ...(options.effortLevel ? { effortLevel: options.effortLevel } : {}),
  };
}

// ---------------------------------------------------------------------------
// Export lifecycle helpers (module-level; take pendingExports as parameter)
// ---------------------------------------------------------------------------

function settlePending(
  pending: Map<string, PendingExport>,
  requestId: string,
  outcome: { resolve: Blob } | { reject: TranscriptExportError }
): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  entry.signal?.removeEventListener('abort', entry.onAbort);
  pending.delete(requestId);
  if ('resolve' in outcome) entry.resolve(outcome.resolve);
  else entry.reject(outcome.reject);
}

function rejectAllPending(
  pending: Map<string, PendingExport>,
  code: TranscriptExportError['code']
): void {
  for (const [id, entry] of pending) {
    entry.signal?.removeEventListener('abort', entry.onAbort);
    entry.reject(new TranscriptExportError(code));
    pending.delete(id);
  }
}

function handleExportProgress(
  pending: Map<string, PendingExport>,
  env: Extract<CherryEnvelope, { kind: 'session.export.progress' }>
): void {
  pending.get(env.requestId)?.onProgress?.({
    phase: env.phase,
    processedBytes: env.processedBytes,
    estimatedBytes: env.estimatedBytes,
  });
}

function handleExportResponse(
  pending: Map<string, PendingExport>,
  env: Extract<CherryEnvelope, { kind: 'session.export.response' }>
): void {
  if (!(env.blob instanceof Blob) || env.blob.type !== 'application/zip') {
    settlePending(pending, env.requestId, {
      reject: new TranscriptExportError('transfer-corrupt'),
    });
    return;
  }
  settlePending(pending, env.requestId, { resolve: env.blob });
}

function handleExportError(
  pending: Map<string, PendingExport>,
  env: Extract<CherryEnvelope, { kind: 'session.export.error' }>
): void {
  settlePending(pending, env.requestId, {
    reject: new TranscriptExportError(env.code as TranscriptExportError['code']),
  });
}

async function dispatchCdp(
  env: Extract<CherryEnvelope, { kind: 'cdp.request' }>,
  hostHandler: ReturnType<typeof createCdpHostHandler>,
  onPermissionRequest?: (domain: string) => boolean | Promise<boolean>
): Promise<CdpResponseShape> {
  const domain = env.method.split('.')[0] ?? env.method;
  try {
    const granted = onPermissionRequest ? await onPermissionRequest(domain) : true;
    if (!granted) {
      return { error: { code: -32601, message: `Cherry: permission denied for ${domain}` } };
    }
    return { result: await hostHandler(env.method, env.params ?? {}) };
  } catch (err) {
    if (err instanceof CherryUnsupportedError)
      return { error: { code: err.code, message: err.message } };
    return { error: { code: -32000, message: err instanceof Error ? err.message : String(err) } };
  }
}

// ---------------------------------------------------------------------------
// Export session factory — captures post + channelId reference via getter
// ---------------------------------------------------------------------------

function buildExportSession(
  pending: Map<string, PendingExport>,
  post: (env: CherryEnvelope) => void,
  getChannelId: () => string | null
): (opts?: ExportSessionOptions) => Promise<Blob> {
  return function exportSession(opts?) {
    const channelId = getChannelId();
    if (channelId === null) return Promise.reject(new TranscriptExportError('transfer-aborted'));
    const signal = opts?.signal;
    if (signal?.aborted) return Promise.reject(new TranscriptExportError('transfer-aborted'));
    const requestId = crypto.randomUUID();
    return new Promise<Blob>((resolve, reject) => {
      const onAbort = () => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        post({
          cherry: CHERRY_PROTOCOL_VERSION,
          channelId,
          kind: 'session.export.cancel',
          requestId,
        });
        reject(new TranscriptExportError('transfer-aborted'));
      };
      pending.set(requestId, { resolve, reject, onProgress: opts?.onProgress, onAbort, signal });
      signal?.addEventListener('abort', onAbort, { once: true });
      const env: Extract<CherryEnvelope, { kind: 'session.export.request' }> = {
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId,
        kind: 'session.export.request',
        requestId,
      };
      if (opts?.sessionId !== undefined) (env as { sessionId?: string }).sessionId = opts.sessionId;
      post(env);
    });
  };
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountSliccImpl(options: MountSliccImplOptions): CherrySliccHandle {
  const sdkCreatedIframe = !options.iframe;
  const iframe = options.iframe ?? document.createElement('iframe');
  const src = new URL(options.sliccOrigin);
  // Normalize to bare origin — MessageEvent.origin never carries a trailing slash.
  const sliccOrigin = src.origin;
  src.searchParams.set('cherry', '1');
  if (options.uiOnly) src.searchParams.set('ui-only', '1');
  iframe.src = src.toString();
  if (sdkCreatedIframe) {
    iframe.style.border = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    options.container?.appendChild(iframe);
  }

  let channelId: string | null = null;
  const pending = new Map<string, PendingExport>();
  const hostHandler = createCdpHostHandler({
    capabilities: options.capabilities,
    onOpenUrl: options.hooks?.onOpenUrl,
  });
  const post = (env: CherryEnvelope) => {
    if (options.__test_post) {
      options.__test_post(env);
      return;
    }
    iframe.contentWindow?.postMessage(env, sliccOrigin);
  };
  const exportSession = buildExportSession(pending, post, () => channelId);

  const handleEnvelope = async (env: CherryEnvelope): Promise<CdpResponseShape | undefined> => {
    switch (env.kind) {
      case 'handshake.hello': {
        rejectAllPending(pending, 'transfer-aborted');
        channelId = env.channelId;
        post(buildWelcomeEnvelope(channelId, options));
        options.hooks?.onHandshakeComplete?.();
        return undefined;
      }
      case 'cdp.request': {
        const resp = await dispatchCdp(env, hostHandler, options.hooks?.onPermissionRequest);
        post({
          cherry: CHERRY_PROTOCOL_VERSION,
          channelId: channelId!,
          kind: 'cdp.response',
          id: env.id,
          ...resp,
        });
        return resp;
      }
      case 'slicc.event': {
        options.hooks?.onSliccEvent?.(env.name, env.detail);
        if (env.name === 'open-url' && options.capabilities.openUrl) {
          const url = (env.detail as { url?: string } | undefined)?.url;
          if (url) options.hooks?.onOpenUrl?.(url);
        }
        return undefined;
      }
      case 'session.export.progress':
        handleExportProgress(pending, env);
        return undefined;
      case 'session.export.response':
        handleExportResponse(pending, env);
        return undefined;
      case 'session.export.error':
        handleExportError(pending, env);
        return undefined;
      default:
        return undefined;
    }
  };

  const passesTrust = (ev: MessageEvent) =>
    ev.origin === sliccOrigin && ev.source === iframe.contentWindow;
  const isReHello = (ev: MessageEvent) =>
    channelId !== null &&
    passesTrust(ev) &&
    isCherryEnvelope(ev.data) &&
    ev.data.kind === 'handshake.hello' &&
    ev.data.channelId !== channelId;
  const onEnvelopeError = (err: unknown) => console.error('[cherry] envelope handling failed', err);

  const onMessage = (event: MessageEvent) => {
    if (isReHello(event)) {
      console.info('[cherry] re-hello from reloaded iframe — re-handshaking', {
        oldChannelId: channelId,
        newChannelId: (event.data as CherryEnvelope).channelId,
      });
      void handleEnvelope(event.data as CherryEnvelope).catch(onEnvelopeError);
      return;
    }
    if (
      !acceptEnvelope(event, {
        allowOrigins: [sliccOrigin],
        expectedSource: iframe.contentWindow,
        channelId,
      })
    ) {
      if (isCherryVersionMismatch(event.data)) {
        console.warn('[cherry] protocol version mismatch — update the older side', {
          peerVersion: event.data.cherry,
          ourVersion: CHERRY_PROTOCOL_VERSION,
        });
      } else if (isCherryEnvelope(event.data)) {
        console.warn('[cherry] rejected a cherry envelope (origin/source/channel mismatch)', {
          origin: event.origin,
          expectedOrigin: sliccOrigin,
        });
      }
      return;
    }
    void handleEnvelope(event.data as CherryEnvelope).catch(onEnvelopeError);
  };
  window.addEventListener('message', onMessage);

  return {
    iframe,
    emitHostEvent(name, detail) {
      if (channelId === null) {
        console.warn('[cherry] emitHostEvent dropped before handshake completed', { name });
        return;
      }
      post({ cherry: CHERRY_PROTOCOL_VERSION, channelId, kind: 'host.event', name, detail });
    },
    exportSession,
    destroy() {
      window.removeEventListener('message', onMessage);
      rejectAllPending(pending, 'transfer-aborted');
      if (sdkCreatedIframe) iframe.remove();
    },
    testReceive: (env) => handleEnvelope(env),
  };
}
