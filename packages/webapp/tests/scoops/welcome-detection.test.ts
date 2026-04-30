/**
 * Tests for the welcome-detection helper used by the boot-time
 * first-run welcome lick. Mirrors the pattern of upgrade-detection but
 * gates purely on the `/shared/.welcomed` marker file.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  detectWelcomeFirstRun,
  hasWelcomeLickInHistory,
  recordWelcomed,
  __test__,
} from '../../src/scoops/welcome-detection.js';

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
  // The chat-history check reads the singleton `browser-coding-agent`
  // IDB; reset it between tests so prior writes don't bleed across cases.
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
      // First call sees no marker.
      const first = await detectWelcomeFirstRun(vfs);
      expect(first.isFirstRun).toBe(true);
      // Second call still sees no marker — detection is read-only.
      const second = await detectWelcomeFirstRun(vfs);
      expect(second.isFirstRun).toBe(true);
      expect(await vfs.exists(__test__.WELCOMED_MARKER_PATH)).toBe(false);
    });

    it('treats a non-empty marker as completed regardless of contents', async () => {
      await vfs.mkdir('/shared', { recursive: true });
      // The legacy panel writes "1"; a future flow could write JSON.
      // Either way the path's mere existence means "already welcomed".
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
});
