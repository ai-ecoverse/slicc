import { TranscriptExportError, type TranscriptExportProgress } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserAPI } from '../../src/cdp/browser-api.js';
import {
  CHERRY_PROTOCOL_VERSION,
  SUPPORTED_CHERRY_PROTOCOL_VERSIONS,
} from '../../src/cdp/cherry-host-protocol.js';
import { CherryHostTransport } from '../../src/cdp/cherry-host-transport.js';

function makeTransport() {
  const posted: any[] = [];
  const parent = { postMessage: (m: any) => posted.push(m) } as unknown as Window;
  const transport = new CherryHostTransport({
    counterpart: parent,
    allowOrigins: ['https://host.example'],
    targetOrigin: 'https://host.example',
  });
  // Drive inbound messages as if from the host.
  const inbound = (data: any) =>
    transport.testReceive({
      origin: 'https://host.example',
      source: parent as unknown as MessageEventSource,
      data,
    } as MessageEvent);
  return { transport, posted, parent, inbound };
}

describe('CherryHostTransport', () => {
  let h: ReturnType<typeof makeTransport>;
  beforeEach(() => {
    h = makeTransport();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('handshakes: sends hello, resolves connect on welcome', async () => {
    const p = h.transport.connect();
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');
    expect(hello).toBeTruthy();
    expect(hello.cherry).toBe(CHERRY_PROTOCOL_VERSION);
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
      joinUrl: 'https://app.example/join?t=Z',
    });
    await expect(p).resolves.toBeUndefined();
    expect(h.transport.state).toBe('connected');
    expect(h.transport.joinUrl).toBe('https://app.example/join?t=Z');
  });

  it('rejects connect() immediately with a distinct error on a version-mismatched welcome', async () => {
    const p = h.transport.connect();
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Host SDK speaking a different cherry version — fails the structural validator, but
      // must be diagnosed as skew (and fail fast), not eaten as noise.
      h.inbound({
        cherry: CHERRY_PROTOCOL_VERSION + 1,
        channelId: hello.channelId,
        kind: 'handshake.welcome',
      });
      await expect(p).rejects.toThrow(
        new RegExp(`version mismatch \\(peer v${CHERRY_PROTOCOL_VERSION + 1}`)
      );
    } finally {
      warnSpy.mockRestore();
    }
    expect(h.transport.state).toBe('disconnected');
  });

  it('does not fail the handshake on a mismatch-shaped message from an untrusted origin', async () => {
    const p = h.transport.connect();
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Hostile frame: right shape, wrong origin — must NOT kill the handshake.
      h.transport.testReceive({
        origin: 'https://evil.example',
        source: {} as MessageEventSource,
        data: {
          cherry: CHERRY_PROTOCOL_VERSION + 1,
          channelId: hello.channelId,
          kind: 'handshake.welcome',
        },
      } as MessageEvent);
    } finally {
      warnSpy.mockRestore();
    }

    // Still pending — a valid welcome completes it.
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hello.channelId,
      kind: 'handshake.welcome',
    });
    await expect(p).resolves.toBeUndefined();
    expect(h.transport.state).toBe('connected');
  });

  it('synthesizes Target.getTargets locally without a host round-trip', async () => {
    await connectHelper(h);
    const res = await h.transport.send('Target.getTargets');
    expect(Array.isArray((res as any).targetInfos)).toBe(true);
    expect((res as any).targetInfos[0].type).toBe('page');
  });

  it('forwards leaf methods and resolves on cdp.response', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const p = h.transport.send('Runtime.evaluate', { expression: '1+1' });
    const req = h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'Runtime.evaluate');
    expect(req).toBeTruthy();
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      result: { result: { type: 'number', value: 2 } },
    });
    await expect(p).resolves.toEqual({ result: { type: 'number', value: 2 } });
  });

  it('evaluates a frame in the Cherry host page main world', async () => {
    await connectHelper(h);
    const api = new BrowserAPI(h.transport);
    await api.attachToPage('cherry-target');

    const evaluation = api.evaluateInFrame('cherry-frame', 'window.appState', { world: 'main' });
    await vi.waitFor(() => {
      expect(
        h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'Runtime.evaluate')
      ).toBeTruthy();
    });
    const req = h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'Runtime.evaluate');
    expect(req.params).toMatchObject({ expression: 'window.appState', contextId: 1 });
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: lastChannelId(h),
      kind: 'cdp.response',
      id: req.id,
      result: { result: { type: 'string', value: 'page-state' } },
    });

    await expect(evaluation).resolves.toBe('page-state');
    api.disconnect();
  });

  it('gets a frame snapshot through the synthetic Cherry isolated world', async () => {
    await connectHelper(h);
    const api = new BrowserAPI(h.transport);
    await api.attachToPage('cherry-target');

    const snapshot = api.getAccessibilityTreeForFrame('cherry-frame');
    await vi.waitFor(() => {
      expect(h.posted.some((m) => m.kind === 'cdp.request')).toBe(true);
    });
    const requests = h.posted.filter((m) => m.kind === 'cdp.request');
    expect(requests.map((request) => request.method)).toEqual(['Runtime.evaluate']);
    expect(requests[0].params).toMatchObject({
      contextId: 1,
      awaitPromise: false,
      returnByValue: true,
    });
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: lastChannelId(h),
      kind: 'cdp.response',
      id: requests[0].id,
      result: {
        result: {
          type: 'object',
          value: { role: 'RootWebArea', name: 'Cherry frame' },
        },
      },
    });

    await expect(snapshot).resolves.toMatchObject({ role: 'RootWebArea', name: 'Cherry frame' });
    api.disconnect();
  });

  it('emits frameNavigated + loadEventFired after Page.navigate resolves', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const events: string[] = [];
    h.transport.on('Page.frameNavigated', () => events.push('frameNavigated'));
    h.transport.on('Page.loadEventFired', () => events.push('loadEventFired'));
    const p = h.transport.send('Page.navigate', { url: 'https://host.example/next' });
    const req = h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'Page.navigate');
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      result: { frameId: 'cherry-frame' },
    });
    await p;
    expect(events).toEqual(['frameNavigated', 'loadEventFired']);
  });

  // -------------------------------------------------------------------------
  // Protocol version negotiation (regression: 2026-07-27 labs handshake timeout
  // — a host page with a vendored v1 SDK silently dropped the v2 hello and the
  // iframe ate the full 30s timeout).
  // -------------------------------------------------------------------------

  it('posts one hello per supported protocol version, newest first, same channelId', async () => {
    const p = h.transport.connect();
    const hellos = h.posted.filter((m) => m.kind === 'handshake.hello');
    expect(hellos.map((m) => m.cherry)).toEqual([...SUPPORTED_CHERRY_PROTOCOL_VERSIONS]);
    expect(SUPPORTED_CHERRY_PROTOCOL_VERSIONS[0]).toBe(CHERRY_PROTOCOL_VERSION);
    // Same channelId on every hello: a legacy host must not read the extra
    // hello as a reloaded-iframe re-handshake (isReHello keys on channelId).
    expect(new Set(hellos.map((m) => m.channelId)).size).toBe(1);
    // Settle the connect so the test doesn't leak a pending timer.
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId: hellos[0].channelId,
      kind: 'handshake.welcome',
    });
    await p;
  });

  it('completes the handshake against a legacy v1 host SDK', async () => {
    const p = h.transport.connect();
    // A vendored v1 host rejects the v2 hello (console.warn only, no reply) and
    // answers ONLY a v1 hello with a v1 welcome.
    const v1Hello = h.posted.find((m) => m.kind === 'handshake.hello' && m.cherry === 1);
    expect(v1Hello).toBeTruthy();
    h.inbound({
      cherry: 1,
      channelId: v1Hello.channelId,
      kind: 'handshake.welcome',
      joinUrl: 'https://app.example/join?t=L',
    });
    await expect(p).resolves.toBeUndefined();
    expect(h.transport.state).toBe('connected');
    expect(h.transport.joinUrl).toBe('https://app.example/join?t=L');
    expect(h.transport.negotiatedProtocolVersion).toBe(1);
  });

  it('stamps outbound envelopes with the negotiated version after a v1 welcome', async () => {
    const p = h.transport.connect();
    const v1Hello = h.posted.find((m) => m.kind === 'handshake.hello' && m.cherry === 1);
    h.inbound({ cherry: 1, channelId: v1Hello.channelId, kind: 'handshake.welcome' });
    await p;
    // slicc.event — the v1 host's acceptEnvelope would drop a v2-stamped one.
    h.transport.emitSliccEventToHost('build.done');
    const ev = h.posted.find((m) => m.kind === 'slicc.event');
    expect(ev.cherry).toBe(1);
    // cdp.request — same wire-version requirement.
    void h.transport.send('Runtime.evaluate', { expression: '1' }).catch(() => {});
    const req = h.posted.find((m) => m.kind === 'cdp.request');
    expect(req.cherry).toBe(1);
    h.transport.disconnect();
  });

  it('accepts inbound v1 envelopes after negotiating v1', async () => {
    const p = h.transport.connect();
    const v1Hello = h.posted.find((m) => m.kind === 'handshake.hello' && m.cherry === 1);
    h.inbound({ cherry: 1, channelId: v1Hello.channelId, kind: 'handshake.welcome' });
    await p;
    const seen: string[] = [];
    h.transport.onHostEvent = (name) => seen.push(name);
    h.inbound({
      cherry: 1,
      channelId: v1Hello.channelId,
      kind: 'host.event',
      name: 'checkout-done',
    });
    expect(seen).toEqual(['checkout-done']);
  });

  it('ignores session.export.request after negotiating v1 (v2-only envelope kind)', async () => {
    const p = h.transport.connect();
    const v1Hello = h.posted.find((m) => m.kind === 'handshake.hello' && m.cherry === 1);
    h.inbound({ cherry: 1, channelId: v1Hello.channelId, kind: 'handshake.welcome' });
    await p;
    h.transport.onExportRequest = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.inbound({
        cherry: 1,
        channelId: v1Hello.channelId,
        kind: 'session.export.request',
        requestId: 'req-v1-export',
      });
    } finally {
      warnSpy.mockRestore();
    }
    expect(h.transport.onExportRequest).not.toHaveBeenCalled();
    expect(h.posted.find((m) => m.kind === 'session.export.error')).toBeUndefined();
  });

  it('fails fast on a trusted welcome with a version outside the supported set', async () => {
    const p = h.transport.connect();
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');
    const unsupported = Math.max(...SUPPORTED_CHERRY_PROTOCOL_VERSIONS) + 1;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.inbound({ cherry: unsupported, channelId: hello.channelId, kind: 'handshake.welcome' });
      // String argument = substring match (avoids a dynamically-built RegExp).
      await expect(p).rejects.toThrow(`version mismatch (peer v${unsupported}`);
    } finally {
      warnSpy.mockRestore();
    }
    expect(h.transport.state).toBe('disconnected');
  });

  it('does not fail a pending connect on a version-skewed envelope with a stale channelId', async () => {
    // A delayed handshake.version-mismatch reply from a PREVIOUS connect
    // attempt (or another transport on the same parent) carries a different
    // channelId — it must not kill the current pending handshake.
    const p = h.transport.connect();
    const hello = h.posted.find((m) => m.kind === 'handshake.hello');
    const unsupported = Math.max(...SUPPORTED_CHERRY_PROTOCOL_VERSIONS) + 1;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.inbound({
        cherry: unsupported,
        channelId: 'cherry-stale-previous-attempt',
        kind: 'handshake.version-mismatch',
        peerVersion: 2,
      });
      // Still pending — a valid welcome for THIS attempt completes it.
      h.inbound({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: hello.channelId,
        kind: 'handshake.welcome',
      });
      await expect(p).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
    expect(h.transport.state).toBe('connected');
  });

  it('rejects connect and resets state when the handshake times out', async () => {
    vi.useFakeTimers();
    const p = h.transport.connect();
    const rejection = expect(p).rejects.toThrow(/Cherry handshake timed out after \d+ms/);
    await vi.advanceTimersByTimeAsync(30000);
    await rejection;
    expect(h.transport.state).toBe('disconnected');
  });

  it('rejects the send promise on a cdp.response error', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const p = h.transport.send('SomeDomain.method');
    const req = h.posted.find((m) => m.kind === 'cdp.request' && m.method === 'SomeDomain.method');
    expect(req).toBeTruthy();
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'cdp.response',
      id: req.id,
      error: { code: -32601, message: 'nope' },
    });
    await expect(p).rejects.toThrow(/nope.*-32601|-32601.*nope/s);
  });

  it('rejects pending sends when disconnect is called', async () => {
    await connectHelper(h);
    const p = h.transport.send('SomeDomain.method');
    // do not resolve it; disconnect should reject it
    h.transport.disconnect();
    await expect(p).rejects.toThrow(/disconnected/);
  });

  it('rejects inbound from a foreign origin', async () => {
    await connectHelper(h);
    const before = h.posted.length;
    h.transport.testReceive({
      origin: 'https://evil.example',
      source: h.parent as unknown as MessageEventSource,
      data: { cherry: CHERRY_PROTOCOL_VERSION, channelId: 'x', kind: 'cdp.event', method: 'X' },
    } as MessageEvent);
    expect(h.posted.length).toBe(before); // no reaction
  });

  it('emitSliccEventToHost posts a slicc.event envelope to the host', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    h.transport.emitSliccEventToHost('build.done', { ok: true });
    const env = h.posted.find((m) => m.kind === 'slicc.event');
    expect(env).toBeTruthy();
    expect(env.cherry).toBe(CHERRY_PROTOCOL_VERSION);
    expect(env.channelId).toBe(channelId);
    expect(env.name).toBe('build.done');
    expect(env.detail).toEqual({ ok: true });
  });

  it('emitSliccEventToHost drops (no post) before the handshake completes', () => {
    // Never connected → channelId is null. Must not post a malformed envelope.
    const before = h.posted.length;
    h.transport.emitSliccEventToHost('too.early');
    expect(h.posted.length).toBe(before);
  });

  it('invokes onHostEvent for an inbound host.event envelope', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const seen: Array<{ name: string; detail?: unknown }> = [];
    h.transport.onHostEvent = (name, detail) => seen.push({ name, detail });
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'host.event',
      name: 'checkout-done',
      detail: { id: 7 },
    });
    expect(seen).toEqual([{ name: 'checkout-done', detail: { id: 7 } }]);
  });

  it('ignores an inbound host.event when no onHostEvent is wired', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const before = h.posted.length;
    // No onHostEvent set — must not throw or react.
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'host.event',
      name: 'noop',
    });
    expect(h.posted.length).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // Export bridge behavioral tests (H-1)
  // ---------------------------------------------------------------------------

  it('calls onExportRequest and posts session.export.response with the Blob', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const verifiedBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' });
    h.transport.onExportRequest = vi.fn().mockResolvedValue(verifiedBlob);

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-export-1',
      sessionId: 'active',
    });
    // Wait for the async handler to settle.
    await new Promise((r) => setTimeout(r, 0));

    const resp = h.posted.find((m) => m.kind === 'session.export.response');
    expect(resp).toBeTruthy();
    expect(resp.requestId).toBe('req-export-1');
    expect(resp.blob).toBe(verifiedBlob);
    expect(resp.channelId).toBe(channelId);
  });

  it('posts session.export.progress envelopes via the onProgress callback', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const blob = new Blob([], { type: 'application/zip' });
    type OnProgressFn = (p: TranscriptExportProgress) => void;
    const captured: { onProgress: OnProgressFn | null; resolve: ((b: Blob) => void) | null } = {
      onProgress: null,
      resolve: null,
    };
    h.transport.onExportRequest = (
      _rId: string,
      _sId: string | undefined,
      _signal: AbortSignal,
      onProgress: OnProgressFn
    ) => {
      captured.onProgress = onProgress;
      return new Promise<Blob>((res) => {
        captured.resolve = res;
      });
    };

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-prog-1',
    });
    await new Promise((r) => setTimeout(r, 0));
    // Fire progress while export is still in-flight (before resolve).
    captured.onProgress?.({ phase: 'packaging' });

    const prog = h.posted.filter((m) => m.kind === 'session.export.progress');
    expect(prog.length).toBeGreaterThan(0);
    expect(prog[0].phase).toBe('packaging');
    expect(prog[0].requestId).toBe('req-prog-1');
    // Settle the export so the test doesn't leak open handles.
    captured.resolve?.(blob);
    await new Promise((r) => setTimeout(r, 0));
  });

  it('posts session.export.error when onExportRequest rejects with a code', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const err = Object.assign(new Error('denied'), { code: 'permission-denied' });
    h.transport.onExportRequest = vi.fn().mockRejectedValue(err);

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-err-1',
    });
    await new Promise((r) => setTimeout(r, 0));

    const errEnv = h.posted.find((m) => m.kind === 'session.export.error');
    expect(errEnv).toBeTruthy();
    expect(errEnv.requestId).toBe('req-err-1');
    expect(errEnv.code).toBe('permission-denied');
  });

  it('posts session.export.error with transfer-corrupt when rejection has an unknown string code', async () => {
    // Exercises the new guard: maybeCode is a non-empty string but is not in
    // VALID_EXPORT_ERROR_CODES. The clamp must fall back to 'transfer-corrupt'.
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const err = Object.assign(new Error('totally unknown'), { code: 'totally-unknown' });
    h.transport.onExportRequest = vi.fn().mockRejectedValue(err);

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-unknown-code-1',
    });
    await new Promise((r) => setTimeout(r, 0));

    const errEnv = h.posted.find((m) => m.kind === 'session.export.error');
    expect(errEnv?.requestId).toBe('req-unknown-code-1');
    expect(errEnv?.code).toBe('transfer-corrupt');
  });

  it('clamps a TranscriptExportError whose code is noncanonical at runtime', async () => {
    // The declared TranscriptExportErrorCode type is not a runtime guarantee:
    // a JS caller, unchecked cast, or later mutation can carry a code outside
    // VALID_EXPORT_ERROR_CODES. The clamp must still fall back to
    // 'transfer-corrupt' rather than passing the noncanonical value on the wire.
    await connectHelper(h);
    const channelId = lastChannelId(h);
    const err = new TranscriptExportError('permission-denied');
    // Simulate a runtime-malformed code that TypeScript's type would forbid.
    (err as unknown as { code: string }).code = 'not-a-real-code';
    h.transport.onExportRequest = vi.fn().mockRejectedValue(err);

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-bad-typed-1',
    });
    await new Promise((r) => setTimeout(r, 0));

    const errEnv = h.posted.find((m) => m.kind === 'session.export.error');
    expect(errEnv?.requestId).toBe('req-bad-typed-1');
    expect(errEnv?.code).toBe('transfer-corrupt');
  });

  it('posts session.export.error with transfer-corrupt when rejection has no code', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    h.transport.onExportRequest = vi.fn().mockRejectedValue(new Error('unknown boom'));

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-corrupt-1',
    });
    await new Promise((r) => setTimeout(r, 0));

    const errEnv = h.posted.find((m) => m.kind === 'session.export.error');
    expect(errEnv?.code).toBe('transfer-corrupt');
  });

  it('aborts the in-flight export on session.export.cancel', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    let aborted = false;
    h.transport.onExportRequest = vi.fn().mockImplementation(
      (_rId: string, _sId: string, signal: AbortSignal) =>
        new Promise<Blob>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(Object.assign(new Error('aborted'), { code: 'transfer-aborted' }));
          });
        })
    );

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-cancel-1',
    });
    await new Promise((r) => setTimeout(r, 0));

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.cancel',
      requestId: 'req-cancel-1',
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(aborted).toBe(true);
  });

  it('posts session.export.error when onExportRequest not wired', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    // onExportRequest is null by default
    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-nowire-1',
    });
    // synchronous path — error is posted immediately
    const errEnv = h.posted.find((m) => m.kind === 'session.export.error');
    expect(errEnv?.code).toBe('transfer-aborted');
  });

  it('aborts pending exports when disconnect is called', async () => {
    await connectHelper(h);
    const channelId = lastChannelId(h);
    let aborted = false;
    h.transport.onExportRequest = vi.fn().mockImplementation(
      (_rId: string, _sId: string, signal: AbortSignal) =>
        new Promise<Blob>((_resolve, _reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
        })
    );

    h.inbound({
      cherry: CHERRY_PROTOCOL_VERSION,
      channelId,
      kind: 'session.export.request',
      requestId: 'req-disc-1',
    });
    await new Promise((r) => setTimeout(r, 0));
    h.transport.disconnect();
    expect(aborted).toBe(true);
  });
});

async function connectHelper(h: ReturnType<typeof makeTransport>) {
  const p = h.transport.connect();
  const hello = h.posted.find((m) => m.kind === 'handshake.hello');
  h.inbound({
    cherry: CHERRY_PROTOCOL_VERSION,
    channelId: hello.channelId,
    kind: 'handshake.welcome',
  });
  await p;
}
function lastChannelId(h: ReturnType<typeof makeTransport>) {
  return h.posted.find((m) => m.kind === 'handshake.hello').channelId as string;
}
