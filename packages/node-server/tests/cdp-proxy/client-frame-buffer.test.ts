/**
 * Bounded Client→Chrome frame buffer used while the `/cdp` proxy's Chrome leg
 * is down (issue #2417). Mirrors swift-server's `appendBufferedMessage`:
 * 1,000 frames, drop-oldest on overflow.
 */
import { describe, expect, it } from 'vitest';
import {
  appendBufferedClientFrame,
  CDP_CLIENT_FRAME_BUFFER_LIMIT,
} from '../../src/cdp-proxy/client-frame-buffer.js';

describe('appendBufferedClientFrame', () => {
  it('appends while below the limit and reports no drop', () => {
    const buffer: unknown[] = [];
    expect(appendBufferedClientFrame(buffer, 'a')).toBe(false);
    expect(appendBufferedClientFrame(buffer, 'b')).toBe(false);
    expect(buffer).toEqual(['a', 'b']);
  });

  it('drops the OLDEST frame at the limit', () => {
    const buffer: unknown[] = ['a', 'b', 'c'];
    expect(appendBufferedClientFrame(buffer, 'd', 3)).toBe(true);
    expect(buffer).toEqual(['b', 'c', 'd']);
  });

  it('keeps the buffer bounded under sustained overflow', () => {
    const buffer: unknown[] = [];
    for (let i = 0; i < 2500; i++) appendBufferedClientFrame(buffer, i);

    expect(buffer).toHaveLength(CDP_CLIENT_FRAME_BUFFER_LIMIT);
    expect(buffer[0]).toBe(2500 - CDP_CLIENT_FRAME_BUFFER_LIMIT);
    expect(buffer.at(-1)).toBe(2499);
  });

  it('trims an over-long buffer down to the limit', () => {
    const buffer: unknown[] = Array.from({ length: 5 }, (_, i) => i);
    expect(appendBufferedClientFrame(buffer, 'x', 3)).toBe(true);
    expect(buffer).toEqual([3, 4, 'x']);
  });

  it('defaults to the swift-parity limit of 1000', () => {
    expect(CDP_CLIENT_FRAME_BUFFER_LIMIT).toBe(1000);
  });
});
