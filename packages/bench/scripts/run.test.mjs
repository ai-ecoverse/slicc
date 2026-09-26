import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskDigests, withDigests } from './format.mjs';
import {
  ageSeconds,
  DEFAULT_MODELS,
  guardrails,
  loadSet,
  main,
  parseCli,
  parseShard,
  planRuns,
  readTrace,
  recordPath,
  resumeAction,
  selectTasks,
  shardRuns,
  tracePath,
} from './run.mjs';

const TASK = withDigests({
  id: 'own-1',
  title: 'Own task',
  task: 'Report the heading.',
  rubric: '## Items\nA1_heading — the heading\n',
  weights: { A1_heading: 100 },
});

function tmp() {
  return mkdtempSync(join(tmpdir(), 'bench-run-'));
}

describe('parseCli', () => {
  it('defaults to Sonnet and Opus, builtin skills, one repeat', () => {
    const o = parseCli(['--set', 'bu-v1']);
    expect(o.models).toEqual(DEFAULT_MODELS);
    expect(o.skills.map((s) => s.name)).toEqual(['builtin']);
    expect(o).toMatchObject({
      repeats: 1,
      timeout: 900,
      judge: true,
      taskIds: null,
      limit: null,
    });
  });

  it('parses the matrix', () => {
    const o = parseCli([
      '--set',
      'a.json',
      '--set',
      'bu-v2',
      '--models',
      'm1, m2',
      '--skills',
      'none,builtin+x',
      '--repeats',
      '3',
      '--tasks',
      't1,t2',
      '--limit',
      '5',
      '--no-judge',
    ]);
    expect(o.sets).toEqual(['a.json', 'bu-v2']);
    expect(o.models).toEqual(['m1', 'm2']);
    expect(o.skills.map((s) => s.name)).toEqual(['none', 'builtin+x']);
    expect(o).toMatchObject({
      repeats: 3,
      taskIds: ['t1', 't2'],
      limit: 5,
      judge: false,
    });
  });

  it('rejects nonsense', () => {
    expect(() => parseCli([])).toThrow(/--set/);
    expect(() => parseCli(['--set', 'x', '--repeats', '0'])).toThrow(/--repeats/);
    expect(() => parseCli(['--set', 'x', '--timeout', '5'])).toThrow(/--timeout/);
    expect(() => parseCli(['--set', 'x', '--executor', 'cdp'])).toThrow(/executor/);
    expect(() => parseCli(['--set', 'x', '--fresh-leader-every', '-1'])).toThrow(
      /--fresh-leader-every/
    );
    expect(() => parseCli(['--set', 'x', '--leader-down-limit', '0'])).toThrow(
      /--leader-down-limit/
    );
    expect(parseCli(['--set', 'x', '--fresh-leader-every', '5'])).toMatchObject({
      freshLeaderEvery: 5,
      leaderDownLimit: 2,
    });
    expect(parseCli(['--help']).help).toBe(true);
  });
});

describe('loadSet', () => {
  it('converts BU V1 (answered tasks only) and marks upstream sets encrypted', async () => {
    const loadUpstream = vi.fn(async () => [
      { task_id: 'a', confirmed_task: 'Q?', category: 'GAIA', answer: '1' },
      { task_id: 'b', confirmed_task: 'Do', category: 'OM2W2' },
    ]);
    const v1 = await loadSet('bu-v1', { loadUpstream });
    expect(v1).toMatchObject({ benchmark: 'BU_Bench_V1', encrypted: true });
    expect(v1.tasks.map((t) => t.id)).toEqual(['a']);
    const v2 = await loadSet('bu-v2', {
      loadUpstream: async () => ({ benchmark: 'BU_Bench_V2', tasks: [TASK] }),
    });
    expect(v2).toMatchObject({ benchmark: 'BU_Bench_V2', encrypted: true });
  });

  it('reads a task-set file, resolving task files beside it', async () => {
    const dir = tmp();
    const path = join(dir, 'set.json');
    writeFileSync(
      path,
      JSON.stringify({
        benchmark: 'Own',
        tasks: [
          { ...TASK, slicc: { files: [{ from: 'files/a.html', to: '/workspace/a.html' }] } },
          { ...TASK, id: 'own-2' },
        ],
      })
    );
    const set = await loadSet(path);
    expect(set).toMatchObject({ benchmark: 'Own', encrypted: false });
    expect(set.tasks[0].slicc.files[0].from).toBe(join(dir, 'files/a.html'));
    expect(set.tasks[1].slicc).toBeUndefined();
  });

  it('reads skill-creator evals and rejects an invalid set', async () => {
    const dir = tmp();
    const evals = join(dir, 'evals.json');
    writeFileSync(
      evals,
      JSON.stringify({ skill_name: 'speck', evals: [{ id: 1, prompt: 'p', expectations: ['e'] }] })
    );
    expect((await loadSet(evals)).benchmark).toBe('speck-evals');
    const bad = join(dir, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({
        benchmark: 'B',
        tasks: Array.from({ length: 7 }, (_, i) => ({
          ...TASK,
          id: `x${i}`,
          weights: { A1_heading: 1 },
        })),
      })
    );
    await expect(loadSet(bad)).rejects.toThrow(/sum to 1, not 100.*\(\+2 more\)/);
  });
});

describe('planning', () => {
  it('filters tasks and orders runs skills → repeat → task → model', () => {
    const tasks = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(selectTasks(tasks, { taskIds: ['c', 'a'] }).map((t) => t.id)).toEqual(['a', 'c']);
    expect(selectTasks(tasks, { limit: 2 }).map((t) => t.id)).toEqual(['a', 'b']);
    expect(selectTasks(tasks, { limit: 0 })).toHaveLength(3);
    const runs = planRuns([{ benchmark: 'B', tasks: tasks.slice(0, 2) }], {
      models: ['s', 'o'],
      skills: [{ name: 'none' }, { name: 'builtin' }],
      repeats: 2,
    });
    expect(runs).toHaveLength(16);
    expect(
      runs.slice(0, 4).map((r) => `${r.condition.name}/${r.repeat}/${r.task.id}/${r.model}`)
    ).toEqual(['none/1/a/s', 'none/1/a/o', 'none/1/b/s', 'none/1/b/o']);
    expect(runs[8].condition.name).toBe('builtin');
  });

  it('shards a plan by task, keeping every model and repeat of a task together', () => {
    expect(parseShard(undefined)).toBeNull();
    expect(parseShard('2/5')).toEqual({ index: 2, count: 5 });
    for (const bad of ['0/3', '4/3', '1/0', 'x', '1-3'])
      expect(() => parseShard(bad)).toThrow(/--shard must be K\/N/);
    const tasks = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    const runs = planRuns(
      [
        { benchmark: 'B', tasks },
        { benchmark: 'C', tasks: [{ id: 'a' }] },
      ],
      { models: ['s', 'o'], skills: [{ name: 'none' }], repeats: 2 }
    );
    expect(shardRuns(runs, null)).toBe(runs);
    const parts = [1, 2, 3].map((index) => shardRuns(runs, { index, count: 3 }));
    expect(parts.map((p) => p.length).reduce((a, b) => a + b)).toBe(runs.length);
    const ids = (p) => [...new Set(p.map((r) => `${r.set.benchmark}/${r.task.id}`))];
    expect(parts.map(ids)).toEqual([['B/a', 'B/d'], ['B/b', 'C/a'], ['B/c']]);
    expect(parts[0]).toHaveLength(8);
  });

  it('keeps record and trace paths filesystem-safe', () => {
    const seg = recordPath('/o', 'BU_Bench_V1', 'builtin+x', 'claude-sonnet-5', 'a/b c', 2);
    expect(seg).toMatch(
      /^\/o\/records\/BU_Bench_V1\/builtin\+x\/claude-sonnet-5\/a-b-c-[0-9a-f]{8}-r2\.json$/
    );
    expect(recordPath('/o', 'B', 'none', 'm', 'a b/c', 1)).not.toBe(
      recordPath('/o', 'B', 'none', 'm', 'a/b c', 1)
    );
    expect(tracePath('/o', 'B', 'none', 'm', 't', 1, true)).toBe(
      '/o/traces/B/none/m/t-r1.json.enc'
    );
    expect(tracePath('/o', 'B', 'none', 'm', 't', 1, false)).toBe('/o/traces/B/none/m/t-r1.json');
  });
});

const TRANSCRIPT = {
  schemaVersion: 1,
  conversations: [
    {
      id: 'cone',
      kind: 'cone',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Report the heading.' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'FINAL ANSWER: Example' }],
          model: { id: 'global.anthropic.m' },
        },
      ],
    },
  ],
};
const TRANSCRIPT_BYTES = Buffer.from(JSON.stringify(TRANSCRIPT));

/**
 * A fake leader behind the `slicc` CLI: each prompt takes five seconds on its own clock and
 * spends a cent. Calls are recorded as `slicc <verb …>` or as the shell command given to exec.
 */
function leader({ failOn, down = () => false } = {}) {
  const commands = [];
  const urls = [];
  let clock = 0;
  let spent = 0;
  const reply = (command, stdout = '') => {
    if (down(command))
      return {
        stdout: '',
        stderr: 'tray connect timed out after 30s',
        status: 1,
        timedOut: false,
        leaderDown: true,
      };
    return failOn?.test(command)
      ? { stdout: '', stderr: 'leader went away', status: 1, timedOut: false }
      : { stdout, stderr: '', status: 0, timedOut: false };
  };
  const cli = vi.fn(async (args) => {
    const command = `slicc ${args.join(' ')}`;
    commands.push(command);
    if (args[0] === 'model') return reply(command, `bedrock:global.anthropic.${args[1]}\n`);
    if (args[0] === 'prompt') {
      clock += 5000;
      spent += 0.01;
      return reply(command, 'FINAL ANSWER: Example\n');
    }
    return reply(command);
  });
  const exec = vi.fn(async (command) => {
    commands.push(command);
    if (command.includes('| wc -l')) return reply(command, '3\n');
    if (command === 'cost --json --all')
      return reply(
        command,
        JSON.stringify({
          scoops: [{ type: 'cone', turns: 1, usage: { totalTokens: 10, cost: { total: spent } } }],
        })
      );
    if (command.startsWith('session export')) {
      // One part: the listing `exportTranscriptCommand` prints, then `base64` of that part.
      const t = `${/--output (\S+)\/transcript\.zip/.exec(command)[1]}/transcript`;
      const hash = createHash('sha256').update(TRANSCRIPT_BYTES).digest('hex');
      return reply(
        command,
        `${TRANSCRIPT_BYTES.length} ${t}/transcript.json\n${hash}  ${t}/transcript.json\n${hash}  ${t}/parts/xaa\n`
      );
    }
    if (/^base64 '\S+\/transcript\/parts\/xaa'$/.test(command))
      return reply(command, TRANSCRIPT_BYTES.toString('base64'));
    return reply(command);
  });
  const setUrl = (u) => {
    urls.push(u);
    commands.push(`(leader ${u})`);
  };
  return { deps: { leader: { cli, exec, setUrl }, now: () => clock }, commands, urls };
}

const PROMPT = 'slicc prompt -';

const fakeJudge = vi.fn(async ({ task }) => ({
  judgement: { infra_error: false, reward_hacking_suspected: false },
  result: {
    score: task.id === 'own-2' ? 0.5 : 1,
    verdict: task.id !== 'own-2',
    statuses: {},
    canary_leak: false,
  },
  usage: { totalTokens: 1 },
  imagesSent: false,
}));

describe('main', () => {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  afterEach(() => {
    if (summary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = summary;
  });

  function setFile(dir, benchmark = 'Own') {
    const path = join(dir, 'set.json');
    writeFileSync(
      path,
      JSON.stringify({ benchmark, tasks: [TASK, withDigests({ ...TASK, id: 'own-2' })] })
    );
    return path;
  }

  it('prints the plan without touching a leader', async () => {
    const dir = tmp();
    const log = vi.fn();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--set', setFile(dir), '--models', 'm', '--plan'], { log })).toBe(0);
    expect(out.mock.calls.map((c) => c[0])).toEqual([
      'Own\tbuiltin\tm\tr1\town-1',
      'Own\tbuiltin\tm\tr1\town-2',
    ]);
    out.mockRestore();
  });

  it('runs, judges, writes records, results and report, then resumes', async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const stepSummary = join(dir, 'summary.md');
    process.env.GITHUB_STEP_SUMMARY = stepSummary;
    const run = leader();
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    const args = [
      '--set',
      setFile(dir),
      '--models',
      'claude-sonnet-5,claude-opus-5-5',
      '--skills',
      'none,builtin',
      '--out',
      outDir,
      '--harness',
      'test',
    ];
    expect(await main(args, { ...run.deps, judge: fakeJudge, spec: {}, log: () => {} })).toBe(0);
    const { commands } = run;
    expect(commands.filter((c) => c === PROMPT)).toHaveLength(8);
    // Per run: fresh session, pick the model, snapshot cost, prompt, snapshot cost, export.
    const order = [
      'slicc new-session --erase',
      'slicc model claude-sonnet-5',
      'cost --json --all',
      PROMPT,
      'cost --json --all',
    ].map((c, i, all) => commands.indexOf(c, i ? commands.indexOf(all[i - 1]) + 1 : 0));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(commands.findIndex((c) => c.startsWith('session export'))).toBeGreaterThan(order[4]);
    expect(commands.filter((c) => c.includes('ls /workspace/skills | wc -l'))).toHaveLength(2);
    expect(commands.at(-1)).toContain('.bench-skills-builtin/. /workspace/skills/');
    const record = JSON.parse(
      readFileSync(recordPath(outDir, 'Own', 'none', 'claude-sonnet-5', 'own-2', 1), 'utf8')
    );
    expect(record).toMatchObject({
      score: 0.5,
      outcome: 'partial',
      verdict: false,
      config: { harness: 'test', model: 'claude-sonnet-5', skills: 'none' },
      model_id: 'bedrock:global.anthropic.claude-sonnet-5',
    });
    expect(record.metrics).toMatchObject({ duration: 5, modelsUsed: ['global.anthropic.m'] });
    expect(record.metrics.cost).toBeCloseTo(0.01, 6);
    expect(readdirSync(join(outDir, 'results'))).toHaveLength(4);
    expect(readFileSync(join(outDir, 'report.md'), 'utf8')).toContain('**What skills add**');
    expect(readFileSync(join(outDir, 'report.html'), 'utf8')).toContain('<h2>Own <small>8 runs');
    const reportJson = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
    expect(reportJson.judges).toEqual(['global.openai.gpt-5.6-luna']);
    expect(reportJson.benchmarks[0].skill_deltas).toHaveLength(2);
    expect(reportJson.benchmarks[0].model_deltas).toHaveLength(2);
    expect(readFileSync(stepSummary, 'utf8')).toContain('### Own');
    const trace = readTrace(
      tracePath(outDir, 'Own', 'none', 'claude-sonnet-5', 'own-1', 1, false),
      'Own'
    );
    expect(trace.result.judgement).toEqual({ infra_error: false, reward_hacking_suspected: false });

    const again = leader();
    expect(
      await main(args, {
        ...again.deps,
        judge: fakeJudge,
        spec: {},
        log: () => {},
      })
    ).toBe(0);
    expect(again.commands.filter((c) => c === PROMPT)).toHaveLength(0);
    quiet.mockRestore();
  });

  it('records an unreachable leader as an error, not a fail, and retries it next time', async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    const down = leader({ failOn: /^rm -rf \/tmp\/bench\// });
    const failed = main(['--set', setFile(dir), '--models', 'm', '--out', outDir, '--no-judge'], {
      ...down.deps,
      log: () => {},
    });
    expect(await failed).toBe(1);
    const record = JSON.parse(
      readFileSync(recordPath(outDir, 'Own', 'builtin', 'm', 'own-1', 1), 'utf8')
    );
    expect(record.error).toMatch(/leader went away/);
    expect(existsSync(tracePath(outDir, 'Own', 'builtin', 'm', 'own-1', 1, false))).toBe(false);
    const ok = leader();
    const retry = await main(
      ['--set', setFile(dir), '--models', 'm', '--out', outDir, '--no-judge'],
      {
        ...ok.deps,
        log: () => {},
      }
    );
    const retried = JSON.parse(
      readFileSync(recordPath(outDir, 'Own', 'builtin', 'm', 'own-1', 1), 'utf8')
    );
    expect(retry).toBe(0);
    expect(retried.error).toBeUndefined();
    expect(retried.score).toBeUndefined();
    quiet.mockRestore();
  });

  it('encrypts traces of upstream sets with the set key', async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    const loadUpstream = async () => [
      { task_id: 'u1', confirmed_task: 'Q?', category: 'GAIA', answer: '7' },
    ];
    await main(['--set', 'bu-v1', '--models', 'm', '--out', outDir], {
      ...leader().deps,
      judge: fakeJudge,
      spec: {},
      loadUpstream,
      log: () => {},
    });
    const path = tracePath(outDir, 'BU_Bench_V1', 'builtin', 'm', 'u1', 1, true);
    expect(readFileSync(path, 'utf8')).not.toContain('Q?');
    expect(readTrace(path, 'BU_Bench_V1').task.task).toBe('Q?');

    const from = {
      repo: 'browser-use/benchmark',
      tag: 'v2.1.1',
      commit: 'abc1234def',
      file: 'BU_Bench_V1.enc',
      sha256: 'f'.repeat(64),
    };
    const withProvenance = async (_name, opts) => {
      const data = await loadUpstream();
      return opts?.withProvenance ? { data, provenance: from } : data;
    };
    const out2 = join(dir, 'out2');
    await main(['--set', 'bu-v1', '--models', 'm', '--out', out2], {
      ...leader().deps,
      judge: fakeJudge,
      spec: {},
      loadUpstream: withProvenance,
      log: () => {},
    });
    const rec = JSON.parse(
      readFileSync(recordPath(out2, 'BU_Bench_V1', 'builtin', 'm', 'u1', 1), 'utf8')
    );
    expect(rec.upstream).toEqual(from);
    expect(readFileSync(join(out2, 'report.md'), 'utf8')).toContain(
      'Tasks: browser-use/benchmark v2.1.1 (abc1234), `BU_Bench_V1.enc` sha256 ffffffffffff'
    );
    const [resultFile] = readdirSync(join(out2, 'results'));
    expect(JSON.parse(readFileSync(join(out2, 'results', resultFile), 'utf8'))[0].upstream).toEqual(
      from
    );
    quiet.mockRestore();
  });

  it('needs a judge key unless judging is off, and warns when skills cannot be restored', async () => {
    const dir = tmp();
    const key = process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.BEDROCK_API_KEY;
    await expect(
      main(['--set', setFile(dir), '--models', 'm', '--out', join(dir, 'o')], {
        ...leader().deps,
        spec: {},
        log: () => {},
      })
    ).rejects.toThrow(/AWS_BEARER_TOKEN_BEDROCK/);
    if (key !== undefined) process.env.AWS_BEARER_TOKEN_BEDROCK = key;
    const log = vi.fn();
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--set', setFile(dir), '--models', 'm', '--out', join(dir, 'o2'), '--no-judge'], {
      ...leader({ failOn: /^if \[ -d/ }).deps,
      log,
    });
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /could not restore \/workspace\/skills/
    );
    quiet.mockRestore();
  });
});

describe('main defaults', () => {
  it('prints its usage for --help', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--help'])).toBe(0);
    expect(out.mock.calls[0][0]).toContain('bench — run task sets on a SLICC leader');
    out.mockRestore();
  });

  it('judges with Bedrock from the environment and logs to stderr', async () => {
    const dir = tmp();
    const key = process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'test-key';
    const judgement = {
      agent_task_reading: 'r',
      findings: [{ item: 'A1_heading', evidence: 'e', status: 'met' }],
      observations: [],
      infra_error: false,
      pii_present: false,
      reward_hacking_suspected: false,
      flag_notes: null,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ output: { message: { content: [{ toolUse: { input: judgement } }] } } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = join(dir, 'set.json');
    writeFileSync(path, JSON.stringify({ benchmark: 'Own', tasks: [TASK] }));
    await main(['--set', path, '--models', 'm', '--out', join(dir, 'o')], {
      ...leader().deps,
      spec: {
        systemPrompt: 'S',
        caps: {
          task: 9e9,
          website: 9e9,
          rubric: 9e9,
          finalResult: 9e9,
          trajectory: 9e9,
          files: 9e9,
        },
      },
    });
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer test-key');
    expect(
      err.mock.calls.some((c) => /\[bench \d\d:\d\d:\d\d\] Own: 1 of 1 tasks/.test(c[0]))
    ).toBe(true);
    const record = JSON.parse(
      readFileSync(recordPath(join(dir, 'o'), 'Own', 'builtin', 'm', 'own-1', 1), 'utf8')
    );
    expect(record).toMatchObject({
      score: 1,
      outcome: 'pass',
      judge: { model: 'global.openai.gpt-5.6-luna' },
    });
    vi.unstubAllGlobals();
    err.mockRestore();
    out.mockRestore();
    if (key === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = key;
  });
});

describe('resumeAction', () => {
  const done = (extra = {}) => ({
    digests: taskDigests(TASK),
    score: 1,
    judge: { model: 'j1' },
    ...extra,
  });
  const ctx = { judge: true, judgeModel: 'j1', traceExists: true };

  it('runs what never ran, what the agent failed, and what a changed task invalidated', () => {
    expect(resumeAction(null, TASK, ctx)).toBe('run');
    expect(resumeAction(done({ error: 'x', error_stage: 'run' }), TASK, ctx)).toBe('run');
    expect(resumeAction(done({ digests: undefined }), TASK, ctx)).toBe('run');
    expect(resumeAction(done(), { ...TASK, task: 'Something else.' }, ctx)).toBe('run');
  });

  it('re-judges when the judgement no longer stands', () => {
    expect(resumeAction(done(), TASK, { ...ctx, judgeModel: 'j2' })).toBe('rejudge');
    expect(
      resumeAction(
        done({ error: 'judge HTTP 500', error_stage: 'judge', score: undefined }),
        TASK,
        ctx
      )
    ).toBe('rejudge');
    expect(resumeAction(done({ score: undefined, judge: undefined }), TASK, ctx)).toBe('rejudge');
    expect(
      resumeAction(done(), { ...TASK, rubric: `${TASK.rubric}\nRuling: stricter.` }, ctx)
    ).toBe('rejudge');
    expect(
      resumeAction(
        done(),
        { ...TASK, weights: { A1_heading: 100 }, rubric: TASK.rubric },
        { ...ctx, judgeModel: 'j1' }
      )
    ).toBe('done');
  });

  it('starts over when the trace to re-judge is gone, and leaves finished runs alone', () => {
    expect(resumeAction(done(), TASK, { ...ctx, judgeModel: 'j2', traceExists: false })).toBe(
      'run'
    );
    expect(resumeAction(done(), TASK, ctx)).toBe('done');
    expect(resumeAction(done({ score: undefined }), TASK, { ...ctx, judge: false })).toBe('done');
    expect(
      resumeAction(done({ error: 'judge down', error_stage: 'judge' }), TASK, {
        ...ctx,
        judge: false,
      })
    ).toBe('done');
  });
});

describe('re-judging on resume', () => {
  it('re-judges saved traces for a new judge model without running the agent again', async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = join(dir, 'set.json');
    writeFileSync(path, JSON.stringify({ benchmark: 'Own', tasks: [TASK] }));
    const judgeAs = (score) =>
      vi.fn(async () => ({
        judgement: { infra_error: false, reward_hacking_suspected: false },
        result: { score, verdict: score === 1, statuses: {}, canary_leak: false },
        usage: null,
        imagesSent: false,
      }));
    const common = ['--set', path, '--models', 'm', '--out', outDir];
    const first = leader();
    await main([...common, '--judge-model', 'j1'], {
      ...first.deps,
      judge: judgeAs(1),
      spec: {},
      log: () => {},
    });
    const rp = recordPath(outDir, 'Own', 'builtin', 'm', 'own-1', 1);
    expect(JSON.parse(readFileSync(rp, 'utf8'))).toMatchObject({
      score: 1,
      judge: { model: 'j1' },
    });

    const second = leader();
    const j2 = judgeAs(0.5);
    const log = vi.fn();
    await main([...common, '--judge-model', 'j2'], {
      ...second.deps,
      judge: j2,
      spec: {},
      log,
    });
    expect(second.commands.filter((c) => c === PROMPT)).toHaveLength(0);
    expect(j2).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /partial 0\.50 5 s \$0\.010 \(re-judged\)/
    );
    const record = JSON.parse(readFileSync(rp, 'utf8'));
    expect(record).toMatchObject({ score: 0.5, outcome: 'partial', judge: { model: 'j2' } });
    expect(record.error).toBeUndefined();
    const summary = JSON.parse(
      readFileSync(join(outDir, 'results', readdirSync(join(outDir, 'results'))[0]), 'utf8')
    );
    expect(summary[0].judge_model).toBe('j2');
    expect(
      readTrace(tracePath(outDir, 'Own', 'builtin', 'm', 'own-1', 1, false), 'Own').record.judge
        .model
    ).toBe('j2');
    quiet.mockRestore();
  });

  it('keeps the run when only judging failed, and re-judges it next time', async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    const path = join(dir, 'set.json');
    writeFileSync(path, JSON.stringify({ benchmark: 'Own', tasks: [TASK] }));
    const broken = vi.fn(async () => {
      throw new Error('judge HTTP 503');
    });
    const code = await main(['--set', path, '--models', 'm', '--out', outDir], {
      ...leader().deps,
      judge: broken,
      spec: {},
      log: () => {},
    });
    expect(code).toBe(1);
    const rp = recordPath(outDir, 'Own', 'builtin', 'm', 'own-1', 1);
    expect(JSON.parse(readFileSync(rp, 'utf8'))).toMatchObject({
      error: 'judge HTTP 503',
      error_stage: 'judge',
      metrics: { duration: 5 },
    });
    expect(readFileSync(join(outDir, 'report.md'), 'utf8')).toContain(
      '| m | builtin | 1 | 0 | 0 | 0 | 1 | 0 | – | 5 | 0.010 |'
    );

    const again = leader();
    const stillBroken = await main(['--set', path, '--models', 'm', '--out', outDir], {
      ...again.deps,
      judge: broken,
      spec: {},
      log: () => {},
    });
    expect(stillBroken).toBe(1);
    expect(again.commands.filter((c) => c === PROMPT)).toHaveLength(0);
    const fixed = await main(['--set', path, '--models', 'm', '--out', outDir], {
      ...leader().deps,
      judge: fakeJudge,
      spec: {},
      log: () => {},
    });
    expect(fixed).toBe(0);
    const record = JSON.parse(readFileSync(rp, 'utf8'));
    expect(record).toMatchObject({ score: 1, outcome: 'pass' });
    expect(record.error_stage).toBeUndefined();
    quiet.mockRestore();
  });
});

describe('leader lifecycle', () => {
  it('reads a leader age from ISO text or epoch ms', () => {
    expect(ageSeconds('1970-01-01T00:01:00.000Z', 90_000)).toBe(30);
    expect(ageSeconds(60_000, 90_000)).toBe(30);
    expect(ageSeconds('not a date', 90_000)).toBeNull();
    expect(ageSeconds(undefined, 90_000)).toBeNull();
  });

  const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});
  const events = (out) =>
    readFileSync(join(out, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  function twoTasks(dir) {
    const path = join(dir, 'set.json');
    writeFileSync(
      path,
      JSON.stringify({ benchmark: 'Own', tasks: [TASK, withDigests({ ...TASK, id: 'own-2' })] })
    );
    return path;
  }
  const recycler = (fn = () => {}) => {
    let n = 0;
    return vi.fn(async () => {
      n += 1;
      fn(n);
      return {
        url: `https://w/join/new-${n}`,
        startedAt: new Date().toISOString(),
        sliccVersion: '9.9',
      };
    });
  };

  it('needs a restartable leader for --fresh-leader-every', async () => {
    const dir = tmp();
    await expect(
      main(
        [
          '--set',
          twoTasks(dir),
          '--models',
          'm',
          '--no-judge',
          '--fresh-leader-every',
          '1',
          '--out',
          join(dir, 'o'),
        ],
        {
          ...leader().deps,
          log: () => {},
        }
      )
    ).rejects.toThrow(/needs a leader it can restart/);
  });

  it('boots a fresh leader every N tasks and stages skills on it again', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    const fake = leader();
    const recycle = recycler();
    const code = await main(
      [
        '--set',
        twoTasks(dir),
        '--models',
        'm',
        '--no-judge',
        '--fresh-leader-every',
        '1',
        '--out',
        out,
      ],
      {
        ...fake.deps,
        recycle,
        firstLeader: { startedAt: '2026-09-24T17:00:00.000Z' },
        log: () => {},
      }
    );
    expect(code).toBe(0);
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(fake.urls).toEqual(['https://w/join/new-1']);
    expect(fake.commands.filter((c) => c.includes('ls /workspace/skills | wc -l'))).toHaveLength(2);
    const r1 = JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'm', 'own-1', 1), 'utf8'));
    const r2 = JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'm', 'own-2', 1), 'utf8'));
    expect(r1.leader).toMatchObject({ generation: 0, task: 1 });
    expect(r1.leader.age_s).toBeGreaterThan(0);
    expect(r2.leader).toMatchObject({ generation: 1, task: 1 });
    const types = events(out).map((e) => e.type);
    expect(types).toEqual(['start', 'task', 'leader-restart', 'leader-ready', 'task', 'end']);
    expect(events(out)[0]).toMatchObject({
      leader_started_at: '2026-09-24T17:00:00.000Z',
      fresh_leader_every: 1,
    });
    expect(events(out)[3]).toMatchObject({ generation: 1, slicc_version: '9.9' });
    expect(events(out)[1].health.before.ok).toBe(true);
    expect(events(out)[1].transcript).toMatchObject({ ok: true, parts: 1, exports: 1, reads: 1 });
    q.mockRestore();
  });

  it('journals why a transcript is missing, in the event, the record and the log', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    const fake = leader({ failOn: /^session export/ });
    const log = vi.fn();
    const code = await main(['--set', twoTasks(dir), '--models', 'm', '--no-judge', '--out', out], {
      ...fake.deps,
      log,
    });
    expect(code).toBe(0);
    const task = events(out).find((e) => e.type === 'task');
    expect(task.transcript).toMatchObject({
      ok: false,
      stage: 'export',
      reason: 'exit 1',
      detail: 'leader went away',
      exports: 2,
    });
    const r1 = JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'm', 'own-1', 1), 'utf8'));
    expect(r1.metrics.transcript).toMatchObject({ ok: false, stage: 'export', reason: 'exit 1' });
    expect(r1.metrics.transcript.detail).toBeUndefined();
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /ran 5 s \$0\.010 \(no transcript: export exit 1\)/
    );
    q.mockRestore();
  });

  it('restarts an unreachable leader and retries the run once', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    let healthy = false;
    const fake = leader({ down: (c) => !healthy && c.startsWith('rm -rf /tmp/bench/') });
    const recycle = recycler(() => {
      healthy = true;
    });
    const log = vi.fn();
    const code = await main(['--set', twoTasks(dir), '--models', 'm', '--no-judge', '--out', out], {
      ...fake.deps,
      recycle,
      log,
    });
    expect(code).toBe(0);
    expect(recycle).toHaveBeenCalledTimes(1);
    const r1 = JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'm', 'own-1', 1), 'utf8'));
    expect(r1.error).toBeUndefined();
    expect(r1.leader.generation).toBe(1);
    expect(events(out).map((e) => e.type)).toContain('leader-down');
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /restarting the leader \(leader unreachable\)/
    );
    q.mockRestore();
  });

  it('retries a run whose transcript was lost to an unreachable leader instead of judging it', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    let healthy = false;
    const fake = leader({ down: (c) => !healthy && c.startsWith('session export') });
    const recycle = recycler(() => {
      healthy = true;
    });
    const judge = vi.fn(async () => ({
      result: { score: 1, verdict: true, statuses: {} },
      judgement: { infra_error: false, reward_hacking_suspected: false },
    }));
    const log = vi.fn();
    const code = await main(['--set', twoTasks(dir), '--models', 'm', '--out', out], {
      ...fake.deps,
      recycle,
      judge,
      spec: {},
      log,
    });
    expect(code).toBe(0);
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledTimes(2);
    const r1 = JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'm', 'own-1', 1), 'utf8'));
    expect(r1.error).toBeUndefined();
    expect(r1.leader.generation).toBe(1);
    expect(events(out).find((e) => e.type === 'task' && e.outcome === 'error')).toBeUndefined();
    expect(events(out).find((e) => e.type === 'leader-down')).toMatchObject({ task_id: 'own-1' });
    q.mockRestore();
  });

  it('records a lost transcript as leader-down when the leader cannot be restarted', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    const fake = leader({ down: (c) => c.startsWith('session export') });
    const judge = vi.fn();
    const code = await main(
      ['--set', twoTasks(dir), '--models', 'm', '--out', out, '--leader-down-limit', '5'],
      { ...fake.deps, judge, spec: {}, log: vi.fn() }
    );
    expect(code).toBe(1);
    expect(judge).not.toHaveBeenCalled();
    const r1 = JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'm', 'own-1', 1), 'utf8'));
    expect(r1).toMatchObject({
      error: 'transcript lost: the leader went down (export)',
      error_stage: 'collect',
      leader_down: true,
    });
    expect(typeof r1.metrics.cost).toBe('number');
    q.mockRestore();
  });

  it('restarts a leader that cannot be reached while its skills are staged', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    let healthy = false;
    const fake = leader({ down: (c) => !healthy && c.includes('.bench-skills-builtin') });
    const recycle = recycler(() => {
      healthy = true;
    });
    const log = vi.fn();
    const code = await main(['--set', twoTasks(dir), '--models', 'm', '--no-judge', '--out', out], {
      ...fake.deps,
      recycle,
      log,
    });
    expect(code).toBe(0);
    expect(recycle).toHaveBeenCalledTimes(1);
    expect(events(out).find((e) => e.type === 'leader-down')).toMatchObject({
      stage: 'prepare',
      task_id: 'own-1',
    });
    const r1 = JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'm', 'own-1', 1), 'utf8'));
    expect(r1.error).toBeUndefined();
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /restarting the leader \(leader unreachable while preparing\)/
    );
    q.mockRestore();
  });

  it('stops after the leader stays unreachable, leaving the rest for a resume', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    const fake = leader({ down: (c) => c.startsWith('rm -rf /tmp/bench/') });
    const log = vi.fn();
    const code = await main(
      ['--set', twoTasks(dir), '--models', 'a,b', '--no-judge', '--out', out],
      { ...fake.deps, log }
    );
    expect(code).toBe(1);
    const r = JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'a', 'own-1', 1), 'utf8'));
    expect(r).toMatchObject({ leader_down: true, error_stage: 'run' });
    expect(r.error).toMatch(/tray connect timed out/);
    expect(existsSync(recordPath(out, 'Own', 'builtin', 'a', 'own-2', 1))).toBe(false);
    expect(events(out).find((e) => e.type === 'stopped')).toMatchObject({
      reason: 'leader unreachable',
      runs_left: 2,
    });
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /stopping: the leader was unreachable for 2 run\(s\) in a row; 2 run\(s\) left/
    );
    q.mockRestore();
  });

  it('stops when a fresh leader will not come up', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    const recycle = vi.fn(async () => {
      throw new Error('start-leader exited 1: chrome did not start');
    });
    const log = vi.fn();
    const code = await main(
      [
        '--set',
        twoTasks(dir),
        '--models',
        'm',
        '--no-judge',
        '--fresh-leader-every',
        '1',
        '--out',
        out,
      ],
      { ...leader().deps, recycle, log }
    );
    expect(code).toBe(1);
    expect(recycle).toHaveBeenCalledTimes(2);
    expect(existsSync(recordPath(out, 'Own', 'builtin', 'm', 'own-2', 1))).toBe(false);
    expect(events(out).find((e) => e.type === 'leader-boot-failed')).toMatchObject({
      lane: 0,
      reason: 'start-leader exited 1: chrome did not start',
    });
    expect(events(out).find((e) => e.type === 'stopped').reason).toMatch(/chrome did not start/);
    q.mockRestore();
  });

  it('boots a leader once more when the new one does not come up, keeping its output', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    let boots = 0;
    const recycle = vi.fn(async () => {
      boots += 1;
      if (boots === 1) {
        const err = new Error('start-leader exited 1: RECATED_ENDPOINT');
        err.output =
          'booting https://w/join/secret-token\n::error::leader did not report a join URL';
        throw err;
      }
      return { url: 'https://w/join/l2', startedAt: new Date().toISOString() };
    });
    const log = vi.fn();
    const code = await main(
      [
        '--set',
        twoTasks(dir),
        '--models',
        'm',
        '--no-judge',
        '--fresh-leader-every',
        '1',
        '--out',
        out,
      ],
      { ...leader().deps, recycle, log }
    );
    expect(code).toBe(0);
    expect(recycle).toHaveBeenCalledTimes(2);
    const failed = events(out).find((e) => e.type === 'leader-boot-failed');
    expect(failed.diagnostics).toMatch(/^diagnostics\/boot-L0-\d+\.log$/);
    const kept = readFileSync(join(out, failed.diagnostics), 'utf8');
    expect(kept).toContain('leader did not report a join URL');
    expect(kept).not.toContain('secret-token');
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(
      /the new leader did not come up; trying once more \(diagnostics\/boot-L0-/
    );
    expect(existsSync(recordPath(out, 'Own', 'builtin', 'm', 'own-2', 1))).toBe(true);
    q.mockRestore();
  });
});

describe('lanes and guardrails', () => {
  const quiet = () => vi.spyOn(console, 'log').mockImplementation(() => {});
  const events = (out) =>
    readFileSync(join(out, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  function setOf(dir, n) {
    const path = join(dir, 'set.json');
    const tasks = Array.from({ length: n }, (_, i) => withDigests({ ...TASK, id: `own-${i + 1}` }));
    writeFileSync(path, JSON.stringify({ benchmark: 'Own', tasks }));
    return path;
  }
  /** Lanes backed by fake leaders; `failOn` lanes never boot. */
  function lanesOf(n, { failOn = [] } = {}) {
    const fakes = Array.from({ length: n }, () => leader());
    const stops = fakes.map(() => vi.fn(async () => {}));
    const bootLane = vi.fn(async (i, { lock }) => {
      expect(typeof lock).toBe('function');
      if (failOn.includes(i)) throw new Error(`lane ${i} chrome did not start`);
      return {
        leader: fakes[i].deps.leader,
        recycle: async () => ({ url: `https://w/join/l${i}`, startedAt: new Date().toISOString() }),
        stop: stops[i],
        startedAt: new Date().toISOString(),
        sliccVersion: '9.9',
        leaderLog: null,
      };
    });
    return { fakes, stops, bootLane };
  }

  it('parses lanes, the deadline and the budgets', () => {
    expect(
      parseCli([
        '--set',
        'x',
        '--leaders',
        '3',
        '--deadline-minutes',
        '300',
        '--max-task-cost',
        '2.5',
        '--max-cost',
        '40',
      ])
    ).toMatchObject({
      leaders: 3,
      bootLeaders: true,
      deadlineMinutes: 300,
      maxTaskCost: 2.5,
      maxCost: 40,
    });
    expect(parseCli(['--set', 'x'])).toMatchObject({
      leaders: 1,
      bootLeaders: false,
      deadlineMinutes: 0,
      maxCost: 0,
    });
    expect(parseCli(['--set', 'x', '--boot-leaders']).bootLeaders).toBe(true);
    expect(() => parseCli(['--set', 'x', '--leaders', '0'])).toThrow(/--leaders/);
    expect(() => parseCli(['--set', 'x', '--leaders', '99'])).toThrow(/--leaders/);
    expect(() => parseCli(['--set', 'x', '--deadline-minutes', '-5'])).toThrow(
      /--deadline-minutes/
    );
    expect(() => parseCli(['--set', 'x', '--timeout', '3600', '--deadline-minutes', '60'])).toThrow(
      '--deadline-minutes 60 leaves no time for a run: one takes up to 80 (the timeout plus 20'
    );
    expect(() => parseCli(['--set', 'x', '--max-cost', 'lots'])).toThrow(/--max-cost/);
    expect(parseCli(['--set', 'x', '--shard', '1/4']).shard).toEqual({ index: 1, count: 4 });
  });

  it('plans only its shard', async () => {
    const dir = tmp();
    const q = quiet();
    const log = vi.fn();
    const code = await main(
      ['--set', setOf(dir, 4), '--models', 'a,b', '--plan', '--shard', '2/3'],
      { log }
    );
    expect(code).toBe(0);
    expect(q.mock.calls.map((c) => c[0].split('\t').slice(2).join(' '))).toEqual([
      'a r1 own-2',
      'b r1 own-2',
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^2 runs \(shard 2\/3\): a, b/));
    q.mockRestore();
  });

  it('shares one queue between lanes, stamps each run with its lane, and stops the leaders it booted', async () => {
    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    const { fakes, stops, bootLane } = lanesOf(2);
    const log = vi.fn();
    const code = await main(
      ['--set', setOf(dir, 4), '--models', 'm', '--no-judge', '--leaders', '2', '--out', out],
      {
        bootLane,
        now: fakes[0].deps.now,
        log,
      }
    );
    expect(code).toBe(0);
    const lanesUsed = [1, 2, 3, 4].map(
      (n) =>
        JSON.parse(readFileSync(recordPath(out, 'Own', 'builtin', 'm', `own-${n}`, 1), 'utf8'))
          .leader.lane
    );
    expect(lanesUsed.sort()).toEqual([0, 0, 1, 1].sort());
    expect(fakes.every((f) => f.commands.includes('slicc prompt -'))).toBe(true);
    expect(stops.every((s) => s.mock.calls.length === 1)).toBe(true);
    // Leaders it booted are stopped, not restored.
    expect(
      fakes.some((f) =>
        f.commands.some((c) => c.startsWith('if [ -d /workspace/.bench-skills-builtin ]'))
      )
    ).toBe(false);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/\[L1\] \[\d\/4\] own-/);
    const ev = events(out);
    expect(ev.filter((e) => e.type === 'leader-ready').map((e) => e.lane)).toEqual([0, 1]);
    expect(ev.find((e) => e.type === 'start')).toMatchObject({ lanes: 2 });
    q.mockRestore();
  });

  it('runs on the lanes that came up, and fails when none did', async () => {
    const dir = tmp();
    const q = quiet();
    const partial = lanesOf(2, { failOn: [0] });
    const out = join(dir, 'o');
    expect(
      await main(
        ['--set', setOf(dir, 2), '--models', 'm', '--no-judge', '--leaders', '2', '--out', out],
        {
          bootLane: partial.bootLane,
          log: () => {},
        }
      )
    ).toBe(0);
    expect(events(out).find((e) => e.type === 'lane-failed')).toMatchObject({ lane: 0 });
    const none = lanesOf(1, { failOn: [0] });
    await expect(
      main(
        [
          '--set',
          setOf(dir, 1),
          '--models',
          'm',
          '--no-judge',
          '--boot-leaders',
          '--out',
          join(dir, 'o2'),
        ],
        {
          bootLane: none.bootLane,
          log: () => {},
        }
      )
    ).rejects.toThrow(/no leader came up/);
    await expect(
      main(
        [
          '--set',
          setOf(dir, 1),
          '--models',
          'm',
          '--no-judge',
          '--boot-leaders',
          '--out',
          join(dir, 'o3'),
        ],
        {
          log: () => {},
        }
      )
    ).rejects.toThrow(/need BENCH_LEADER_SCRIPTS/);
    q.mockRestore();
  });

  it('stops taking runs past the deadline, and journals it once', () => {
    const journal = { event: vi.fn() };
    const log = vi.fn();
    let t = 0;
    const stop = guardrails(
      { deadlineMinutes: 40, timeout: 900, maxCost: 0 },
      { startedMs: 0, now: () => t, journal, log }
    );
    const state = { spent: 0, reasons: [], stopped: false };
    const queue = { next: 3, total: 10 };
    expect(stop(state, queue)).toBeNull();
    t = 6 * 60_000;
    expect(stop(state, queue)).toBe('deadline');
    expect(stop(state, queue)).toBe('deadline');
    expect(journal.event).toHaveBeenCalledTimes(1);
    expect(journal.event).toHaveBeenCalledWith('stopped', {
      reason: 'deadline',
      runs_left: 7,
      spent: 0,
    });
    expect(state.stopped).toBe(true);
    expect(log.mock.calls[0][0]).toMatch(/past the deadline for another run; 7 run\(s\) left/);
  });

  it("uses the next task's slicc.timeoutSeconds for the deadline", () => {
    const journal = { event: vi.fn() };
    const log = vi.fn();
    const t = 0;
    const runs = [
      { task: { id: 'short' } },
      { task: { id: 'long', slicc: { timeoutSeconds: 3600 } } },
    ];
    const stop = guardrails(
      { deadlineMinutes: 40, timeout: 900, maxCost: 0 },
      { startedMs: 0, now: () => t, journal, log, runs }
    );
    const state = { spent: 0, reasons: [], stopped: false };
    // Default 900s + 20 min overhead still fits in a 40 min deadline at t=0.
    expect(stop(state, { next: 0, total: 2 })).toBeNull();
    // The long task needs 60 + 20 min; starting it at t=0 already overruns a 40 min deadline.
    expect(stop(state, { next: 1, total: 2 })).toBe('deadline');
    expect(journal.event).toHaveBeenCalledWith('stopped', {
      reason: 'deadline',
      runs_left: 1,
      spent: 0,
    });
  });

  it('stops at the spend budget, counting only runs paid for here', async () => {
    const journal = { event: vi.fn() };
    const log = vi.fn();
    const stop = guardrails(
      { deadlineMinutes: 0, timeout: 900, maxCost: 1 },
      { startedMs: 0, journal, log }
    );
    const state = { spent: 1.2, reasons: [], stopped: false };
    expect(stop(state, { next: 2, total: 5 })).toBe('budget');
    expect(log.mock.calls[0][0]).toMatch(/spent \$1\.20 of the \$1 budget; 3 run\(s\) left/);

    const dir = tmp();
    const out = join(dir, 'o');
    const q = quiet();
    const code = await main(
      ['--set', setOf(dir, 3), '--models', 'm', '--no-judge', '--max-cost', '0.01', '--out', out],
      {
        ...leader().deps,
        log: () => {},
      }
    );
    expect(code).toBe(1);
    expect(existsSync(recordPath(out, 'Own', 'builtin', 'm', 'own-1', 1))).toBe(true);
    expect(existsSync(recordPath(out, 'Own', 'builtin', 'm', 'own-3', 1))).toBe(false);
    expect(events(out).find((e) => e.type === 'stopped')).toMatchObject({ reason: 'budget' });
    q.mockRestore();
  });
});
