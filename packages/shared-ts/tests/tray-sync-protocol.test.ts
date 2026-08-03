import { describe, expect, it } from 'vitest';
import type {
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
} from '../src/tray-sync-protocol.js';
import {
  CHERRY_RUNTIME_TAG,
  isCherryHostEventMessage,
  isCherrySliccEventMessage,
  TRAY_SYNC_PROTOCOL_VERSION,
  unhandledProtocolMessage,
} from '../src/tray-sync-protocol.js';

describe('tray-sync-protocol', () => {
  it('exposes protocol version 5 and the cherry runtime tag', () => {
    expect(TRAY_SYNC_PROTOCOL_VERSION).toBe(5);
    expect(CHERRY_RUNTIME_TAG).toBe('slicc-cherry');
  });

  it('includes model catalog and selection state in leader messages', () => {
    const messages: LeaderToFollowerMessage[] = [
      {
        type: 'models.list',
        models: [
          {
            providerName: 'Example Provider',
            modelId: 'example:reasoner',
            modelName: 'Reasoner',
            reasoning: true,
          },
        ],
      },
      {
        type: 'model.state',
        state: {
          activeModelId: 'example:reasoner',
          scoopJid: 'scoop@example',
          thinkingLevel: 'xhigh',
          effortOverride: 'max',
        },
      },
    ];

    expect(messages.map((message) => message.type)).toEqual(['models.list', 'model.state']);
  });

  it('includes model catalog requests and model/thinking selection in follower messages', () => {
    const messages: FollowerToLeaderMessage[] = [
      { type: 'models.request' },
      { type: 'model.select', modelId: 'example:reasoner' },
      {
        type: 'thinking.set',
        scoopJid: 'scoop@example',
        thinkingLevel: 'xhigh',
        effortOverride: 'max',
      },
    ];

    expect(messages.map((message) => message.type)).toEqual([
      'models.request',
      'model.select',
      'thinking.set',
    ]);
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
