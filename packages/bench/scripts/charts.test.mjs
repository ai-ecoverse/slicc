import { describe, expect, it } from 'vitest';
import {
  chartLegend,
  indexScore,
  logTicks,
  modelSlots,
  paretoFront,
  rankingChart,
  valueChart,
} from './charts.mjs';

const cfg = (model, skills, mean_score, mean_cost) => ({
  model,
  skills,
  mean_score,
  mean_cost,
  pass: 1,
  partial: 1,
  fail: 0,
});

const CONFIGS = [
  cfg('opus', 'builtin', 0.73, 0.2),
  cfg('opus', 'none', 0.59, 0.28),
  cfg('sonnet', 'builtin', 0.4, 0.42),
  cfg('sonnet', 'none', 0.3, 1.33),
];

describe('encoding', () => {
  it('gives each model a stable slot, alphabetically, whatever order it arrives in', () => {
    expect([...modelSlots(['sonnet', 'opus', 'sonnet']).entries()]).toEqual([
      ['opus', 1],
      ['sonnet', 2],
    ]);
    const many = modelSlots(Array.from({ length: 9 }, (_, i) => `m${i}`));
    expect(many.get('m8')).toBe(1);
  });

  it('reads a score as an index, and lists models and the skills encoding', () => {
    expect(indexScore({ mean_score: 0.73 })).toBeCloseTo(73);
    expect(indexScore({ mean_score: null })).toBeNull();
    const legend = chartLegend(modelSlots(['<b>']), '<li>extra</li>');
    expect(legend).toContain('<li>extra</li>');
    expect(legend).toContain('&lt;b&gt;');
    expect(legend).toContain('outlined: without skills');
  });
});

describe('rankingChart', () => {
  it('ranks configurations best first, solid with skills and outlined without', () => {
    const svg = rankingChart(CONFIGS, modelSlots(['opus', 'sonnet']));
    const values = [...svg.matchAll(/class="bar-value">(\d+)</g)].map((m) => Number(m[1]));
    expect(values).toEqual([73, 59, 40, 30]);
    expect(svg.match(/class="mark with"/g)).toHaveLength(2);
    expect(svg.match(/class="mark without"/g)).toHaveLength(2);
    expect(svg).toContain('style="--c: var(--series-2)"');
    expect(svg).toContain('<title>opus · builtin: 73 (mean score 0.73 over 2 judged runs)</title>');
  });

  it('breaks ties by model name, draws a flat bar for zero, and says when nothing was judged', () => {
    const svg = rankingChart(
      [cfg('b', 'none', 0.5, 1), cfg('a', 'none', 0.5, 1), cfg('z', 'none', 0, 1)],
      modelSlots(['a', 'b', 'z'])
    );
    expect(svg.indexOf('>a</text>')).toBeLessThan(svg.indexOf('>b</text>'));
    expect(svg).toMatch(/d="M\d+(\.\d+)?,226H\d+(\.\d+)?Z"/);
    expect(rankingChart([cfg('a', 'none', null, 1)], modelSlots(['a']))).toContain(
      'No judged runs yet.'
    );
  });
});

describe('valueChart', () => {
  it('ticks a log axis at 1-2-5', () => {
    expect(logTicks(0.11, 1.5)).toEqual([0.2, 0.5, 1]);
    expect(logTicks(0.9, 25)).toEqual([1, 2, 5, 10, 20]);
  });

  it('keeps the configurations no cheaper one beats', () => {
    const pts = [
      { cost: 1, score: 50 },
      { cost: 0.2, score: 40 },
      { cost: 2, score: 45 },
      { cost: 3, score: 70 },
      { cost: 0.2, score: 30 },
    ];
    expect(paretoFront(pts).map((p) => [p.cost, p.score])).toEqual([
      [0.2, 40],
      [1, 50],
      [3, 70],
    ]);
  });

  it('draws the quadrant, labels every point, and draws the Pareto line when there is one', () => {
    const slots = modelSlots(['opus', 'sonnet']);
    const withLine = valueChart(
      [
        cfg('opus', 'builtin', 0.73, 1.2),
        cfg('sonnet', 'builtin', 0.4, 0.3),
        cfg('sonnet', 'none', 0.2, 2),
      ],
      slots
    );
    expect(withLine).toContain('class="quad-good"');
    expect(withLine).toContain('<polyline points=');
    expect(withLine).toContain('Pareto line</li>');
    expect(withLine).toContain('>opus · builtin</text>');
    expect(withLine).toContain('<title>sonnet · none: score 20, $2.000 per task</title>');
    expect(withLine).toMatch(/class="label">\$0\.2<\/text>/);
    expect(withLine).toMatch(/class="label">\$1<\/text>/);
  });

  it('says so when one configuration is cheapest and best, and needs a score and a cost', () => {
    const slots = modelSlots(['opus', 'sonnet']);
    const dominant = valueChart(CONFIGS, slots);
    expect(dominant).not.toContain('<polyline');
    expect(dominant).not.toContain('Pareto line</li>');
    expect(dominant).toContain('No Pareto line: opus · builtin is both the cheapest and the best');
    expect(valueChart([cfg('opus', 'builtin', 0.7, 0.2)], slots)).not.toContain('No Pareto line');
    expect(valueChart([cfg('opus', 'builtin', 0.7, null)], slots)).toContain(
      'No configuration has both a score and a cost yet.'
    );
    expect(valueChart([cfg('opus', 'builtin', 0.7, 12.5)], slots)).toMatch(/\$10<\//);
  });
});
