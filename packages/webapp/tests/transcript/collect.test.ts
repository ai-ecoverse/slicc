/**
 * Tests for collectActiveTranscriptSources.
 *
 * Covers:
 *  - Waiting for all scoops to reach a completed-turn boundary
 *  - Returning cone + all scoops as sources
 *  - Preferring live agent messages over persisted sessions
 *  - Falling back to SessionStore.loadAll() persisted sessions
 *  - Building chatMessagesByConversation from UI sessions by JID
 *  - Rejecting an aborted wait
 *  - Partial-source detection (missing messages)
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { SessionData } from '../../src/core/types.js';
import type { ChatMessage, Session } from '../../src/scoops/chat-types.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';
import {
  collectActiveTranscriptSources,
  type TranscriptCollectionDeps,
} from '../../src/transcript/collect.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const cone: RegisteredScoop = {
  jid: 'cone-jid',
  name: 'Sliccy',
  folder: 'cone',
  isCone: true,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: '2024-01-01T00:00:00.000Z',
};

const scoop: RegisteredScoop = {
  jid: 'scoop-jid',
  name: 'Andy',
  folder: 'andy-scoop',
  isCone: false,
  type: 'scoop',
  trigger: '@andy-scoop',
  requiresTrigger: true,
  assistantLabel: 'andy-scoop',
  addedAt: '2024-01-01T00:00:00.000Z',
};

const coneMessages: readonly AgentMessage[] = [{ role: 'user', content: 'hello', timestamp: 1000 }];

const scoopMessages: readonly AgentMessage[] = [
  { role: 'user', content: 'scoop task', timestamp: 2000 },
];

function makeUiSession(id: string, messages: ChatMessage[] = []): Session {
  return { id, messages, createdAt: 1, updatedAt: 1 };
}

function noop(): Promise<void> {
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests: waiting behaviour
// ---------------------------------------------------------------------------

describe('collectActiveTranscriptSources — boundary waiting', () => {
  it('waits for every scoop to reach a completed-turn boundary', async () => {
    const coneUiSession = makeUiSession('session-cone');
    const scoopUiSession = makeUiSession(`session-${scoop.folder}`);
    let processing = true;
    const wait = vi.fn(async () => {
      processing = false;
    });
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone, scoop],
      isProcessing: () => processing,
      getAgentMessages: (jid) => (jid === cone.jid ? coneMessages : scoopMessages),
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [coneUiSession, scoopUiSession],
      wait,
    });
    expect(wait).toHaveBeenCalledOnce();
    expect(result.sources.map((s) => s.id)).toEqual([cone.jid, scoop.jid]);
    expect(result.chatMessagesByConversation.get(cone.jid)).toEqual(coneUiSession.messages);
  });

  it('does not call wait when no scoop is processing', async () => {
    const wait = vi.fn(noop);
    await collectActiveTranscriptSources({
      listScoops: () => [cone],
      isProcessing: () => false,
      getAgentMessages: () => coneMessages,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [makeUiSession('session-cone')],
      wait,
    });
    expect(wait).not.toHaveBeenCalled();
  });

  it('polls at 50 ms increments', async () => {
    let calls = 0;
    const wait = vi.fn(async (ms: number) => {
      calls++;
    });
    await collectActiveTranscriptSources({
      listScoops: () => [cone],
      isProcessing: () => calls < 3,
      getAgentMessages: () => coneMessages,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [makeUiSession('session-cone')],
      wait,
    });
    expect(wait).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls[0][0]).toBe(50);
  });

  it('throws transfer-aborted when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectActiveTranscriptSources(
        {
          listScoops: () => [cone],
          isProcessing: () => true,
          getAgentMessages: () => null,
          loadPersistedSessions: async () => [],
          loadUiChatSessions: async () => [],
          wait: noop,
        },
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'transfer-aborted' });
  });

  it('throws transfer-aborted when signal is aborted during wait', async () => {
    const controller = new AbortController();
    const wait = vi.fn(async () => {
      controller.abort();
    });
    await expect(
      collectActiveTranscriptSources(
        {
          listScoops: () => [cone],
          isProcessing: () => true,
          getAgentMessages: () => null,
          loadPersistedSessions: async () => [],
          loadUiChatSessions: async () => [],
          wait,
        },
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'transfer-aborted' });
  });
});

// ---------------------------------------------------------------------------
// Tests: source assembly
// ---------------------------------------------------------------------------

describe('collectActiveTranscriptSources — source assembly', () => {
  it('returns cone as kind=cone and scoops as kind=scoop', async () => {
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone, scoop],
      isProcessing: () => false,
      getAgentMessages: (jid) => (jid === cone.jid ? coneMessages : scoopMessages),
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [],
      wait: noop,
    });
    const coneSource = result.sources.find((s) => s.id === cone.jid);
    const scoopSource = result.sources.find((s) => s.id === scoop.jid);
    expect(coneSource?.kind).toBe('cone');
    expect(scoopSource?.kind).toBe('scoop');
    expect(scoopSource?.folder).toBe(scoop.folder);
  });

  it('prefers live agent messages over persisted sessions', async () => {
    const persisted: SessionData = {
      id: cone.jid,
      messages: [{ role: 'user', content: 'stale msg', timestamp: 0 } as AgentMessage],
      config: {} as SessionData['config'],
      createdAt: 0,
      updatedAt: 0,
    };
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone],
      isProcessing: () => false,
      getAgentMessages: () => coneMessages, // live
      loadPersistedSessions: async () => [persisted],
      loadUiChatSessions: async () => [],
      wait: noop,
    });
    expect(result.sources[0].messages).toBe(coneMessages);
  });

  it('falls back to persisted session when live messages are null', async () => {
    const persistedMessages: AgentMessage[] = [
      { role: 'user', content: 'persisted', timestamp: 1 },
    ];
    const persisted: SessionData = {
      id: cone.jid,
      messages: persistedMessages,
      config: {} as SessionData['config'],
      createdAt: 0,
      updatedAt: 0,
    };
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone],
      isProcessing: () => false,
      getAgentMessages: () => null, // no live messages
      loadPersistedSessions: async () => [persisted],
      loadUiChatSessions: async () => [],
      wait: noop,
    });
    expect(result.sources[0].messages).toEqual(persistedMessages);
  });

  it('returns empty messages when neither live nor persisted', async () => {
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone],
      isProcessing: () => false,
      getAgentMessages: () => null,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [],
      wait: noop,
    });
    expect(result.sources[0].messages).toEqual([]);
  });

  it('maps cone UI session (session-cone) to cone.jid in chatMessagesByConversation', async () => {
    const msg: ChatMessage = {
      id: 'm1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    };
    const coneUiSession = makeUiSession('session-cone', [msg]);
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone],
      isProcessing: () => false,
      getAgentMessages: () => coneMessages,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [coneUiSession],
      wait: noop,
    });
    expect(result.chatMessagesByConversation.get(cone.jid)).toEqual([msg]);
  });

  it(`maps scoop UI session (session-\${folder}) to scoop.jid`, async () => {
    const msg: ChatMessage = { id: 'm2', role: 'user', content: 'task', timestamp: 2 };
    const scoopUiSession = makeUiSession(`session-${scoop.folder}`, [msg]);
    const result = await collectActiveTranscriptSources({
      listScoops: () => [scoop],
      isProcessing: () => false,
      getAgentMessages: () => scoopMessages,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [scoopUiSession],
      wait: noop,
    });
    expect(result.chatMessagesByConversation.get(scoop.jid)).toEqual([msg]);
  });

  it('does not add jid to chatMessagesByConversation when UI session missing', async () => {
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone],
      isProcessing: () => false,
      getAgentMessages: () => coneMessages,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [], // no UI sessions
      wait: noop,
    });
    expect(result.chatMessagesByConversation.has(cone.jid)).toBe(false);
  });

  it('includes parentConversationId from scoop.parentJid', async () => {
    const scoopWithParent: RegisteredScoop = {
      ...scoop,
      parentJid: cone.jid,
    };
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone, scoopWithParent],
      isProcessing: () => false,
      getAgentMessages: () => null,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [],
      wait: noop,
    });
    const scoopSource = result.sources.find((s) => s.id === scoop.jid);
    expect(scoopSource?.parentConversationId).toBe(cone.jid);
  });

  it('includes originToolCallId from scoop.originToolCallId', async () => {
    const scoopWithTool: RegisteredScoop = {
      ...scoop,
      parentJid: cone.jid,
      originToolCallId: 'tool-call-xyz',
    };
    const result = await collectActiveTranscriptSources({
      listScoops: () => [scoopWithTool],
      isProcessing: () => false,
      getAgentMessages: () => null,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [],
      wait: noop,
    });
    expect(result.sources[0].originToolCallId).toBe('tool-call-xyz');
  });

  it('preserves scoop order from listScoops', async () => {
    const scoopB: RegisteredScoop = { ...scoop, jid: 'scoop-b', folder: 'scoop-b', name: 'B' };
    const result = await collectActiveTranscriptSources({
      listScoops: () => [cone, scoop, scoopB],
      isProcessing: () => false,
      getAgentMessages: () => null,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [],
      wait: noop,
    });
    expect(result.sources.map((s) => s.id)).toEqual([cone.jid, scoop.jid, scoopB.jid]);
  });
});

// ---------------------------------------------------------------------------
// Tests: TranscriptCollectionDeps shape compliance
// ---------------------------------------------------------------------------

describe('TranscriptCollectionDeps interface', () => {
  it('accepts a minimal deps object and resolves', async () => {
    const deps: TranscriptCollectionDeps = {
      listScoops: () => [],
      isProcessing: () => false,
      getAgentMessages: () => null,
      loadPersistedSessions: async () => [],
      loadUiChatSessions: async () => [],
      wait: noop,
    };
    const result = await collectActiveTranscriptSources(deps);
    expect(result.sources).toEqual([]);
    expect(result.chatMessagesByConversation.size).toBe(0);
  });
});
