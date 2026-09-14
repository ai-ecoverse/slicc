import { describe, expect, it } from 'vitest';
import { isExtensionMessage } from '../src/extension-message.js';

describe('isExtensionMessage', () => {
  it('returns true for a panel envelope', () => {
    expect(isExtensionMessage({ source: 'panel', payload: { type: 'request-state' } })).toBe(true);
  });

  it('returns true for an offscreen envelope', () => {
    expect(
      isExtensionMessage({
        source: 'offscreen',
        payload: { type: 'scoop-status', scoopJid: 'test', status: 'ready' },
      })
    ).toBe(true);
  });

  it('returns true for a service-worker envelope', () => {
    expect(
      isExtensionMessage({
        source: 'service-worker',
        payload: { type: 'cdp-event', method: 'Page.loadEventFired' },
      })
    ).toBe(true);
  });

  it('returns false for null, undefined, and primitives', () => {
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage(undefined)).toBe(false);
    expect(isExtensionMessage('hello')).toBe(false);
    expect(isExtensionMessage(42)).toBe(false);
  });

  it('returns false for objects missing source or payload', () => {
    expect(isExtensionMessage({ payload: {} })).toBe(false);
    expect(isExtensionMessage({ source: 'panel' })).toBe(false);
    expect(isExtensionMessage({})).toBe(false);
  });

  it('returns false when source is not a string', () => {
    expect(isExtensionMessage({ source: 1, payload: {} })).toBe(false);
  });
});
