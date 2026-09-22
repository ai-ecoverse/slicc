/**
 * Incremental curation of a live archive: the cursor moves only after a
 * successful slice, a receipt makes a replay a no-op, and a later finalize
 * mines only the messages the cursor has not covered.
 */
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyHostFlagOverrides, initFeatureFlags } from '../../src/core/feature-flags.js';
import { FsError } from '../../src/fs/types.js';
import type { AgentSpawnOptions, AgentSpawnResult } from '../../src/scoops/agent-bridge.js';
import { curatorReceiptPath } from '../../src/scoops/agentic-memory.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import {
  advanceCuratedThrough,
  curateLiveSessionDelta,
  curationTargetForFinalize,
  type LiveCurationVfs,
  liveDeltaArchivePath,
  scheduleLiveDeltaCuration,
  takeDeltaSlice,
} from '../../src/scoops/live-session-curation.js';
import { snapshotLiveSession } from '../../src/scoops/live-session-snapshot.js';
import { runMemoryDreamPass } from '../../src/scoops/memory-dreaming.js';
import {
  parseFrozenArchive,
  readSessionsIndex,
} from '../../src/transcript/frozen-archive-format.js';
import type { ArchiveVfs } from '../../src/transcript/frozen-archive-writer.js';

function fakeVfs(): ArchiveVfs & LiveCurationVfs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async readFile(path: string): Promise<string> {
      const hit = files.get(path);
      if (hit === undefined) throw new FsError('ENOENT', `missing ${path}`, path);
      return hit;
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content);
    },
    async mkdir(): Promise<void> {},
    async rm(path: string): Promise<void> {
      files.delete(path);
    },
    async flush(): Promise<void> {},
  };
}

const chat = (role: 'user' | 'assistant', content: string, timestamp: number): ChatMessage => ({
  id: `${role}-${timestamp}`,
  role,
  content,
  timestamp,
});

const agent = (role: 'user' | 'assistant', text: string, timestamp: number): AgentMessage =>
  ({ role, content: [{ type: 'text', text }], timestamp, stopReason: 'stop' }) as AgentMessage;

function successSpawn() {
  return vi.fn(
    async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
      finalText: 'folded',
      exitCode: 0,
    })
  );
}

function spawnPrompt(spawn: ReturnType<typeof successSpawn>, index = 0): string {
  const call = spawn.mock.calls[index];
  if (!call) throw new Error(`spawn was not called (index ${index})`);
  return call[0].prompt;
}

async function seedLive(vfs: ArchiveVfs) {
  const result = await snapshotLiveSession({
    vfs,
    cone: { folder: 'cone' },
    messages: [agent('user', 'fix the build', 10), agent('assistant', 'on it', 20)],
    trigger: 'idle',
    now: () => 1_000,
  });
  if (!result?.entry.sessionId) throw new Error('snapshot skipped');
  return { ...result, sessionId: result.entry.sessionId };
}

beforeEach(() => {
  initFeatureFlags('standalone');
});

afterEach(() => {
  initFeatureFlags('standalone');
  delete (globalThis as { __slicc_agent?: unknown }).__slicc_agent;
});

describe('takeDeltaSlice', () => {
  it('keeps a same-timestamp sibling with the message that hit the cap', () => {
    const messages = [
      chat('user', 'a', 10),
      chat('assistant', 'b', 20),
      chat('user', 'c', 20),
      chat('assistant', 'd', 30),
    ];
    const slice = takeDeltaSlice(messages, { maxMessages: 2, maxChars: 10_000 });
    expect(slice.map((message) => message.content)).toEqual(['a', 'b', 'c']);
  });
});

describe('curateLiveSessionDelta', () => {
  it('advances curatedThrough only after the slice succeeds, and a replay does not spawn', async () => {
    const vfs = fakeVfs();
    const live = await seedLive(vfs);
    const spawn = successSpawn();

    const first = await curateLiveSessionDelta({
      vfs,
      cone: { folder: 'cone' },
      spawn,
      enabled: true,
    });

    expect(first).toEqual({ status: 'curated', curatedThrough: 20, filename: live.entry.filename });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawnPrompt(spawn)).toContain(liveDeltaArchivePath(live.sessionId, 0, 20));
    const [entry] = await readSessionsIndex(vfs as never);
    expect(entry.curatedThrough).toBe(20);
    expect(
      parseFrozenArchive(vfs.files.get(`/sessions/${live.entry.filename}`)!).curatedThrough
    ).toBe(20);

    const second = await curateLiveSessionDelta({
      vfs,
      cone: { folder: 'cone' },
      spawn,
      enabled: true,
    });
    expect(second).toEqual({ status: 'skipped', reason: 'caught-up' });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('treats an existing slice receipt as already curated and does not spawn', async () => {
    const vfs = fakeVfs();
    const live = await seedLive(vfs);
    const path = liveDeltaArchivePath(live.sessionId, 0, 20);
    vfs.files.set(curatorReceiptPath(path), 'ok');
    const spawn = successSpawn();

    const result = await curateLiveSessionDelta({
      vfs,
      cone: { folder: 'cone' },
      spawn,
      enabled: true,
    });

    expect(result).toEqual({ status: 'skipped', reason: 'caught-up' });
    expect(spawn).not.toHaveBeenCalled();
    expect((await readSessionsIndex(vfs as never))[0].curatedThrough).toBe(20);
  });

  it('leaves the cursor in place when the pass fails, and retries on the next call', async () => {
    const vfs = fakeVfs();
    const live = await seedLive(vfs);
    const spawn = vi.fn(
      async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => ({
        finalText: 'timeout',
        exitCode: 1,
      })
    );

    const failed = await curateLiveSessionDelta({
      vfs,
      cone: { folder: 'cone' },
      spawn,
      enabled: true,
    });

    expect(failed.status).toBe('failed');
    expect((await readSessionsIndex(vfs as never))[0].curatedThrough).toBeUndefined();
    expect((await readSessionsIndex(vfs as never))[0].memoryFailed).toContain('timeout');

    spawn.mockResolvedValueOnce({ finalText: 'folded', exitCode: 0 });
    const retried = await curateLiveSessionDelta({
      vfs,
      cone: { folder: 'cone' },
      spawn,
      enabled: true,
    });
    expect(retried).toMatchObject({ status: 'curated', curatedThrough: 20 });
    expect((await readSessionsIndex(vfs as never))[0].memoryFailed).toBeUndefined();
  });

  it('does not spawn when the flag gate is off', async () => {
    const vfs = fakeVfs();
    await seedLive(vfs);
    const spawn = successSpawn();
    const result = await curateLiveSessionDelta({ vfs, cone: { folder: 'cone' }, spawn });
    expect(result).toEqual({ status: 'skipped', reason: 'flag-off' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('keeps the cursor across a later compaction round', async () => {
    const vfs = fakeVfs();
    const live = await seedLive(vfs);
    await advanceCuratedThrough(vfs, live.entry.filename, 20);
    const again = await snapshotLiveSession({
      vfs,
      cone: { folder: 'cone' },
      messages: [
        agent('user', '<context-summary>', 30),
        agent('user', 'fix the build', 10),
        agent('assistant', 'on it', 20),
        agent('user', 'next', 40),
      ],
      trigger: 'idle',
    });
    expect(again?.entry.curatedThrough).toBe(20);
    expect(again?.entry.liveThrough).toBe(40);
    expect(parseFrozenArchive(vfs.files.get(again!.transcriptPath)!).curatedThrough).toBe(20);
  });

  it('releases the in-flight slot when the pass rejects, without an unhandled rejection', async () => {
    const vfs = fakeVfs();
    await seedLive(vfs);
    const original = vfs.readFile.bind(vfs);
    vfs.readFile = async (path: string) => {
      if (path.includes('/.curated/')) throw new FsError('EIO', 'disk', path);
      return original(path);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    const spawn = successSpawn();
    try {
      await expect(
        curateLiveSessionDelta({ vfs, cone: { folder: 'cone' }, spawn, enabled: true })
      ).rejects.toThrow('disk');
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    vfs.readFile = original;
    const retried = await curateLiveSessionDelta({
      vfs,
      cone: { folder: 'cone' },
      spawn,
      enabled: true,
    });
    expect(retried).toMatchObject({ status: 'curated', curatedThrough: 20 });
  });

  it('serializes a second caller behind the in-flight pass', async () => {
    const vfs = fakeVfs();
    await seedLive(vfs);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = vi.fn(async (_options: AgentSpawnOptions): Promise<AgentSpawnResult> => {
      await gate;
      return { finalText: 'folded', exitCode: 0 };
    });
    const first = curateLiveSessionDelta({ vfs, cone: { folder: 'cone' }, spawn, enabled: true });
    const second = curateLiveSessionDelta({ vfs, cone: { folder: 'cone' }, spawn, enabled: true });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    release?.();
    await Promise.all([first, second]);
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe('curationTargetForFinalize', () => {
  it('keeps the whole-archive pass when nothing has been curated', async () => {
    const vfs = fakeVfs();
    const target = await curationTargetForFinalize(vfs, {
      sessionId: 'sid',
      filename: 'live-cone-a.md',
      title: 't',
      frozenAt: 'now',
      messages: [chat('user', 'one', 10), chat('assistant', 'two', 20)],
    });
    expect(target).toEqual({ kind: 'full' });
  });

  it('mines only the tail after curatedThrough, and a tail receipt skips the spawn', async () => {
    const vfs = fakeVfs();
    const messages = [chat('user', 'old', 10), chat('assistant', 'new', 20)];
    const tail = await curationTargetForFinalize(vfs, {
      sessionId: 'sid',
      filename: 'live-cone-a.md',
      title: 't',
      frozenAt: 'now',
      curatedThrough: 10,
      messages,
    });
    expect(tail.kind).toBe('delta');
    if (tail.kind !== 'delta') return;
    expect(tail.through).toBe(20);
    expect(tail.messages.map((message) => message.content)).toEqual(['new']);
    expect(parseFrozenArchive(vfs.files.get(tail.path)!).messages.map((m) => m.content)).toEqual([
      'new',
    ]);

    vfs.files.set(curatorReceiptPath(liveDeltaArchivePath('sid', 10, 20)), 'ok');
    const again = await curationTargetForFinalize(vfs, {
      sessionId: 'sid',
      filename: 'live-cone-a.md',
      title: 't',
      frozenAt: 'now',
      curatedThrough: 10,
      messages,
    });
    expect(again).toEqual({ kind: 'covered', through: 20 });
  });
});

describe('schedule and dream', () => {
  it('does not schedule when the flags are off', async () => {
    const vfs = fakeVfs();
    const result = await scheduleLiveDeltaCuration({ vfs, cone: { folder: 'cone' } });
    expect(result).toEqual({ status: 'skipped', reason: 'flag-off' });
  });

  it('runs one live slice before the dreamer when both flags are on', async () => {
    applyHostFlagOverrides({ 'memory-v2': 'on', 'agentic-memory': 'on' });
    const vfs = fakeVfs();
    await seedLive(vfs);
    const spawn = successSpawn();

    const dreamed = await runMemoryDreamPass({
      spawn,
      vfs,
      sessionCount: 1,
      today: '2026-09-22',
    });

    expect(dreamed).toEqual({ ok: true, report: 'folded' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawnPrompt(spawn, 0)).toContain('**Curation pass**');
    expect(spawn.mock.calls[0]?.[0].name).toBe('memory-curator');
    expect(spawn.mock.calls[1]?.[0].name).toBe('memory-dreamer');
    expect((await readSessionsIndex(vfs as never))[0].curatedThrough).toBe(20);
  });
});
