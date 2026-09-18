import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  __test__,
  detectWelcomeFirstRun,
  hasOnboardingFinalLickInHistory,
  hasWelcomeLickInHistory,
  recordWelcomed,
} from '../../src/scoops/welcome-detection.js';
import { WorkUnitConversationStore } from '../../src/work-unit/conversation/store.js';

interface PersistedSession {
  id: string;
  messages: Array<{ role: string; content: unknown }>;
}

function openChatDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(__test__.CHAT_DB_NAME, __test__.CHAT_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(__test__.CHAT_STORE_NAME)) {
        db.createObjectStore(__test__.CHAT_STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeChatSession(session: PersistedSession): Promise<void> {
  const db = await openChatDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(__test__.CHAT_STORE_NAME, 'readwrite');
      tx.objectStore(__test__.CHAT_STORE_NAME).put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function deleteChatSession(id: string): Promise<void> {
  const db = await openChatDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(__test__.CHAT_STORE_NAME, 'readwrite');
      tx.objectStore(__test__.CHAT_STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function clearConeSession(): Promise<void> {
  await deleteChatSession(__test__.CONE_SESSION_ID).catch(() => {});
}

async function seedConeSessionWithWelcomeLick(): Promise<void> {
  await writeChatSession({
    id: __test__.CONE_SESSION_ID,
    messages: [
      {
        role: 'user',
        content: `${__test__.WELCOME_LICK_HEADER}\n\nNew user — first run`,
      },
    ],
  });
}

describe('welcome-detection', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-welcome-${dbCounter++}`, wipe: true });
    await clearConeSession();
    await new WorkUnitConversationStore().clearAll();
  });

  describe('canonical conversation record', () => {
    const primaryCone = {
      key: '/workspace::cone_1',
      workUnitId: 'cone_1',
      workspaceId: '/workspace',
      folder: 'cone',
      legacyKeys: { agentSessionId: 'cone_1', chatSessionId: 'session-cone' },
    };

    function lickMessage(text: string) {
      return { role: 'user', content: [{ type: 'text', text }], timestamp: 1 } as never;
    }

    it('finds a welcome lick recorded only in the canonical record', async () => {
      await new WorkUnitConversationStore().syncAgentMessages(primaryCone, [
        lickMessage(`${__test__.WELCOME_LICK_HEADER}\n\nNew user — first run`),
      ]);
      expect(await hasWelcomeLickInHistory()).toBe(true);
      expect((await detectWelcomeFirstRun(vfs)).isFirstRun).toBe(false);
    });

    it('finds the final onboarding lick recorded only in the canonical record', async () => {
      await new WorkUnitConversationStore().syncAgentMessages(primaryCone, [
        lickMessage('{"action":"onboarding-complete-with-provider"}'),
      ]);
      expect(await hasOnboardingFinalLickInHistory()).toBe(true);
    });

    it('ignores a welcome recorded by an extra cone', async () => {
      await new WorkUnitConversationStore().syncAgentMessages(
        {
          ...primaryCone,
          key: '/cones/cone-two/workspace::cone_2',
          workUnitId: 'cone_2',
          workspaceId: '/cones/cone-two/workspace',
          folder: 'cone-two',
        },
        [lickMessage(__test__.WELCOME_LICK_HEADER)]
      );
      expect(await hasWelcomeLickInHistory()).toBe(false);
    });
  });

  describe('detectWelcomeFirstRun', () => {
    it('reports first-run when /shared/.welcomed is absent', async () => {
      const result = await detectWelcomeFirstRun(vfs);
      expect(result.isFirstRun).toBe(true);
    });

    it('reports NOT first-run when the welcomed marker exists', async () => {
      await vfs.mkdir('/shared', { recursive: true });
      await vfs.writeFile(__test__.WELCOMED_MARKER_PATH, '1');
      const result = await detectWelcomeFirstRun(vfs);
      expect(result.isFirstRun).toBe(false);
    });

    it('does not create the marker as a side effect — a partial onboarding still re-fires next boot', async () => {
      const first = await detectWelcomeFirstRun(vfs);
      expect(first.isFirstRun).toBe(true);

      const second = await detectWelcomeFirstRun(vfs);
      expect(second.isFirstRun).toBe(true);
      expect(await vfs.exists(__test__.WELCOMED_MARKER_PATH)).toBe(false);
    });

    it('treats a non-empty marker as completed regardless of contents', async () => {
      await vfs.mkdir('/shared', { recursive: true });

      await vfs.writeFile(__test__.WELCOMED_MARKER_PATH, '{"profileSavedAt":"2026-01-01"}');
      const result = await detectWelcomeFirstRun(vfs);
      expect(result.isFirstRun).toBe(false);
    });
  });

  describe('hasWelcomeLickInHistory', () => {
    it('returns false on a fresh database (no cone session yet)', async () => {
      expect(await hasWelcomeLickInHistory()).toBe(false);
    });

    it('returns true when the cone session contains a welcome lick header', async () => {
      await seedConeSessionWithWelcomeLick();
      expect(await hasWelcomeLickInHistory()).toBe(true);
    });

    it('matches welcome-lick text inside structured (block-array) message content', async () => {
      await writeChatSession({
        id: __test__.CONE_SESSION_ID,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'preamble' },
              { type: 'text', text: __test__.WELCOME_LICK_HEADER + '\nbody' },
            ],
          },
        ],
      });
      expect(await hasWelcomeLickInHistory()).toBe(true);
    });

    it('returns false when the session exists but no message references the welcome lick', async () => {
      await writeChatSession({
        id: __test__.CONE_SESSION_ID,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      });
      expect(await hasWelcomeLickInHistory()).toBe(false);
    });
  });

  describe('detectWelcomeFirstRun (history dedup)', () => {
    it('reports NOT first-run when the marker is absent but history already has a welcome lick', async () => {
      await seedConeSessionWithWelcomeLick();
      const result = await detectWelcomeFirstRun(vfs);
      expect(result.isFirstRun).toBe(false);
    });

    it('still reports first-run when both marker AND history are clean', async () => {
      const result = await detectWelcomeFirstRun(vfs);
      expect(result.isFirstRun).toBe(true);
    });
  });

  describe('recordWelcomed', () => {
    it('writes the marker file', async () => {
      await vfs.mkdir('/shared', { recursive: true });
      await recordWelcomed(vfs);
      expect(await vfs.exists(__test__.WELCOMED_MARKER_PATH)).toBe(true);
    });

    it('flips detection back to NOT first-run after being called', async () => {
      const before = await detectWelcomeFirstRun(vfs);
      expect(before.isFirstRun).toBe(true);
      await vfs.mkdir('/shared', { recursive: true });
      await recordWelcomed(vfs);
      const after = await detectWelcomeFirstRun(vfs);
      expect(after.isFirstRun).toBe(false);
    });
  });

  describe('primary cone only (#2272)', () => {
    it('keys off the primary cone session', () => {
      expect(__test__.CONE_SESSION_ID).toBe('session-cone');
    });

    it('ignores a welcome lick sitting in an extra cone history', async () => {
      await writeChatSession({
        id: 'session-cone-research',
        messages: [{ role: 'user', content: `${__test__.WELCOME_LICK_HEADER}\n\nwelcome, again` }],
      });
      try {
        expect(await hasWelcomeLickInHistory()).toBe(false);
        expect((await detectWelcomeFirstRun(vfs)).isFirstRun).toBe(true);
      } finally {
        await deleteChatSession('session-cone-research').catch(() => {});
      }
    });
  });
});
