import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { backfillTools, backfillVersions, main, taskVersions } from './backfill-tools.mjs';
import { recordPath, tracePath } from './run.mjs';
import { decryptSetFile, encryptJson } from './upstream.mjs';

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const bareTranscript = {
  conversations: [
    { kind: 'cone', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }] },
  ],
};
const record = (benchmark, task) => ({
  benchmark,
  task_id: task,
  repeat: 1,
  config: { harness: 'h', model: 'm', skills: 'none' },
  metrics: { duration: 3 },
});

describe('backfillTools', () => {
  it('counts tool use into records and traces, encrypted or not, and leaves no transcript unknown', () => {
    const out = mkdtempSync(join(tmpdir(), 'bench-backfill-'));
    const own = record('Own', 'a');
    write(recordPath(out, 'Own', 'none', 'm', 'a', 1), JSON.stringify(own));
    write(
      tracePath(out, 'Own', 'none', 'm', 'a', 1, false),
      JSON.stringify({ record: own, result: { transcript: bareTranscript } })
    );
    const up = record('BU_Bench_V1', 'u');
    write(recordPath(out, 'BU_Bench_V1', 'none', 'm', 'u', 1), JSON.stringify(up));
    write(
      tracePath(out, 'BU_Bench_V1', 'none', 'm', 'u', 1, true),
      encryptJson(
        { record: up, task: { task: 'secret' }, result: { transcript: null } },
        'BU_Bench_V1'
      )
    );
    const lone = record('Own', 'b');
    write(
      tracePath(out, 'Own', 'none', 'm', 'b', 1, false),
      JSON.stringify({ record: lone, result: { transcript: bareTranscript } })
    );

    expect(backfillTools(out)).toEqual({ updated: 3, unknown: 1 });
    const ownRecord = JSON.parse(readFileSync(recordPath(out, 'Own', 'none', 'm', 'a', 1), 'utf8'));
    expect(ownRecord.metrics).toMatchObject({
      duration: 3,
      tool_calls: 0,
      answered_without_tools: true,
    });
    const upRecord = JSON.parse(
      readFileSync(recordPath(out, 'BU_Bench_V1', 'none', 'm', 'u', 1), 'utf8')
    );
    expect(upRecord.metrics).toMatchObject({ tool_calls: null, answered_without_tools: null });
    const upTrace = readFileSync(tracePath(out, 'BU_Bench_V1', 'none', 'm', 'u', 1, true), 'utf8');
    expect(upTrace).not.toContain('secret');
    expect(decryptSetFile(upTrace, 'BU_Bench_V1').record.metrics.tool_calls).toBeNull();
    const ownTrace = JSON.parse(
      readFileSync(tracePath(out, 'Own', 'none', 'm', 'b', 1, false), 'utf8')
    );
    expect(ownTrace.record.metrics.answered_without_tools).toBe(true);
  });

  it('logs what it did, and needs an out dir', () => {
    const out = mkdtempSync(join(tmpdir(), 'bench-backfill-'));
    const log = vi.fn();
    expect(main(['--out', out], { log })).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'backfilled 0 run(s); 0 without a transcript to count (left unknown)'
    );
    expect(log).toHaveBeenCalledWith(
      'stamped the SLICC version on 0 record(s); 0 not found in events.jsonl'
    );
    expect(() => main([])).toThrow(/--out/);
  });
});

describe('backfillVersions', () => {
  const EVENTS = [
    { type: 'start', slicc_version: '1.0.0' },
    { type: 'leader-ready', lane: 1, generation: 0, slicc_version: '1.0.0' },
    { type: 'task', lane: 0, task_id: 'a', model: 'm', skills: 'none' },
    { type: 'leader-ready', lane: 1, generation: 1, slicc_version: '1.0.1' },
    { type: 'task', lane: 1, task_id: 'b', model: 'm', skills: 'none' },
    { type: 'task', task_id: 'c', model: 'm', skills: 'none' },
  ]
    .map((e) => JSON.stringify(e))
    .join('\n');

  it('maps each task to the last leader boot on its lane', () => {
    const v = taskVersions(`${EVENTS}\nnot json\n\n`);
    expect(v.get('a|m|none')).toBe('1.0.0');
    expect(v.get('b|m|none')).toBe('1.0.1');
    expect(v.get('c|m|none')).toBe('1.0.0');
    // A lane that never reported a boot has no version to give.
    expect(
      taskVersions('{"type":"task","lane":3,"task_id":"x","model":"m","skills":"s"}').get('x|m|s')
    ).toBeNull();
  });

  it('stamps records that lack a version, leaves the rest, and needs a journal', () => {
    const out = mkdtempSync(join(tmpdir(), 'bench-versions-'));
    expect(backfillVersions(out)).toEqual({ stamped: 0, unknown: 0 });
    write(join(out, 'events.jsonl'), EVENTS);
    expect(backfillVersions(out)).toEqual({ stamped: 0, unknown: 0 });
    write(recordPath(out, 'Own', 'none', 'm', 'b', 1), JSON.stringify(record('Own', 'b')));
    const kept = { ...record('Own', 'a'), leader: { lane: 0, slicc_version: '9.9' } };
    write(recordPath(out, 'Own', 'none', 'm', 'a', 1), JSON.stringify(kept));
    write(recordPath(out, 'Own', 'none', 'm', 'z', 1), JSON.stringify(record('Own', 'z')));
    expect(backfillVersions(out)).toEqual({ stamped: 1, unknown: 1 });
    const read = (t) => JSON.parse(readFileSync(recordPath(out, 'Own', 'none', 'm', t, 1), 'utf8'));
    expect(read('b').leader).toEqual({ slicc_version: '1.0.1' });
    expect(read('a').leader.slicc_version).toBe('9.9');
    expect(read('z').leader).toBeUndefined();
  });
});
