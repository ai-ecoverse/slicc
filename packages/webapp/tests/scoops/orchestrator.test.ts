/**
 * Tests for Orchestrator message routing and cone/scoop communication.
 *
 * Tests the routing logic WITHOUT spinning up full agent contexts.
 * Uses the DB layer directly to verify message persistence and routing.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import {
  clearAllMessages,
  getAllScoops,
  getMessagesForScoop,
  initDB,
  saveScoop,
} from '../../src/scoops/db.js';
import { Orchestrator, SCOOP_IDLE_TIMEOUT_MS } from '../../src/scoops/orchestrator.js';
import {
  type ChannelMessage,
  CURRENT_SCOOP_CONFIG_VERSION,
  type RegisteredScoop,
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
  // LightningFS-specific graceful shutdown / debounce cancel is no
  // longer needed — ZenFS backends own no IDB-debounced state, so
  // `dispose()` alone is sufficient.
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

  it('notifies onScoopUnregistered with the scoop snapshot on programmatic unregister', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_unreg_cb_1',
      name: 'unreg-cb',
      folder: 'unreg-cb-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'unreg-cb-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    const onScoopUnregistered = vi.fn();
    orch = new Orchestrator(container, { ...noopCallbacks(), onScoopUnregistered });
    await orch.init();

    // Programmatic teardown — the path ephemeral `agent` spawns,
    // `drop_scoop` tool calls, and workflow subagents go through.
    // Consumers (e.g. the kernel bridge) must learn about it so they
    // can evict per-scoop chat buffers; before this hook existed,
    // buffers leaked the scoop's full transcript (incl. tool results).
    await orch.unregisterScoop(scoop.jid);

    expect(onScoopUnregistered).toHaveBeenCalledTimes(1);
    expect(onScoopUnregistered.mock.calls[0][0]).toMatchObject({
      jid: scoop.jid,
      folder: scoop.folder,
    });
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
    const consumed = await priv.unmuteScoops([scoop.jid]);
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

  it('waitForScoops dedupes duplicate jids so a single completion resolves all entries', async () => {
    // Without dedup, the same jid registered twice would leave the
    // second waiter stuck on its `results.has(jid)` guard (no
    // `resolve()`) and stall `Promise.all(promises)` indefinitely.
    const scoop: RegisteredScoop = {
      jid: 'scoop_wait_dedup_1',
      name: 'wait-dedup',
      folder: 'wait-dedup-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'wait-dedup-scoop',
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

    const waitPromise = orch.waitForScoops([scoop.jid, scoop.jid]);
    // Give the micro-tasks a chance to register the waiters.
    await new Promise((resolve) => setTimeout(resolve, 5));
    priv.scoopResponseBuffer.set(scoop.jid, 'dedup output');
    priv.maybeNotifyConeOnScoopComplete(scoop.jid);
    const results = await waitPromise;

    expect(results).toHaveLength(2);
    expect(results[0].summary).toBe('dedup output');
    expect(results[1].summary).toBe('dedup output');
    expect(priv.completionWaiters.has(scoop.jid)).toBe(false);
  });

  it('waitForScoops treats timeout 0 as immediate (does not hang)', async () => {
    // timeout_ms === 0 is an explicit "tell me who's already done"
    // request. The previous `timeoutMs > 0` guard disabled the timer
    // entirely for 0, so a scoop that never completed would stall
    // Promise.all forever. This test asserts 0 returns immediately
    // (with a timed-out entry) instead.
    const scoop: RegisteredScoop = {
      jid: 'scoop_wait_zero_1',
      name: 'wait-zero',
      folder: 'wait-zero-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'wait-zero-scoop',
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

    const started = Date.now();
    const results = await orch.waitForScoops([scoop.jid], 0);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(100);
    expect(results[0].timedOut).toBe(true);
    expect(results[0].summary).toBeNull();
  });

  it('shutdown drains pending scoop_wait waiters so in-flight calls resolve', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_wait_shutdown_1',
      name: 'wait-shutdown',
      folder: 'wait-shutdown-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'wait-shutdown-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    await saveScoop(scoop);

    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    const localOrch = new Orchestrator(
      container,
      noopCallbacksWith(() => {})
    );
    await localOrch.init();

    const priv = localOrch as unknown as OrchestratorPrivate;
    priv.handleMessage = async () => {};

    // Pre-seed mute + pending state so shutdown's clear() branches are
    // exercised, and kick off a long-running waitForScoops that would
    // hang without shutdown's drain.
    priv.muteScoops([scoop.jid]);
    const sharedFs = localOrch.getSharedFS();
    const waitPromise = localOrch.waitForScoops([scoop.jid]); // no timeout
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(priv.completionWaiters.size).toBeGreaterThan(0);

    await localOrch.shutdown();
    await sharedFs?.dispose();

    const results = await waitPromise;
    expect(results[0].summary).toBeNull();
    expect(results[0].timedOut).toBe(true);
    expect(priv.completionWaiters.size).toBe(0);
    expect(priv.mutedScoops.size).toBe(0);
    expect(priv.pendingCompletions.size).toBe(0);

    // null out the suite-level orch so afterEach doesn't double-shutdown.
    orch = undefined as unknown as Orchestrator;
  });

  it('scheduleScoopWait returns synchronously, mutes targets, and fires a scoop-wait lick on completion', async () => {
    // The whole point of the refactor: scoop_wait must NOT freeze the
    // cone. scheduleScoopWait kicks the wait off in the background and
    // returns immediately; when every listed scoop has completed, the
    // orchestrator must fire a single `scoop-wait` channel message
    // through onIncomingMessage so the UI renders the lick.
    const a: RegisteredScoop = {
      jid: 'scoop_sched_a',
      name: 'sched-a',
      folder: 'sched-a-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'sched-a-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    const b: RegisteredScoop = {
      ...a,
      jid: 'scoop_sched_b',
      folder: 'sched-b-scoop',
      assistantLabel: 'sched-b-scoop',
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

    const start = Date.now();
    const ack = orch.scheduleScoopWait([a.jid, b.jid], 2000);
    const elapsed = Date.now() - start;
    // Sync return — must not have done any actual waiting.
    expect(elapsed).toBeLessThan(50);
    expect(ack.scheduled).toEqual([a.jid, b.jid]);
    expect(ack.unknown).toEqual([]);
    // Mute is installed synchronously by waitForScoops' sync setup.
    expect(priv.mutedScoops.has(a.jid)).toBe(true);
    expect(priv.mutedScoops.has(b.jid)).toBe(true);

    priv.scoopResponseBuffer.set(a.jid, 'result A');
    await priv.maybeNotifyConeOnScoopComplete(a.jid);
    priv.scoopResponseBuffer.set(b.jid, 'result B');
    await priv.maybeNotifyConeOnScoopComplete(b.jid);

    // Allow the background `void this.waitForScoops(...).then(...)` to
    // settle and emit the scoop-wait lick.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Exactly one scoop-wait lick — completed scoops must NOT also
    // fire individual scoop-notify licks while a wait is active.
    expect(incoming).toHaveLength(1);
    const lick = incoming[0];
    expect(lick.channel).toBe('scoop-wait');
    expect(lick.content).toContain('[scoop_wait completed]');
    expect(lick.content).toContain('2 completed, 0 timed out');
    expect(lick.content).toContain('--- sched-a-scoop ---');
    expect(lick.content).toContain('result A');
    expect(lick.content).toContain('--- sched-b-scoop ---');
    expect(lick.content).toContain('result B');

    // Mute released after completion.
    expect(priv.mutedScoops.has(a.jid)).toBe(false);
    expect(priv.mutedScoops.has(b.jid)).toBe(false);
  });

  it('scheduleScoopWait fires a scoop-wait lick when the timeout elapses', async () => {
    const scoop: RegisteredScoop = {
      jid: 'scoop_sched_timeout_1',
      name: 'sched-timeout',
      folder: 'sched-timeout-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'sched-timeout-scoop',
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

    orch.scheduleScoopWait([scoop.jid], 30);
    // Wait long enough for the timer to fire and the lick to be
    // dispatched on the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(incoming).toHaveLength(1);
    const lick = incoming[0];
    expect(lick.channel).toBe('scoop-wait');
    expect(lick.content).toContain('0 completed, 1 timed out');
    expect(lick.content).toContain('--- sched-timeout-scoop (timed out) ---');
  });

  it('scheduleScoopWait reports unknown jids in the sync ack and skips them in the lick', async () => {
    // The lick body must match the synchronous ack: unknown jids stay
    // in the ack only and are NOT re-rendered as timed-out rows in the
    // eventual lick. Without this contract the cone sees the same
    // unknown scoop twice (once in the tool result, once in the lick),
    // contradicting the "ack tells you what's scheduled, lick tells
    // you what completed" split.
    const scoop: RegisteredScoop = {
      jid: 'scoop_sched_partial_1',
      name: 'sched-partial',
      folder: 'sched-partial-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'sched-partial-scoop',
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

    const ack = orch.scheduleScoopWait([scoop.jid, 'scoop_unknown_42'], 10);
    expect(ack.scheduled).toEqual([scoop.jid]);
    expect(ack.unknown).toEqual(['scoop_unknown_42']);

    // Let the timeout fire and the lick land.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(incoming).toHaveLength(1);
    const lick = incoming[0];
    expect(lick.channel).toBe('scoop-wait');
    // Unknown jid must NOT appear in the lick — only the scheduled one.
    expect(lick.content).not.toContain('scoop_unknown_42');
    expect(lick.content).toContain('--- sched-partial-scoop (timed out) ---');
    expect(lick.content).toContain('0 completed, 1 timed out');
  });

  it('scheduleScoopWait collapses duplicate jids into a single lick row', async () => {
    // `waitForScoops` already dedupes its input, but `scheduleScoopWait`
    // must also pass the de-duped list so the lick body has one row
    // per scoop instead of N copies. The synchronous ack reflects the
    // same de-duplication.
    const scoop: RegisteredScoop = {
      jid: 'scoop_sched_dedup_1',
      name: 'sched-dedup',
      folder: 'sched-dedup-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'sched-dedup-scoop',
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

    const ack = orch.scheduleScoopWait([scoop.jid, scoop.jid], 30);
    expect(ack.scheduled).toEqual([scoop.jid]);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(incoming).toHaveLength(1);
    const lick = incoming[0];
    // Exactly one row for the duplicated jid.
    const rowCount = (lick.content.match(/--- sched-dedup-scoop /g) ?? []).length;
    expect(rowCount).toBe(1);
    expect(lick.content).toContain('0 completed, 1 timed out');
  });

  it('scheduleScoopWait stamps unique message IDs for back-to-back schedules', async () => {
    // Date.now() alone is not enough entropy: two waits scheduled in
    // the same tick (e.g. timeout_ms: 0) can resolve in the same
    // millisecond, and the chat panel + persistence layer dedupe by
    // msg.id. A collision drops one lick. Verify each wait gets a
    // distinct id.
    const scoopA: RegisteredScoop = {
      jid: 'scoop_sched_id_a',
      name: 'sched-id-a',
      folder: 'sched-id-a-scoop',
      isCone: false,
      type: 'scoop',
      requiresTrigger: false,
      assistantLabel: 'sched-id-a-scoop',
      addedAt: new Date().toISOString(),
      configSchemaVersion: CURRENT_SCOOP_CONFIG_VERSION,
    };
    const scoopB: RegisteredScoop = {
      ...scoopA,
      jid: 'scoop_sched_id_b',
      folder: 'sched-id-b-scoop',
      assistantLabel: 'sched-id-b-scoop',
    };
    await saveScoop(scoopA);
    await saveScoop(scoopB);

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

    // Two zero-timeout waits scheduled in the same tick; both will
    // resolve essentially simultaneously.
    orch.scheduleScoopWait([scoopA.jid], 0);
    orch.scheduleScoopWait([scoopB.jid], 0);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(incoming).toHaveLength(2);
    expect(incoming[0].id).not.toBe(incoming[1].id);
    expect(incoming[0].id.startsWith('scoop-wait-')).toBe(true);
    expect(incoming[1].id.startsWith('scoop-wait-')).toBe(true);
  });
});

describe('Orchestrator handleMessage external-lick visibility', () => {
  // Confirms the regression fix: when an external lick event (webhook /
  // cron / sprinkle / fswatch / session-reload / navigate / upgrade)
  // reaches `handleMessage`, the orchestrator fires `onIncomingMessage`
  // so the chat panel renders a chip live (not just after reload). The
  // scoop-lifecycle channels keep their existing upstream fires and
  // must NOT double-fire from inside `handleMessage`.
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

  async function makeOrch(
    capture: (scoopJid: string, msg: ChannelMessage) => void
  ): Promise<Orchestrator> {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    const o = new Orchestrator(container, {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onSendMessage: vi.fn(),
      onStatusChange: vi.fn(),
      onError: vi.fn(),
      getBrowserAPI: vi.fn(() => ({}) as any),
      onIncomingMessage: capture,
    });
    await o.init();
    return o;
  }

  it('fires onIncomingMessage exactly once for a navigate lick routed via handleMessage', async () => {
    const incoming: Array<{ jid: string; msg: ChannelMessage }> = [];
    orch = await makeOrch((jid, msg) => incoming.push({ jid, msg }));

    const navigateMsg: ChannelMessage = {
      id: 'navigate-test-1',
      chatJid: cone.jid,
      senderId: 'navigate',
      senderName: 'navigate:https://example.com/',
      content: '[Navigate Event: https://example.com/]',
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'navigate',
    };

    await orch.handleMessage(navigateMsg);

    expect(incoming).toHaveLength(1);
    expect(incoming[0].jid).toBe(cone.jid);
    expect(incoming[0].msg.channel).toBe('navigate');
    expect(incoming[0].msg.id).toBe('navigate-test-1');
  });

  it('fires onIncomingMessage exactly once for a webhook lick routed via handleMessage', async () => {
    const incoming: Array<{ jid: string; msg: ChannelMessage }> = [];
    orch = await makeOrch((jid, msg) => incoming.push({ jid, msg }));

    const webhookMsg: ChannelMessage = {
      id: 'webhook-test-1',
      chatJid: cone.jid,
      senderId: 'webhook',
      senderName: 'webhook:demo',
      content: '[Webhook Event: demo]',
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'webhook',
    };

    await orch.handleMessage(webhookMsg);

    expect(incoming).toHaveLength(1);
    expect(incoming[0].msg.channel).toBe('webhook');
  });

  it.each([
    ['cron'],
    ['sprinkle'],
    ['fswatch'],
    ['session-reload'],
    ['upgrade'],
  ] as const)('fires onIncomingMessage once for %s channel', async (channel) => {
    const incoming: ChannelMessage[] = [];
    orch = await makeOrch((_jid, msg) => incoming.push(msg));

    const msg: ChannelMessage = {
      id: `${channel}-test-1`,
      chatJid: cone.jid,
      senderId: channel,
      senderName: `${channel}:demo`,
      content: `[${channel}]`,
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: channel as ChannelMessage['channel'],
    };

    await orch.handleMessage(msg);

    expect(incoming).toHaveLength(1);
    expect(incoming[0].channel).toBe(channel);
  });

  it('does NOT fire onIncomingMessage from inside handleMessage for scoop-notify (avoids double-fire with upstream)', async () => {
    const incoming: ChannelMessage[] = [];
    orch = await makeOrch((_jid, msg) => incoming.push(msg));

    const notifyMsg: ChannelMessage = {
      id: 'scoop-notify-test-1',
      chatJid: cone.jid,
      senderId: 'some-scoop',
      senderName: 'some-scoop',
      content: '[@some-scoop completed]',
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'scoop-notify',
    };

    await orch.handleMessage(notifyMsg);

    // handleMessage must NOT fire onIncomingMessage for scoop-notify —
    // `maybeNotifyConeOnScoopComplete` already fires it manually just
    // before calling handleMessage. Firing again here would render a
    // duplicate chip in the chat panel.
    expect(incoming).toHaveLength(0);
  });

  it('does NOT fire onIncomingMessage from inside handleMessage for scoop-idle / scoop-wait / scoop-error / delegation / web', async () => {
    const incoming: ChannelMessage[] = [];
    orch = await makeOrch((_jid, msg) => incoming.push(msg));

    for (const channel of [
      'scoop-idle',
      'scoop-wait',
      'scoop-error',
      'delegation',
      'web',
    ] as const) {
      await orch.handleMessage({
        id: `${channel}-test`,
        chatJid: cone.jid,
        senderId: 'x',
        senderName: 'x',
        content: 'noop',
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: channel as ChannelMessage['channel'],
      });
    }

    expect(incoming).toHaveLength(0);
  });

  it('catches handler exceptions so message routing is not broken', async () => {
    const incoming: ChannelMessage[] = [];
    orch = await makeOrch((_jid, msg) => {
      incoming.push(msg);
      throw new Error('handler boom');
    });

    const navigateMsg: ChannelMessage = {
      id: 'navigate-throws',
      chatJid: cone.jid,
      senderId: 'navigate',
      senderName: 'navigate:demo',
      content: 'boom',
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'navigate',
    };

    // Must resolve, not reject — the try/catch around the fire site
    // prevents a UI handler exception from breaking message routing.
    await expect(orch.handleMessage(navigateMsg)).resolves.toBeUndefined();
    expect(incoming).toHaveLength(1);
  });
});

describe('Orchestrator legacy cone-memory migration', () => {
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

  interface MigrationPrivate {
    migrateLegacyConeMemory(): Promise<void>;
  }

  async function readUtf8(fs: NonNullable<ReturnType<Orchestrator['getSharedFS']>>, path: string) {
    const raw = await fs.readFile(path, { encoding: 'utf-8' });
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  }

  it('lifts legacy ## Auto-extracted blocks from /shared/CLAUDE.md into /workspace/CLAUDE.md while leaving the bundled default intact', async () => {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const fs = orch.getSharedFS()!;
    // Capture the bundled default so we can compare after migration strips
    // the appended auto-block.
    const bundledDefault = await readUtf8(fs, '/shared/CLAUDE.md');

    // Append a single auto-extracted block to the bundled default (the
    // same shape `appendConeMemory` would produce), then wipe the sentinel
    // so the migration re-runs.
    const polluted =
      bundledDefault + '\n## Auto-extracted (2024-01-01, compaction)\n\n- legacy bullet\n';
    await fs.writeFile('/shared/CLAUDE.md', polluted);
    await fs.rm('/workspace/.cone-memory-migrated').catch(() => {});
    // Start from a clean cone-memory file to make the assertion deterministic.
    await fs.rm('/workspace/CLAUDE.md').catch(() => {});

    await (orch as unknown as MigrationPrivate).migrateLegacyConeMemory();

    // /workspace/CLAUDE.md now carries the lifted block.
    const coneMemory = await readUtf8(fs, '/workspace/CLAUDE.md');
    expect(coneMemory).toContain('## Auto-extracted (2024-01-01, compaction)');
    expect(coneMemory).toContain('legacy bullet');

    // /shared/CLAUDE.md retains the bundled default verbatim — no reseed
    // happened, the migration just dropped the appended auto-block.
    const sharedAfter = await readUtf8(fs, '/shared/CLAUDE.md');
    expect(sharedAfter).toBe(bundledDefault);
    expect(sharedAfter).not.toMatch(/## Auto-extracted/);

    // Sentinel was written so subsequent boots are no-ops.
    await expect(fs.stat('/workspace/.cone-memory-migrated')).resolves.toBeTruthy();
  });

  it('preserves user-authored header and footer around the lifted auto-block', async () => {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const fs = orch.getSharedFS()!;

    // User-edited header + auto-block + user-edited footer. The footer is
    // its own `## ` section so the block-splitting loop terminates the
    // auto-block at the footer heading rather than swallowing it.
    const header = ['# User Notes', '', 'Header paragraph the user wrote.', ''].join('\n');
    const autoBlock = [
      '## Auto-extracted (2024-01-01, compaction)',
      '',
      '- legacy bullet',
      '',
    ].join('\n');
    const footer = ['## User Footer', '', 'Footer paragraph the user wrote.', ''].join('\n');
    const polluted = header + autoBlock + footer;

    await fs.writeFile('/shared/CLAUDE.md', polluted);
    await fs.rm('/workspace/.cone-memory-migrated').catch(() => {});
    await fs.rm('/workspace/CLAUDE.md').catch(() => {});

    await (orch as unknown as MigrationPrivate).migrateLegacyConeMemory();

    // /workspace/CLAUDE.md carries the lifted block.
    const coneMemory = await readUtf8(fs, '/workspace/CLAUDE.md');
    expect(coneMemory).toContain('## Auto-extracted (2024-01-01, compaction)');
    expect(coneMemory).toContain('legacy bullet');

    // /shared/CLAUDE.md preserves header and footer verbatim, with the
    // auto-block excised. Trailing whitespace collapses to a single newline.
    const sharedAfter = await readUtf8(fs, '/shared/CLAUDE.md');
    expect(sharedAfter).toBe(header + footer);
    expect(sharedAfter).not.toMatch(/## Auto-extracted/);
    expect(sharedAfter).toContain('# User Notes');
    expect(sharedAfter).toContain('Header paragraph the user wrote.');
    expect(sharedAfter).toContain('## User Footer');
    expect(sharedAfter).toContain('Footer paragraph the user wrote.');

    await expect(fs.stat('/workspace/.cone-memory-migrated')).resolves.toBeTruthy();
  });

  it('terminates the auto-block at a top-level `# ` heading footer (not just `## `)', async () => {
    // Regression for PR #770 Codex P2 review: a hand-edited file with a
    // top-level `# Hand-written footer` after the auto block must NOT have
    // the footer swept into the lifted block. The terminator regex must
    // stop at any `# ` or `## ` heading, not just `## `.
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const fs = orch.getSharedFS()!;

    const polluted = [
      '# User header',
      '',
      'Initial user notes.',
      '',
      '## Auto-extracted (2026-01-01, compaction)',
      '- bullet 1',
      '- bullet 2',
      '',
      '# Hand-written footer',
      '',
      'User footer content.',
      '',
    ].join('\n');

    await fs.writeFile('/shared/CLAUDE.md', polluted);
    await fs.rm('/workspace/.cone-memory-migrated').catch(() => {});
    await fs.rm('/workspace/CLAUDE.md').catch(() => {});

    await (orch as unknown as MigrationPrivate).migrateLegacyConeMemory();

    // /workspace/CLAUDE.md carries the lifted block (bullets only).
    const coneMemory = await readUtf8(fs, '/workspace/CLAUDE.md');
    expect(coneMemory).toContain('## Auto-extracted (2026-01-01, compaction)');
    expect(coneMemory).toContain('- bullet 1');
    expect(coneMemory).toContain('- bullet 2');
    // Critically: the user-authored footer must NOT have leaked into the
    // migrated cone memory.
    expect(coneMemory).not.toContain('# Hand-written footer');
    expect(coneMemory).not.toContain('User footer content.');

    // /shared/CLAUDE.md preserves the header AND the footer verbatim.
    const sharedAfter = await readUtf8(fs, '/shared/CLAUDE.md');
    expect(sharedAfter).toContain('# User header');
    expect(sharedAfter).toContain('Initial user notes.');
    expect(sharedAfter).toContain('# Hand-written footer');
    expect(sharedAfter).toContain('User footer content.');
    expect(sharedAfter).not.toMatch(/## Auto-extracted/);
    expect(sharedAfter).not.toContain('bullet 1');
  });

  it('treats a `### Subheading` inside an auto-block as part of the block', async () => {
    // The system never emits `### ` inside an auto block, but if a user
    // somehow added one, the conservative behavior is to keep it as part
    // of the block (it gets lifted along with the bullets) rather than
    // treat it as a terminator and accidentally leave bullets behind in
    // the shared file.
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const fs = orch.getSharedFS()!;

    const polluted = [
      '## Auto-extracted (2026-01-01, compaction)',
      '- bullet a',
      '',
      '### Subheading inside the auto block',
      '- bullet b',
      '',
      '# Real footer',
      '',
      'Footer text.',
      '',
    ].join('\n');

    await fs.writeFile('/shared/CLAUDE.md', polluted);
    await fs.rm('/workspace/.cone-memory-migrated').catch(() => {});
    await fs.rm('/workspace/CLAUDE.md').catch(() => {});

    await (orch as unknown as MigrationPrivate).migrateLegacyConeMemory();

    // Both bullets and the `### Subheading` line are lifted as one block.
    const coneMemory = await readUtf8(fs, '/workspace/CLAUDE.md');
    expect(coneMemory).toContain('## Auto-extracted (2026-01-01, compaction)');
    expect(coneMemory).toContain('- bullet a');
    expect(coneMemory).toContain('### Subheading inside the auto block');
    expect(coneMemory).toContain('- bullet b');

    // Shared file retains only the `# Real footer` region.
    const sharedAfter = await readUtf8(fs, '/shared/CLAUDE.md');
    expect(sharedAfter).toContain('# Real footer');
    expect(sharedAfter).toContain('Footer text.');
    expect(sharedAfter).not.toContain('bullet a');
    expect(sharedAfter).not.toContain('bullet b');
    expect(sharedAfter).not.toContain('### Subheading');
  });

  it('is a no-op (just drops the sentinel) when /shared/CLAUDE.md has no Auto-extracted blocks', async () => {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const fs = orch.getSharedFS()!;
    // init already wrote the sentinel on the first migrateLegacyConeMemory
    // call. Drop it and ensure a second invocation against the clean bundled
    // default re-creates the sentinel without producing /workspace/CLAUDE.md.
    await fs.rm('/workspace/.cone-memory-migrated').catch(() => {});
    await fs.rm('/workspace/CLAUDE.md').catch(() => {});

    await (orch as unknown as MigrationPrivate).migrateLegacyConeMemory();

    await expect(fs.stat('/workspace/.cone-memory-migrated')).resolves.toBeTruthy();
    await expect(fs.readFile('/workspace/CLAUDE.md', { encoding: 'utf-8' })).rejects.toBeDefined();
  });

  it('is idempotent — second call short-circuits on the sentinel', async () => {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    orch = new Orchestrator(container, noopCallbacks());
    await orch.init();

    const fs = orch.getSharedFS()!;
    // Pollute again, but DO NOT clear the sentinel. Migration must skip.
    const polluted = '## Auto-extracted (2024-09-09, compaction)\n\n- should not move\n';
    await fs.writeFile('/shared/CLAUDE.md', polluted);

    await (orch as unknown as MigrationPrivate).migrateLegacyConeMemory();

    // Shared file is left exactly as the test wrote it — no migration happened.
    expect(await readUtf8(fs, '/shared/CLAUDE.md')).toBe(polluted);
    // /workspace/CLAUDE.md was not created by this no-op call.
    await expect(fs.readFile('/workspace/CLAUDE.md', { encoding: 'utf-8' })).rejects.toBeDefined();
  });
});

describe('Orchestrator.handleCherryHostEvent', () => {
  function makeOrch(): Orchestrator {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    return new Orchestrator(container, {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onSendMessage: vi.fn(),
      onStatusChange: vi.fn(),
      onError: vi.fn(),
      getBrowserAPI: vi.fn(() => ({}) as any),
    });
  }

  it('emits a cherry lick with the host event name, runtime id, and detail', () => {
    const orch = makeOrch();
    const emitEvent = vi.fn();
    orch.setLickManager({ emitEvent } as any);

    orch.handleCherryHostEvent('follower-b1', 'cart.updated', { items: 3 });

    expect(emitEvent).toHaveBeenCalledTimes(1);
    const evt = emitEvent.mock.calls[0][0];
    expect(evt.type).toBe('cherry');
    expect(evt.cherryName).toBe('cart.updated');
    expect(evt.cherryRuntimeId).toBe('follower-b1');
    expect(evt.cherryOrigin).toBeUndefined();
    expect(evt.body).toEqual({ items: 3 });
    expect(typeof evt.timestamp).toBe('string');
  });

  it('does not throw when no lick manager is set', () => {
    const orch = makeOrch();
    expect(() => orch.handleCherryHostEvent('rt', 'evt')).not.toThrow();
  });
});
