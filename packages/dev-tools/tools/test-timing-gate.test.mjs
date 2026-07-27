import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluateTiming, TIMED_PROJECTS } from './ceiling-ratchet-lib.mjs';

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'test-timing-gate.mjs');

const summary = { tests: 40, retried: 1, p95Ms: 900, slowestMs: 4000, slowestTest: 'slow one' };

describe('evaluateTiming', () => {
  it('passes when p95 is under the ceiling', () => {
    expect(evaluateTiming(summary, 1250)).toEqual({ status: 'pass', ceilingMs: 1250, summary });
  });

  it('fails when p95 exceeds the ceiling', () => {
    expect(evaluateTiming(summary, 800).status).toBe('fail');
  });

  it('passes exactly at the ceiling', () => {
    expect(evaluateTiming(summary, 900).status).toBe('pass');
  });

  it('skips instead of failing when there is nothing to gate on', () => {
    expect(evaluateTiming(null, 1250).status).toBe('skip');
    expect(evaluateTiming(summary, undefined).status).toBe('skip');
    expect(evaluateTiming(summary, Number.NaN).status).toBe('skip');
  });
});

describe('test-timing-gate: entry script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timing-gate-'));

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function writeReport(name, durations) {
    const file = join(dir, name);
    writeFileSync(
      file,
      JSON.stringify({
        testResults: [
          {
            name: `/repo/${TIMED_PROJECTS.webapp}a.test.ts`,
            assertionResults: durations.map((duration, i) => ({
              fullName: `t${i}`,
              status: 'passed',
              duration,
              failureMessages: [],
            })),
          },
        ],
      })
    );
    return file;
  }

  function run(args) {
    return spawnSync('node', [scriptPath, ...args], { encoding: 'utf8' });
  }

  it('exits 2 without a project', () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: test-timing-gate.mjs');
  });

  it('exits 2 for a project that is not timed', () => {
    expect(run(['cherry']).status).toBe(2);
  });

  it('skips a missing report rather than failing', () => {
    const result = run(['webapp', join(dir, 'absent.json')]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[skip] webapp timing: no report');
  });

  it('skips a report with no durations for the project', () => {
    const file = join(dir, 'empty.json');
    writeFileSync(file, JSON.stringify({ testResults: [] }));
    const result = run(['webapp', file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[skip]');
  });

  it('passes a fast report against the configured ceiling', () => {
    const result = run(['webapp', writeReport('fast.json', [1, 2, 3, 4, 5])]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/webapp timing ok|\[skip\]/);
  });

  it('fails a report whose p95 blows past the ceiling', () => {
    const result = run(['webapp', writeReport('slow.json', Array(20).fill(600000))]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('tests got slower');
  });
});
