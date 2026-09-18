import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  previewArgs,
  TOOL_ARGS_PREVIEW_MAX,
  TurnJournal,
} from '../../../src/scoops/scoop-context/turn-journal.js';

let dbCounter = 0;
const freshJournal = () => new TurnJournal({ dbName: `turn-journal-test-${++dbCounter}` });

describe('TurnJournal', () => {
  it('records a running turn and survives into a new journal instance (a reload)', async () => {
    const dbName = `turn-journal-test-${++dbCounter}`;
    const before = new TurnJournal({ dbName });
    before.begin('cone_1', 'cone', 0, [{ requester: 'guest-1' }]);
    void before.toolStarted('cone_1', 'call-a', 'bash', { command: 'sleep 60' });
    await before.flush();

    const after = new TurnJournal({ dbName });
    const [turn] = await after.readAll();
    expect(turn).toMatchObject({
      jid: 'cone_1',
      folder: 'cone',
      resumeCount: 0,
      guestGates: [{ requester: 'guest-1' }],
      tools: [{ toolCallId: 'call-a', toolName: 'bash', argsPreview: '{"command":"sleep 60"}' }],
    });
    expect(after.isLive('cone_1')).toBe(false);
  });

  it('drops a finished tool call and deletes the record when the turn settles', async () => {
    const journal = freshJournal();
    journal.begin('cone_1', 'cone');
    void journal.toolStarted('cone_1', 'call-a', 'bash', {});
    void journal.toolStarted('cone_1', 'call-a', 'bash', {});
    void journal.toolStarted('cone_1', 'call-b', 'read_file', {});
    journal.toolEnded('cone_1', 'call-a');
    journal.toolEnded('cone_1', 'unknown');
    await journal.flush();
    expect((await journal.readAll())[0]?.tools.map((t) => t.toolCallId)).toEqual(['call-b']);
    expect(journal.isLive('cone_1')).toBe(true);

    journal.end('cone_1');
    await journal.flush();
    expect(await journal.readAll()).toEqual([]);
    expect(journal.isLive('cone_1')).toBe(false);
  });

  it('toolStarted resolves once the record naming the call has landed', async () => {
    const dbName = `turn-journal-test-${++dbCounter}`;
    const journal = new TurnJournal({ dbName });
    journal.begin('cone_1', 'cone');
    await journal.toolStarted('cone_1', 'call-a', 'bash', {});

    const [row] = await new TurnJournal({ dbName }).readAll();
    expect(row?.tools.map((t) => t.toolCallId)).toEqual(['call-a']);

    await expect(journal.toolStarted('cone_1', 'call-a', 'bash', {})).resolves.toBeUndefined();
    await expect(journal.toolStarted('nobody', 'x', 'bash', {})).resolves.toBeUndefined();
  });

  it('ignores tool and gate updates for a unit with no running turn', async () => {
    const journal = freshJournal();
    void journal.toolStarted('cone_1', 'call-a', 'bash', {});
    journal.toolEnded('cone_1', 'call-a');
    journal.setGuestGates('cone_1', [{ requester: 'x' }]);
    await journal.flush();
    expect(await journal.readAll()).toEqual([]);
  });

  it('widens the journaled guest gates when a queued prompt adds one', async () => {
    const journal = freshJournal();
    journal.begin('cone_1', 'cone');
    journal.setGuestGates('cone_1', [{ requester: 'a' }, { requester: 'b' }]);
    await journal.flush();
    expect((await journal.readAll())[0]?.guestGates).toEqual([
      { requester: 'a' },
      { requester: 'b' },
    ]);
  });

  it('end() never deletes a record left over from a previous page life', async () => {
    const dbName = `turn-journal-test-${++dbCounter}`;
    const before = new TurnJournal({ dbName });
    before.begin('cone_1', 'cone');
    await before.flush();

    const after = new TurnJournal({ dbName });
    after.end('cone_1');
    await after.flush();
    expect(await after.readAll()).toHaveLength(1);

    await after.clear('cone_1');
    expect(await after.readAll()).toEqual([]);
  });

  it('carries the resume count forward', async () => {
    const journal = freshJournal();
    journal.begin('cone_1', 'cone', 2);
    await journal.flush();
    expect((await journal.readAll())[0]?.resumeCount).toBe(2);
  });

  it('normalizes records missing newer fields and skips junk rows', async () => {
    const dbName = `turn-journal-test-${++dbCounter}`;
    const journal = new TurnJournal({ dbName });
    journal.begin('seed', 'seed');
    await journal.flush();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onsuccess = () => {
        const tx = req.result.transaction('inflight', 'readwrite');
        const store = tx.objectStore('inflight');
        store.put({ jid: 'old', folder: 'old', startedAt: 1, updatedAt: 1, tools: [] });
        store.put({ jid: 'junk' });
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });
    const rows = await new TurnJournal({ dbName }).readAll();
    expect(rows.map((r) => r.jid).sort()).toEqual(['old', 'seed']);
    expect(rows.find((r) => r.jid === 'old')).toMatchObject({ resumeCount: 0, guestGates: [] });
  });

  it('reads nothing (and never throws) when IndexedDB is unavailable', async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error — simulate a realm without IndexedDB
    delete globalThis.indexedDB;
    try {
      const journal = freshJournal();
      expect(await journal.readAll()).toEqual([]);
      journal.begin('cone_1', 'cone');
      await journal.flush();
    } finally {
      globalThis.indexedDB = original;
    }
  });
});

describe('previewArgs', () => {
  it('serializes objects, passes strings through, and truncates long payloads', () => {
    expect(previewArgs({ a: 1 })).toBe('{"a":1}');
    expect(previewArgs('raw')).toBe('raw');
    const long = previewArgs({ text: 'x'.repeat(2 * TOOL_ARGS_PREVIEW_MAX) });
    expect(long).toHaveLength(TOOL_ARGS_PREVIEW_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('never throws on unserializable arguments', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(previewArgs(cyclic)).toBe('[object Object]');
    expect(previewArgs(undefined)).toBe('');
  });
});
