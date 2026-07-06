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
});

describe('isCherryVersionMismatch', () => {
  it('detects an envelope-shaped message with a different version', () => {
    expect(isCherryVersionMismatch({ ...make(), cherry: 2 })).toBe(true);
    expect(isCherryVersionMismatch({ cherry: 0, channelId: 'x', kind: 'handshake.hello' })).toBe(
      true
    );
  });
  it('is false for the current version (that is a valid envelope, not a mismatch)', () => {
    expect(isCherryVersionMismatch(make())).toBe(false);
  });
  it('is false for non-envelope noise', () => {
    expect(isCherryVersionMismatch(null)).toBe(false);
    expect(isCherryVersionMismatch({ cherry: 2 })).toBe(false);
    expect(isCherryVersionMismatch({ cherry: '2', channelId: 'x', kind: 'k' })).toBe(false);
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
});
