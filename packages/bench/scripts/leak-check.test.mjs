import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  collapse,
  findLeaks,
  MIN_NEEDLE,
  main,
  matchesScrub,
  needlesFor,
  SCRUB_PLACEHOLDER,
  scrubLeaks,
  scrubText,
} from './leak-check.mjs';
import { encryptJson } from './upstream.mjs';

const TASK =
  'Find the cheapest direct flight from Berlin to Lisbon next Tuesday and report the airline and price in euros.';

describe('leak-check', () => {
  it('takes windows of a task, without URLs, and skips very short tasks', () => {
    const n = needlesFor('t1', `${TASK} Start at https://example.com/flights?from=BER`);
    expect(n.length).toBeGreaterThan(1);
    for (const x of n) {
      expect(x.id).toBe('t1');
      expect(x.text.length).toBeGreaterThanOrEqual(MIN_NEEDLE);
      expect(x.text).not.toContain('https://');
    }
    expect(needlesFor('t2', 'Say hi.')).toEqual([]);
    expect(needlesFor('t3', null)).toEqual([]);
    const mid = 'a'.repeat(40);
    expect(needlesFor('t4', mid)).toEqual([{ id: 't4', text: mid }]);
    expect(collapse(undefined)).toBe('');
  });

  it('finds a quote of any part of a task, whatever its whitespace or case', () => {
    const needles = needlesFor('t1', TASK);
    const quoted = `error: ${TASK.slice(30, 100).toUpperCase().replace(/ /g, '\n  ')}`;
    expect(findLeaks([{ path: 'a.log', text: quoted }], needles)).toEqual([
      { path: 'a.log', id: 't1' },
    ]);
    expect(findLeaks([{ path: 'b.json', text: '{"task_id":"t1","score":0.5}' }], needles)).toEqual(
      []
    );
    expect(collapse('  A\n B ')).toBe('a b');
  });

  it('passes an out dir whose task text is only in encrypted traces, and fails a plaintext copy', async () => {
    const out = mkdtempSync(join(tmpdir(), 'leak-'));
    const canary = 'CANARY-7f3a-the-arm-driver-wrote-this-into-its-files';
    const set = { encrypted: true, tasks: [{ id: 'bu2-x', task: `${TASK} ${canary}` }] };
    mkdirSync(join(out, 'records/BU_Bench_V2/builtin+arm/m'), { recursive: true });
    writeFileSync(
      join(out, 'records/BU_Bench_V2/builtin+arm/m/bu2-x-r1.json'),
      JSON.stringify({ task_id: 'bu2-x', config: { arm: 'intent-budget' }, score: 0.4 })
    );
    mkdirSync(join(out, 'results/BU_Bench_V2/builtin+arm/m'), { recursive: true });
    const trace = {
      task: set.tasks[0],
      result: { arm: { files: [{ path: '/tmp/intent-arm/r/transcript.md', text: canary }] } },
    };
    writeFileSync(
      join(out, 'results/BU_Bench_V2/builtin+arm/m/bu2-x-r1.json.enc'),
      encryptJson(trace, 'BU_Bench_V2')
    );
    const deps = { loadSet: vi.fn(async () => set) };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--out', out, '--set', 'bu-v2', '--canary', canary], deps)).toBe(0);
    writeFileSync(join(out, 'transcript.md'), `goal: ${canary}`);
    expect(await main(['--out', out, '--set', 'bu-v2', '--canary', canary], deps)).toBe(1);
    const lines = err.mock.calls.map((c) => c[0]).join('\n');
    expect(lines).toContain('transcript.md quotes task');
    expect(lines).not.toContain(canary);
    err.mockRestore();
  });
});

describe('leak-check main', () => {
  it('needs --out, checks only encrypted sets, and reads only plaintext text files', async () => {
    await expect(main([], {})).rejects.toThrow(/--out/);
    const out = mkdtempSync(join(tmpdir(), 'leak-'));
    mkdirSync(join(out, 'traces/S'), { recursive: true });
    writeFileSync(join(out, 'traces/S/smoke-001-r1.json'), `{"task":"${TASK}"}`);
    writeFileSync(join(out, 'shot.png'), TASK);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const publicSet = { encrypted: false, tasks: [{ id: 'smoke-001', task: TASK }] };
    expect(await main(['--out', out, '--set', 'smoke'], { loadSet: async () => publicSet })).toBe(
      0
    );
    const secret = { ...publicSet, encrypted: true };
    expect(await main(['--out', out, '--set', 'bu-v2'], { loadSet: async () => secret })).toBe(1);
    expect(err.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /1 plaintext files, 3 needles, 1 leak/
    );
    err.mockRestore();
  });

  it('scrubs memory/CLAUDE.md quotes and passes; still fails non-memory leaks', async () => {
    const out = mkdtempSync(join(tmpdir(), 'leak-'));
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(
      join(out, 'memory/CLAUDE.md'),
      `# Memory\n\nKeep this.\n\n## Auto-extracted\n\n- Note: ${TASK}\n\nAlso keep.\n`
    );
    const set = { encrypted: true, tasks: [{ id: 'bu2-166', task: TASK }] };
    const deps = { loadSet: vi.fn(async () => set) };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--out', out, '--set', 'bu-v2', '--scrub', 'memory/'], deps)).toBe(0);
    const mem = readFileSync(join(out, 'memory/CLAUDE.md'), 'utf8');
    expect(mem).toContain('Keep this.');
    expect(mem).toContain('Also keep.');
    expect(mem).toContain(SCRUB_PLACEHOLDER);
    expect(mem.toLowerCase()).not.toContain('cheapest direct flight');
    expect(err.mock.calls.map((c) => c[0]).join('\n')).toMatch(/scrubbed/);

    writeFileSync(join(out, 'oops.log'), `goal: ${TASK}`);
    expect(await main(['--out', out, '--set', 'bu-v2', '--scrub', 'memory/'], deps)).toBe(1);
    expect(err.mock.calls.map((c) => c[0]).join('\n')).toContain('oops.log quotes task');
    err.mockRestore();
  });
});

describe('scrub helpers', () => {
  it('matches memory/ prefixes and drops leaking paragraphs', () => {
    expect(matchesScrub('memory/CLAUDE.md', ['memory/'])).toBe(true);
    expect(matchesScrub('memory/CLAUDE.md', ['memory/**'])).toBe(true);
    expect(matchesScrub('memory/CLAUDE.md', ['memory'])).toBe(true);
    expect(matchesScrub('memory', ['memory/'])).toBe(true);
    expect(matchesScrub('results/x.json', ['memory/'])).toBe(false);
    expect(matchesScrub('memory/CLAUDE.md', ['', null])).toBe(false);
    expect(matchesScrub('memory/CLAUDE.md', [])).toBe(false);
    const needles = needlesFor('t1', TASK);
    const { text, removed } = scrubText(`Safe.\n\nQuoted: ${TASK}\n\nSafe again.`, needles);
    expect(removed).toBe(1);
    expect(text).toContain('Safe.');
    expect(text).toContain('Safe again.');
    expect(text).toContain(SCRUB_PLACEHOLDER);
    expect(findLeaks([{ path: 'm', text }], needles)).toEqual([]);
    expect(scrubText('unchanged', []).removed).toBe(0);
    expect(scrubText(null, needles).text).toBe('');
  });

  it('skips a scrubbable path that no longer contains a needle', () => {
    const out = mkdtempSync(join(tmpdir(), 'leak-skip-'));
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(join(out, 'memory/CLAUDE.md'), '# Memory\n\nClean notes only.\n');
    const needles = needlesFor('t1', TASK);
    const r = scrubLeaks(out, [{ path: 'memory/CLAUDE.md', id: 't1' }], needles, ['memory/']);
    expect(r).toEqual({ files: 0, removed: 0 });
    expect(readFileSync(join(out, 'memory/CLAUDE.md'), 'utf8')).toContain('Clean notes only.');
  });

  it('does not scrub memory when a non-memory leak is also present', async () => {
    const out = mkdtempSync(join(tmpdir(), 'leak-hard-'));
    mkdirSync(join(out, 'memory'), { recursive: true });
    writeFileSync(join(out, 'memory/CLAUDE.md'), `# Memory\n\n- ${TASK}\n`);
    writeFileSync(join(out, 'oops.log'), `goal: ${TASK}`);
    const set = { encrypted: true, tasks: [{ id: 'bu2-x', task: TASK }] };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await main(['--out', out, '--set', 'bu-v2', '--scrub', 'memory/'], {
        loadSet: async () => set,
      })
    ).toBe(1);
    // Memory must remain unscrubbed when a hard leak blocks the scrub gate.
    expect(readFileSync(join(out, 'memory/CLAUDE.md'), 'utf8')).toContain('cheapest direct flight');
    expect(err.mock.calls.map((c) => c[0]).join('\n')).toContain('oops.log quotes task');
    err.mockRestore();
  });

  it('stubs memory when a needle straddles a blank-line boundary', async () => {
    // Canary is one full needle (not windowed). Split on an existing space so
    // collapse() still matches the whole file, but no single paragraph contains
    // the needle — paragraph scrub leaves the leak; stub must fire.
    const canary = 'CANARY-span-abcdefghijklmnop and then more marker text here!!';
    const spaceAt = canary.indexOf(' ');
    const left = canary.slice(0, spaceAt);
    const right = canary.slice(spaceAt + 1);
    const out = mkdtempSync(join(tmpdir(), 'leak-span-'));
    mkdirSync(join(out, 'memory'), { recursive: true });
    const spanned = `# Memory\n\nKeep prior notes.\n\n${left}\n\n${right}\n\nAlso keep.\n`;
    writeFileSync(join(out, 'memory/CLAUDE.md'), spanned);
    const needles = [{ id: 'canary', text: collapse(canary) }];
    expect(scrubText(spanned, needles).removed).toBe(0);
    expect(findLeaks([{ path: 'memory/CLAUDE.md', text: spanned }], needles)).toEqual([
      { path: 'memory/CLAUDE.md', id: 'canary' },
    ]);

    const r = scrubLeaks(out, [{ path: 'memory/CLAUDE.md', id: 'canary' }], needles, ['memory/']);
    expect(r.files).toBe(1);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    const mem = readFileSync(join(out, 'memory/CLAUDE.md'), 'utf8');
    expect(mem.trim()).toBe(SCRUB_PLACEHOLDER);
    expect(findLeaks([{ path: 'memory/CLAUDE.md', text: mem }], needles)).toEqual([]);

    // End-to-end: main with --scrub + --canary also stubs and exits 0.
    writeFileSync(join(out, 'memory/CLAUDE.md'), `# Memory\n\n${left}\n\n${right}\n`);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await main(['--out', out, '--scrub', 'memory/', '--canary', canary], {
        loadSet: async () => ({ encrypted: false, tasks: [] }),
      })
    ).toBe(0);
    expect(readFileSync(join(out, 'memory/CLAUDE.md'), 'utf8').trim()).toBe(SCRUB_PLACEHOLDER);
    expect(err.mock.calls.map((c) => c[0]).join('\n')).toMatch(/scrubbed/);
    err.mockRestore();
  });
});
