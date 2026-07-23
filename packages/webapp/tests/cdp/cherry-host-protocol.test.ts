import { describe, expect, it } from 'vitest';
import {
  acceptEnvelope,
  CHERRY_PROTOCOL_VERSION,
  type CherryEnvelope,
  isCherryEnvelope,
  isCherryVersionMismatch,
} from '../../src/cdp/cherry-host-protocol.js';

const make = (over: Partial<CherryEnvelope> = {}): CherryEnvelope =>
  ({
    cherry: CHERRY_PROTOCOL_VERSION,
    channelId: 'cherry-abc',
    kind: 'cdp.request',
    id: 1,
    method: 'Page.enable',
    ...over,
  }) as CherryEnvelope;

describe('isCherryEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isCherryEnvelope(make())).toBe(true);
  });
  it('rejects wrong protocol version', () => {
    expect(isCherryEnvelope({ ...make(), cherry: 999 })).toBe(false);
  });
  it('rejects non-objects', () => {
    expect(isCherryEnvelope(null)).toBe(false);
    expect(isCherryEnvelope('x')).toBe(false);
  });
  it('rejects an envelope missing channelId', () => {
    expect(isCherryEnvelope({ ...make(), channelId: undefined })).toBe(false);
  });
  it('rejects an unknown kind', () => {
    expect(isCherryEnvelope({ ...make(), kind: 'bogus.kind' })).toBe(false);
  });

  // New export envelope kinds
  it('accepts session.export.request kind', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.request',
        requestId: 'req-1',
      })
    ).toBe(true);
  });
  it('accepts session.export.cancel kind', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.cancel',
        requestId: 'req-1',
      })
    ).toBe(true);
  });
  it('accepts session.export.progress kind', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.progress',
        requestId: 'req-1',
        phase: 'collecting',
      })
    ).toBe(true);
  });
  it('accepts session.export.response kind', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.response',
        requestId: 'req-1',
        blob: new Blob(['data'], { type: 'application/zip' }),
      })
    ).toBe(true);
  });
  it('accepts session.export.error kind', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.error',
        requestId: 'req-1',
        code: 'permission-denied',
      })
    ).toBe(true);
  });

  // Malformed export envelopes — L-2 guard tests
  it('rejects export kinds with an empty requestId', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.request',
        requestId: '',
      })
    ).toBe(false);
  });
  it('rejects export kinds with a missing requestId', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.cancel',
      })
    ).toBe(false);
  });
  it('rejects session.export.progress without phase', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.progress',
        requestId: 'req-1',
      })
    ).toBe(false);
  });
  it('rejects session.export.response without a Blob', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.response',
        requestId: 'req-1',
        blob: 'not-a-blob',
      })
    ).toBe(false);
  });
  it('rejects session.export.error without a code', () => {
    expect(
      isCherryEnvelope({
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'ch-1',
        kind: 'session.export.error',
        requestId: 'req-1',
      })
    ).toBe(false);
  });
});

describe('isCherryVersionMismatch', () => {
  it('detects an envelope-shaped message with a different version', () => {
    expect(isCherryVersionMismatch({ ...make(), cherry: CHERRY_PROTOCOL_VERSION + 1 })).toBe(true);
    expect(isCherryVersionMismatch({ cherry: 0, channelId: 'x', kind: 'handshake.hello' })).toBe(
      true
    );
    expect(isCherryVersionMismatch({ cherry: 1, channelId: 'x', kind: 'handshake.hello' })).toBe(
      true
    );
  });
  it('is false for the current version (that is a valid envelope, not a mismatch)', () => {
    expect(isCherryVersionMismatch(make())).toBe(false);
  });
  it('is false for non-envelope noise', () => {
    expect(isCherryVersionMismatch(null)).toBe(false);
    expect(isCherryVersionMismatch({ cherry: CHERRY_PROTOCOL_VERSION + 1 })).toBe(false);
    expect(isCherryVersionMismatch({ cherry: '3', channelId: 'x', kind: 'k' })).toBe(false);
  });
});

describe('acceptEnvelope three-factor pinning', () => {
  const expectedSource = {} as MessageEventSource;
  const ctx = {
    allowOrigins: ['https://host.example'],
    expectedSource,
    channelId: 'cherry-abc',
  };

  it('accepts matching origin + source + channelId', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(true);
  });

  it('rejects foreign origin', () => {
    const ev = {
      origin: 'https://evil.example',
      source: expectedSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('rejects mismatched source', () => {
    const ev = {
      origin: 'https://host.example',
      source: {} as MessageEventSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('rejects mismatched channelId', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make({ channelId: 'cherry-other' }),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('accepts pre-handshake when ctx.channelId is null', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make({ kind: 'handshake.hello', channelId: 'cherry-new' }),
    } as MessageEvent;
    expect(acceptEnvelope(ev, { ...ctx, channelId: null })).toBe(true);
  });

  it('rejects a malformed (non-cherry) payload even when origin + source match', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: { foo: 1 },
    } as unknown as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('accepts a foreign source when ctx.expectedSource is null', () => {
    const ev = {
      origin: 'https://host.example',
      source: {} as MessageEventSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, { ...ctx, expectedSource: null })).toBe(true);
  });

  it('accepts a session.export.response envelope through the gate', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: {
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'cherry-abc',
        kind: 'session.export.response',
        requestId: 'req-1',
        blob: new Blob(['data'], { type: 'application/zip' }),
      },
    } as unknown as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(true);
  });

  it('rejects a session.export.response from wrong origin', () => {
    const ev = {
      origin: 'https://evil.example',
      source: expectedSource,
      data: {
        cherry: CHERRY_PROTOCOL_VERSION,
        channelId: 'cherry-abc',
        kind: 'session.export.response',
        requestId: 'req-1',
        blob: new Blob(['data'], { type: 'application/zip' }),
      },
    } as unknown as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });
});
