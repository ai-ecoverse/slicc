/**
 * Tests for extension message types and helpers.
 */

import { describe, it, expect } from 'vitest';
import { isExtensionMessage, type ExtensionMessage } from '../src/messages.js';

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

  it('returns true for handoff list envelopes', () => {
    const msg: ExtensionMessage = {
      source: 'service-worker',
      payload: { type: 'handoff-pending-list', handoffs: [] },
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
