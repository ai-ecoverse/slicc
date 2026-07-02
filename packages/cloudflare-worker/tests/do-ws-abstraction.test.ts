import { describe, expect, it } from 'vitest';
import type { DurableObjectStateLike, TrayWebSocketLike } from '../src/shared.js';

// A minimal fake implementing the extended seam, proving the shape compiles + round-trips.
function makeFakeWs(): TrayWebSocketLike {
  let attachment: unknown;
  return {
    send: () => {},
    close: () => {},
    serializeAttachment: (v: unknown) => {
      attachment = v;
    },
    deserializeAttachment: () => attachment,
  };
}

describe('DO WS abstraction extensions', () => {
  it('round-trips a serialized attachment', () => {
    const ws = makeFakeWs();
    ws.serializeAttachment?.({ connId: 'c1', previewToken: 't.s' });
    expect(ws.deserializeAttachment?.()).toEqual({ connId: 'c1', previewToken: 't.s' });
  });

  it('state exposes getTags and setWebSocketAutoResponse as optional members', () => {
    const state: Partial<DurableObjectStateLike> = {
      getTags: (_ws: unknown) => ['leader'],
      setWebSocketAutoResponse: (_pair: unknown) => {},
    };
    expect(state.getTags?.({})).toEqual(['leader']);
    expect(() => state.setWebSocketAutoResponse?.({})).not.toThrow();
  });
});
