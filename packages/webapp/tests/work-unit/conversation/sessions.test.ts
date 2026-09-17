/**
 * Legacy-shaped views of canonical records (#2365): what transcript export,
 * the Freezer and page hydration read now that the legacy stores are frozen.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { agentMessagesToChatMessages } from '../../../src/scoops/agent-message-to-chat.js';
import { CanonicalSessionReader } from '../../../src/work-unit/conversation/sessions.js';
import type { ConversationIdentity } from '../../../src/work-unit/conversation/store.js';
import { WorkUnitConversationStore } from '../../../src/work-unit/conversation/store.js';
import { legacyAgentMessages } from './fixtures.js';

let dbCounter = 0;

function identityFor(
  workUnitId: string,
  folder: string,
  workspaceId: string
): ConversationIdentity {
  return {
    key: `${workspaceId}::${workUnitId}`,
    workUnitId,
    workspaceId,
    folder,
    legacyKeys: { agentSessionId: workUnitId, chatSessionId: `session-${folder}` },
  };
}

const primary = identityFor('cone_1', 'cone', '/workspace');
const research = identityFor('cone_2', 'cone-research', '/cones/cone-research/workspace');
const scoop = identityFor('scoop_1', 'worker', '/scoops/worker/workspace');

describe('CanonicalSessionReader', () => {
  let store: WorkUnitConversationStore;
  let reader: CanonicalSessionReader;

  beforeEach(async () => {
    dbCounter++;
    store = new WorkUnitConversationStore({ dbName: `test-sessions-${dbCounter}` });
    reader = new CanonicalSessionReader(store);
    await store.syncAgentMessages(primary, legacyAgentMessages(), { createdAt: 5, now: 6 });
    await store.syncAgentMessages(research, legacyAgentMessages().slice(0, 1));
    await store.syncAgentMessages(scoop, legacyAgentMessages().slice(0, 2));
  });

  it('derives every unit as an agent-sessions row, keyed by jid', async () => {
    const sessions = await reader.loadAgentSessions();
    const primarySession = sessions.find((s) => s.id === 'cone_1');
    expect(sessions.map((s) => s.id).sort()).toEqual(['cone_1', 'cone_2', 'scoop_1']);
    expect(primarySession).toMatchObject({ createdAt: 5, updatedAt: 6, config: {} });
    expect(primarySession?.messages).toEqual(legacyAgentMessages());
  });

  it('derives every unit as a chat session, keyed like the legacy chat store', async () => {
    const sessions = await reader.loadChatSessions();
    expect(sessions.map((s) => s.id).sort()).toEqual([
      'session-cone',
      'session-cone-research',
      'session-worker',
    ]);
    const primarySession = sessions.find((s) => s.id === 'session-cone');
    expect(primarySession?.messages.map((m) => m.content)).toEqual(
      agentMessagesToChatMessages(legacyAgentMessages()).map((m) => m.content)
    );
  });

  it('finds a cone by folder, never a scoop of the same name', async () => {
    expect((await reader.loadRootChatSession('cone-research'))?.id).toBe('session-cone-research');
    expect((await reader.loadRootChatSession('cone'))?.messages.length).toBeGreaterThan(1);
    // `worker` is a scoop: its workspace is not a root's.
    expect(await reader.loadRootChatSession('worker')).toBeNull();
    expect(await reader.loadRootChatSession('cone-missing')).toBeNull();
  });

  it('answers the Freezer lookup by legacy session id', async () => {
    expect((await reader.load('session-cone-research'))?.id).toBe('session-cone-research');
    expect(await reader.load('not-a-session-id')).toBeNull();
  });

  it('reports a unit once when an interrupted rekey left it under two keys', async () => {
    // `rekey` is save-then-delete; a crash in between leaves both copies.
    const promoted = identityFor('scoop_1', 'worker', '/cones/worker/workspace');
    await store.syncAgentMessages(promoted, legacyAgentMessages(), { now: Date.now() + 1_000 });

    const agent = (await reader.loadAgentSessions()).filter((s) => s.id === 'scoop_1');
    const chat = (await reader.loadChatSessions()).filter((s) => s.id === 'session-worker');
    expect(agent).toHaveLength(1);
    expect(chat).toHaveLength(1);
    // The newer (promoted, continued) copy wins, not whichever sorts last.
    expect(agent[0].messages).toEqual(legacyAgentMessages());
  });
});
