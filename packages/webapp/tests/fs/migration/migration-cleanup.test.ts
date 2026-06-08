import { describe, expect, it, vi } from 'vitest';
import {
  cleanupLegacyIdb,
  type LegacyIdbCleanupResult,
} from '../../../src/fs/migration/migration-cleanup.js';

function collectLogs() {
  const entries: { level: 'info' | 'warn'; msg: string }[] = [];
  return {
    entries,
    logger: {
      info: (msg: string) => entries.push({ level: 'info', msg }),
      warn: (msg: string) => entries.push({ level: 'warn', msg }),
    },
  };
}

describe('cleanupLegacyIdb', () => {
  it('refuses to delete when the migration sentinel is absent (rollback escape hatch preserved)', async () => {
    const deleteLegacyDb = vi.fn(async () => 'deleted' as const);
    const probeLegacyDbExists = vi.fn(async () => true);
    const logs = collectLogs();

    const result: LegacyIdbCleanupResult = await cleanupLegacyIdb({
      sentinelExists: async () => false,
      probeLegacyDbExists,
      deleteLegacyDb,
      logger: logs.logger,
    });

    expect(result.kind).toBe('sentinel-missing');
    expect(deleteLegacyDb).not.toHaveBeenCalled();
    expect(probeLegacyDbExists).not.toHaveBeenCalled();
    // The warning must mention the refusal — counts/state only, no paths.
    expect(logs.entries.some((e) => e.level === 'warn' && e.msg.includes('refusing'))).toBe(true);
  });

  it('reports absent when the legacy IDB is already gone (idempotent re-run)', async () => {
    const deleteLegacyDb = vi.fn(async () => 'deleted' as const);
    const result = await cleanupLegacyIdb({
      sentinelExists: async () => true,
      probeLegacyDbExists: async () => false,
      deleteLegacyDb,
    });
    expect(result.kind).toBe('absent');
    expect(deleteLegacyDb).not.toHaveBeenCalled();
  });

  it('deletes the legacy IDB ONLY when the sentinel is present AND the IDB exists', async () => {
    const deleteLegacyDb = vi.fn(async () => 'deleted' as const);
    const result = await cleanupLegacyIdb({
      sentinelExists: async () => true,
      probeLegacyDbExists: async () => true,
      deleteLegacyDb,
    });
    expect(result.kind).toBe('deleted');
    expect(deleteLegacyDb).toHaveBeenCalledTimes(1);
  });

  it('surfaces blocked from the IDB delete request', async () => {
    const result = await cleanupLegacyIdb({
      sentinelExists: async () => true,
      probeLegacyDbExists: async () => true,
      deleteLegacyDb: async () => 'blocked',
    });
    expect(result.kind).toBe('blocked');
    expect(result.message).toContain('blocked');
  });

  it('surfaces error from the IDB delete request', async () => {
    const result = await cleanupLegacyIdb({
      sentinelExists: async () => true,
      probeLegacyDbExists: async () => true,
      deleteLegacyDb: async () => 'error',
    });
    expect(result.kind).toBe('error');
  });

  it('logs the IDB name but never any user paths or contents', async () => {
    const logs = collectLogs();
    await cleanupLegacyIdb({
      sentinelExists: async () => true,
      probeLegacyDbExists: async () => true,
      deleteLegacyDb: async () => 'deleted',
      logger: logs.logger,
    });
    for (const { msg } of logs.entries) {
      expect(msg).toContain('slicc-fs');
      expect(msg).not.toContain('/workspace');
      expect(msg).not.toContain('/shared');
    }
  });
});
