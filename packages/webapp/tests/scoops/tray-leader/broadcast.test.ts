import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../../src/base/logger.js';
import {
  BroadcastManager,
  SPRINKLE_CHUNK_SIZE,
  SPRINKLE_CHUNK_THRESHOLD,
} from '../../../src/scoops/tray-leader/broadcast.js';
import type { LeaderSyncContext } from '../../../src/scoops/tray-leader/context.js';
import {
  type ConnectedFollower,
  FollowerRegistry,
} from '../../../src/scoops/tray-leader/follower-registry.js';
import type { LeaderSyncManagerOptions } from '../../../src/scoops/tray-leader-sync.js';
import type { LeaderToFollowerMessage } from '../../../src/scoops/tray-sync-protocol.js';

function createLog(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createHarness(overrides: Partial<LeaderSyncManagerOptions> = {}) {
  const log = createLog();
  const registry = new FollowerRegistry({ log, onMessage: vi.fn() });
  const sent: LeaderToFollowerMessage[] = [];
  const send = vi.fn((message: LeaderToFollowerMessage) => {
    sent.push(message);
    return true;
  });
  registry.followers.set('follower', {
    bootstrapId: 'follower',
    sync: { send },
  } as unknown as ConnectedFollower);
  const options: LeaderSyncManagerOptions = {
    getMessages: () => [],
    getScoopJid: () => 'cone',
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    sendControl: vi.fn(),
    ...overrides,
  };
  const context: LeaderSyncContext = {
    options,
    followers: registry,
    log,
    sendControl: options.sendControl,
  };
  return { broadcast: new BroadcastManager(context), registry, sent };
}

describe('BroadcastManager', () => {
  it('sends content at the sprinkle threshold without chunk metadata', async () => {
    const content = 'x'.repeat(SPRINKLE_CHUNK_THRESHOLD);
    const { broadcast, sent } = createHarness({ readSprinkleContent: () => content });

    await broadcast.handleSprinkleFetch('follower', 'request', 'threshold');

    expect(sent).toEqual([
      { type: 'sprinkle.content', requestId: 'request', sprinkleName: 'threshold', content },
    ]);
  });

  it('chunks content one character above the sprinkle threshold', async () => {
    const content = 'x'.repeat(SPRINKLE_CHUNK_THRESHOLD + 1);
    const { broadcast, sent } = createHarness({ readSprinkleContent: () => content });

    await broadcast.handleSprinkleFetch('follower', 'request', 'oversized');

    expect(sent).toHaveLength(3);
    expect(
      sent.map((message) => (message.type === 'sprinkle.content' ? message.chunkIndex : -1))
    ).toEqual([0, 1, 2]);
    expect(
      sent.every((message) => message.type === 'sprinkle.content' && message.totalChunks === 3)
    ).toBe(true);
    expect(
      sent.map((message) => (message.type === 'sprinkle.content' ? message.content : '')).join('')
    ).toBe(content);
    expect(SPRINKLE_CHUNK_SIZE).toBe(32 * 1024);
  });

  it('loads a follower-selected scoop for snapshots', async () => {
    const getMessagesForScoop = vi.fn(() => [
      { id: 'message', role: 'user' as const, content: 'selected', timestamp: 1 },
    ]);
    const { broadcast, registry, sent } = createHarness({ getMessagesForScoop });
    const follower = registry.followers.get('follower');
    if (!follower) throw new Error('missing follower');
    follower.selectedScoopJid = 'scoop-1';

    await broadcast.sendSnapshotToFollower('follower');

    expect(getMessagesForScoop).toHaveBeenCalledWith('scoop-1');
    expect(sent).toEqual([
      {
        type: 'snapshot',
        messages: [{ id: 'message', role: 'user', content: 'selected', timestamp: 1 }],
        scoopJid: 'scoop-1',
      },
    ]);
  });

  it('falls back to and re-registers active when the preserved scoop disappeared', async () => {
    const getMessagesForScoop = vi.fn();
    const { broadcast, registry, sent } = createHarness({
      getScoops: () => [{ jid: 'cone' }] as never,
      getMessages: () => [{ id: 'active', role: 'user' as const, content: 'active', timestamp: 1 }],
      getMessagesForScoop,
    });
    const follower = registry.followers.get('follower');
    if (!follower) throw new Error('missing follower');
    follower.selectedScoopJid = 'removed-scoop';

    await broadcast.sendSnapshotToFollower('follower', 'removed-scoop');

    expect(getMessagesForScoop).not.toHaveBeenCalled();
    expect(follower.selectedScoopJid).toBe('cone');
    expect(sent).toEqual([
      {
        type: 'snapshot',
        messages: [{ id: 'active', role: 'user', content: 'active', timestamp: 1 }],
        scoopJid: 'cone',
      },
    ]);
  });

  it('sends a sanitized model catalog and the follower-selected scoop state', () => {
    const getModelSelectionState = vi.fn((scoopJid: string) => ({
      activeModelId: 'adobe:claude-opus-4-8',
      scoopJid,
      thinkingLevel: 'xhigh' as const,
      effortOverride: 'max',
    }));
    const { broadcast, registry, sent } = createHarness({
      getModelCatalog: () =>
        [
          {
            providerName: 'Adobe',
            modelId: 'adobe:claude-opus-4-8',
            modelName: 'Claude Opus 4.8',
            reasoning: true,
            accessToken: 'must-not-cross-the-wire',
            accountId: 'private-account',
          },
        ] as never,
      getModelSelectionState,
    });
    const follower = registry.followers.get('follower');
    if (!follower) throw new Error('missing follower');
    follower.selectedScoopJid = 'scoop-1';

    broadcast.sendModelCatalogToFollower('follower');

    expect(sent).toEqual([
      {
        type: 'models.list',
        models: [
          {
            providerName: 'Adobe',
            modelId: 'adobe:claude-opus-4-8',
            modelName: 'Claude Opus 4.8',
            reasoning: true,
          },
        ],
      },
      {
        type: 'model.state',
        state: {
          activeModelId: 'adobe:claude-opus-4-8',
          scoopJid: 'scoop-1',
          thinkingLevel: 'xhigh',
          effortOverride: 'max',
        },
      },
    ]);
    expect(getModelSelectionState).toHaveBeenCalledWith('scoop-1');
  });
});
