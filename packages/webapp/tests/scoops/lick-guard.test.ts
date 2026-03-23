/**
 * Tests for the lick guard: preventing scoop removal when active licks exist.
 *
 * Tests getLicksForScoop on LickManager and the guard logic in unregisterScoop.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { LickManager, buildActiveLicksError } from '../../src/scoops/lick-manager.js';

// Each test gets a fresh LickManager WITHOUT calling init() to avoid
// accumulating state in the shared IndexedDB across tests.

describe('LickManager.getLicksForScoop', () => {
  let manager: LickManager;

  beforeEach(() => {
    manager = new LickManager();
  });

  it('returns empty arrays when no licks target the scoop', () => {
    const result = manager.getLicksForScoop('test', 'test-scoop');
    expect(result.webhooks).toEqual([]);
    expect(result.cronTasks).toEqual([]);
  });

  it('returns webhooks targeting the scoop by folder', async () => {
    await manager.createWebhook('hook1', 'test-scoop');
    await manager.createWebhook('hook2', 'other-scoop');
    await manager.createWebhook('hook3', 'test-scoop');

    const result = manager.getLicksForScoop('test', 'test-scoop');
    expect(result.webhooks).toHaveLength(2);
    expect(result.webhooks.map((w) => w.name)).toEqual(['hook1', 'hook3']);
    expect(result.cronTasks).toEqual([]);
  });

  it('returns webhooks targeting the scoop by name', async () => {
    await manager.createWebhook('hook1', 'click-handler');

    const result = manager.getLicksForScoop('click-handler', 'click-handler-scoop');
    expect(result.webhooks).toHaveLength(1);
    expect(result.webhooks[0].name).toBe('hook1');
  });

  it('returns webhooks when scoop field + "-scoop" matches folder', async () => {
    // Webhook created with --scoop click-handler (the name), folder is click-handler-scoop
    await manager.createWebhook('hook1', 'click-handler');

    const result = manager.getLicksForScoop('something-else', 'click-handler-scoop');
    expect(result.webhooks).toHaveLength(1);
  });

  it('returns cron tasks targeting the scoop', async () => {
    await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');
    await manager.createCronTask('cron2', '0 * * * *', 'other-scoop');

    const result = manager.getLicksForScoop('test', 'test-scoop');
    expect(result.webhooks).toEqual([]);
    expect(result.cronTasks).toHaveLength(1);
    expect(result.cronTasks[0].name).toBe('cron1');
  });

  it('returns cron tasks targeting the scoop by name alias', async () => {
    await manager.createCronTask('cron1', '*/5 * * * *', 'my-task');

    const result = manager.getLicksForScoop('my-task', 'my-task-scoop');
    expect(result.cronTasks).toHaveLength(1);
  });

  it('returns both webhooks and cron tasks', async () => {
    await manager.createWebhook('hook1', 'test-scoop');
    await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    const result = manager.getLicksForScoop('test', 'test-scoop');
    expect(result.webhooks).toHaveLength(1);
    expect(result.cronTasks).toHaveLength(1);
  });

  it('does not return webhooks without a scoop', async () => {
    await manager.createWebhook('global-hook');

    const result = manager.getLicksForScoop('test', 'test-scoop');
    expect(result.webhooks).toEqual([]);
  });

  it('returns empty after licks are deleted', async () => {
    const wh = await manager.createWebhook('hook1', 'test-scoop');
    const ct = await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    // Verify they exist
    expect(manager.getLicksForScoop('test', 'test-scoop').webhooks).toHaveLength(1);
    expect(manager.getLicksForScoop('test', 'test-scoop').cronTasks).toHaveLength(1);

    // Delete them
    await manager.deleteWebhook(wh.id);
    await manager.deleteCronTask(ct.id);

    // Should be empty now
    const result = manager.getLicksForScoop('test', 'test-scoop');
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
   * Uses the shared buildActiveLicksError() to avoid duplicating error construction.
   */
  function checkGuard(name: string, folder: string): void {
    const { webhooks, cronTasks } = manager.getLicksForScoop(name, folder);
    const err = buildActiveLicksError(folder, webhooks, cronTasks);
    if (err) throw err;
  }

  it('blocks removal when scoop has active webhooks', async () => {
    await manager.createWebhook('hook1', 'test-scoop');
    await manager.createWebhook('hook2', 'test-scoop');

    expect(() => checkGuard('test', 'test-scoop')).toThrow(
      "Cannot remove scoop 'test-scoop': it has 2 active webhooks"
    );
  });

  it('blocks removal when scoop has active cron tasks', async () => {
    await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    expect(() => checkGuard('test', 'test-scoop')).toThrow(
      "Cannot remove scoop 'test-scoop': it has 1 active cron task."
    );
  });

  it('blocks removal with both webhooks and cron tasks', async () => {
    await manager.createWebhook('hook1', 'test-scoop');
    await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    expect(() => checkGuard('test', 'test-scoop')).toThrow(
      'it has 1 active webhook and 1 active cron task'
    );
  });

  it('blocks removal when lick targets scoop by name alias', async () => {
    // Webhook created with name, not folder
    await manager.createWebhook('hook1', 'click-handler');

    expect(() => checkGuard('click-handler', 'click-handler-scoop')).toThrow(
      "Cannot remove scoop 'click-handler-scoop'"
    );
  });

  it('allows removal when scoop has no licks', () => {
    expect(() => checkGuard('test', 'test-scoop')).not.toThrow();
  });

  it('allows removal after licks are deleted', async () => {
    const wh = await manager.createWebhook('hook1', 'test-scoop');
    const ct = await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    // Blocked
    expect(() => checkGuard('test', 'test-scoop')).toThrow();

    // Remove licks
    await manager.deleteWebhook(wh.id);
    await manager.deleteCronTask(ct.id);

    // Now allowed
    expect(() => checkGuard('test', 'test-scoop')).not.toThrow();
  });

  it('error message includes exact commands with actual IDs', async () => {
    const wh = await manager.createWebhook('hook1', 'test-scoop');
    const ct = await manager.createCronTask('cron1', '*/5 * * * *', 'test-scoop');

    try {
      checkGuard('test', 'test-scoop');
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(`webhook delete ${wh.id}`);
      expect(msg).toContain(`crontask delete ${ct.id}`);
    }
  });
});
