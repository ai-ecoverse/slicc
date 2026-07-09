/**
 * Tests for extension message types and helpers.
 */

import { describe, expect, it } from 'vitest';
import type {
  LeaderActiveScoopMsg,
  LeaderModeChangedMsg,
  LeaderRequestLeaderModeStateMsg,
  LeaderSprinklesSnapshotMsg,
  LeaderSprinkleUpdateMsg,
  LeaderTrayResetRequestMsg,
  LeaderTrayResetResponseMsg,
  LeaderUserMessageEchoMsg,
  OffscreenToPanelMessage,
  PanelToOffscreenMessage,
} from '../../webapp/src/kernel/messages.js';
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

describe('leader-sync message types', () => {
  it('every new panel→offscreen type is in the PanelToOffscreenMessage union', () => {
    const samples: PanelToOffscreenMessage[] = [
      { type: 'leader-sprinkles-snapshot', sprinkles: [] },
      { type: 'leader-sprinkle-update', sprinkleName: 'x', data: null },
      { type: 'leader-user-message-echo', text: 'hi', messageId: 'm1' },
      { type: 'leader-active-scoop', scoopJid: 'cone' },
      { type: 'leader-request-mode-state' },
      { type: 'leader-tray-reset', requestId: 'r1' },
    ];
    expect(samples.length).toBe(6);
  });

  it('every new offscreen→panel type is in the OffscreenToPanelMessage union', () => {
    // Both branches of the LeaderTrayResetResponseMsg discriminated union
    // must be assignable to the parent envelope union.
    const samples: OffscreenToPanelMessage[] = [
      { type: 'leader-mode-changed', active: true },
      {
        type: 'leader-tray-reset-response',
        requestId: 'r1',
        ok: true,
        status: {
          state: 'inactive',
          session: null,
          error: null,
          reconnectAttempts: 0,
        } as any,
      },
      {
        type: 'leader-tray-reset-response',
        requestId: 'r2',
        ok: false,
        error: 'oops',
      },
    ];
    expect(samples.length).toBe(3);
  });

  it('sprinkles snapshot envelope is assignable to SprinkleSummary[]', () => {
    // Compile-time invariant: the leader-sprinkles-snapshot envelope shape
    // must remain structurally assignable to SprinkleSummary[].
    const msg: LeaderSprinklesSnapshotMsg = {
      type: 'leader-sprinkles-snapshot',
      sprinkles: [{ name: 'a', title: 'A', path: '/a.shtml', open: false, autoOpen: false }],
    };
    // If the envelope type drifts from SprinkleSummary, this won't compile.
    const summaries: import('../../webapp/src/scoops/tray-sync-protocol.js').SprinkleSummary[] =
      msg.sprinkles;
    expect(summaries.length).toBe(1);
  });

  it('individual leader-sync message types are exported', () => {
    // Compile-time: ensure all named exports exist (silences unused-import lints
    // for the test runtime). Each cast is a structural check, not a value test.
    const _a: LeaderSprinklesSnapshotMsg = { type: 'leader-sprinkles-snapshot', sprinkles: [] };
    const _b: LeaderSprinkleUpdateMsg = {
      type: 'leader-sprinkle-update',
      sprinkleName: 'x',
      data: null,
    };
    const _c: LeaderUserMessageEchoMsg = {
      type: 'leader-user-message-echo',
      text: 'hi',
      messageId: 'm1',
    };
    const _d: LeaderActiveScoopMsg = { type: 'leader-active-scoop', scoopJid: 'cone' };
    const _e: LeaderRequestLeaderModeStateMsg = { type: 'leader-request-mode-state' };
    const _f: LeaderTrayResetRequestMsg = { type: 'leader-tray-reset', requestId: 'r1' };
    const _g: LeaderModeChangedMsg = { type: 'leader-mode-changed', active: false };
    const _h: LeaderTrayResetResponseMsg = {
      type: 'leader-tray-reset-response',
      requestId: 'r1',
      ok: true,
      status: {} as any,
    };
    expect([_a, _b, _c, _d, _e, _f, _g, _h].length).toBe(8);
  });
});
