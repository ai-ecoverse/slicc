import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { collapse, findLeaks, MIN_NEEDLE, main, needlesFor } from './leak-check.mjs';
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
});
