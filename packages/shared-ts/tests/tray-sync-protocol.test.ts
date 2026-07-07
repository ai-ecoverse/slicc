import { describe, expect, it } from 'vitest';
import {
  CHERRY_RUNTIME_TAG,
  isCherryHostEventMessage,
  isCherrySliccEventMessage,
  TRAY_SYNC_PROTOCOL_VERSION,
  unhandledProtocolMessage,
} from '../src/tray-sync-protocol.js';

describe('tray-sync-protocol', () => {
  it('exposes protocol version 1 and the cherry runtime tag', () => {
    expect(TRAY_SYNC_PROTOCOL_VERSION).toBe(1);
    expect(CHERRY_RUNTIME_TAG).toBe('slicc-cherry');
  });

  describe('isCherryHostEventMessage', () => {
    it('accepts a cherry.host_event message', () => {
      expect(
        isCherryHostEventMessage({ type: 'cherry.host_event', targetId: 't1', name: 'ready' })
      ).toBe(true);
    });

    it('rejects other message types, null, and non-objects', () => {
      expect(isCherryHostEventMessage({ type: 'cherry.slicc_event' })).toBe(false);
      expect(isCherryHostEventMessage({ type: 'ping' })).toBe(false);
      expect(isCherryHostEventMessage(null)).toBe(false);
      expect(isCherryHostEventMessage('cherry.host_event')).toBe(false);
      expect(isCherryHostEventMessage(undefined)).toBe(false);
    });
  });

  describe('isCherrySliccEventMessage', () => {
    it('accepts a cherry.slicc_event message', () => {
      expect(
        isCherrySliccEventMessage({ type: 'cherry.slicc_event', targetId: 't1', name: 'go' })
      ).toBe(true);
    });

    it('rejects other message types, null, and non-objects', () => {
      expect(isCherrySliccEventMessage({ type: 'cherry.host_event' })).toBe(false);
      expect(isCherrySliccEventMessage(null)).toBe(false);
      expect(isCherrySliccEventMessage(42)).toBe(false);
    });
  });

  describe('unhandledProtocolMessage', () => {
    it('returns the message without throwing (version-skewed peers are legitimate)', () => {
      const skewed = { type: 'future.message' } as never;
      expect(unhandledProtocolMessage(skewed)).toEqual({ type: 'future.message' });
    });
  });
});
