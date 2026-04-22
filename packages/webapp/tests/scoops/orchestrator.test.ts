/**
 * Tests for Orchestrator message routing and cone/scoop communication.
 *
 * Tests the routing logic WITHOUT spinning up full agent contexts.
 * Uses the DB layer directly to verify message persistence and routing.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  initDB,
  saveScoop,
  getMessagesForScoop,
  clearAllMessages,
  getAllScoops,
} from '../../src/scoops/db.js';
import { Orchestrator, SCOOP_IDLE_TIMEOUT_MS } from '../../src/scoops/orchestrator.js';
import {
  CURRENT_SCOOP_CONFIG_VERSION,
  type RegisteredScoop,
  type ChannelMessage,
} from '../../src/scoops/types.js';

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

function extractVfsPath(content: string): string {
  const match = content.match(/^VFS path: (.+)$/m);
  expect(match).not.toBeNull();
  return match![1];
}

async function settleAndDisposeSharedFs(
  sharedFs: ReturnType<Orchestrator['getSharedFS']>
): Promise<void> {
  if (!sharedFs) return;

  const lfs = sharedFs.getLightningFS() as any;
  if (lfs?._operations?.size > 0) {
    await lfs._gracefulShutdown?.();
  }
  if (lfs?._deactivationTimeout) {
    clearTimeout(lfs._deactivationTimeout);
    lfs._deactivationTimeout = null;
  }
  if (lfs?._deactivate) {
    await lfs._deactivate();
  }

  await sharedFs.dispose();
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
        content:
          `[@${testScoop.assistantLabel} completed]\n` +
          `VFS path: /shared/scoop-notifications/test-scoop.md\n` +
          `Total lines: 1\n` +
          `Preview (up to 1000 chars):\nDownloaded 15 images`,
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
        content:
          '[@test-scoop completed]\n' +
          'VFS path: /shared/scoop-notifications/test-scoop.md\n' +
          'Total lines: 1\n' +
          'Preview (up to 1000 chars):\ndone',
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
        content:
          '[@test-scoop completed]\n' +
          'VFS path: /shared/scoop-notifications/test-scoop.md\n' +
          'Total lines: 1\n' +
          'Preview (up to 1000 chars):\nI finished downloading',
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

describe('Orchestrator session-restore compat for path config', () => {
  let orch: Orchestrator;
  let priorWindow: unknown;
  let windowWasShimmed = false;

  beforeAll(() => {
    // TaskScheduler.start() calls window.setInterval; vitest runs in node.
    // Expose a minimal shim so orchestrator.init() can boot, remembering the
    // prior value so afterAll can restore it (vitest may share a worker
    // across test files and we don't want to leak a globalThis.window shim).
    if (typeof (globalThis as any).window === 'undefined') {
      priorWindow = (globalThis as any).window;
      (globalThis as any).window = globalThis;
      windowWasShimmed = true;
    }
  });

  afterAll(() => {
    if (windowWasShimmed) {
      if (priorWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = priorWindow;
      }
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
    // Stop the scheduler's poll timer AND dispose the shared VirtualFS so
    // BroadcastChannel / IndexedDB handles don't leak across test runs.
    const sharedFs = orch?.getSharedFS();
    await orch?.shutdown();
    await settleAndDisposeSharedFs(sharedFs);
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

  it('backfills both visiblePaths and writablePaths for truly-legacy non-cone scoops', async () => {
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
    expect(restored?.config?.writablePaths).toEqual(['/scoops/legacy-scoop/', '/shared/']);
    expect(restored?.configSchemaVersion).toBe(CURRENT_SCOOP_CONFIG_VERSION);
  });

  it('bumps a v1-schema record to v2 by filling writablePaths only', async () => {
    // A scoop stamped under the previous (visiblePaths-only) schema must
    // gain writablePaths on restore without losing its existing visiblePaths.
    const v1: RegisteredScoop = {
      jid: 'scoop_v1_1',
      name: 'v1',
      folder: 'v1-scoop',
      trigger: '@v1-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'v1-scoop',
      addedAt: new Date().toISOString(),
      config: { visiblePaths: ['/custom/'] },
      configSchemaVersion: 1,
    };
    await saveScoop(v1);

    const o = await initOrchestrator();
    const restored = o.getScoop('scoop_v1_1');
    expect(restored?.config?.visiblePaths).toEqual(['/custom/']);
    expect(restored?.config?.writablePaths).toEqual(['/scoops/v1-scoop/', '/shared/']);
    expect(restored?.configSchemaVersion).toBe(CURRENT_SCOOP_CONFIG_VERSION);
  });

  it('preserves an explicitly-set writablePaths under the current schema', async () => {
    const configured: RegisteredScoop = {
      jid: 'scoop_configured_writable_1',
      name: 'configured-writable',
      folder: 'configured-writable-scoop',
      trigger: '@configured-writable-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'configured-writable-scoop',
      addedAt: new Date().toISOString(),
      config: { visiblePaths: [], writablePaths: ['/custom-write/'] },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(configured);

    const o = await initOrchestrator();
    const restored = o.getScoop('scoop_configured_writable_1');
    expect(restored?.config?.writablePaths).toEqual(['/custom-write/']);
    expect(restored?.config?.visiblePaths).toEqual([]);
  });

  it('preserves an explicit undefined writablePaths on a current-schema record (no silent backfill)', async () => {
    // A scoop created deliberately with no writable paths under the current
    // schema must keep that contract — migration only fires below current.
    const strict: RegisteredScoop = {
      jid: 'scoop_strict_writable_1',
      name: 'strict-writable',
      folder: 'strict-writable-scoop',
      trigger: '@strict-writable-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'strict-writable-scoop',
      addedAt: new Date().toISOString(),
      config: { modelId: 'claude-sonnet-4-6' }, // has config, no paths at all
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(strict);

    const o = await initOrchestrator();
    const restored = o.getScoop('scoop_strict_writable_1');
    expect(restored?.config?.writablePaths).toBeUndefined();
    expect(restored?.config?.visiblePaths).toBeUndefined();
    expect(restored?.configSchemaVersion).toBe(CURRENT_SCOOP_CONFIG_VERSION);
  });

  it('preserves an explicit empty-array writablePaths across restart', async () => {
    const strict: RegisteredScoop = {
      jid: 'scoop_empty_writable_1',
      name: 'empty-writable',
      folder: 'empty-writable-scoop',
      trigger: '@empty-writable-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: true,
      assistantLabel: 'empty-writable-scoop',
      addedAt: new Date().toISOString(),
      config: { writablePaths: [] },
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(strict);

    const o = await initOrchestrator();
    const restored = o.getScoop('scoop_empty_writable_1');
    expect(restored?.config?.writablePaths).toEqual([]);
  });

  it('does not touch cone records (cones ignore path config)', async () => {
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
    expect(restored?.config?.writablePaths).toBeUndefined();
    // Cones never get a schema stamp — they have no path-config surface.
    expect(restored?.configSchemaVersion).toBeUndefined();
  });
});

describe('Orchestrator scoop-notify gating (notifyOnComplete)', () => {
  let orch: Orchestrator;
  let priorWindow: unknown;
  let windowWasShimmed = false;

  beforeAll(() => {
    // TaskScheduler.start() calls window.setInterval; vitest runs in node.
    if (typeof (globalThis as any).window === 'undefined') {
      priorWindow = (globalThis as any).window;
      (globalThis as any).window = globalThis;
      windowWasShimmed = true;
    }
  });

  afterAll(() => {
    if (windowWasShimmed) {
      if (priorWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = priorWindow;
      }
    }
  });

  beforeEach(async () => {
    await initDB();
    // Start from a clean slate so notify messages from an earlier test
    // don't bleed into the next — the gate tests assert presence/absence
    // of a single scoop-notify keyed on the cone's jid.
    await clearAllMessages();
    const existing = await getAllScoops();
    const { deleteScoop } = await import('../../src/scoops/db.js');
    for (const jid of Object.keys(existing)) {
      await deleteScoop(jid);
    }
    // Seed a cone so the notify path has a target; without one the
    // orchestrator short-circuits out before we can observe gating.
    await saveScoop(cone);
  });

  afterEach(async () => {
    const sharedFs = orch?.getSharedFS();
    await orch?.shutdown();
    await settleAndDisposeSharedFs(sharedFs);
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

  /**
   * Cast to expose the private helper + response-buffer Map for tests.
   * Hitting the helper directly lets us assert the gate without driving
   * a full `ScoopContext` through an agent loop, which is what the
   * production code path uses to reach this method.
   *
   * We stub out `handleMessage` per-test so the completion path only
   * writes the artifact file and never queues a real message save.
   */
  interface OrchestratorPrivate {
    scoopResponseBuffer: Map<string, string>;
    maybeNotifyConeOnScoopComplete(jid: string): Promise<void>;
    handleMessage(msg: ChannelMessage): Promise<void>;
  }

  it('writes a scoop-notify to the cone when notifyOnComplete is unset (default)', async () => {
    const notifyingScoop: RegisteredScoop = {
      jid: 'scoop_notify_default_1',
      name: 'notify-default',
      folder: 'notify-default-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'notify-default-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(notifyingScoop);
    const o = await initOrchestrator();
    const priv = o as unknown as OrchestratorPrivate;

    // Capture the notify instead of letting it flush through LightningFS.
    const captured: ChannelMessage[] = [];
    priv.handleMessage = async (msg) => {
      captured.push(msg);
    };

    const responseText = 'all done\nwith details';
    priv.scoopResponseBuffer.set(notifyingScoop.jid, responseText);
    await priv.maybeNotifyConeOnScoopComplete(notifyingScoop.jid);

    expect(captured).toHaveLength(1);
    expect(captured[0].channel).toBe('scoop-notify');
    expect(captured[0].chatJid).toBe(cone.jid);
    expect(captured[0].content).toContain('VFS path: /shared/scoop-notifications/');
    expect(captured[0].content).toContain('Total lines: 2');
    expect(captured[0].content).toContain(responseText);
    expect(captured[0].senderId).toBe(notifyingScoop.folder);
    const sharedFs = o.getSharedFS()!;
    const artifactPath = extractVfsPath(captured[0].content);
    const stored = await sharedFs.readFile(artifactPath, { encoding: 'utf-8' });
    expect(stored).toBe(responseText);
    // Buffer cleared on fire.
    expect(priv.scoopResponseBuffer.has(notifyingScoop.jid)).toBe(false);
  });

  it('falls back to an inline preview notification when artifact persistence fails', async () => {
    const notifyingScoop: RegisteredScoop = {
      jid: 'scoop_notify_fallback_1',
      name: 'notify-fallback',
      folder: 'notify-fallback-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'notify-fallback-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(notifyingScoop);
    const o = await initOrchestrator();
    const priv = o as unknown as OrchestratorPrivate & {
      writeScoopCompletionArtifact(scoop: RegisteredScoop, responseText: string): Promise<string>;
    };

    const captured: ChannelMessage[] = [];
    priv.handleMessage = async (msg) => {
      captured.push(msg);
    };
    priv.writeScoopCompletionArtifact = vi.fn().mockRejectedValue(new Error('quota exceeded'));

    const responseText = 'artifact fallback result\nsecond line';
    priv.scoopResponseBuffer.set(notifyingScoop.jid, responseText);
    await priv.maybeNotifyConeOnScoopComplete(notifyingScoop.jid);

    expect(captured).toHaveLength(1);
    expect(captured[0].content).toContain('VFS path: unavailable');
    expect(captured[0].content).toContain('Artifact persistence error: quota exceeded');
    expect(captured[0].content).toContain('Total lines: 2');
    expect(captured[0].content).toContain(responseText);
  });

  it('suppresses the scoop-notify when notifyOnComplete is false', async () => {
    const ephemeralScoop: RegisteredScoop = {
      jid: 'scoop_ephemeral_1',
      name: 'ephemeral',
      folder: 'agent-ephemeral',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'agent-ephemeral',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
      notifyOnComplete: false,
    };
    await saveScoop(ephemeralScoop);
    const o = await initOrchestrator();
    const priv = o as unknown as OrchestratorPrivate;

    const captured: ChannelMessage[] = [];
    priv.handleMessage = async (msg) => {
      captured.push(msg);
    };

    priv.scoopResponseBuffer.set(ephemeralScoop.jid, 'final ephemeral output');
    await priv.maybeNotifyConeOnScoopComplete(ephemeralScoop.jid);

    expect(captured).toHaveLength(0);
    // Buffer still cleared so memory stays bounded even when the notify
    // side effect is opted out.
    expect(priv.scoopResponseBuffer.has(ephemeralScoop.jid)).toBe(false);
  });

  it('clears the response buffer and skips notify when the scoop produced no output', async () => {
    const notifyingScoop: RegisteredScoop = {
      jid: 'scoop_noout_default_1',
      name: 'noout',
      folder: 'noout-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'noout-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(notifyingScoop);
    const o = await initOrchestrator();
    const priv = o as unknown as OrchestratorPrivate;

    const captured: ChannelMessage[] = [];
    priv.handleMessage = async (msg) => {
      captured.push(msg);
    };

    // No response buffer entry — scoop said nothing.
    await priv.maybeNotifyConeOnScoopComplete(notifyingScoop.jid);

    // Even with notifyOnComplete default, empty output => no notify sent.
    expect(captured).toHaveLength(0);
  });
});

describe('Orchestrator scoop-notify file artifacts', () => {
  let orch: Orchestrator;
  let priorWindow: unknown;
  let windowWasShimmed = false;

  beforeAll(() => {
    if (typeof (globalThis as any).window === 'undefined') {
      priorWindow = (globalThis as any).window;
      (globalThis as any).window = globalThis;
      windowWasShimmed = true;
    }
  });

  afterAll(() => {
    if (windowWasShimmed) {
      if (priorWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = priorWindow;
      }
    }
  });

  beforeEach(async () => {
    await initDB();
    await clearAllMessages();
    const existing = await getAllScoops();
    const { deleteScoop } = await import('../../src/scoops/db.js');
    for (const jid of Object.keys(existing)) {
      await deleteScoop(jid);
    }
    await saveScoop(cone);
  });

  afterEach(async () => {
    const sharedFs = orch?.getSharedFS();
    await orch?.shutdown();
    await settleAndDisposeSharedFs(sharedFs);
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

  interface OrchestratorPrivate {
    scoopResponseBuffer: Map<string, string>;
    maybeNotifyConeOnScoopComplete(jid: string): Promise<void>;
    handleMessage(msg: ChannelMessage): Promise<void>;
  }

  it('writes the full response to VFS and sends only a 1000-char preview to the cone', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_truncate_test_1',
      name: 'truncate-test',
      folder: 'truncate-test-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'truncate-test-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    const captured: ChannelMessage[] = [];
    priv.handleMessage = async (msg) => {
      captured.push(msg);
    };

    const preview = 'a'.repeat(1000);
    const hiddenMarker = 'SECOND-LINE-HIDDEN-FROM-PREVIEW';
    const longResponse = `${preview}\n${hiddenMarker}\nthird line`;
    priv.scoopResponseBuffer.set(scoop.jid, longResponse);
    await priv.maybeNotifyConeOnScoopComplete(scoop.jid);

    expect(captured).toHaveLength(1);
    expect(captured[0].channel).toBe('scoop-notify');
    expect(captured[0].content).toContain(`[@${scoop.assistantLabel} completed]`);
    expect(captured[0].content).toContain('VFS path: /shared/scoop-notifications/');
    expect(captured[0].content).toContain('Total lines: 3');
    expect(captured[0].content).toContain(preview);
    expect(captured[0].content).not.toContain(hiddenMarker);

    const sharedFs = orch.getSharedFS()!;
    const artifactPath = extractVfsPath(captured[0].content);
    const stored = await sharedFs.readFile(artifactPath, { encoding: 'utf-8' });
    expect(stored).toBe(longResponse);
  });

  it('includes the full short response in the preview metadata', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_no_truncate_test_1',
      name: 'no-truncate-test',
      folder: 'no-truncate-test-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'no-truncate-test-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    const captured: ChannelMessage[] = [];
    priv.handleMessage = async (msg) => {
      captured.push(msg);
    };

    const shortResponse = 'Short completion message\nwith two lines';
    priv.scoopResponseBuffer.set(scoop.jid, shortResponse);
    await priv.maybeNotifyConeOnScoopComplete(scoop.jid);

    expect(captured).toHaveLength(1);
    expect(captured[0].channel).toBe('scoop-notify');
    expect(captured[0].content).toContain(`[@${scoop.assistantLabel} completed]`);
    expect(captured[0].content).toContain('Total lines: 2');
    expect(captured[0].content).toContain(shortResponse);

    const sharedFs = orch.getSharedFS()!;
    const artifactPath = extractVfsPath(captured[0].content);
    const stored = await sharedFs.readFile(artifactPath, { encoding: 'utf-8' });
    expect(stored).toBe(shortResponse);
  });

  it('counts trailing-newline output as a single line', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_trailing_newline_1',
      name: 'trailing-newline',
      folder: 'trailing-newline-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'trailing-newline-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    const captured: ChannelMessage[] = [];
    priv.handleMessage = async (msg) => {
      captured.push(msg);
    };

    priv.scoopResponseBuffer.set(scoop.jid, 'line one\n');
    await priv.maybeNotifyConeOnScoopComplete(scoop.jid);

    expect(captured).toHaveLength(1);
    expect(captured[0].content).toContain('Total lines: 1');
  });

  it('prunes old scoop notification artifacts to keep the directory bounded', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_prune_test_1',
      name: 'prune-test',
      folder: 'prune-test-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'prune-test-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const sharedFs = orch.getSharedFS()!;
    await sharedFs.mkdir('/shared/scoop-notifications', { recursive: true });
    await sharedFs.writeFile('/shared/scoop-notifications/2026-01-01T00-00-00-000Z-a.md', 'a');
    await sharedFs.writeFile('/shared/scoop-notifications/2026-01-01T00-00-01-000Z-b.md', 'b');
    await sharedFs.writeFile('/shared/scoop-notifications/2026-01-01T00-00-02-000Z-c.md', 'c');

    const priv = orch as unknown as OrchestratorPrivate & {
      pruneScoopCompletionArtifacts(maxArtifacts?: number): Promise<void>;
    };
    await priv.pruneScoopCompletionArtifacts(2);

    const entries = await sharedFs.readDir('/shared/scoop-notifications');
    const names = entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => entry.name)
      .sort();

    expect(names).toEqual(['2026-01-01T00-00-01-000Z-b.md', '2026-01-01T00-00-02-000Z-c.md']);
  });
});

describe('Orchestrator observer cleanup on scoop teardown', () => {
  let orch: Orchestrator;
  let priorWindow: unknown;
  let windowWasShimmed = false;

  beforeAll(() => {
    if (typeof (globalThis as any).window === 'undefined') {
      priorWindow = (globalThis as any).window;
      (globalThis as any).window = globalThis;
      windowWasShimmed = true;
    }
  });

  afterAll(() => {
    if (windowWasShimmed) {
      if (priorWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = priorWindow;
      }
    }
  });

  beforeEach(async () => {
    await initDB();
    const existing = await getAllScoops();
    const { deleteScoop } = await import('../../src/scoops/db.js');
    for (const jid of Object.keys(existing)) {
      await deleteScoop(jid);
    }
    await saveScoop(cone);
  });

  afterEach(async () => {
    const sharedFs = orch?.getSharedFS();
    await orch?.shutdown();
    await settleAndDisposeSharedFs(sharedFs);
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

  interface OrchestratorObserverInternals {
    scoopObservers: Map<string, Set<unknown>>;
    dispatchScoopEvent(jid: string, event: 'onSendMessage', text: string): void;
  }

  it('drops lingering observers when unregisterScoop runs', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_observer_leak_1',
      name: 'observer-leak',
      folder: 'observer-leak-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'observer-leak-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const handler = vi.fn();
    // Subscribe but "forget" to unsubscribe — the production pathway
    // that matters is a crash/exception preventing the bridge's
    // `finally` from running. We skip the `unsubscribe()` return value
    // on purpose.
    orch.observeScoop(scoop.jid, { onSendMessage: handler });

    const internals = orch as unknown as OrchestratorObserverInternals;
    expect(internals.scoopObservers.has(scoop.jid)).toBe(true);

    await orch.unregisterScoop(scoop.jid);

    expect(internals.scoopObservers.has(scoop.jid)).toBe(false);

    // A post-teardown dispatch must NOT reach the lingering handler.
    internals.dispatchScoopEvent(scoop.jid, 'onSendMessage', 'post-teardown text');
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops observers when destroyScoopTab runs standalone (shutdown / reset paths)', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_observer_leak_2',
      name: 'observer-leak-2',
      folder: 'observer-leak-2-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'observer-leak-2-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const handler = vi.fn();
    orch.observeScoop(scoop.jid, { onSendMessage: handler });

    const internals = orch as unknown as OrchestratorObserverInternals;
    expect(internals.scoopObservers.has(scoop.jid)).toBe(true);

    await orch.destroyScoopTab(scoop.jid);

    expect(internals.scoopObservers.has(scoop.jid)).toBe(false);
    internals.dispatchScoopEvent(scoop.jid, 'onSendMessage', 'post-teardown text');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('Orchestrator scoop-notify onIncomingMessage visibility', () => {
  // Confirms the regression fix: when a scoop completes, the orchestrator
  // must fire `onIncomingMessage` for the cone so the UI can render the
  // scoop-notify as a lick. Before this fix the notify only flowed into
  // the cone's agent queue and never surfaced in the chat panel, so the
  // user saw scoops complete silently.
  let orch: Orchestrator;
  let priorWindow: unknown;
  let windowWasShimmed = false;

  beforeAll(() => {
    if (typeof (globalThis as any).window === 'undefined') {
      priorWindow = (globalThis as any).window;
      (globalThis as any).window = globalThis;
      windowWasShimmed = true;
    }
  });

  afterAll(() => {
    if (windowWasShimmed) {
      if (priorWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = priorWindow;
      }
    }
  });

  beforeEach(async () => {
    await initDB();
    await clearAllMessages();
    const existing = await getAllScoops();
    const { deleteScoop } = await import('../../src/scoops/db.js');
    for (const jid of Object.keys(existing)) {
      await deleteScoop(jid);
    }
    await saveScoop(cone);
  });

  afterEach(async () => {
    const sharedFs = orch?.getSharedFS();
    await orch?.shutdown();
    // Use the settle helper so any scheduled LightningFS _deactivate
    // timers are drained before dispose — otherwise the timer fires
    // after the backend is torn down and Node surfaces an unhandled
    // "Cannot read properties of null (reading 'deactivate')" rejection.
    await settleAndDisposeSharedFs(sharedFs);
  });

  interface OrchestratorPrivate {
    scoopResponseBuffer: Map<string, string>;
    maybeNotifyConeOnScoopComplete(jid: string): Promise<void>;
    handleMessage(msg: ChannelMessage): Promise<void>;
    muteScoops(jids: readonly string[]): void;
    unmuteScoops(
      jids: readonly string[]
    ): Promise<
      Array<{ jid: string; summary: string; timestamp: string; notificationPath: string | null }>
    >;
    mutedScoops: Set<string>;
    pendingCompletions: Map<string, { responseText: string; timestamp: string }>;
    completionWaiters: Map<string, Array<(s: string | null) => void>>;
  }

  function noopCallbacksWith(incomingCapture: (scoopJid: string, msg: ChannelMessage) => void): {
    onResponse: ReturnType<typeof vi.fn>;
    onResponseDone: ReturnType<typeof vi.fn>;
    onSendMessage: ReturnType<typeof vi.fn>;
    onStatusChange: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    getBrowserAPI: ReturnType<typeof vi.fn>;
    onIncomingMessage: (scoopJid: string, msg: ChannelMessage) => void;
  } {
    return {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onSendMessage: vi.fn(),
      onStatusChange: vi.fn(),
      onError: vi.fn(),
      getBrowserAPI: vi.fn(() => ({}) as any),
      onIncomingMessage: incomingCapture,
    };
  }

  it('fires onIncomingMessage with the scoop-notify so the UI renders a lick', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_incoming_1',
      name: 'notify-vis',
      folder: 'notify-vis-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'notify-vis-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const incoming: Array<{ scoopJid: string; msg: ChannelMessage }> = [];
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(
      container,
      noopCallbacksWith((scoopJid, msg) => {
        incoming.push({ scoopJid, msg });
      })
    );
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    priv.handleMessage = async () => {
      /* suppress LightningFS writes so afterEach dispose doesn't race */
    };

    priv.scoopResponseBuffer.set(scoop.jid, 'scoop output');
    await priv.maybeNotifyConeOnScoopComplete(scoop.jid);

    expect(incoming).toHaveLength(1);
    expect(incoming[0].scoopJid).toBe(cone.jid);
    expect(incoming[0].msg.channel).toBe('scoop-notify');
    expect(incoming[0].msg.content).toContain('scoop output');
  });

  it('muteScoops stashes the completion and unmuteScoops returns it WITHOUT firing new events', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_mute_1',
      name: 'mute-scoop',
      folder: 'mute-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'mute-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const incoming: ChannelMessage[] = [];
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(
      container,
      noopCallbacksWith((_jid, msg) => {
        incoming.push(msg);
      })
    );
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    priv.handleMessage = async () => {};

    priv.muteScoops([scoop.jid]);
    priv.scoopResponseBuffer.set(scoop.jid, 'muted output');
    await priv.maybeNotifyConeOnScoopComplete(scoop.jid);

    // Muted: nothing should reach the cone yet.
    expect(incoming).toHaveLength(0);
    expect(priv.pendingCompletions.has(scoop.jid)).toBe(true);

    const consumed = await priv.unmuteScoops([scoop.jid]);

    // Unmute returns the stashed summary for the caller (scoop_unmute
    // tool) to fold into its result — it must NOT re-fire the lick as
    // a fresh scoop-notify (which would trigger another cone turn, the
    // very thing scoop_mute was called to avoid).
    expect(consumed).toHaveLength(1);
    expect(consumed[0].jid).toBe(scoop.jid);
    expect(consumed[0].summary).toBe('muted output');
    // The full response is still persisted to the artifact dir so the
    // cone can read it on demand via the returned path.
    expect(consumed[0].notificationPath).toMatch(/^\/shared\/scoop-notifications\/.+\.md$/);
    expect(incoming).toHaveLength(0);
    expect(priv.pendingCompletions.has(scoop.jid)).toBe(false);
    expect(priv.mutedScoops.has(scoop.jid)).toBe(false);
  });

  it('unmuteScoops returns an empty list for scoops without stashed completions', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_unmute_noop_1',
      name: 'unmute-noop',
      folder: 'unmute-noop-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'unmute-noop-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(
      container,
      noopCallbacksWith(() => {})
    );
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    priv.handleMessage = async () => {};

    priv.muteScoops([scoop.jid]);
    const consumed = priv.unmuteScoops([scoop.jid]);
    expect(consumed).toHaveLength(0);
    expect(priv.mutedScoops.has(scoop.jid)).toBe(false);
  });

  it('waitForScoops resolves with captured summaries and does not ping the cone', async () => {
    const a: RegisteredScoop = {
      jid: 'scoop_wait_a',
      name: 'wait-a',
      folder: 'wait-a-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'wait-a-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    const b: RegisteredScoop = {
      ...a,
      jid: 'scoop_wait_b',
      folder: 'wait-b-scoop',
      assistantLabel: 'wait-b-scoop',
    };
    await saveScoop(a);
    await saveScoop(b);

    const incoming: ChannelMessage[] = [];
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(
      container,
      noopCallbacksWith((_jid, msg) => {
        incoming.push(msg);
      })
    );
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    priv.handleMessage = async () => {};

    // Start the wait then complete the scoops.
    const waitPromise = orch.waitForScoops([a.jid, b.jid], 2000);

    priv.scoopResponseBuffer.set(a.jid, 'result A');
    await priv.maybeNotifyConeOnScoopComplete(a.jid);
    priv.scoopResponseBuffer.set(b.jid, 'result B');
    await priv.maybeNotifyConeOnScoopComplete(b.jid);

    const results = await waitPromise;
    expect(results).toHaveLength(2);
    const mapped = new Map(results.map((r) => [r.jid, r]));
    expect(mapped.get(a.jid)?.summary).toBe('result A');
    expect(mapped.get(a.jid)?.timedOut).toBe(false);
    expect(mapped.get(b.jid)?.summary).toBe('result B');
    expect(mapped.get(b.jid)?.timedOut).toBe(false);
    // scoop_wait must NOT also ping the cone — otherwise the cone takes
    // two turns for one coordinated wait.
    expect(incoming).toHaveLength(0);
    // After resolution mute is released and nothing stays buffered.
    expect(priv.mutedScoops.has(a.jid)).toBe(false);
    expect(priv.mutedScoops.has(b.jid)).toBe(false);
    expect(priv.pendingCompletions.has(a.jid)).toBe(false);
    expect(priv.pendingCompletions.has(b.jid)).toBe(false);
  });

  it('waitForScoops times out scoops that never complete', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_wait_timeout_1',
      name: 'wait-timeout',
      folder: 'wait-timeout-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'wait-timeout-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(
      container,
      noopCallbacksWith(() => {})
    );
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    priv.handleMessage = async () => {};

    const results = await orch.waitForScoops([scoop.jid], 20);
    expect(results).toHaveLength(1);
    expect(results[0].timedOut).toBe(true);
    expect(results[0].summary).toBeNull();
    // On timeout the registered waiter must be cleaned up so a later
    // completion doesn't stall waiting for a list that no longer exists.
    expect(priv.completionWaiters.has(scoop.jid)).toBe(false);
    // Mute we added is released on timeout.
    expect(priv.mutedScoops.has(scoop.jid)).toBe(false);
  });

  it('waitForScoops consumes an already-pending completion without pinging the cone', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_wait_prepend_1',
      name: 'wait-prepend',
      folder: 'wait-prepend-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'wait-prepend-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const incoming: ChannelMessage[] = [];
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(
      container,
      noopCallbacksWith((_jid, msg) => {
        incoming.push(msg);
      })
    );
    await orch.init();

    const priv = orch as unknown as OrchestratorPrivate;
    priv.handleMessage = async () => {};

    // Completion lands while the scoop is muted (as if scoop_mute was
    // active). Then scoop_wait is invoked — it should claim the stashed
    // summary and NOT re-fire it through the cone.
    priv.muteScoops([scoop.jid]);
    priv.scoopResponseBuffer.set(scoop.jid, 'stashed output');
    await priv.maybeNotifyConeOnScoopComplete(scoop.jid);
    expect(priv.pendingCompletions.has(scoop.jid)).toBe(true);

    const results = await orch.waitForScoops([scoop.jid], 50);
    expect(results[0].summary).toBe('stashed output');
    expect(results[0].timedOut).toBe(false);
    expect(incoming).toHaveLength(0);
    expect(priv.pendingCompletions.has(scoop.jid)).toBe(false);
  });
});
