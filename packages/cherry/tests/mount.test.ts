import { describe, expect, it, vi } from 'vitest';
import { mountSliccImpl } from '../src/mount.js';
import { TranscriptExportError } from '../src/transcript-types.js';

describe('mountSliccImpl', () => {
  it('creates an iframe in the container pointed at ?cherry=1', () => {
    const container = document.createElement('div');
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
    });
    const iframe = container.querySelector('iframe')!;
    expect(iframe).toBeTruthy();
    expect(iframe.src).toContain('cherry=1');
    handle.destroy();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('honors onPermissionRequest denials before dispatching CDP', async () => {
    const container = document.createElement('div');
    const onPermissionRequest = vi.fn(() => false);
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: false },
      hooks: { onPermissionRequest },
      joinToken: 'https://app.example/join?t=X',
    });
    // Drive a cdp.request for a denied domain through the test seam.
    const res = await handle.testReceive({
      kind: 'cdp.request',
      id: 7,
      method: 'Page.navigate',
      params: { url: 'https://evil' },
    } as never);
    expect(onPermissionRequest).toHaveBeenCalledWith('Page');
    expect(res?.error?.code).toBe(-32601);
    handle.destroy();
  });

  it('returns a cdp.response error (not a hang) when onPermissionRequest throws', async () => {
    const container = document.createElement('div');
    // A throwing hook must NOT leave the cdp.request unanswered — otherwise the
    // leader's CherryHostTransport blocks until its 30s timeout.
    const onPermissionRequest = vi.fn(() => {
      throw new Error('hook boom');
    });
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: false },
      hooks: { onPermissionRequest },
      joinToken: 'https://app.example/join?t=X',
    });
    const res = await handle.testReceive({
      kind: 'cdp.request',
      id: 9,
      method: 'Page.navigate',
      params: { url: 'https://evil' },
    } as never);
    expect(onPermissionRequest).toHaveBeenCalledWith('Page');
    expect(res?.result).toBeUndefined();
    expect(res?.error?.code).toBe(-32000);
    expect(res?.error?.message).toContain('hook boom');
    handle.destroy();
  });

  it('posts a cdp.response error back over postMessage when the hook rejects', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; id?: number; error?: { code: number } }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: false },
      hooks: { onPermissionRequest: () => Promise.reject(new Error('async boom')) },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    // Establish the channelId so the cdp.response can be posted.
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-err',
      kind: 'handshake.hello',
    } as never);
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-err',
      kind: 'cdp.request',
      id: 11,
      method: 'Page.navigate',
      params: { url: 'https://evil' },
    } as never);
    const response = posted.find((e) => e.kind === 'cdp.response' && e.id === 11);
    expect(response?.error?.code).toBe(-32000);
    handle.destroy();
  });

  it('forwards a ready joinToken in the welcome envelope (no auth)', async () => {
    const container = document.createElement('div');
    const posted: unknown[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=PRE',
      __test_post: (env) => posted.push(env),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-1',
      kind: 'handshake.hello',
    } as never);
    const welcome = posted.find(
      (e): e is { kind: string; joinUrl?: string; auth?: unknown } =>
        (e as { kind?: string }).kind === 'handshake.welcome'
    );
    expect(welcome?.joinUrl).toBe('https://app.example/join?t=PRE');
    expect(welcome?.auth).toBeUndefined();
    handle.destroy();
  });

  it('fires onHandshakeComplete exactly once after handshake.hello', async () => {
    const container = document.createElement('div');
    const onHandshakeComplete = vi.fn();
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      hooks: { onHandshakeComplete },
      joinToken: 'https://app.example/join?t=X',
    });
    expect(onHandshakeComplete).not.toHaveBeenCalled();
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-hc',
      kind: 'handshake.hello',
    } as never);
    expect(onHandshakeComplete).toHaveBeenCalledTimes(1);
    // A second hello should not re-fire (channelId already pinned in practice,
    // but the hook fires per hello dispatch).
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-hc',
      kind: 'handshake.hello',
    } as never);
    expect(onHandshakeComplete).toHaveBeenCalledTimes(2);
    handle.destroy();
  });

  it('emitHostEvent posts a host.event envelope once the handshake pins a channelId', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; name?: string; detail?: unknown; channelId?: string }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-host',
      kind: 'handshake.hello',
    } as never);
    handle.emitHostEvent('checkout-done', { id: 7 });
    const evt = posted.find((e) => e.kind === 'host.event');
    expect(evt?.name).toBe('checkout-done');
    expect(evt?.detail).toEqual({ id: 7 });
    expect(evt?.channelId).toBe('ch-host');
    handle.destroy();
  });

  it('serializes options.theme as JSON in the handshake.welcome envelope', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; theme?: string }[] = [];
    const theme = {
      id: 'acme-dark',
      name: 'Acme Dark',
      base: 'dark' as const,
      tokens: { '--bg': '#111', '--fg': '#eee' },
    };
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      theme,
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-theme',
      kind: 'handshake.hello',
    } as never);
    const welcome = posted.find((e) => e.kind === 'handshake.welcome');
    expect(welcome?.theme).toBe(JSON.stringify(theme));
    handle.destroy();
  });

  it('omits theme from the welcome envelope when options.theme is undefined', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; theme?: string }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-no-theme',
      kind: 'handshake.hello',
    } as never);
    const welcome = posted.find((e) => e.kind === 'handshake.welcome');
    expect(welcome?.theme).toBeUndefined();
    handle.destroy();
  });

  it('includes effortLevel in the welcome envelope when the option is set', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; effortLevel?: string }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      effortLevel: 'low',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-effort',
      kind: 'handshake.hello',
    } as never);
    const welcome = posted.find((e) => e.kind === 'handshake.welcome');
    expect(welcome?.effortLevel).toBe('low');
    handle.destroy();
  });

  it('omits effortLevel from the welcome envelope when the option is not set', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; effortLevel?: string }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-no-effort',
      kind: 'handshake.hello',
    } as never);
    const welcome = posted.find((e) => e.kind === 'handshake.welcome');
    expect(welcome?.effortLevel).toBeUndefined();
    handle.destroy();
  });

  it('normalizes a trailing-slash sliccOrigin to the bare origin for postMessage targeting', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; channelId?: string }[] = [];
    const handle = mountSliccImpl({
      container,
      // A trailing slash is a common copy-paste mistake — MessageEvent.origin
      // never carries one, so using the raw string here would make every
      // postMessage silently rejected by the follower's acceptEnvelope gate.
      sliccOrigin: 'https://app.example/',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    const iframe = container.querySelector('iframe')!;
    expect(iframe.src).toBe('https://app.example/?cherry=1');
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-slash',
      kind: 'handshake.hello',
    } as never);
    expect(posted.some((e) => e.kind === 'handshake.welcome')).toBe(true);
    handle.destroy();
  });

  it('accepts an inbound envelope whose event.origin matches the bare (slash-stripped) sliccOrigin', async () => {
    const container = document.createElement('div');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onHandshakeComplete = vi.fn();
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example/',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      hooks: { onHandshakeComplete },
      joinToken: 'https://app.example/join?t=X',
    });
    const iframe = container.querySelector('iframe')!;
    // Real MessageEvent.origin values never carry a trailing slash. Before
    // normalizing sliccOrigin, the allowlist held 'https://app.example/' and
    // rejected every real postMessage as an origin mismatch — logging the
    // warning below and leaving the handshake hanging (a 30s timeout
    // downstream) instead of firing onHandshakeComplete.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { cherry: 2, channelId: 'ch-real', kind: 'handshake.hello' },
        origin: 'https://app.example',
        source: iframe.contentWindow,
      })
    );
    await vi.waitFor(() => expect(onHandshakeComplete).toHaveBeenCalledTimes(1));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    handle.destroy();
  });

  it('emitHostEvent drops (with a warning) before the handshake completes', () => {
    const container = document.createElement('div');
    const posted: unknown[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env),
    });
    handle.emitHostEvent('too-early');
    expect(posted.find((e) => (e as { kind?: string }).kind === 'host.event')).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    handle.destroy();
  });
});

describe('iframe reload / re-handshake', () => {
  it('accepts a re-hello with a new channelId from the same origin+source after a reload', async () => {
    const container = document.createElement('div');
    const onHandshakeComplete = vi.fn();
    const posted: { kind?: string; channelId?: string }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      hooks: { onHandshakeComplete },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    const iframe = container.querySelector('iframe')!;

    // --- initial handshake (channelId A) ---
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { cherry: 2, channelId: 'ch-A', kind: 'handshake.hello' },
        origin: 'https://app.example',
        source: iframe.contentWindow,
      })
    );
    await vi.waitFor(() => expect(onHandshakeComplete).toHaveBeenCalledTimes(1));
    const welcomeA = posted.find((e) => e.kind === 'handshake.welcome');
    expect(welcomeA?.channelId).toBe('ch-A');

    // --- iframe reloads → new hello with channelId B ---
    // The reloaded iframe is the same WindowProxy (identity survives navigation),
    // same origin, but a fresh channelId. Without the fix this is rejected by
    // acceptEnvelope's factor-3 check and the embed is permanently dead.
    posted.length = 0;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { cherry: 2, channelId: 'ch-B', kind: 'handshake.hello' },
        origin: 'https://app.example',
        source: iframe.contentWindow,
      })
    );
    await vi.waitFor(() => expect(onHandshakeComplete).toHaveBeenCalledTimes(2));
    const welcomeB = posted.find((e) => e.kind === 'handshake.welcome');
    expect(welcomeB?.channelId).toBe('ch-B');
    handle.destroy();
  });

  it('uses the new channelId for subsequent emitHostEvent calls after re-hello', async () => {
    const container = document.createElement('div');
    const posted: { kind?: string; channelId?: string; name?: string }[] = [];
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    const iframe = container.querySelector('iframe')!;

    // initial handshake
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { cherry: 2, channelId: 'ch-old', kind: 'handshake.hello' },
        origin: 'https://app.example',
        source: iframe.contentWindow,
      })
    );
    await vi.waitFor(() => expect(posted.some((e) => e.kind === 'handshake.welcome')).toBe(true));

    // re-hello with a new channelId
    posted.length = 0;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { cherry: 2, channelId: 'ch-new', kind: 'handshake.hello' },
        origin: 'https://app.example',
        source: iframe.contentWindow,
      })
    );
    await vi.waitFor(() => expect(posted.some((e) => e.kind === 'handshake.welcome')).toBe(true));

    // emitHostEvent should use the NEW channelId
    posted.length = 0;
    handle.emitHostEvent('test-event', { v: 1 });
    const evt = posted.find((e) => e.kind === 'host.event');
    expect(evt?.channelId).toBe('ch-new');
    expect(evt?.name).toBe('test-event');
    handle.destroy();
  });

  it('still rejects a re-hello from a different origin (factor 1)', async () => {
    const container = document.createElement('div');
    const onHandshakeComplete = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      hooks: { onHandshakeComplete },
      joinToken: 'https://app.example/join?t=X',
    });
    const iframe = container.querySelector('iframe')!;

    // initial handshake
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { cherry: 2, channelId: 'ch-ok', kind: 'handshake.hello' },
        origin: 'https://app.example',
        source: iframe.contentWindow,
      })
    );
    await vi.waitFor(() => expect(onHandshakeComplete).toHaveBeenCalledTimes(1));

    // re-hello from a WRONG origin — must stay rejected
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { cherry: 2, channelId: 'ch-evil', kind: 'handshake.hello' },
        origin: 'https://evil.example',
        source: iframe.contentWindow,
      })
    );
    // Give the event loop a tick; if the handler fires it would be synchronous
    await new Promise((r) => setTimeout(r, 10));
    expect(onHandshakeComplete).toHaveBeenCalledTimes(1); // no re-handshake
    warn.mockRestore();
    handle.destroy();
  });
});

describe('mountSlicc iframe + uiOnly options', () => {
  it('uses a caller-provided iframe instead of creating one', () => {
    const iframe = document.createElement('iframe');
    const container = document.createElement('div');
    container.appendChild(iframe); // caller owns placement
    const before = document.querySelectorAll('iframe').length;
    const handle = mountSliccImpl({
      iframe,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    expect(handle.iframe).toBe(iframe); // same element, not a new one
    expect(document.querySelectorAll('iframe').length).toBe(before); // none created
    handle.destroy();
  });

  it('appends ui-only=1 AFTER cherry=1 when uiOnly is set', () => {
    const iframe = document.createElement('iframe');
    mountSliccImpl({
      iframe,
      uiOnly: true,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    const url = new URL(iframe.src);
    expect(url.searchParams.get('cherry')).toBe('1');
    expect(url.searchParams.get('ui-only')).toBe('1');
    // cherry must be the FIRST search param so the DNR ||sliccy.ai/?cherry=1 prefix matches
    expect(iframe.src).toContain('?cherry=1');
    expect(iframe.src.indexOf('cherry=1')).toBeLessThan(iframe.src.indexOf('ui-only=1'));
  });

  it('default (no uiOnly) does not append ui-only', () => {
    const iframe = document.createElement('iframe');
    mountSliccImpl({
      iframe,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    expect(new URL(iframe.src).searchParams.get('ui-only')).toBeNull();
  });

  it('still creates + appends an iframe when only container is given (backward compat)', () => {
    const container = document.createElement('div');
    const handle = mountSliccImpl({
      container,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    expect(container.querySelector('iframe')).toBe(handle.iframe);
    handle.destroy();
    expect(container.querySelector('iframe')).toBeNull(); // SDK-created iframe removed
  });

  it('destroy() does NOT remove a caller-provided iframe (caller owns it)', () => {
    const container = document.createElement('div');
    const iframe = document.createElement('iframe');
    container.appendChild(iframe);
    const handle = mountSliccImpl({
      iframe,
      sliccOrigin: 'https://app.example.test',
      capabilities: { navigate: false, screenshot: 'none', openUrl: false },
      joinToken: 'https://w.example.test/join/tray.secret',
    });
    handle.destroy();
    expect(container.querySelector('iframe')).toBe(iframe); // still attached
  });
});

// ---------------------------------------------------------------------------
// exportSession lifecycle
// ---------------------------------------------------------------------------

describe('exportSession', () => {
  it('resolves exportSession with the follower-verified zip Blob', async () => {
    const posted: Array<{ kind?: string; requestId?: string }> = [];
    const seen: string[] = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (envelope) => posted.push(envelope as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-export',
      kind: 'handshake.hello',
    } as never);
    const pending = handle.exportSession({
      sessionId: 'active',
      onProgress: (progress) => seen.push(progress.phase),
    });
    const request = posted.find((envelope) => envelope.kind === 'session.export.request');
    expect(request).toBeDefined();
    expect(request?.requestId).toBeTruthy();

    // Simulate progress from follower
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-export',
      kind: 'session.export.progress',
      requestId: request?.requestId,
      phase: 'collecting',
    } as never);
    expect(seen).toEqual(['collecting']);

    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-export',
      kind: 'session.export.response',
      requestId: request?.requestId,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }),
    } as never);
    await expect(pending).resolves.toBeInstanceOf(Blob);
    handle.destroy();
  });

  it('rejects exportSession before handshake completes', async () => {
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
    });
    await expect(handle.exportSession()).rejects.toBeInstanceOf(TranscriptExportError);
    handle.destroy();
  });

  it('maps session.export.error to TranscriptExportError with correct code', async () => {
    const posted: Array<{ kind?: string; requestId?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-err',
      kind: 'handshake.hello',
    } as never);
    const promise = handle.exportSession();
    const request = posted.find((e) => e.kind === 'session.export.request');
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-err',
      kind: 'session.export.error',
      requestId: request?.requestId,
      code: 'permission-denied',
    } as never);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptExportError);
    expect((err as TranscriptExportError).code).toBe('permission-denied');
    handle.destroy();
  });

  it('maps unknown session.export.error code to transfer-corrupt (M-1 runtime guard)', async () => {
    const posted: Array<{ kind?: string; requestId?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.__test_receive({
      cherry: 2,
      channelId: 'ch-unknown-code',
      kind: 'handshake.hello',
    } as never);
    const promise = handle.exportSession();
    const request = posted.find((e) => e.kind === 'session.export.request');
    await handle.__test_receive({
      cherry: 2,
      channelId: 'ch-unknown-code',
      kind: 'session.export.error',
      requestId: request?.requestId,
      code: 'permission_denied', // underscore, not dash — not a valid code
    } as never);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptExportError);
    expect((err as TranscriptExportError).code).toBe('transfer-corrupt');
    handle.destroy();
  });

  it('rejects with transfer-corrupt when blob.type is not application/zip', async () => {
    const posted: Array<{ kind?: string; requestId?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-corrupt',
      kind: 'handshake.hello',
    } as never);
    const promise = handle.exportSession();
    const request = posted.find((e) => e.kind === 'session.export.request');
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-corrupt',
      kind: 'session.export.response',
      requestId: request?.requestId,
      blob: new Blob(['bad'], { type: 'text/plain' }),
    } as never);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptExportError);
    expect((err as TranscriptExportError).code).toBe('transfer-corrupt');
    handle.destroy();
  });

  it('AbortSignal posts session.export.cancel and rejects with transfer-aborted', async () => {
    const posted: Array<{ kind?: string; requestId?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-abort',
      kind: 'handshake.hello',
    } as never);
    const controller = new AbortController();
    const promise = handle.exportSession({ signal: controller.signal });
    const request = posted.find((e) => e.kind === 'session.export.request');
    expect(request).toBeDefined();

    posted.length = 0;
    controller.abort();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptExportError);
    expect((err as TranscriptExportError).code).toBe('transfer-aborted');
    const cancel = posted.find((e) => e.kind === 'session.export.cancel');
    expect(cancel).toBeDefined();
    expect(cancel?.requestId).toBe(request?.requestId);
    handle.destroy();
  });

  it('already-aborted AbortSignal rejects immediately without posting a request', async () => {
    const posted: Array<{ kind?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-pre-abort',
      kind: 'handshake.hello',
    } as never);
    posted.length = 0;
    const controller = new AbortController();
    controller.abort();
    const err = await handle.exportSession({ signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptExportError);
    expect((err as TranscriptExportError).code).toBe('transfer-aborted');
    expect(posted.find((e) => e.kind === 'session.export.request')).toBeUndefined();
    handle.destroy();
  });

  it('destroy() rejects all pending exports with transfer-aborted', async () => {
    const posted: Array<{ kind?: string; requestId?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-destroy',
      kind: 'handshake.hello',
    } as never);
    const p1 = handle.exportSession();
    const p2 = handle.exportSession();
    handle.destroy();
    const [e1, e2] = await Promise.all([p1.catch((e: unknown) => e), p2.catch((e: unknown) => e)]);
    expect(e1).toBeInstanceOf(TranscriptExportError);
    expect((e1 as TranscriptExportError).code).toBe('transfer-aborted');
    expect(e2).toBeInstanceOf(TranscriptExportError);
    expect((e2 as TranscriptExportError).code).toBe('transfer-aborted');
  });

  it('re-handshake rejects all pending exports before pinning the new channelId', async () => {
    const posted: Array<{ kind?: string; requestId?: string; channelId?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-old',
      kind: 'handshake.hello',
    } as never);
    const stalePromise = handle.exportSession();

    // Re-handshake from iframe reload
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-new',
      kind: 'handshake.hello',
    } as never);

    const err = await stalePromise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscriptExportError);
    expect((err as TranscriptExportError).code).toBe('transfer-aborted');

    // Stale response for old request should be silently ignored
    const oldRequestId = posted.find((e) => e.kind === 'session.export.request')?.requestId;
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-new',
      kind: 'session.export.response',
      requestId: oldRequestId,
      blob: new Blob([new Uint8Array([1])], { type: 'application/zip' }),
    } as never);
    // No crash, no resolution — promise was already rejected

    handle.destroy();
  });

  it('routes concurrent export progress by requestId', async () => {
    const posted: Array<{ kind?: string; requestId?: string }> = [];
    const seenA: string[] = [];
    const seenB: string[] = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-concurrent',
      kind: 'handshake.hello',
    } as never);

    const pA = handle.exportSession({ onProgress: (p) => seenA.push(p.phase) });
    const pB = handle.exportSession({ onProgress: (p) => seenB.push(p.phase) });
    const requests = posted.filter((e) => e.kind === 'session.export.request');
    const [reqA, reqB] = requests;

    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-concurrent',
      kind: 'session.export.progress',
      requestId: reqA?.requestId,
      phase: 'collecting',
    } as never);
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-concurrent',
      kind: 'session.export.progress',
      requestId: reqB?.requestId,
      phase: 'redacting',
    } as never);

    expect(seenA).toEqual(['collecting']);
    expect(seenB).toEqual(['redacting']);

    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-concurrent',
      kind: 'session.export.response',
      requestId: reqA?.requestId,
      blob: new Blob([new Uint8Array([1])], { type: 'application/zip' }),
    } as never);
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-concurrent',
      kind: 'session.export.response',
      requestId: reqB?.requestId,
      blob: new Blob([new Uint8Array([2])], { type: 'application/zip' }),
    } as never);
    await expect(pA).resolves.toBeInstanceOf(Blob);
    await expect(pB).resolves.toBeInstanceOf(Blob);
    handle.destroy();
  });

  it('untrusted-origin export response cannot resolve a pending export', async () => {
    const posted: Array<{ kind?: string; requestId?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    const iframe = handle.iframe;
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { cherry: 2, channelId: 'ch-sec', kind: 'handshake.hello' },
        origin: 'https://app.example',
        source: iframe.contentWindow,
      })
    );
    await vi.waitFor(() => expect(posted.some((e) => e.kind === 'handshake.welcome')).toBe(true));

    const exportPromise = handle.exportSession();
    const request = posted.find((e) => e.kind === 'session.export.request');

    // Attacker sends a response from a different origin
    let settled = false;
    exportPromise
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          cherry: 2,
          channelId: 'ch-sec',
          kind: 'session.export.response',
          requestId: request?.requestId,
          blob: new Blob([new Uint8Array([0])], { type: 'application/zip' }),
        },
        origin: 'https://evil.example',
        source: iframe.contentWindow,
      })
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // promise still pending

    handle.destroy();
    // destroy() rejects
    await exportPromise.catch(() => {});
  });

  it('posts session.export.request with the supplied sessionId', async () => {
    const posted: Array<{ kind?: string; requestId?: string; sessionId?: string }> = [];
    const handle = mountSliccImpl({
      container: document.createElement('div'),
      sliccOrigin: 'https://app.example',
      capabilities: { navigate: true, screenshot: 'none', openUrl: true },
      joinToken: 'https://app.example/join?t=X',
      __test_post: (env) => posted.push(env as never),
    });
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-sid',
      kind: 'handshake.hello',
    } as never);
    const p = handle.exportSession({ sessionId: 'frozen-abc' });
    const request = posted.find((e) => e.kind === 'session.export.request');
    expect(request?.sessionId).toBe('frozen-abc');
    // Clean up
    await handle.testReceive({
      cherry: 2,
      channelId: 'ch-sid',
      kind: 'session.export.error',
      requestId: request?.requestId,
      code: 'session-not-found',
    } as never);
    await p.catch(() => {});
    handle.destroy();
  });
});
