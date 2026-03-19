/**
 * Tests for TaskScheduler cron, interval, and once scheduling.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import 'fake-indexeddb/auto';
import { TaskScheduler } from './scheduler.js';
import * as db from './db.js';
import type { ScheduledTask, RegisteredScoop } from './types.js';

// Mock scoop for testing
const mockScoop: RegisteredScoop = {
  jid: 'test-scoop-jid',
  name: 'Test Scoop',
  folder: 'test-scoop',
  isCone: false,
  type: 'scoop',
  trigger: '@test-scoop',
  requiresTrigger: true,
  assistantLabel: 'test-scoop',
  addedAt: new Date().toISOString(),
};

describe('TaskScheduler', () => {
  let scheduler: TaskScheduler;

  beforeAll(async () => {
    // Initialize IndexedDB
    await db.initDB();

    // Create scheduler with mock callbacks
    scheduler = new TaskScheduler({
      onTaskRun: async () => {
        // No-op for testing
      },
      getScoop: () => mockScoop,
    });
  });

  describe('Cron scheduling', () => {
    it('createTask with "* * * * *" (every minute) calculates nextRun within 60 seconds', async () => {
      const now = new Date();
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'cron', '* * * * *');

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      // Next run should be in the future
      expect(nextRun.getTime()).toBeGreaterThan(now.getTime());

      // Should be within 60 seconds
      const diffSeconds = (nextRun.getTime() - now.getTime()) / 1000;
      expect(diffSeconds).toBeLessThanOrEqual(60);
    });

    it('createTask with "0 9 * * *" (daily at 9am) calculates nextRun at 09:00', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'cron', '0 9 * * *');

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      // Hour should be 9, minute should be 0
      expect(nextRun.getHours()).toBe(9);
      expect(nextRun.getMinutes()).toBe(0);
      expect(nextRun.getSeconds()).toBe(0);
    });

    it('createTask with "*/5 * * * *" (every 5 minutes) has minute divisible by 5', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'cron', '*/5 * * * *');

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      // Minute should be divisible by 5
      expect(nextRun.getMinutes() % 5).toBe(0);
    });

    it('createTask with "0 0 15 * *" (15th day of month at midnight) has correct date and time', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'cron', '0 0 15 * *');

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      // Should be on the 15th at 00:00
      expect(nextRun.getDate()).toBe(15);
      expect(nextRun.getHours()).toBe(0);
      expect(nextRun.getMinutes()).toBe(0);
    });

    it('createTask with "0 0 * * 1" (Mondays at midnight) has day of week = 1 (Monday)', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'cron', '0 0 * * 1');

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      // getDay() returns 0-6 where 0 = Sunday, 1 = Monday
      expect(nextRun.getDay()).toBe(1);
      expect(nextRun.getHours()).toBe(0);
      expect(nextRun.getMinutes()).toBe(0);
    });

    it('createTask with "0 12 * * 0" (Sundays at noon) has day of week = 0 (Sunday)', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'cron', '0 12 * * 0');

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      // getDay() returns 0 for Sunday
      expect(nextRun.getDay()).toBe(0);
      expect(nextRun.getHours()).toBe(12);
      expect(nextRun.getMinutes()).toBe(0);
    });

    it('createTask with "0 9,17 * * *" (9am and 5pm) has hour in list', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'cron', '0 9,17 * * *');

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      // Hour should be either 9 or 17
      expect([9, 17]).toContain(nextRun.getHours());
      expect(nextRun.getMinutes()).toBe(0);
    });

    it('createTask with "0 9-17 * * *" (9am to 5pm) has hour in range', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'cron', '0 9-17 * * *');

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      // Hour should be between 9 and 17 inclusive
      expect(nextRun.getHours()).toBeGreaterThanOrEqual(9);
      expect(nextRun.getHours()).toBeLessThanOrEqual(17);
      expect(nextRun.getMinutes()).toBe(0);
    });

    it('createTask with invalid cron (wrong field count) returns null nextRun', async () => {
      const task = await scheduler.createTask(
        'test-scoop',
        'test prompt',
        'cron',
        '* * * *' // Only 4 fields
      );

      expect(task.nextRun).toBeNull();
    });
  });

  describe('Interval scheduling', () => {
    it('createTask with interval schedule calculates nextRun ~intervalMs in the future', async () => {
      const now = new Date();
      const intervalMs = 60000; // 1 minute

      const task = await scheduler.createTask(
        'test-scoop',
        'test prompt',
        'interval',
        String(intervalMs)
      );

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      const diffMs = nextRun.getTime() - now.getTime();

      // Should be approximately the interval duration
      expect(diffMs).toBeGreaterThanOrEqual(intervalMs - 100);
      expect(diffMs).toBeLessThanOrEqual(intervalMs + 100);
    });

    it('createTask with interval 3600000 (1 hour) returns nextRun ~1 hour in future', async () => {
      const now = new Date();
      const intervalMs = 3600000; // 1 hour

      const task = await scheduler.createTask(
        'test-scoop',
        'test prompt',
        'interval',
        String(intervalMs)
      );

      expect(task.nextRun).toBeTruthy();
      const nextRun = new Date(task.nextRun!);

      const diffMs = nextRun.getTime() - now.getTime();

      // Allow some tolerance
      expect(diffMs).toBeGreaterThanOrEqual(intervalMs - 1000);
      expect(diffMs).toBeLessThanOrEqual(intervalMs + 1000);
    });

    it('createTask with invalid interval (NaN) returns null nextRun', async () => {
      const task = await scheduler.createTask(
        'test-scoop',
        'test prompt',
        'interval',
        'not-a-number'
      );

      expect(task.nextRun).toBeNull();
    });

    it('createTask with invalid interval (negative) returns null nextRun', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '-1000');

      expect(task.nextRun).toBeNull();
    });

    it('createTask with interval 0 returns null nextRun', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '0');

      expect(task.nextRun).toBeNull();
    });
  });

  describe('Once scheduling', () => {
    it('createTask with once schedule in the future returns target timestamp', async () => {
      const future = new Date();
      future.setHours(future.getHours() + 1);
      const futureISO = future.toISOString();

      const task = await scheduler.createTask('test-scoop', 'test prompt', 'once', futureISO);

      expect(task.nextRun).toBe(futureISO);
    });

    it('createTask with once schedule in the past returns null nextRun', async () => {
      const past = new Date();
      past.setHours(past.getHours() - 1);
      const pastISO = past.toISOString();

      const task = await scheduler.createTask('test-scoop', 'test prompt', 'once', pastISO);

      expect(task.nextRun).toBeNull();
    });

    it('createTask with once schedule now (current time) returns null nextRun', async () => {
      const now = new Date().toISOString();

      const task = await scheduler.createTask('test-scoop', 'test prompt', 'once', now);

      // Should be null because it's not strictly in the future
      expect(task.nextRun).toBeNull();
    });
  });

  describe('Task status operations', () => {
    it('pauseTask sets status to "paused"', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '60000');

      const paused = await scheduler.pauseTask(task.id);
      expect(paused).toBe(true);

      const retrieved = await db.getTask(task.id);
      expect(retrieved?.status).toBe('paused');
    });

    it('resumeTask sets status to "active"', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '60000');

      await scheduler.pauseTask(task.id);
      const resumed = await scheduler.resumeTask(task.id);
      expect(resumed).toBe(true);

      const retrieved = await db.getTask(task.id);
      expect(retrieved?.status).toBe('active');
    });

    it('pauseTask on non-existent task returns false', async () => {
      const paused = await scheduler.pauseTask('non-existent-id');
      expect(paused).toBe(false);
    });

    it('resumeTask on non-existent task returns false', async () => {
      const resumed = await scheduler.resumeTask('non-existent-id');
      expect(resumed).toBe(false);
    });

    it('deleteTask removes the task from database', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '60000');

      const deleted = await scheduler.deleteTask(task.id);
      expect(deleted).toBe(true);

      const retrieved = await db.getTask(task.id);
      expect(retrieved).toBeNull();
    });

    it('deleteTask on non-existent task returns false', async () => {
      const deleted = await scheduler.deleteTask('non-existent-id');
      expect(deleted).toBe(false);
    });
  });

  describe('Task persistence', () => {
    it('createTask saves task to database and retrieves it', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '120000');

      const retrieved = await db.getTask(task.id);

      expect(retrieved).toBeTruthy();
      expect(retrieved?.id).toBe(task.id);
      expect(retrieved?.groupFolder).toBe('test-scoop');
      expect(retrieved?.prompt).toBe('test prompt');
      expect(retrieved?.scheduleType).toBe('interval');
      expect(retrieved?.scheduleValue).toBe('120000');
      expect(retrieved?.status).toBe('active');
      expect(retrieved?.nextRun).toBe(task.nextRun);
    });

    it('updateTask modifies task and recalculates nextRun when schedule changes', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '60000');

      const originalNextRun = task.nextRun;

      // Update schedule
      const updated = await scheduler.updateTask(task.id, {
        scheduleType: 'interval',
        scheduleValue: '120000',
      });

      expect(updated).toBeTruthy();
      expect(updated?.nextRun).not.toBe(originalNextRun);

      const retrieved = await db.getTask(task.id);
      expect(retrieved?.scheduleValue).toBe('120000');
    });

    it('getTasksByScoop returns only tasks for specified scoop', async () => {
      const task1 = await scheduler.createTask('scoop-a', 'prompt 1', 'interval', '60000');

      const task2 = await scheduler.createTask('scoop-b', 'prompt 2', 'interval', '60000');

      const tasksA = await scheduler.getTasksByScoop('scoop-a');
      const tasksB = await scheduler.getTasksByScoop('scoop-b');

      expect(tasksA.some((t) => t.id === task1.id)).toBe(true);
      expect(tasksA.some((t) => t.id === task2.id)).toBe(false);

      expect(tasksB.some((t) => t.id === task2.id)).toBe(true);
      expect(tasksB.some((t) => t.id === task1.id)).toBe(false);
    });

    it('getAllTasks returns all tasks', async () => {
      const task1 = await scheduler.createTask('scoop-1', 'prompt 1', 'interval', '60000');

      const task2 = await scheduler.createTask('scoop-2', 'prompt 2', 'cron', '0 9 * * *');

      const allTasks = await scheduler.getAllTasks();

      expect(allTasks.length).toBeGreaterThanOrEqual(2);
      expect(allTasks.some((t) => t.id === task1.id)).toBe(true);
      expect(allTasks.some((t) => t.id === task2.id)).toBe(true);
    });
  });

  describe('Task properties', () => {
    it('createTask generates unique task ID', async () => {
      const task1 = await scheduler.createTask('test-scoop', 'prompt 1', 'interval', '60000');

      const task2 = await scheduler.createTask('test-scoop', 'prompt 2', 'interval', '60000');

      expect(task1.id).not.toBe(task2.id);
      expect(task1.id).toMatch(/^task-/);
      expect(task2.id).toMatch(/^task-/);
    });

    it('createTask sets initial status to "active"', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '60000');

      expect(task.status).toBe('active');
    });

    it('createTask sets createdAt to current timestamp', async () => {
      const before = new Date();
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '60000');
      const after = new Date();

      const createdAt = new Date(task.createdAt);
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('createTask sets lastRun to null', async () => {
      const task = await scheduler.createTask('test-scoop', 'test prompt', 'interval', '60000');

      expect(task.lastRun).toBeNull();
    });
  });
});
