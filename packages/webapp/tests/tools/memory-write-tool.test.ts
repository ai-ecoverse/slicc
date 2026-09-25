import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeBudget } from '../../src/base/memory-budget.js';
import { VirtualFS } from '../../src/fs/index.js';
import {
  applyMemoryEdits,
  describeBudgetPosition,
  memoryWriteVerdict,
} from '../../src/tools/memory-write-execute.js';
import { createMemoryWriteTool } from '../../src/tools/memory-write-tool.js';
import type { ToolDefinition } from '../../src/tools/types.js';

const MEMORY = '/workspace/CLAUDE.md';

const BUDGET = computeBudget(0);

describe('memoryWriteVerdict', () => {
  it('lets any write land while the result stays inside the budget', () => {
    expect(memoryWriteVerdict(0, BUDGET, BUDGET)).toEqual({ allowed: true });
    expect(memoryWriteVerdict(BUDGET + 500, BUDGET, BUDGET)).toEqual({ allowed: true });
  });

  it('refuses growth, and standing still, while over budget', () => {
    const grown = memoryWriteVerdict(BUDGET + 100, BUDGET + 200, BUDGET);
    expect(grown.allowed).toBe(false);
    if (!grown.allowed) expect(grown.reason).toMatch(/grow from \d+ to \d+ chars, 200 over/);
    const same = memoryWriteVerdict(BUDGET + 100, BUDGET + 100, BUDGET);
    expect(same.allowed).toBe(false);
    if (!same.allowed) expect(same.reason).toMatch(/stay at \d+ chars/);
  });

  it('refuses a write that would cross the budget upward', () => {
    expect(memoryWriteVerdict(BUDGET - 10, BUDGET + 1, BUDGET).allowed).toBe(false);
  });

  it('lets an over-budget file shrink even while still over', () => {
    expect(memoryWriteVerdict(BUDGET + 500, BUDGET + 400, BUDGET)).toEqual({ allowed: true });
  });
});

describe('describeBudgetPosition', () => {
  it('reports room under budget and the overage above it', () => {
    expect(describeBudgetPosition(100, 150)).toBe('100 chars, 50 under the 150-char budget.');
    expect(describeBudgetPosition(200, 150)).toBe(
      '200 chars, 50 OVER the 150-char budget — the next write must be smaller than 200 chars.'
    );
  });
});

describe('applyMemoryEdits', () => {
  it('applies unique exact replacements in order', () => {
    expect(applyMemoryEdits('alpha beta gamma', [{ oldText: 'beta', newText: 'BETA' }])).toEqual({
      ok: true,
      content: 'alpha BETA gamma',
    });
  });

  it('rejects a miss, an ambiguous match, and an empty needle', () => {
    expect(applyMemoryEdits('alpha beta', [{ oldText: 'zeta', newText: 'x' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found'),
    });
    expect(applyMemoryEdits('a-a', [{ oldText: 'a', newText: 'x' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('more than once'),
    });
    expect(applyMemoryEdits('a', [{ oldText: '', newText: 'x' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('must not be empty'),
    });
  });
});

describe('memory_write tool', () => {
  let fs: VirtualFS;
  let tool: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-memory-write-${dbCounter++}`, wipe: true });
    tool = createMemoryWriteTool(fs, { readSessionCount: async () => 0 });
  });

  it('is named memory_write and asks for a path plus content or edits', () => {
    expect(tool.name).toBe('memory_write');
    expect(tool.inputSchema.required).toEqual(['path']);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['path', 'content', 'edits']);
  });

  it('writes a memory file under budget and reports the remaining room', async () => {
    const content = '# Memory\n\n- human: prefers terse answers\n';
    const result = await tool.execute({ path: MEMORY, content });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      `Wrote ${MEMORY}: ${content.length} chars, ${BUDGET - content.length} under the ${BUDGET}-char budget.`
    );
    expect(await fs.readFile(MEMORY, { encoding: 'utf-8' })).toBe(content);
  });

  it('refuses a write that would grow an over-budget file, leaving it untouched', async () => {
    const oversized = 'x'.repeat(BUDGET + 100);
    await fs.writeFile(MEMORY, oversized);
    const result = await tool.execute({ path: MEMORY, content: `${oversized}more` });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Rejected: the file would grow from \d+ to \d+ chars/);
    expect(await fs.readFile(MEMORY, { encoding: 'utf-8' })).toBe(oversized);
  });

  it('lets an over-budget file shrink and reports the overage that remains', async () => {
    await fs.writeFile(MEMORY, 'x'.repeat(BUDGET + 500));
    const smaller = 'x'.repeat(BUDGET + 100);
    const result = await tool.execute({ path: MEMORY, content: smaller });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      `Wrote ${MEMORY}: ${smaller.length} chars, 100 OVER the ${BUDGET}-char budget — the next write must be smaller than ${smaller.length} chars.`
    );
  });

  it('refuses to cross the budget upward from an under-budget file', async () => {
    await fs.writeFile(MEMORY, 'x'.repeat(BUDGET - 10));
    const result = await tool.execute({ path: MEMORY, content: 'x'.repeat(BUDGET + 1) });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('1 over');
  });

  it('applies exact edits in place under the same rule', async () => {
    await fs.writeFile(MEMORY, '# Memory\n\n- fact one\n- fact two\n');
    const result = await tool.execute({
      path: MEMORY,
      edits: [{ oldText: '- fact two', newText: '- fact two (verified 2026-09-16)' }],
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toMatch(/under the \d+-char budget/);
    expect(await fs.readFile(MEMORY, { encoding: 'utf-8' })).toBe(
      '# Memory\n\n- fact one\n- fact two (verified 2026-09-16)\n'
    );
  });

  it('rejects edits that miss, and edits on a file that does not exist yet', async () => {
    await fs.writeFile(MEMORY, 'alpha');
    const miss = await tool.execute({ path: MEMORY, edits: [{ oldText: 'zeta', newText: 'x' }] });
    expect(miss.isError).toBe(true);
    expect(miss.content).toContain('not found');
    const missing = await tool.execute({
      path: '/shared/CLAUDE.md',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('does not exist yet');
  });

  it('accepts every memory-file shape and refuses ordinary files', async () => {
    for (const path of [
      '/workspace/CLAUDE.md',
      '/shared/CLAUDE.md',
      '/cones/cone-helix/CLAUDE.md',
      '/scoops/helper/CLAUDE.md',
      '/sessions/.curation/dream-2026-09-16-cone-helix.md/draft.md',
    ]) {
      const result = await tool.execute({ path, content: 'ok\n' });
      expect(result.isError, path).toBeUndefined();
    }
    const repoDoc = await tool.execute({ path: '/workspace/repo/CLAUDE.md', content: 'x' });
    expect(repoDoc.isError).toBe(true);
    expect(repoDoc.content).toContain('not a memory file');
  });

  it('insists on exactly one of content and edits', async () => {
    const neither = await tool.execute({ path: MEMORY });
    expect(neither.isError).toBe(true);
    const both = await tool.execute({ path: MEMORY, content: 'x', edits: [] });
    expect(both.isError).toBe(true);
    expect(both.content).toContain('exactly one');
    const noPath = await tool.execute({ content: 'x' });
    expect(noPath.isError).toBe(true);
  });

  it('reads the session count per call so the budget tracks new archives', async () => {
    let sessions = 0;
    const live = createMemoryWriteTool(fs, { readSessionCount: async () => sessions });
    const first = await live.execute({ path: MEMORY, content: 'x' });
    expect(first.content).toContain(`${computeBudget(0)}-char budget`);
    sessions = 30;
    const second = await live.execute({ path: MEMORY, content: 'y' });
    expect(second.content).toContain(`${computeBudget(30)}-char budget`);
  });

  describe('blind paths', () => {
    const DRAFT = '/sessions/.curation/dream-2026-09-24-cone.md/draft.md';
    const STORED =
      '# Memory\n\n- process: www.printful.com is in /etc/llmstxtignore (2026-09-18)\n';
    let blind: string[];
    let guarded: ToolDefinition;

    beforeEach(async () => {
      blind = [];
      await fs.mkdir('/sessions/.curation/dream-2026-09-24-cone.md', { recursive: true });
      await fs.writeFile(DRAFT, STORED);
      guarded = createMemoryWriteTool(fs, {
        readSessionCount: async () => 0,
        blindPaths: () => blind,
      });
    });

    it('refuses a new line that records a probed path as absent, leaving the file untouched', async () => {
      blind = ['/etc/llmstxtignore'];
      const result = await guarded.execute({
        path: DRAFT,
        edits: [
          {
            oldText: '- process: www.printful.com is in /etc/llmstxtignore (2026-09-18)',
            newText:
              '- not: www.printful.com is in the ignore list — why: /etc/llmstxtignore no longer exists on 6.169.0 (2026-09-24)',
          },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('/etc/llmstxtignore is outside this pass');
      expect(result.content).toContain('UNKNOWN, never absent');
      expect(await fs.readFile(DRAFT, { encoding: 'utf-8' })).toBe(STORED);
    });

    it('applies the same rule to a whole-file rewrite', async () => {
      blind = ['/etc/MEMORY.md'];
      const result = await guarded.execute({
        path: DRAFT,
        content: `${STORED}- process: the contracts live in /shared/, not /etc/MEMORY.md (2026-09-24)\n`,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain('/etc/MEMORY.md');
    });

    it('lets the stored claim stand, and a neutral note about the blind path through', async () => {
      blind = ['/etc/llmstxtignore'];
      const result = await guarded.execute({
        path: DRAFT,
        content: `${STORED}- process: /etc/llmstxtignore is outside this pass's visiblePaths; unverified here (2026-09-24)\n`,
      });
      expect(result.isError).toBeUndefined();
    });

    it('does not fire for a path the pass never probed, nor without a ledger', async () => {
      blind = ['/etc/MEMORY.md'];
      const unrelated = await guarded.execute({
        path: DRAFT,
        content: `${STORED}- pitfall: /workspace/repo/dist is missing after a clean checkout\n`,
      });
      expect(unrelated.isError).toBeUndefined();
      const noLedger = await tool.execute({
        path: DRAFT,
        content: `${STORED}- process: /etc/llmstxtignore no longer exists\n`,
      });
      expect(noLedger.isError).toBeUndefined();
    });
  });
});
