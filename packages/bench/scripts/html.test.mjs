import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cellState, main, readRecordsDir, reportHtml, shortId, tradeoff } from './html.mjs';

const record = (model, skills, taskId, extra = {}) => ({
  benchmark: 'B',
  task_id: taskId,
  repeat: 1,
  config: { harness: 'h', model, skills },
  score: 1,
  outcome: 'pass',
  verdict: true,
  metrics: { duration: 20, cost: 0.02 },
  judge: { model: 'j' },
  ...extra,
});

const RECORDS = [
  record('opus', 'builtin', 't1'),
  record('opus', 'none', 't1', { score: 0.8, outcome: 'partial', verdict: false }),
  record('sonnet', 'builtin', 't1', { score: 0, outcome: 'fail', verdict: false }),
  record('sonnet', 'none', 't1', {
    score: undefined,
    outcome: undefined,
    error: 'judge output is invalid',
    error_stage: 'judge',
  }),
  record('opus', 'builtin', 't2-long-uuid-0000-0000'),
  record('opus', 'none', 't2-long-uuid-0000-0000', {
    score: undefined,
    outcome: undefined,
    error: 'leader went away',
    error_stage: 'run',
    metrics: undefined,
  }),
];

describe('cells', () => {
  it('names each run by outcome, error or not judged', () => {
    expect(cellState(undefined)).toBe('missing');
    expect(cellState(RECORDS[0])).toBe('pass');
    expect(cellState(RECORDS[1])).toBe('partial');
    expect(cellState(RECORDS[3])).toBe('unjudged');
    expect(cellState(RECORDS[5])).toBe('error');
    expect(cellState({ score: 0.5 })).toBe('partial');
    expect(cellState({ score: 0 })).toBe('fail');
    expect(cellState({ score: 1 })).toBe('pass');
  });

  it('shortens only long ids', () => {
    expect(shortId('smoke-001')).toBe('smoke-001');
    expect(shortId('5a0c2db3-a687-4dfe-b7e7-22d01eae23f6')).toBe('5a0c2db3');
  });
});

describe('tradeoff', () => {
  it('says what a paired time or cost difference means', () => {
    expect(tradeoff(-71.2, -0.26, 'time')).toBe(
      '<span class="up">26% faster</span> <span class="muted">(71 s)</span>'
    );
    expect(tradeoff(5, 0.1, 'time')).toBe('10% slower <span class="muted">(5 s)</span>');
    expect(tradeoff(-0.035, null, 'cost')).toBe('<span class="up">$0.035 cheaper</span>');
    expect(tradeoff(0.2, 0.5, 'cost')).toBe(
      '50% more expensive <span class="muted">($0.200)</span>'
    );
    expect(tradeoff(0.0001, 0.01, 'cost')).toBe('about the same');
    expect(tradeoff(null, null, 'time')).toBe('–');
  });
});

describe('reportHtml', () => {
  it('renders cards, table, deltas, a matrix and a scatter', () => {
    const html = reportHtml(RECORDS, { title: 'T', generated: 'now' });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<h2>B <small>6 runs, 2 tasks</small></h2>');
    expect(html.match(/<article class="card">/g)).toHaveLength(4);
    expect(html).toContain('Skills lift <small>relative to none; paired by task');
    const order = [
      '<h3>Ranking',
      'Score vs. cost per task',
      'Skills lift',
      '<h3>Configurations</h3>',
    ];
    const at = order.map((s) => html.indexOf(s));
    expect(at.every((v, i) => v > 0 && (i === 0 || v > at[i - 1]))).toBe(true);
    expect(html).toContain('class="bar-value">100</text>');
    expect(html).toContain('<svg viewBox="0 0 760 380" class="value"');
    expect(html.match(/<article class="card lift">/g)).toHaveLength(2);
    expect(html).toContain('<p class="big up">+25.0%<small> score lift</small></p>');
    expect(html).toContain('<svg class="dumbbell up"');
    expect(html).toContain('<p class="pair">none 0.80 → builtin 1.00 (+0.20)</p>');
    expect(html).toContain('<dd>1 <span class="chip warn">small sample</span></dd>');
    expect(html.indexOf('Skills lift')).toBeLessThan(html.indexOf('<h3>Configurations</h3>'));
    expect(html).toContain('What models change (paired, against opus)');
    expect(html).toContain('<td class="cell pass"');
    expect(html).toContain('<td class="cell error" title="error · error: leader went away');
    expect(html).toContain('<td class="cell unjudged"');
    expect(html).toContain('<code>t2-long-</code>');
    expect(html).toContain('<td class="cell missing" title="not run">');
    // Per-run dots (r=5) in the time-and-cost scatter; the value chart's are r=7.
    expect(html.match(/<circle [^>]*r="5"[^>]*><title>/g)).toHaveLength(5);
    expect(html).toContain('Generated now.');
    const t1 = html.indexOf('title="t1"');
    expect(t1).toBeGreaterThan(-1);
    expect(t1).toBeLessThan(html.indexOf('title="t2-long-uuid-0000-0000"'));
  });

  it('escapes everything it prints', () => {
    const html = reportHtml([record('<script>x</script>', 'a"b', '<t>')]);
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a&quot;b');
  });

  it('labels repeats, and says when there is nothing to show', () => {
    const repeated = reportHtml([record('m', 's', 't'), { ...record('m', 's', 't'), repeat: 2 }]);
    expect(repeated).toContain('m · s r2</th>');
    expect(reportHtml([])).toContain('No runs yet.');
    expect(reportHtml([])).toContain('Judge: none yet.');
    expect(reportHtml([RECORDS[5]])).toContain('No finished runs with a measured time and cost.');
    const unknownCost = record('m', 's', 't', { metrics: { duration: 20, cost: null } });
    expect(reportHtml([unknownCost])).toContain('No finished runs with a measured time and cost.');
  });
});

describe('main', () => {
  it('renders a records directory to a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-html-'));
    mkdirSync(join(dir, 'records/B/builtin/opus'), { recursive: true });
    writeFileSync(join(dir, 'records/B/builtin/opus/t1-r1.json'), JSON.stringify(RECORDS[0]));
    writeFileSync(join(dir, 'records/B/builtin/opus/notes.txt'), 'ignored');
    expect(readRecordsDir(dir)).toHaveLength(1);
    expect(readRecordsDir(join(dir, 'missing'))).toEqual([]);
    const log = vi.fn();
    const out = join(dir, 'r.html');
    expect(main(['--records', dir, '--out', out, '--title', 'Mine'], { log })).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('<title>Mine</title>');
    expect(log).toHaveBeenCalledWith(`wrote ${out} from 1 record(s)`);
    main(['--records', dir, '--out', out], { log });
    expect(readFileSync(out, 'utf8')).toContain('<title>SLICC Bench</title>');
    expect(() => main(['--records', dir])).toThrow(/--out/);
  });
});
