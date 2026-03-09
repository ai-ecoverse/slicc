/**
 * Tests for the lick guard: preventing scoop removal when active licks exist.
 *
 * Tests getLicksForScoop on LickManager and the guard logic in unregisterScoop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { LickManager } from './lick-manager.js';

// Each test gets a fresh LickManager WITHOUT calling init() to avoid
// accumulating state in the shared IndexedDB across tests.

describe('LickManager.getLicksForScoop', () => {
  let manager: LickManager;

  beforeEach(() => {
    manager = new LickManager();
  });

  it('returns empty arrays when no licks target the scoop', () => {
    const result = manager.getLicksForScoop('test-scoop');
    expect(result.webhooks).toEqual([]);
    expect(result.cronTasks).toEqual([]);
  });

  it('returns webhooks targeting the scoop', async () => {
    await manager.createWebhook('hook1', 'test-scoop');
    await manager.createWebhook('hook2', 'other-scoop');
    await manager.createWebhook('hook3', 'test-scoop');

    const result = manager.getLicksForScoop('test-scoop');
    expect(result.webhooks).toHaveLength(2);
    expect(result.webhooks.map(w => w.name)).toEqual(['hook1', 'hook3']);
    expect(result.cronTasks).toEqual([]);
  });

  it('returns cron tasks targeting the scoop', async () => {
    await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');
    await manager.createCronTask('cron2', '0 * * * *', 'other-scoop');

    const result = manager.getLicksForScoop('test-scoop');
    expect(result.webhooks).toEqual([]);
    expect(result.cronTasks).toHaveLength(1);
    expect(result.cronTasks[0].name).toBe('cron1');
  });

  it('returns both webhooks and cron tasks', async () => {
    await manager.createWebhook('hook1', 'test-scoop');
    await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    const result = manager.getLicksForScoop('test-scoop');
    expect(result.webhooks).toHaveLength(1);
    expect(result.cronTasks).toHaveLength(1);
  });

  it('does not return webhooks without a scoop', async () => {
    await manager.createWebhook('global-hook');

    const result = manager.getLicksForScoop('test-scoop');
    expect(result.webhooks).toEqual([]);
  });

  it('returns empty after licks are deleted', async () => {
    const wh = await manager.createWebhook('hook1', 'test-scoop');
    const ct = await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    // Verify they exist
    expect(manager.getLicksForScoop('test-scoop').webhooks).toHaveLength(1);
    expect(manager.getLicksForScoop('test-scoop').cronTasks).toHaveLength(1);

    // Delete them
    await manager.deleteWebhook(wh.id);
    await manager.deleteCronTask(ct.id);

    // Should be empty now
    const result = manager.getLicksForScoop('test-scoop');
    expect(result.webhooks).toEqual([]);
    expect(result.cronTasks).toEqual([]);
  });
});

describe('Scoop removal guard (integration-style)', () => {
  let manager: LickManager;

  beforeEach(() => {
    manager = new LickManager();
  });

  /**
   * Simulates the guard logic from orchestrator.unregisterScoop().
   * We test the logic in isolation since full Orchestrator requires DOM/VFS.
   */
  function checkGuard(scoopFolder: string): void {
    const { webhooks, cronTasks } = manager.getLicksForScoop(scoopFolder);
    if (webhooks.length > 0 || cronTasks.length > 0) {
      const parts: string[] = [];
      if (webhooks.length > 0) {
        parts.push(`${webhooks.length} active webhook${webhooks.length > 1 ? 's' : ''}`);
      }
      if (cronTasks.length > 0) {
        parts.push(`${cronTasks.length} active cron task${cronTasks.length > 1 ? 's' : ''}`);
      }
      const commands = [
        ...webhooks.map(wh => `  webhook delete ${wh.id}`),
        ...cronTasks.map(ct => `  crontask delete ${ct.id}`),
      ].join('\n');
      throw new Error(
        `Cannot remove scoop '${scoopFolder}': it has ${parts.join(' and ')}. Unregister them first:\n${commands}`
      );
    }
  }

  it('blocks removal when scoop has active webhooks', async () => {
    await manager.createWebhook('hook1', 'test-scoop');
    await manager.createWebhook('hook2', 'test-scoop');

    expect(() => checkGuard('test-scoop')).toThrow(
      "Cannot remove scoop 'test-scoop': it has 2 active webhooks"
    );
  });

  it('blocks removal when scoop has active cron tasks', async () => {
    await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    expect(() => checkGuard('test-scoop')).toThrow(
      "Cannot remove scoop 'test-scoop': it has 1 active cron task."
    );
  });

  it('blocks removal with both webhooks and cron tasks', async () => {
    await manager.createWebhook('hook1', 'test-scoop');
    await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    expect(() => checkGuard('test-scoop')).toThrow(
      "it has 1 active webhook and 1 active cron task"
    );
  });

  it('allows removal when scoop has no licks', () => {
    expect(() => checkGuard('test-scoop')).not.toThrow();
  });

  it('allows removal after licks are deleted', async () => {
    const wh = await manager.createWebhook('hook1', 'test-scoop');
    const ct = await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    // Blocked
    expect(() => checkGuard('test-scoop')).toThrow();

    // Remove licks
    await manager.deleteWebhook(wh.id);
    await manager.deleteCronTask(ct.id);

    // Now allowed
    expect(() => checkGuard('test-scoop')).not.toThrow();
  });

  it('error message includes exact commands with actual IDs', async () => {
    const wh = await manager.createWebhook('hook1', 'test-scoop');
    const ct = await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    try {
      checkGuard('test-scoop');
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(`webhook delete ${wh.id}`);
      expect(msg).toContain(`crontask delete ${ct.id}`);
    }
  });
});
