/**
 * Tests for the scoops database layer.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import {
  initDB,
  saveScoop,
  getScoop,
  getAllScoops,
  deleteScoop,
  saveMessage,
  getMessagesSince,
  saveSession,
  getSession,
  getAllSessions,
  saveTask,
  getTask,
  getAllTasks,
  deleteTask,
  getState,
  setState,
} from '../../src/scoops/db.js';
import type { RegisteredScoop, ChannelMessage, ScheduledTask } from '../../src/scoops/types.js';

describe('Scoops Database', () => {
  beforeAll(async () => {
    await initDB();
  });

  describe('Scoops', () => {
    const testScoop: RegisteredScoop = {
      jid: 'test-jid-123',
      name: 'Test Scoop',
      folder: 'test-scoop',
      trigger: '@test-scoop',
      requiresTrigger: true,
      isCone: false,
      type: 'scoop',
      assistantLabel: 'test-scoop',
      addedAt: new Date().toISOString(),
    };

    it('saves and retrieves a scoop', async () => {
      await saveScoop(testScoop);
      const retrieved = await getScoop(testScoop.jid);
      expect(retrieved).toEqual(testScoop);
    });

    it('returns null for non-existent scoop', async () => {
      const result = await getScoop('non-existent');
      expect(result).toBeNull();
    });

    it('gets all scoops', async () => {
      const uniqueId = Date.now().toString();
      const scoop1 = { ...testScoop, jid: `jid-1-${uniqueId}`, name: 'Scoop 1' };
      const scoop2 = { ...testScoop, jid: `jid-2-${uniqueId}`, name: 'Scoop 2' };

      await saveScoop(scoop1);
      await saveScoop(scoop2);

      const all = await getAllScoops();
      expect(all[scoop1.jid].name).toBe('Scoop 1');
      expect(all[scoop2.jid].name).toBe('Scoop 2');
    });

    it('deletes a scoop', async () => {
      await saveScoop(testScoop);
      await deleteScoop(testScoop.jid);
      const result = await getScoop(testScoop.jid);
      expect(result).toBeNull();
    });

    it('updates an existing scoop', async () => {
      await saveScoop(testScoop);
      const updated = { ...testScoop, name: 'Updated Name' };
      await saveScoop(updated);

      const retrieved = await getScoop(testScoop.jid);
      expect(retrieved?.name).toBe('Updated Name');
    });
  });

  describe('Messages', () => {
    const testMessage: ChannelMessage = {
      id: 'msg-1',
      chatJid: 'chat-123',
      senderId: 'user-1',
      senderName: 'Test User',
      content: 'Hello world',
      timestamp: new Date().toISOString(),
      fromAssistant: false,
      channel: 'web',
    };

    it('saves and retrieves messages', async () => {
      await saveMessage(testMessage);
      const messages = await getMessagesSince(testMessage.chatJid, '');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Hello world');
    });

    it('filters messages by timestamp', async () => {
      const now = new Date();
      const msg1 = {
        ...testMessage,
        id: 'msg-1',
        timestamp: new Date(now.getTime() - 2000).toISOString(),
      };
      const msg2 = {
        ...testMessage,
        id: 'msg-2',
        timestamp: new Date(now.getTime() - 1000).toISOString(),
      };
      const msg3 = { ...testMessage, id: 'msg-3', timestamp: now.toISOString() };

      await saveMessage(msg1);
      await saveMessage(msg2);
      await saveMessage(msg3);

      const messages = await getMessagesSince(testMessage.chatJid, msg1.timestamp);
      expect(messages).toHaveLength(2);
    });

    it('excludes sender from results', async () => {
      const uniqueJid = `chat-exclude-${Date.now()}`;
      const msg1 = {
        ...testMessage,
        id: `msg-exclude-1-${Date.now()}`,
        chatJid: uniqueJid,
        senderName: 'User',
      };
      const msg2 = {
        ...testMessage,
        id: `msg-exclude-2-${Date.now()}`,
        chatJid: uniqueJid,
        senderName: 'sliccy',
      };

      await saveMessage(msg1);
      await saveMessage(msg2);

      const messages = await getMessagesSince(uniqueJid, '', 'sliccy');
      expect(messages).toHaveLength(1);
      expect(messages[0].senderName).toBe('User');
    });
  });

  describe('Sessions', () => {
    it('saves and retrieves a session', async () => {
      await saveSession('test-folder', 'session-123');
      const sessionId = await getSession('test-folder');
      expect(sessionId).toBe('session-123');
    });

    it('returns null for non-existent session', async () => {
      const result = await getSession('non-existent');
      expect(result).toBeNull();
    });

    it('gets all sessions', async () => {
      await saveSession('folder-1', 'session-1');
      await saveSession('folder-2', 'session-2');

      const all = await getAllSessions();
      expect(all['folder-1']).toBe('session-1');
      expect(all['folder-2']).toBe('session-2');
    });

    it('updates an existing session', async () => {
      await saveSession('folder', 'session-old');
      await saveSession('folder', 'session-new');

      const sessionId = await getSession('folder');
      expect(sessionId).toBe('session-new');
    });
  });

  describe('Tasks', () => {
    const testTask: ScheduledTask = {
      id: 'task-1',
      groupFolder: 'test-folder',
      prompt: 'Test task',
      scheduleType: 'cron',
      scheduleValue: '0 9 * * *',
      status: 'active',
      nextRun: new Date().toISOString(),
      lastRun: null,
      createdAt: new Date().toISOString(),
    };

    it('saves and retrieves a task', async () => {
      await saveTask(testTask);
      const retrieved = await getTask(testTask.id);
      expect(retrieved).toEqual(testTask);
    });

    it('returns null for non-existent task', async () => {
      const result = await getTask('non-existent');
      expect(result).toBeNull();
    });

    it('gets all tasks', async () => {
      const task1 = { ...testTask, id: 'task-1' };
      const task2 = { ...testTask, id: 'task-2' };

      await saveTask(task1);
      await saveTask(task2);

      const all = await getAllTasks();
      expect(all).toHaveLength(2);
    });

    it('deletes a task', async () => {
      await saveTask(testTask);
      await deleteTask(testTask.id);
      const result = await getTask(testTask.id);
      expect(result).toBeNull();
    });
  });

  describe('State', () => {
    it('saves and retrieves state', async () => {
      await setState('testKey', 'testValue');
      const value = await getState('testKey');
      expect(value).toBe('testValue');
    });

    it('returns null for non-existent state', async () => {
      const result = await getState('non-existent');
      expect(result).toBeNull();
    });

    it('updates existing state', async () => {
      await setState('key', 'value1');
      await setState('key', 'value2');

      const value = await getState('key');
      expect(value).toBe('value2');
    });
  });
});
