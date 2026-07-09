/**
 * Tests for extension message types and helpers.
 */

import { describe, expect, it } from 'vitest';
import type { SprinkleSummaryEnvelope } from '../../webapp/src/kernel/messages.js';
import { type ExtensionMessage, isExtensionMessage } from '../../webapp/src/kernel/messages.js';

describe('isExtensionMessage', () => {
  it('returns true for valid panel envelope', () => {
    const msg: ExtensionMessage = {
      source: 'panel',
      payload: { type: 'request-state' },
    };
    expect(isExtensionMessage(msg)).toBe(true);
  });

  it('returns true for valid offscreen envelope', () => {
    const msg: ExtensionMessage = {
      source: 'offscreen',
      payload: { type: 'scoop-status', scoopJid: 'test', status: 'ready' },
    };
    expect(isExtensionMessage(msg)).toBe(true);
  });

  it('returns true for valid service-worker envelope', () => {
    const msg: ExtensionMessage = {
      source: 'service-worker',
      payload: { type: 'cdp-event', method: 'Page.loadEventFired' },
    };
    expect(isExtensionMessage(msg)).toBe(true);
  });

  it('returns true for tray socket command envelopes', () => {
    const msg: ExtensionMessage = {
      source: 'offscreen',
      payload: { type: 'tray-socket-open', id: 1, url: 'wss://tray.example.com/controller' },
    };
    expect(isExtensionMessage(msg)).toBe(true);
  });

  it('returns true for tray socket event envelopes', () => {
    const msg: ExtensionMessage = {
      source: 'service-worker',
      payload: { type: 'tray-socket-opened', id: 1 },
    };
    expect(isExtensionMessage(msg)).toBe(true);
  });

  it('returns true for navigate-lick envelopes', () => {
    const msg: ExtensionMessage = {
      source: 'service-worker',
      payload: {
        type: 'navigate-lick',
        url: 'https://example.com/',
        verb: 'handoff',
        target: 'https://example.com/',
        instruction: 'do the thing',
      },
    };
    expect(isExtensionMessage(msg)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isExtensionMessage(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isExtensionMessage(undefined)).toBe(false);
  });

  it('returns false for primitive', () => {
    expect(isExtensionMessage('hello')).toBe(false);
    expect(isExtensionMessage(42)).toBe(false);
  });

  it('returns false for object without source', () => {
    expect(isExtensionMessage({ payload: {} })).toBe(false);
  });

  it('returns false for object without payload', () => {
    expect(isExtensionMessage({ source: 'panel' })).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isExtensionMessage({})).toBe(false);
  });
});

describe('sprinkle summary envelope', () => {
  it('is assignable to SprinkleSummary[] (compile-time wire invariant)', () => {
    // The envelope shape is mirrored (not imported) from
    // `tray-sync-protocol.ts` for webapp-worker tsconfig reasons — see the
    // comment on `SprinkleSummaryEnvelope`. This assignment is the
    // compile-time guard that keeps the mirror in lockstep: if either side
    // drifts, this file (typechecked in CI) stops compiling.
    const envelope: SprinkleSummaryEnvelope[] = [
      { name: 'a', title: 'A', path: '/a.shtml', open: false, autoOpen: false },
    ];
    const summaries: import('../../webapp/src/scoops/tray-sync-protocol.js').SprinkleSummary[] =
      envelope;
    expect(summaries.length).toBe(1);
  });
});
