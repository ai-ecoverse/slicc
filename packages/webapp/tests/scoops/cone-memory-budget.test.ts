/**
 * Tests for the cone-memory budget + restructure module.
 *
 * Pure helpers are tested directly; the LLM-driven `restructureConeMemory`
 * mocks `completeSimple` from pi-ai with the same `vi.mock` shape used by
 * `tests/core/context-compaction.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Api, Model } from '@earendil-works/pi-ai';

const mockCompleteSimple = vi.fn();

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    completeSimple: (...args: unknown[]) => mockCompleteSimple(...args),
  };
});

import { FsError, VirtualFS } from '../../src/fs/index.js';
import {
  applyConeMemoryBudget,
  CONE_MEMORY_PATH,
  computeBudget,
  MEMORY_BASE_CHARS,
  MEMORY_OVERSHOOT_RATIO,
  MEMORY_PER_LOG_CHARS,
  readSessionCount,
  restructureConeMemory,
  SESSIONS_INDEX_PATH,
  splitConeMemory,
} from '../../src/scoops/cone-memory-budget.js';
import { ConeMemoryStore } from '../../src/scoops/cone-memory-store.js';
import { getAllScoops, initDB } from '../../src/scoops/db.js';
import { Orchestrator } from '../../src/scoops/orchestrator.js';

const fakeModel = { provider: 'anthropic', id: 'claude-opus-4-6' } as unknown as Model<Api>;

function llmResponse(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    timestamp: 0,
  };
}

function llmError(message: string) {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
    timestamp: 0,
  };
}

let dbCounter = 0;
async function makeVfs(): Promise<VirtualFS> {
  dbCounter += 1;
  return VirtualFS.create({ dbName: `cone-memory-budget-test-${Date.now()}-${dbCounter}` });
}

describe('computeBudget', () => {
  it('is monotonically non-decreasing and equals BASE + PER_LOG*log2(N+2)', () => {
    const cases: Array<[number, number]> = [
      [0, MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(2)],
      [1, MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(3)],
      [2, MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(4)],
      [6, MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(8)],
      [14, MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(16)],
      [100, MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * Math.log2(102)],
    ];
    let prev = -1;
    for (const [n, expected] of cases) {
      const got = computeBudget(n);
      expect(got).toBe(Math.round(expected));
      expect(got).toBeGreaterThanOrEqual(prev);
      prev = got;
    }
  });

  it('clamps negative/NaN to N=0', () => {
    const baseline = computeBudget(0);
    expect(computeBudget(-5)).toBe(baseline);
    expect(computeBudget(NaN)).toBe(baseline);
  });
});

describe('splitConeMemory', () => {
  it('returns the whole content as header when no auto-extracted block exists', () => {
    const content = '# User memory\n\nHand-curated notes.\n';
    expect(splitConeMemory(content)).toEqual({ header: content, autoExtracted: '' });
  });

  it('splits at the FIRST ## Auto-extracted heading and keeps later blocks in the tail', () => {
    const header = '# User memory\n\nUser-authored.\n\n';
    const tail =
      '## Auto-extracted (2024-01-01, compaction)\n\n- first\n\n## Auto-extracted (2024-01-02, new-session)\n\n- second\n';
    const { header: h, autoExtracted: t } = splitConeMemory(header + tail);
    expect(h).toBe(header);
    expect(t).toBe(tail);
  });

  it('emits an empty header when the file starts with the auto-extracted heading', () => {
    const tail = '## Auto-extracted (2024-01-01)\n\n- foo\n';
    expect(splitConeMemory(tail)).toEqual({ header: '', autoExtracted: tail });
  });
});

describe('readSessionCount', () => {
  it('returns 0 when the index is missing', async () => {
    const vfs = await makeVfs();
    expect(await readSessionCount(vfs)).toBe(0);
  });

  it('returns the array length when the index is well-formed', async () => {
    const vfs = await makeVfs();
    await vfs.mkdir('/sessions', { recursive: true });
    await vfs.writeFile(
      SESSIONS_INDEX_PATH,
      JSON.stringify([{ filename: 'a.md' }, { filename: 'b.md' }, { filename: 'c.md' }])
    );
    expect(await readSessionCount(vfs)).toBe(3);
  });

  it('returns 0 for malformed JSON or non-array shapes', async () => {
    const vfs = await makeVfs();
    await vfs.mkdir('/sessions', { recursive: true });
    await vfs.writeFile(SESSIONS_INDEX_PATH, 'not json');
    expect(await readSessionCount(vfs)).toBe(0);
    await vfs.writeFile(SESSIONS_INDEX_PATH, JSON.stringify({ not: 'array' }));
    expect(await readSessionCount(vfs)).toBe(0);
  });
});

describe('restructureConeMemory', () => {
  beforeEach(() => {
    mockCompleteSimple.mockReset();
  });

  it('preserves the header verbatim and replaces the auto-extracted tail with the LLM output', async () => {
    mockCompleteSimple.mockResolvedValueOnce(
      llmResponse('## Auto-extracted (consolidated)\n\n- merged fact')
    );
    const header = '# Cone memory\n\nUser-authored.\n\n';
    const content =
      header +
      '## Auto-extracted (2024-01-01, compaction)\n\n- a\n\n## Auto-extracted (2024-01-02, new-session)\n\n- b\n';
    const next = await restructureConeMemory({
      currentContent: content,
      budget: 4000,
      model: fakeModel,
      apiKey: 'k',
    });
    expect(next.startsWith(header)).toBe(true);
    expect(next).toContain('## Auto-extracted (consolidated)');
    expect(next).toContain('- merged fact');
    expect(next).not.toContain('- a');
    expect(next).not.toContain('- b');
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
  });

  it('returns the content unchanged when no auto-extracted tail is present', async () => {
    const content = '# Cone memory\n\nNothing auto-extracted yet.\n';
    const next = await restructureConeMemory({
      currentContent: content,
      budget: 4000,
      model: fakeModel,
      apiKey: 'k',
    });
    expect(next).toBe(content);
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('forwards headers and signal to completeSimple', async () => {
    mockCompleteSimple.mockResolvedValueOnce(
      llmResponse('## Auto-extracted (consolidated)\n\n- x')
    );
    const ac = new AbortController();
    await restructureConeMemory({
      currentContent: '## Auto-extracted (2024-01-01)\n\n- y\n',
      budget: 4000,
      model: fakeModel,
      apiKey: 'k',
      headers: { 'X-Session-Id': 'sess-1' },
      signal: ac.signal,
    });
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    const opts = mockCompleteSimple.mock.calls[0][2] as {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      apiKey?: string;
    };
    expect(opts.headers).toEqual({ 'X-Session-Id': 'sess-1' });
    expect(opts.signal).toBe(ac.signal);
    expect(opts.apiKey).toBe('k');
  });

  it('throws when the LLM call returns an error stopReason', async () => {
    mockCompleteSimple.mockResolvedValueOnce(llmError('boom'));
    await expect(
      restructureConeMemory({
        currentContent: '## Auto-extracted (2024-01-01)\n\n- y\n',
        budget: 4000,
        model: fakeModel,
        apiKey: 'k',
      })
    ).rejects.toThrow(/boom/);
  });

  it('throws when the LLM returns no text content', async () => {
    mockCompleteSimple.mockResolvedValueOnce(llmResponse('   '));
    await expect(
      restructureConeMemory({
        currentContent: '## Auto-extracted (2024-01-01)\n\n- y\n',
        budget: 4000,
        model: fakeModel,
        apiKey: 'k',
      })
    ).rejects.toThrow(/empty/i);
  });
});

describe('applyConeMemoryBudget', () => {
  beforeEach(() => {
    mockCompleteSimple.mockReset();
  });

  it('is a no-op when no model/apiKey are provided', async () => {
    const vfs = await makeVfs();
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.writeFile(CONE_MEMORY_PATH, 'x'.repeat(50_000));
    const result = await applyConeMemoryBudget({ vfs });
    expect(result).toEqual({ restructured: false, reason: 'no-llm' });
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('is a no-op when CLAUDE.md is missing', async () => {
    const vfs = await makeVfs();
    const result = await applyConeMemoryBudget({ vfs, model: fakeModel, apiKey: 'k' });
    expect(result).toEqual({ restructured: false, reason: 'missing-file' });
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('skips when current size is under budget * overshoot', async () => {
    const vfs = await makeVfs();
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.writeFile(CONE_MEMORY_PATH, 'short content');
    const result = await applyConeMemoryBudget({ vfs, model: fakeModel, apiKey: 'k' });
    expect(result).toEqual({ restructured: false, reason: 'under-threshold' });
    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('runs restructure and writes back when over threshold', async () => {
    mockCompleteSimple.mockResolvedValueOnce(
      llmResponse('## Auto-extracted (consolidated)\n\n- tight')
    );
    const vfs = await makeVfs();
    await vfs.mkdir('/workspace', { recursive: true });
    const header = '# Memory\n\nUser-authored.\n\n';
    const budget = computeBudget(0);
    const filler = 'x'.repeat(Math.ceil(budget * MEMORY_OVERSHOOT_RATIO) + 200);
    const bloated = header + '## Auto-extracted (2024-01-01, compaction)\n\n- ' + filler + '\n';
    await vfs.writeFile(CONE_MEMORY_PATH, bloated);
    const result = await applyConeMemoryBudget({ vfs, model: fakeModel, apiKey: 'k' });
    expect(result).toEqual({ restructured: true });
    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    const after = (await vfs.readFile(CONE_MEMORY_PATH, { encoding: 'utf-8' })) as string;
    expect(after.startsWith(header)).toBe(true);
    expect(after).toContain('- tight');
    expect(after.length).toBeLessThan(bloated.length);
  });

  it('leaves the file in place when the restructure call throws', async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error('network'));
    const vfs = await makeVfs();
    await vfs.mkdir('/workspace', { recursive: true });
    const budget = computeBudget(0);
    const bloated =
      '# H\n\n## Auto-extracted (2024-01-01)\n\n- ' +
      'x'.repeat(Math.ceil(budget * MEMORY_OVERSHOOT_RATIO) + 200) +
      '\n';
    await vfs.writeFile(CONE_MEMORY_PATH, bloated);
    const result = await applyConeMemoryBudget({ vfs, model: fakeModel, apiKey: 'k' });
    expect(result).toEqual({ restructured: false, reason: 'error' });
    const after = (await vfs.readFile(CONE_MEMORY_PATH, { encoding: 'utf-8' })) as string;
    expect(after).toBe(bloated);
  });
});

describe('Orchestrator.appendConeMemory budget integration', () => {
  let orch: Orchestrator | undefined;
  let priorWindow: unknown;
  let windowWasShimmed = false;

  beforeEach(async () => {
    mockCompleteSimple.mockReset();
    if (typeof (globalThis as any).window === 'undefined') {
      priorWindow = (globalThis as any).window;
      (globalThis as any).window = globalThis;
      windowWasShimmed = true;
    }
    await initDB();
    const existing = await getAllScoops();
    const { deleteScoop } = await import('../../src/scoops/db.js');
    for (const jid of Object.keys(existing)) await deleteScoop(jid);
  });

  afterEach(async () => {
    await orch?.shutdown();
    orch = undefined;
    if (windowWasShimmed) {
      if (priorWindow === undefined) delete (globalThis as any).window;
      else (globalThis as any).window = priorWindow;
      windowWasShimmed = false;
    }
  });

  function noopCallbacks() {
    return {
      onResponse: vi.fn(),
      onResponseDone: vi.fn(),
      onSendMessage: vi.fn(),
      onStatusChange: vi.fn(),
      onError: vi.fn(),
      getBrowserAPI: vi.fn(() => ({}) as any),
    };
  }

  async function newOrch(): Promise<Orchestrator> {
    const container =
      typeof document !== 'undefined'
        ? document.createElement('div')
        : ({ appendChild: () => {} } as unknown as HTMLElement);
    const o = new Orchestrator(container, noopCallbacks() as any);
    await o.init();
    return o;
  }

  it('does NOT call the LLM when no model/apiKey are supplied (freezer-only path)', async () => {
    orch = await newOrch();
    const fs = orch.getSharedFS()!;
    // Force the existing CLAUDE.md WAY over the budget; without LLM creds the
    // append must still succeed and the restructure must be skipped.
    const budget = computeBudget(0);
    const huge = 'y'.repeat(Math.ceil(budget * MEMORY_OVERSHOOT_RATIO) + 1000);
    await fs.writeFile(CONE_MEMORY_PATH, '## Auto-extracted (2024-01-01)\n\n- ' + huge + '\n');

    await orch.appendConeMemory('- fresh bullet', { source: 'new-session' });

    expect(mockCompleteSimple).not.toHaveBeenCalled();
    const after = (await fs.readFile(CONE_MEMORY_PATH, { encoding: 'utf-8' })) as string;
    expect(after).toContain('- fresh bullet');
  });

  it('triggers the LLM restructure when an append pushes the file over budget * overshoot', async () => {
    mockCompleteSimple.mockResolvedValueOnce(
      llmResponse('## Auto-extracted (consolidated)\n\n- merged')
    );
    orch = await newOrch();
    const fs = orch.getSharedFS()!;
    const budget = computeBudget(0);
    const filler = 'y'.repeat(Math.ceil(budget * MEMORY_OVERSHOOT_RATIO) + 200);
    const header = '# Cone memory\n\nUser-authored.\n\n';
    await fs.writeFile(
      CONE_MEMORY_PATH,
      header + '## Auto-extracted (2024-01-01, compaction)\n\n- ' + filler + '\n'
    );

    await orch.appendConeMemory('- new fact', {
      source: 'compaction',
      model: fakeModel,
      apiKey: 'k',
    });

    expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
    const after = (await fs.readFile(CONE_MEMORY_PATH, { encoding: 'utf-8' })) as string;
    expect(after.startsWith(header)).toBe(true);
    expect(after).toContain('- merged');
    expect(after).not.toContain(filler);
  });

  it('does NOT trigger restructure when the post-append size is under threshold', async () => {
    orch = await newOrch();

    await orch.appendConeMemory('- tiny bullet', {
      source: 'compaction',
      model: fakeModel,
      apiKey: 'k',
    });

    expect(mockCompleteSimple).not.toHaveBeenCalled();
  });

  it('serializes concurrent appends so neither block is lost', async () => {
    orch = await newOrch();
    const fs = orch.getSharedFS()!;
    // Start from a clean slate so the heading count below isn't polluted by
    // anything the orchestrator boot may have seeded into the file.
    await fs.writeFile(CONE_MEMORY_PATH, '# Cone memory\n');
    // No LLM creds — pure write-serialization check, no restructure noise.
    await Promise.all([
      orch.appendConeMemory('- alpha bullet', { source: 'compaction' }),
      orch.appendConeMemory('- beta bullet', { source: 'new-session' }),
      orch.appendConeMemory('- gamma bullet', { source: 'compaction' }),
    ]);

    const after = (await fs.readFile(CONE_MEMORY_PATH, { encoding: 'utf-8' })) as string;
    // All three appended bullets must be present; the serialization chain
    // guarantees no read/write race could drop one of them.
    expect(after).toContain('- alpha bullet');
    expect(after).toContain('- beta bullet');
    expect(after).toContain('- gamma bullet');
    // And exactly three Auto-extracted blocks were written.
    const headings = after.match(/^## Auto-extracted/gm) ?? [];
    expect(headings.length).toBe(3);
  });
});

describe('ConeMemoryStore.appendConeMemory readFile narrowing', () => {
  // Regression for issue #1500: the pre-fix bare `catch { }` in
  // appendConeMemory reinterpreted ANY readFile failure as "file doesn't
  // exist yet", then unconditionally wrote `'' + block` — silently discarding
  // accumulated durable memory on any transient VFS fault. Narrowing the
  // catch to `FsError` with `code === 'ENOENT'` re-throws everything else so
  // the outer memoryWriteChain `.catch` logs the real fault and the existing
  // file survives untouched.
  it('preserves existing /workspace/CLAUDE.md when readFile throws a non-ENOENT FsError', async () => {
    const backing = await VirtualFS.create({ backend: 'memory', wipe: true });
    const durable = '## Auto-extracted (2025-01-01, compaction)\n\n- long-standing preference\n';
    await backing.writeFile(CONE_MEMORY_PATH, durable);

    // Wrap only readFile of CONE_MEMORY_PATH so writes still hit the real FS
    // — that way, if the narrowing regresses and the write path runs, this
    // test observes the clobber via a direct read of the durable file.
    const fs = new Proxy(backing, {
      get(target, prop, receiver) {
        if (prop === 'readFile') {
          return async (path: string, opts?: unknown): Promise<string | Uint8Array> => {
            if (path === CONE_MEMORY_PATH) {
              throw new FsError('EIO', 'transient OPFS fault', path);
            }
            return target.readFile(path, opts as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as VirtualFS;

    const store = new ConeMemoryStore({ getSharedFs: () => fs });
    // The narrow catch re-throws the non-ENOENT fault; the caller sees it (the
    // outer memoryWriteChain `.catch` logs it so subsequent appends still run).
    // Before the fix, the bare `catch { }` swallowed this error and the
    // unconditional writeFile below clobbered `durable` with just the new block.
    await expect(
      store.appendConeMemory('- new bullet extracted this round', { source: 'compaction' })
    ).rejects.toBeInstanceOf(FsError);

    // Durable memory is untouched.
    const after = (await backing.readFile(CONE_MEMORY_PATH, { encoding: 'utf-8' })) as string;
    expect(after).toBe(durable);
    await backing.dispose();
  });
});
