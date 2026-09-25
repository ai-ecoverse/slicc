import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main, mergeShards } from './merge.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'bench-merge-'));
const put = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
};
const record = (taskId, extra = {}) => ({
  benchmark: 'B',
  task_id: taskId,
  repeat: 1,
  config: { harness: 'h', model: 'm', skills: 'none' },
  score: 1,
  outcome: 'pass',
  verdict: true,
  metrics: { duration: 10, cost: 0.1 },
  ...extra,
});

function shard(root, name, { tasks, start, extra = {} }) {
  const dir = join(root, name);
  for (const t of tasks) {
    put(join(dir, 'records/B/none/m', `${t}-r1.json`), record(t, extra[t]));
    put(join(dir, 'traces/B/none/m', `${t}-r1.json`), { t });
  }
  put(join(dir, 'events.jsonl'), `{"event":"start","shard":"${name}"}\n`);
  put(join(dir, 'diagnostics/dial.txt'), 'x');
  put(join(dir, 'report.md'), 'stale');
  if (start) put(join(dir, 'report.json'), { run_start: start });
  return dir;
}

describe('mergeShards', () => {
  it('combines records, traces and journals, and rebuilds the report', () => {
    const root = tmp();
    const out = join(root, 'out');
    const a = shard(root, 'bench-1', { tasks: ['t1', 't3'], start: '2026-09-25T10:00:05Z' });
    const b = shard(root, 'bench-2', { tasks: ['t2'], start: '2026-09-25T10:00:01Z' });
    const got = mergeShards([a, b], out);
    expect(got).toEqual({
      shards: 2,
      records: 3,
      runStart: '2026-09-25T10:00:01Z',
      unreadable: [],
    });
    expect(readFileSync(join(out, 'shards/bench-2/events.jsonl'), 'utf8')).toContain('bench-2');
    expect(readFileSync(join(out, 'shards/bench-1/diagnostics/dial.txt'), 'utf8')).toBe('x');
    expect(JSON.parse(readFileSync(join(out, 'traces/B/none/m/t2-r1.json'), 'utf8'))).toEqual({
      t: 't2',
    });
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(report.run_start).toBe('2026-09-25T10:00:01Z');
    expect(readFileSync(join(out, 'report.md'), 'utf8')).not.toBe('stale');
    expect(readFileSync(join(out, 'report.html'), 'utf8')).toMatch(/^<!doctype html>/);
  });

  it('keeps the judged copy of a record two shards both hold', () => {
    const root = tmp();
    const out = join(root, 'out');
    const errored = { t1: { score: undefined, error: 'leader went away' } };
    const a = shard(root, 'x/bench-1', { tasks: ['t1', 't2'], extra: errored });
    const b = shard(root, 'y/bench-1', { tasks: ['t1'] });
    const c = shard(root, 'z/bench-1', { tasks: ['t2'], extra: { t2: { score: 0.2 } } });
    put(join(c, 'records/B/none/m/broken-r1.json'), '{');
    put(join(a, 'records/B/none/m/broken-r1.json'), '{');
    expect(mergeShards([a, b, c], out).unreadable).toEqual([
      'bench-1/records/B/none/m/broken-r1.json',
      'bench-1/records/B/none/m/broken-r1.json',
    ]);
    const read = (t) =>
      JSON.parse(readFileSync(join(out, 'records/B/none/m', `${t}-r1.json`), 'utf8'));
    expect(read('t1')).toMatchObject({ score: 1 });
    expect(read('t1').error).toBeUndefined();
    expect(read('t2')).toMatchObject({ score: 1 });
    expect(readFileSync(join(out, 'shards/bench-1+/events.jsonl'), 'utf8')).toContain('y/bench-1');
    expect(readFileSync(join(out, 'shards/bench-1++/events.jsonl'), 'utf8')).toContain('z/bench-1');
  });
});

describe('main', () => {
  it('merges the shard dirs it is given, skipping missing ones', () => {
    const root = tmp();
    const a = shard(root, 'bench-1', { tasks: ['t1'] });
    put(join(a, 'records/B/none/m/cut-r1.json'), '{"benchmark"');
    const log = vi.fn();
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    expect(main(['--out', join(root, 'out'), a, join(root, 'nope')], { log })).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^merged 1 shard\(s\): 1 record\(s\), run start \d{4}-/)
    );
    expect(log).toHaveBeenCalledWith(
      'left out bench-1/records/B/none/m/cut-r1.json: not valid JSON'
    );
    expect(() => main([a])).toThrow(/--out/);
    expect(() => main(['--out', join(root, 'o2'), join(root, 'nope')])).toThrow(/no shard/);
    vi.unstubAllEnvs();
  });
});
