import { CherryUnsupportedError, createCdpHostHandler } from './cdp-host-handlers.js';
import type { MountSliccOptions, SliccHandle } from './index.js';
import {
  acceptEnvelope,
  CHERRY_PROTOCOL_VERSION,
  type CherryEnvelope,
  isCherryEnvelope,
  isCherryVersionMismatch,
} from './protocol.js';

interface CdpResponseShape {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
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
  // JSON.stringify can throw on cyclic/non-serializable theme objects — a
  // malformed theme must not take down the whole handshake.
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

export function mountSliccImpl(options: MountSliccImplOptions): CherrySliccHandle {
  const sdkCreatedIframe = !options.iframe;
  const iframe = options.iframe ?? document.createElement('iframe');
  const src = new URL(options.sliccOrigin);
  // Normalize to the bare origin (drops any trailing slash / path / query the
  // caller passed in `sliccOrigin`, e.g. "http://localhost:8787/"). This must
  // match `MessageEvent.origin` on inbound postMessages, which browsers NEVER
  // report with a trailing slash — using the raw string here made the
  // `acceptEnvelope` allowlist check fail silently on a trailing slash,
  // surfacing only as an opaque 30s handshake timeout.
  const sliccOrigin = src.origin;
  src.searchParams.set('cherry', '1');
  if (options.uiOnly) src.searchParams.set('ui-only', '1'); // appended AFTER cherry=1
  iframe.src = src.toString();
  if (sdkCreatedIframe) {
    // Only style + append an iframe the SDK created; a caller-provided iframe is
    // placed and sized by the caller (e.g. the spoon launcher's shadow DOM).
    iframe.style.border = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    options.container?.appendChild(iframe);
  }

  let channelId: string | null = null;
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

  const dispatchCdp = async (
    env: Extract<CherryEnvelope, { kind: 'cdp.request' }>
  ): Promise<CdpResponseShape> => {
    const domain = env.method.split('.')[0] ?? env.method;
    try {
      const granted = options.hooks?.onPermissionRequest
        ? await options.hooks.onPermissionRequest(domain)
        : true;
      if (!granted) {
        return { error: { code: -32601, message: `Cherry: permission denied for ${domain}` } };
      }
      const result = await hostHandler(env.method, env.params ?? {});
      return { result };
    } catch (err) {
      if (err instanceof CherryUnsupportedError) {
        return { error: { code: err.code, message: err.message } };
      }
      return {
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  };

  const handleEnvelope = async (env: CherryEnvelope): Promise<CdpResponseShape | undefined> => {
    switch (env.kind) {
      case 'handshake.hello': {
        channelId = env.channelId;
        post(buildWelcomeEnvelope(channelId, options));
        options.hooks?.onHandshakeComplete?.();
        return undefined;
      }
      case 'cdp.request': {
        const resp = await dispatchCdp(env);
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
      default:
        return undefined;
    }
  };

  /** True when the message passes origin + source (factors 1-2) of the gate. */
  const passesTrustFactors = (event: MessageEvent): boolean =>
    [sliccOrigin].includes(event.origin) && event.source === iframe.contentWindow;

  /**
   * Detect a re-hello: a well-formed handshake.hello from a trusted peer
   * (origin + source match) carrying a channelId that differs from the pinned
   * one. This happens when the iframe reloads (host-page re-render, follower
   * stale-chunk recovery, crashed renderer restore) — the new page boots a
   * fresh CherryHostTransport and mints a new channelId.
   *
   * Security: a re-hello from the same origin + WindowProxy is equivalent in
   * power to the initial hello — the trust basis is identical (the browser
   * guarantees WindowProxy identity across same-origin navigations). Accepting
   * it does NOT weaken factors 1-2; it only relaxes factor 3 for this specific
   * envelope kind so the re-pin code in handleEnvelope is reachable.
   */
  const isReHello = (event: MessageEvent): boolean =>
    channelId !== null &&
    passesTrustFactors(event) &&
    isCherryEnvelope(event.data) &&
    event.data.kind === 'handshake.hello' &&
    event.data.channelId !== channelId;

  // Shared catch handler for handleEnvelope rejections. handleEnvelope already
  // converts cdp.request failures into a posted cdp.response.error. A reject
  // here means a handshake/event handler threw unexpectedly — log so it doesn't
  // vanish as a silent 30s leader timeout.
  const onEnvelopeError = (err: unknown) => {
    console.error('[cherry] envelope handling failed', err);
  };

  const onMessage = (event: MessageEvent) => {
    // Accept a re-hello from a reloaded iframe before the standard gate —
    // the standard gate would reject it because channelId changed.
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
      // A version-skewed follower fails `isCherryEnvelope` itself — without
      // this distinct log the skew is indistinguishable from the 30s timeout.
      if (isCherryVersionMismatch(event.data)) {
        console.warn('[cherry] protocol version mismatch — update the older side', {
          peerVersion: event.data.cherry,
          ourVersion: CHERRY_PROTOCOL_VERSION,
          origin: event.origin,
        });
      } else if (isCherryEnvelope(event.data)) {
        // A well-formed cherry envelope that still fails the gate is almost
        // always a misconfiguration (wrong sliccOrigin, source/channel mismatch).
        // Surface it — otherwise it manifests downstream as an opaque 30s
        // handshake/CDP timeout. Non-cherry postMessage noise stays silent.
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
      post({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId,
        kind: 'host.event',
        name,
        detail,
      });
    },
    destroy() {
      window.removeEventListener('message', onMessage);
      if (sdkCreatedIframe) iframe.remove(); // never remove a caller-provided iframe
    },
    testReceive: (env) => handleEnvelope(env),
  };
}
