/**
 * Regression tests for the versionchange/close handler wiring in
 * `scoops/db.ts` — when another context bumps the schema or `nuke` deletes
 * the database, the cached connection must be dropped and the next caller
 * must re-open cleanly instead of throwing "the database connection is
 * closing".
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { getScoop, saveScoop } from '../../src/scoops/db.js';
import type { RegisteredScoop } from '../../src/scoops/types.js';

const sample = (jid: string): RegisteredScoop => ({
  jid,
  name: 'sample',
  folder: 'sample',
  requiresTrigger: false,
  isCone: false,
  type: 'scoop',
  assistantLabel: 'sample',
  addedAt: '2025-01-01T00:00:00.000Z',
});

describe('scoops/db.ts versionchange/close handler', () => {
  it('re-opens transparently after deleteDatabase fires versionchange', async () => {
    // First call opens + caches the connection.
    await saveScoop(sample('s1'));
    expect(await getScoop('s1')).not.toBeNull();

    // deleteDatabase delivers `versionchange` to every open connection. With
    // the handler installed the cached connection closes and the cache is
    // nulled; without it, deleteDatabase would block and the next
    // transaction would throw the closing error.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('slicc-groups');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () =>
        reject(new Error('deleteDatabase blocked — cached connection was not closed'));
    });

    // Next operation must re-open transparently.
    await saveScoop(sample('s2'));
    expect(await getScoop('s2')).not.toBeNull();
  });

  it('does not block deleteDatabase after concurrent opens overwrite the cache', async () => {
    // Two parallel callers both miss the module-level cache and each opens
    // its own connection — the second `onsuccess` overwrites the first in
    // the cache. The previous handler closed whatever was cached when a
    // `versionchange` fired on the FIRST (non-cached) connection, leaving
    // the original connection open and blocking `deleteDatabase`. The fix
    // captures `request.result` per open so each handler closes its own
    // connection regardless of cache state.
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
