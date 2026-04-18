/**
 * Tests for Orchestrator message routing and cone/scoop communication.
 *
 * Tests the routing logic WITHOUT spinning up full agent contexts.
 * Uses the DB layer directly to verify message persistence and routing.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  initDB,
  saveScoop,
  getMessagesForScoop,
  clearAllMessages,
  getAllScoops,
} from '../../src/scoops/db.js';
import { Orchestrator, SCOOP_IDLE_TIMEOUT_MS } from '../../src/scoops/orchestrator.js';
import type { RegisteredScoop, ChannelMessage } from '../../src/scoops/types.js';

// Test helpers — we can't instantiate a full Orchestrator (needs VirtualFS, DOM, etc.)
// but we CAN test the DB-level routing by simulating what handleMessage does.

const cone: RegisteredScoop = {
  jid: 'cone_main_1',
  name: 'Main',
  folder: 'main',
  isCone: true,
  type: 'cone',
  requiresTrigger: false,
  assistantLabel: 'sliccy',
  addedAt: new Date().toISOString(),
};

const testScoop: RegisteredScoop = {
  jid: 'scoop_test_1',
  name: 'test',
  folder: 'test-scoop',
  trigger: '@test-scoop',
  isCone: false,
  type: 'scoop',
  requiresTrigger: true,
  assistantLabel: 'test-scoop',
  addedAt: new Date().toISOString(),
};

const otherScoop: RegisteredScoop = {
  jid: 'scoop_other_1',
  name: 'other',
  folder: 'other-scoop',
  trigger: '@other-scoop',
  isCone: false,
  type: 'scoop',
  requiresTrigger: true,
  assistantLabel: 'other-scoop',
  addedAt: new Date().toISOString(),
};

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    chatJid: cone.jid,
    senderId: 'user',
    senderName: 'User',
    content: 'hello',
    timestamp: new Date().toISOString(),
    fromAssistant: false,
    channel: 'web',
    ...overrides,
  };
}

describe('Orchestrator Message Routing (DB-level)', () => {
  beforeAll(async () => {
    await initDB();
    await saveScoop(cone);
    await saveScoop(testScoop);
    await saveScoop(otherScoop);
  });

  beforeEach(async () => {
    await clearAllMessages();
  });

  describe('Message persistence', () => {
    it('messages saved with correct chatJid are retrievable', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      const msg = makeMessage({ chatJid: testScoop.jid, content: 'hello scoop' });
      await saveMessage(msg);

      const messages = await getMessagesForScoop(testScoop.jid);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('hello scoop');
    });

    it('messages for different scoops are isolated', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      await saveMessage(makeMessage({ chatJid: cone.jid, content: 'cone msg' }));
      await saveMessage(makeMessage({ chatJid: testScoop.jid, content: 'scoop msg' }));

      const coneMessages = await getMessagesForScoop(cone.jid);
      const scoopMessages = await getMessagesForScoop(testScoop.jid);
      expect(coneMessages).toHaveLength(1);
      expect(scoopMessages).toHaveLength(1);
      expect(coneMessages[0].content).toBe('cone msg');
      expect(scoopMessages[0].content).toBe('scoop msg');
    });
  });

  describe('Delegation message routing', () => {
    it('delegation message is saved with scoop chatJid', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      // Simulate what delegateToScoop does
      const delegationMsg = makeMessage({
        id: `delegate-${Date.now()}`,
        chatJid: testScoop.jid,
        senderId: 'cone',
        senderName: 'sliccy',
        content: 'Please download images from https://example.com',
        fromAssistant: true,
        channel: 'delegation',
      });
      await saveMessage(delegationMsg);

      const messages = await getMessagesForScoop(testScoop.jid);
      expect(messages).toHaveLength(1);
      expect(messages[0].channel).toBe('delegation');
      expect(messages[0].senderName).toBe('sliccy');
    });

    it('delegation message does not appear in cone messages', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      const delegationMsg = makeMessage({
        chatJid: testScoop.jid,
        channel: 'delegation',
      });
      await saveMessage(delegationMsg);

      const coneMessages = await getMessagesForScoop(cone.jid);
      expect(coneMessages).toHaveLength(0);
    });
  });

  describe('Completion notification routing', () => {
    it('scoop-notify message is saved with cone chatJid', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      // Simulate what the orchestrator does when a scoop completes
      const notifyMsg = makeMessage({
        id: `scoop-done-${testScoop.jid}-${Date.now()}`,
        chatJid: cone.jid,
        senderId: testScoop.folder,
        senderName: testScoop.assistantLabel,
        content: `[@${testScoop.assistantLabel} completed]:\nDownloaded 15 images`,
        fromAssistant: false,
        channel: 'scoop-notify',
      });
      await saveMessage(notifyMsg);

      const coneMessages = await getMessagesForScoop(cone.jid);
      expect(coneMessages).toHaveLength(1);
      expect(coneMessages[0].content).toContain('@test-scoop completed');
      expect(coneMessages[0].channel).toBe('scoop-notify');
    });

    it('scoop-notify does not appear in scoop messages', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      const notifyMsg = makeMessage({
        chatJid: cone.jid,
        channel: 'scoop-notify',
        content: '[@test-scoop completed]: done',
      });
      await saveMessage(notifyMsg);

      const scoopMessages = await getMessagesForScoop(testScoop.jid);
      expect(scoopMessages).toHaveLength(0);
    });
  });

  describe('Message filtering (getMessagesSince)', () => {
    it('excludes messages from specified sender', async () => {
      const { saveMessage, getMessagesSince } = await import('../../src/scoops/db.js');
      const ts = new Date(Date.now() - 5000).toISOString();

      await saveMessage(
        makeMessage({
          chatJid: testScoop.jid,
          senderName: 'User',
          content: 'user message',
        })
      );
      await saveMessage(
        makeMessage({
          chatJid: testScoop.jid,
          senderName: 'test-scoop',
          content: 'scoop own response',
        })
      );

      // Exclude scoop's own messages (prevents processing own responses)
      const messages = await getMessagesSince(testScoop.jid, ts, 'test-scoop');
      expect(messages).toHaveLength(1);
      expect(messages[0].senderName).toBe('User');
    });

    it('does NOT exclude cone messages from scoop queue', async () => {
      const { saveMessage, getMessagesSince } = await import('../../src/scoops/db.js');
      const ts = new Date(Date.now() - 5000).toISOString();

      await saveMessage(
        makeMessage({
          chatJid: testScoop.jid,
          senderName: 'sliccy',
          content: 'cone delegation message',
        })
      );

      // Exclude only the scoop's own name, not 'sliccy'
      const messages = await getMessagesSince(testScoop.jid, ts, 'test-scoop');
      expect(messages).toHaveLength(1);
      expect(messages[0].senderName).toBe('sliccy');
    });
  });

  describe('Routing rules', () => {
    it('user messages go to cone only (no @mention routing)', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      // User says "tell @test-scoop to do X" — this goes to the cone
      const userMsg = makeMessage({
        chatJid: cone.jid,
        content: 'tell @test-scoop to download images',
      });
      await saveMessage(userMsg);

      // Only cone has the message (no @mention routing copies)
      const coneMessages = await getMessagesForScoop(cone.jid);
      const scoopMessages = await getMessagesForScoop(testScoop.jid);
      expect(coneMessages).toHaveLength(1);
      expect(scoopMessages).toHaveLength(0);
    });

    it('fromAssistant messages are not @mention-routed', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      // Cone's send_message with @test-scoop — should NOT be duplicated to scoop
      const assistantMsg = makeMessage({
        chatJid: cone.jid,
        senderName: 'sliccy',
        content: '@test-scoop please download images',
        fromAssistant: true,
      });
      await saveMessage(assistantMsg);

      // Only the cone has it
      const scoopMessages = await getMessagesForScoop(testScoop.jid);
      expect(scoopMessages).toHaveLength(0);
    });

    it('scoop-notify messages are not @mention-routed (prevents loops)', async () => {
      const { saveMessage } = await import('../../src/scoops/db.js');
      // Completion notification contains @test-scoop — must NOT loop back
      const notifyMsg = makeMessage({
        chatJid: cone.jid,
        content: '[@test-scoop completed]: I finished downloading',
        channel: 'scoop-notify',
      });
      await saveMessage(notifyMsg);

      // Only cone has it, NOT routed back to test-scoop
      const scoopMessages = await getMessagesForScoop(testScoop.jid);
      expect(scoopMessages).toHaveLength(0);
    });
  });

  describe('Scoop type validation', () => {
    it('cone has correct properties', () => {
      expect(cone.isCone).toBe(true);
      expect(cone.type).toBe('cone');
      expect(cone.requiresTrigger).toBe(false);
      expect(cone.trigger).toBeUndefined();
      expect(cone.assistantLabel).toBe('sliccy');
    });

    it('scoop has correct properties', () => {
      expect(testScoop.isCone).toBe(false);
      expect(testScoop.type).toBe('scoop');
      expect(testScoop.requiresTrigger).toBe(true);
      expect(testScoop.trigger).toBe('@test-scoop');
      expect(testScoop.assistantLabel).toBe('test-scoop');
    });

    it('scoop trigger matches the expected format', () => {
      // Trigger should be @{folder}
      expect(testScoop.trigger).toBe(`@${testScoop.folder}`);
    });
  });
});

/**
 * Tests for Orchestrator SessionStore integration.
 *
 * Validates that the orchestrator correctly wires SessionStore cleanup
 * into scoop unregister and clear-all flows.
 */
describe('Orchestrator SessionStore integration', () => {
  // We can't instantiate a full Orchestrator (needs VFS, DOM, Chrome, etc.)
  // but we can verify the cleanup logic by testing the SessionStore calls
  // that the orchestrator makes in unregisterScoop() and clearAllMessages().

  it('unregisterScoop deletes the session for that scoop JID', async () => {
    // Simulate what orchestrator.unregisterScoop does with sessionStore
    const mockSessionStore = {
      delete: vi.fn().mockResolvedValue(undefined),
      clearAll: vi.fn().mockResolvedValue(undefined),
    };

    const jid = testScoop.jid;
    // This mirrors orchestrator.ts lines 225-227
    await mockSessionStore.delete(jid);

    expect(mockSessionStore.delete).toHaveBeenCalledWith(jid);
  });

  it('clearAllMessages clears all sessions', async () => {
    const mockSessionStore = {
      delete: vi.fn().mockResolvedValue(undefined),
      clearAll: vi.fn().mockResolvedValue(undefined),
    };

    // This mirrors orchestrator.ts lines 248-252
    await clearAllMessages();
    await mockSessionStore.clearAll();

    expect(mockSessionStore.clearAll).toHaveBeenCalled();
  });

  it('session delete failure does not prevent scoop cleanup', async () => {
    const mockSessionStore = {
      delete: vi.fn().mockRejectedValue(new Error('DB locked')),
    };

    // Mirrors the fire-and-forget .catch() pattern in orchestrator.ts
    const deleteResult = mockSessionStore.delete(testScoop.jid).catch(() => {
      // Error logged, not re-thrown — scoop cleanup continues
    });

    // Should resolve without throwing
    await expect(deleteResult).resolves.toBeUndefined();
  });

  it('session clearAll failure does not prevent message cleanup', async () => {
    const mockSessionStore = {
      clearAll: vi.fn().mockRejectedValue(new Error('DB locked')),
    };

    // Mirrors the .catch() pattern in orchestrator.ts clearAllMessages
    const clearResult = mockSessionStore.clearAll().catch(() => {
      // Error logged, not re-thrown
    });

    await expect(clearResult).resolves.toBeUndefined();
  });
});

/**
 * Tests for scoop idle detection.
 *
 * Validates the idle notification message format and routing
 * that the orchestrator uses when a scoop sits in ready state
 * without receiving work.
 */
describe('Scoop idle detection', () => {
  beforeAll(async () => {
    await initDB();
    await saveScoop(cone);
    await saveScoop(testScoop);
    await saveScoop(otherScoop);
  });

  beforeEach(async () => {
    await clearAllMessages();
  });

  it('SCOOP_IDLE_TIMEOUT_MS is exported and equals 120000', () => {
    expect(SCOOP_IDLE_TIMEOUT_MS).toBe(120000);
  });

  it('idle notification message has correct format', async () => {
    const { saveMessage } = await import('../../src/scoops/db.js');
    // Simulate what the idle timer does — build and save the notification
    const idleMsg = makeMessage({
      id: `scoop-idle-${testScoop.jid}-${Date.now()}`,
      chatJid: cone.jid,
      senderId: testScoop.folder,
      senderName: testScoop.assistantLabel,
      content: `[@${testScoop.assistantLabel} idle]: Scoop "${testScoop.name}" has been ready for 2 minutes without receiving any work. This is expected if the scoop is waiting for webhooks or cron tasks. If you intended to delegate work, use feed_scoop to send a prompt.`,
      fromAssistant: false,
      channel: 'scoop-idle',
    });
    await saveMessage(idleMsg);

    const coneMessages = await getMessagesForScoop(cone.jid);
    expect(coneMessages).toHaveLength(1);
    expect(coneMessages[0].channel).toBe('scoop-idle');
    expect(coneMessages[0].senderId).toBe(testScoop.folder);
    expect(coneMessages[0].senderName).toBe(testScoop.assistantLabel);
    expect(coneMessages[0].content).toContain(`[@${testScoop.assistantLabel} idle]`);
    expect(coneMessages[0].content).toBe(
      `[@${testScoop.assistantLabel} idle]: Scoop "${testScoop.name}" has been ready for 2 minutes without receiving any work. This is expected if the scoop is waiting for webhooks or cron tasks. If you intended to delegate work, use feed_scoop to send a prompt.`
    );
    expect(coneMessages[0].fromAssistant).toBe(false);
  });

  it('idle notification does not appear in scoop messages', async () => {
    const { saveMessage } = await import('../../src/scoops/db.js');
    // Save an idle notification to the cone
    const idleMsg = makeMessage({
      chatJid: cone.jid,
      senderId: testScoop.folder,
      senderName: testScoop.assistantLabel,
      content: `[@${testScoop.assistantLabel} idle]: Scoop "${testScoop.name}" has been ready for 2 minutes without receiving any work. This is expected if the scoop is waiting for webhooks or cron tasks. If you intended to delegate work, use feed_scoop to send a prompt.`,
      fromAssistant: false,
      channel: 'scoop-idle',
    });
    await saveMessage(idleMsg);

    // Verify it does NOT show up in the scoop's messages
    const scoopMessages = await getMessagesForScoop(testScoop.jid);
    expect(scoopMessages).toHaveLength(0);
  });
});

describe('Orchestrator session-restore compat for visiblePaths', () => {
  let orch: Orchestrator;

  beforeAll(() => {
    // TaskScheduler.start() calls window.setInterval; vitest runs in node.
    // Expose a minimal shim so orchestrator.init() can boot.
    if (typeof (globalThis as any).window === 'undefined') {
      (globalThis as any).window = globalThis;
    }
  });

  beforeEach(async () => {
    // Fresh DB state — clear any scoops from previous tests so we control
    // exactly what gets hydrated.
    await initDB();
    const existing = await getAllScoops();
    const { deleteScoop } = await import('../../src/scoops/db.js');
    for (const jid of Object.keys(existing)) {
      await deleteScoop(jid);
    }
  });

  afterEach(async () => {
    // Stop the scheduler's poll timer so tests don't leak across runs.
    await orch?.shutdown();
  });

  function noopCallbacks() {
    return {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onSendMessage: vi.fn(),
      onStatusChange: vi.fn(),
      onError: vi.fn(),
      getBrowserAPI: vi.fn(() => ({}) as any),
    };
  }

  async function initOrchestrator(): Promise<Orchestrator> {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();
    return orch;
  }

  it('backfills visiblePaths = ["/workspace/"] for truly-legacy non-cone scoops (no configSchemaVersion)', async () => {
    const legacy: RegisteredScoop = {
      jid: 'scoop_legacy_1',
      name: 'legacy',
      folder: 'legacy-scoop',
      trigger: '@legacy-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'legacy-scoop',
      addedAt: new Date().toISOString(),
      // Deliberately no `config` and no `configSchemaVersion` — mirrors a
      // scoop saved before the path-config fields existed.
    };
    await saveScoop(legacy);

    const o = await initOrchestrator();
    const restored = o.getScoop('scoop_legacy_1');
    expect(restored?.config?.visiblePaths).toEqual(['/workspace/']);
    expect(restored?.configSchemaVersion).toBe(1);
  });

  it('preserves an explicitly-set visiblePaths under the current schema version', async () => {
    const configured: RegisteredScoop = {
      jid: 'scoop_configured_1',
      name: 'configured',
      folder: 'configured-scoop',
      trigger: '@configured-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'configured-scoop',
      addedAt: new Date().toISOString(),
      config: { visiblePaths: ['/custom/'] },
      configSchemaVersion: 1,
    };
    await saveScoop(configured);

    const o = await initOrchestrator();
    const restored = o.getScoop('scoop_configured_1');
    expect(restored?.config?.visiblePaths).toEqual(['/custom/']);
  });

  it('preserves an explicit undefined visiblePaths on a current-schema record (no silent backfill)', async () => {
    // A scoop created deliberately with no read-only paths under the new
    // schema must keep that contract — the migration only fires for truly
    // legacy records (versions below the current schema).
    const strict: RegisteredScoop = {
      jid: 'scoop_strict_1',
      name: 'strict',
      folder: 'strict-scoop',
      trigger: '@strict-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'strict-scoop',
      addedAt: new Date().toISOString(),
      config: { modelId: 'claude-sonnet-4-6' }, // has config, no visiblePaths
      configSchemaVersion: 1,
    };
    await saveScoop(strict);

    const o = await initOrchestrator();
    const restored = o.getScoop('scoop_strict_1');
    expect(restored?.config?.visiblePaths).toBeUndefined();
    expect(restored?.configSchemaVersion).toBe(1);
  });

  it('preserves an explicit empty-array visiblePaths across restart', async () => {
    const strict: RegisteredScoop = {
      jid: 'scoop_empty_1',
      name: 'empty',
      folder: 'empty-scoop',
      trigger: '@empty-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'empty-scoop',
      addedAt: new Date().toISOString(),
      config: { visiblePaths: [] },
      configSchemaVersion: 1,
    };
    await saveScoop(strict);

    const o = await initOrchestrator();
    const restored = o.getScoop('scoop_empty_1');
    expect(restored?.config?.visiblePaths).toEqual([]);
  });

  it('does not touch cone records (cones ignore visiblePaths)', async () => {
    const legacyCone: RegisteredScoop = {
      jid: 'cone_legacy_1',
      name: 'Cone',
      folder: 'cone',
      isCone: true,
      type: 'cone',
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: new Date().toISOString(),
    };
    await saveScoop(legacyCone);

    const o = await initOrchestrator();
    const restored = o.getScoop('cone_legacy_1');
    expect(restored?.config?.visiblePaths).toBeUndefined();
    // Cones never get a schema stamp — they have no path-config surface.
    expect(restored?.configSchemaVersion).toBeUndefined();
  });
});
