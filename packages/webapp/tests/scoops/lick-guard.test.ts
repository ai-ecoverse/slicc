/**
 * Tests for the lick guard: preventing scoop removal when active licks exist.
 *
 * Tests getLicksForScoop on LickManager and the guard logic in unregisterScoop.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import * as db from '../../src/scoops/db.js';
import {
  buildActiveLicksError,
  type CronTaskEntry,
  LickManager,
  type WebhookEntry,
} from '../../src/scoops/lick-manager.js';

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

describe('LickManager orphan self-heal + persistence-authoritative guard', () => {
  // Uses unique per-test scoop names so the shared fake-indexeddb store can't
  // leak between tests (the DB-reading paths below query IndexedDB directly).

  it('runCronScheduler deletes a task whose target scoop no longer exists', async () => {
    const manager = new LickManager();
    // Only 'sched-live-scoop' still exists; the orphan targets a gone scoop.
    manager.setScoopExistenceResolver((f) => f === 'sched-live-scoop');
    const orphan = await manager.createCronTask('sched-orphan', '*/5 * * * *', 'sched-gone-scoop');

    let dispatched = 0;
    manager.setEventHandler(() => {
      dispatched++;
    });

    await (manager as unknown as { runCronScheduler(): Promise<void> }).runCronScheduler();

    // Dropped from memory + persistence and never dispatched.
    expect(manager.getCronTask(orphan.id)).toBeUndefined();
    expect(dispatched).toBe(0);
    const persisted = await manager.getLicksForScoopFromDb('sched-gone', 'sched-gone-scoop');
    expect(persisted.cronTasks).toHaveLength(0);
  });

  it('init() removes orphaned licks (but keeps live ones) before the scheduler starts', async () => {
    // Seed persisted licks with a separate manager (writes IndexedDB).
    const seeder = new LickManager();
    const wh = await seeder.createWebhook('init-orphan-wh', 'init-gone-scoop');
    const ct = await seeder.createCronTask('init-orphan-cron', '*/5 * * * *', 'init-gone-scoop');
    const liveWh = await seeder.createWebhook('init-live-wh', 'init-live-scoop');

    // Fresh manager loads them from IndexedDB. Resolver treats only
    // 'init-gone-scoop' as missing, so unrelated rows from other tests survive.
    const manager = new LickManager();
    manager.setScoopExistenceResolver((f) => f !== 'init-gone-scoop');
    await manager.init();

    try {
      expect(manager.getCronTask(ct.id)).toBeUndefined();
      expect(manager.getWebhook(wh.id)).toBeUndefined();
      expect(manager.getWebhook(liveWh.id)).toBeDefined();
      const goneDb = await manager.getLicksForScoopFromDb('init-gone', 'init-gone-scoop');
      expect(goneDb.webhooks).toHaveLength(0);
      expect(goneDb.cronTasks).toHaveLength(0);
    } finally {
      manager.dispose();
      await manager.deleteWebhook(liveWh.id);
    }
  });

  it('persisted-but-not-in-memory lick still blocks the drop via getLicksForScoopFromDb', async () => {
    // Seeder persists a webhook to IndexedDB (and its own in-memory map).
    const seeder = new LickManager();
    const wh = await seeder.createWebhook('db-guard-wh', 'db-guard-scoop');

    // A fresh manager never loaded it, so the in-memory lookup finds nothing…
    const manager = new LickManager();
    expect(manager.getLicksForScoop('db-guard', 'db-guard-scoop').webhooks).toHaveLength(0);

    // …but the persistence-authoritative lookup does, so the guard still blocks
    // with the existing error message.
    const { webhooks, cronTasks } = await manager.getLicksForScoopFromDb(
      'db-guard',
      'db-guard-scoop'
    );
    expect(webhooks).toHaveLength(1);
    const err = buildActiveLicksError('db-guard-scoop', webhooks, cronTasks);
    expect(err).not.toBeNull();
    expect(err?.message).toContain("Cannot remove scoop 'db-guard-scoop'");

    await seeder.deleteWebhook(wh.id);
  });
});

describe('LickManager DB-authoritative delete (multi-worker drift remediation)', () => {
  // Seeds rows directly into IndexedDB (bypassing the manager's in-memory map)
  // so a fresh manager whose map lacks the id can still delete them — the exact
  // remediation the persistence-authoritative drop guard tells users to run.

  it('deleteCronTask removes a task that exists ONLY in the DB', async () => {
    const id = 'db-only-cron-remediate';
    const entry: CronTaskEntry = {
      id,
      name: 'db-only-cron',
      cron: '*/5 * * * *',
      scoop: 'db-only-cron-scoop',
      filter: undefined,
      nextRun: new Date().toISOString(),
      lastRun: null,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    await db.saveCronTask(entry);

    // Fresh manager never loaded it, so the in-memory map lacks it.
    const manager = new LickManager();
    expect(manager.getCronTask(id)).toBeUndefined();

    expect(await manager.deleteCronTask(id)).toBe(true);
    expect(await db.getCronTask(id)).toBeNull();
  });

  it('deleteWebhook removes a webhook that exists ONLY in the DB', async () => {
    const id = 'db-only-wh-remediate';
    const entry: WebhookEntry = {
      id,
      name: 'db-only-wh',
      createdAt: new Date().toISOString(),
      filter: undefined,
      scoop: 'db-only-wh-scoop',
    };
    await db.saveWebhook(entry);

    const manager = new LickManager();
    expect(manager.getWebhook(id)).toBeUndefined();

    expect(await manager.deleteWebhook(id)).toBe(true);
    expect(await db.getWebhook(id)).toBeNull();
  });

  it('deleteCronTask returns false when neither the map nor the DB has the id', async () => {
    const manager = new LickManager();
    expect(await manager.deleteCronTask('genuinely-missing-cron')).toBe(false);
  });

  it('deleteWebhook returns false when neither the map nor the DB has the id', async () => {
    const manager = new LickManager();
    expect(await manager.deleteWebhook('genuinely-missing-wh')).toBe(false);
  });
});
