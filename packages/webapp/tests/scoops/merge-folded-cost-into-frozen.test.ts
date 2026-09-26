import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage } from '../../src/core/types.js';
import { VirtualFS } from '../../src/fs/index.js';
import { mergeFoldedCostIntoLatestFrozen } from '../../src/scoops/merge-folded-cost-into-frozen.js';
import {
  type FrozenSessionIndexEntry,
  readSessionsIndex,
  SESSIONS_DIR,
  SESSIONS_INDEX_PATH,
} from '../../src/transcript/frozen-archive-format.js';

describe('mergeFoldedCostIntoLatestFrozen', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `merge-folded-${dbCounter++}`, wipe: true });
    await vfs.mkdir(SESSIONS_DIR, { recursive: true });
  });

  function foldedTurn(model: string, cost: number, tokens = 100): AssistantMessage {
    return {
      role: 'assistant',
      model,
      timestamp: Date.now(),
      usage: {
        input: tokens / 2,
        output: tokens / 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
    } as AssistantMessage;
  }

  async function seedIndex(entries: FrozenSessionIndexEntry[]): Promise<void> {
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(entries));
  }

  it('merges folded agent spend into the newest frozen row for the cone', async () => {
    await seedIndex([
      {
        filename: 'older.md',
        title: 'older',
        frozenAt: '2026-01-01T00:00:00.000Z',
        messageCount: 2,
        cone: 'cone',
        cost: { total: 1, input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
        models: [{ model: 'claude-opus-4-6', cost: 1, turns: 1, tokens: 50 }],
      },
      {
        filename: 'newest.md',
        title: 'newest',
        frozenAt: '2026-09-26T00:00:00.000Z',
        messageCount: 4,
        cone: 'cone',
        cost: { total: 0.15, input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0 },
        models: [{ model: 'claude-opus-4-6', cost: 0.15, turns: 1, tokens: 150 }],
      },
    ]);

    const ok = await mergeFoldedCostIntoLatestFrozen(vfs, { folder: 'cone' }, [
      foldedTurn('claude-haiku-4-5', 0.003, 240),
    ]);
    expect(ok).toBe(true);

    const index = await readSessionsIndex(vfs);
    // upsertSessionsIndexEntry moves the updated row to the head.
    const newest = index.find((e) => e.filename === 'newest.md');
    expect(newest?.cost?.total).toBeCloseTo(0.153, 6);
    expect(newest?.models?.map((m) => m.model)).toEqual(
      expect.arrayContaining(['claude-opus-4-6', 'claude-haiku-4-5'])
    );
  });

  it('returns false when no frozen row exists for the cone', async () => {
    await seedIndex([]);
    const ok = await mergeFoldedCostIntoLatestFrozen(vfs, { folder: 'cone' }, [
      foldedTurn('claude-haiku-4-5', 0.01),
    ]);
    expect(ok).toBe(false);
  });
});
