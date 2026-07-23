import { describe, expect, it } from 'vitest';
import {
  type AcceptContext,
  acceptEnvelope,
  CHERRY_PROTOCOL_VERSION,
  type CherryEnvelope,
  isCherryEnvelope,
  isCherryVersionMismatch,
} from '../src/protocol.js';

/** A minimal but structurally valid envelope. */
function validEnvelope(channelId = 'cherry-test'): CherryEnvelope {
  return {
    cherry: CHERRY_PROTOCOL_VERSION,
    channelId,
    kind: 'handshake.hello',
    capabilities: { navigate: true, screenshot: true, openUrl: true },
  };
}

/** Build a MessageEvent-shaped stub (acceptEnvelope only reads origin/source/data). */
function evt(data: unknown, origin: string, source: MessageEventSource | null): MessageEvent {
  return { origin, source, data } as unknown as MessageEvent;
}

describe('isCherryEnvelope', () => {
  it('rejects non-objects and null', () => {
    expect(isCherryEnvelope('not-an-object')).toBe(false);
    expect(isCherryEnvelope(null)).toBe(false);
    expect(isCherryEnvelope(42)).toBe(false);
    expect(isCherryEnvelope(undefined)).toBe(false);
  });

  it('rejects a wrong protocol version', () => {
    expect(isCherryEnvelope({ ...validEnvelope(), cherry: CHERRY_PROTOCOL_VERSION + 1 })).toBe(
      false
    );
  });

  it('rejects a non-string channelId', () => {
    expect(isCherryEnvelope({ ...validEnvelope(), channelId: 123 })).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(isCherryEnvelope({ ...validEnvelope(), kind: 'bogus' })).toBe(false);
  });

  it('accepts a structurally valid envelope', () => {
    expect(isCherryEnvelope(validEnvelope())).toBe(true);
  });
});

describe('isCherryVersionMismatch', () => {
  it('detects an envelope-shaped message with a different version', () => {
    expect(
      isCherryVersionMismatch({ ...validEnvelope(), cherry: CHERRY_PROTOCOL_VERSION + 1 })
    ).toBe(true);
  });
  it('is false for the current version and for noise', () => {
    expect(isCherryVersionMismatch(validEnvelope())).toBe(false);
    expect(isCherryVersionMismatch(null)).toBe(false);
    // Only version number — missing channelId and kind → not a mismatch
    expect(isCherryVersionMismatch({ cherry: CHERRY_PROTOCOL_VERSION + 1 })).toBe(false);
  });
});

describe('acceptEnvelope (three-factor gate)', () => {
  const source = {} as MessageEventSource;
  const ctx: AcceptContext = {
    allowOrigins: ['https://app.example.com'],
    expectedSource: source,
    channelId: 'cherry-test',
  };

  it('rejects an origin that is not allowlisted', () => {
    const e = evt(validEnvelope(), 'https://evil.example.com', source);
    expect(acceptEnvelope(e, ctx)).toBe(false);
  });

  it('rejects a mismatched source when a source is expected', () => {
    const e = evt(validEnvelope(), 'https://app.example.com', {} as MessageEventSource);
    expect(acceptEnvelope(e, ctx)).toBe(false);
  });

  it('rejects data that is not a cherry envelope', () => {
    const e = evt({ not: 'an envelope' }, 'https://app.example.com', source);
    expect(acceptEnvelope(e, ctx)).toBe(false);
  });

  it('rejects a channelId nonce mismatch', () => {
    const e = evt(validEnvelope('cherry-other'), 'https://app.example.com', source);
    expect(acceptEnvelope(e, ctx)).toBe(false);
  });

  it('accepts when all three factors hold', () => {
    const e = evt(validEnvelope(), 'https://app.example.com', source);
    expect(acceptEnvelope(e, ctx)).toBe(true);
  });

  it('skips the source and nonce factors during the pre-handshake window', () => {
    const preHandshake: AcceptContext = {
      allowOrigins: ['https://app.example.com'],
      expectedSource: null,
      channelId: null,
    };
    const e = evt(validEnvelope('cherry-anything'), 'https://app.example.com', null);
    expect(acceptEnvelope(e, preHandshake)).toBe(true);
  });
});
