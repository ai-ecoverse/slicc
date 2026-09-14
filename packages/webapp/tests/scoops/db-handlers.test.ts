import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getScoop, saveScoop } from '../../src/scoops/db.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const sample = (jid: string): RegisteredScoop => ({
  jid,
  name: 'sample',
  folder: 'sample',
  requiresTrigger: false,
  parentJid: 'cone',
  assistantLabel: 'sample',
  addedAt: '2025-01-01T00:00:00.000Z',
});

describe('scoops/db.ts versionchange/close handler', () => {
  it('re-opens transparently after deleteDatabase fires versionchange', async () => {
    await saveScoop(sample('s1'));
    expect(await getScoop('s1')).not.toBeNull();

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('slicc-groups');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error('deleteDatabase blocked — cached connection was not closed'));
    });

    await saveScoop(sample('s2'));
    expect(await getScoop('s2')).not.toBeNull();
  });

  it('does not block deleteDatabase after concurrent opens overwrite the cache', async () => {
    await Promise.all([saveScoop(sample('cc1')), saveScoop(sample('cc2'))]);

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('slicc-groups');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error('deleteDatabase blocked — a concurrent-open connection was not closed'));
    });

    await saveScoop(sample('cc3'));
    expect(await getScoop('cc3')).not.toBeNull();
  });
});
