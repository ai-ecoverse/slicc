import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDigests } from './format.mjs';
import {
  DEFAULT_MODELS,
  loadSet,
  main,
  parseCli,
  planRuns,
  readTrace,
  recordPath,
  selectTasks,
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
      executor: 'cli',
      taskIds: null,
      limit: null,
    });
  });

  it('parses the matrix and the leader options', () => {
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
      '--executor',
      'cdp',
      '--cdp',
      'http://127.0.0.1:9',
      '--no-judge',
      '--thinking',
      'low',
    ]);
    expect(o.sets).toEqual(['a.json', 'bu-v2']);
    expect(o.models).toEqual(['m1', 'm2']);
    expect(o.skills.map((s) => s.name)).toEqual(['none', 'builtin+x']);
    expect(o).toMatchObject({
      repeats: 3,
      taskIds: ['t1', 't2'],
      limit: 5,
      executor: 'cdp',
      cdp: 'http://127.0.0.1:9',
      judge: false,
      thinking: 'low',
    });
  });

  it('rejects nonsense', () => {
    expect(() => parseCli([])).toThrow(/--set/);
    expect(() => parseCli(['--set', 'x', '--repeats', '0'])).toThrow(/--repeats/);
    expect(() => parseCli(['--set', 'x', '--timeout', '5'])).toThrow(/--timeout/);
    expect(() => parseCli(['--set', 'x', '--executor', 'ssh'])).toThrow(/--executor/);
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

  it('keeps record and trace paths filesystem-safe', () => {
    expect(recordPath('/o', 'BU_Bench_V1', 'builtin+x', 'claude-sonnet-5', 'a/b c', 2)).toBe(
      '/o/records/BU_Bench_V1/builtin+x/claude-sonnet-5/a-b-c-r2.json'
    );
    expect(tracePath('/o', 'B', 'none', 'm', 't', 1, true)).toBe(
      '/o/traces/B/none/m/t-r1.json.enc'
    );
    expect(tracePath('/o', 'B', 'none', 'm', 't', 1, false)).toBe('/o/traces/B/none/m/t-r1.json');
  });
});

/** A fake leader that answers the adapter's commands with a canned result.json. */
function leader({ failOn } = {}) {
  const commands = [];
  const exec = vi.fn(async (command) => {
    commands.push(command);
    if (failOn?.test(command)) return { stdout: '', stderr: 'leader went away', status: 1 };
    if (command.includes('| wc -l')) return { stdout: '3\n', stderr: '', status: 0 };
    if (/^cat \/tmp\/bench\/.*\/result\.json$/.test(command)) {
      return {
        stdout: JSON.stringify({
          exitCode: 0,
          finalText: 'FINAL ANSWER: Example',
          archive: '## assistant\nread the page',
          durationMs: 5000,
          costUsd: 0.01,
          tokens: 10,
          screenshots: [],
          outputFiles: [],
        }),
        stderr: '',
        status: 0,
      };
    }
    return { stdout: '', stderr: '', status: 0 };
  });
  return { exec, commands };
}

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
    const { exec, commands } = leader();
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
    expect(
      await main(args, { exec, judge: fakeJudge, spec: {}, log: () => {}, leaderScript: 'script' })
    ).toBe(0);
    expect(commands[0]).toBe('mkdir -p /tmp/bench && cat > /tmp/bench/run-task.jsh');
    expect(commands.filter((c) => c.includes('| wc -l'))).toHaveLength(2);
    expect(commands.at(-1)).toContain('.bench-skills-builtin/. /workspace/skills/');
    const record = JSON.parse(
      readFileSync(recordPath(outDir, 'Own', 'none', 'claude-sonnet-5', 'own-2', 1), 'utf8')
    );
    expect(record).toMatchObject({
      score: 0.5,
      outcome: 'partial',
      verdict: false,
      config: { harness: 'test', model: 'claude-sonnet-5', skills: 'none' },
    });
    expect(record.metrics.duration).toBe(5);
    expect(readdirSync(join(outDir, 'results'))).toHaveLength(4);
    expect(readFileSync(join(outDir, 'report.md'), 'utf8')).toContain('**What skills change**');
    expect(readFileSync(stepSummary, 'utf8')).toContain('### Own');
    const trace = readTrace(
      tracePath(outDir, 'Own', 'none', 'claude-sonnet-5', 'own-1', 1, false),
      'Own'
    );
    expect(trace.result.judgement).toEqual({ infra_error: false, reward_hacking_suspected: false });

    const again = leader();
    expect(
      await main(args, {
        exec: again.exec,
        judge: fakeJudge,
        spec: {},
        log: () => {},
        leaderScript: 'script',
      })
    ).toBe(0);
    expect(again.commands.filter((c) => c.startsWith('node '))).toHaveLength(0);
    quiet.mockRestore();
  });

  it('records an unreachable leader as an error, not a fail, and retries it next time', async () => {
    const dir = tmp();
    const outDir = join(dir, 'out');
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { exec } = leader({ failOn: /^rm -rf \/tmp\/bench\// });
    const failed = main(['--set', setFile(dir), '--models', 'm', '--out', outDir, '--no-judge'], {
      exec,
      log: () => {},
      leaderScript: 's',
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
        exec: ok.exec,
        log: () => {},
        leaderScript: 's',
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
      exec: leader().exec,
      judge: fakeJudge,
      spec: {},
      loadUpstream,
      log: () => {},
      leaderScript: 's',
    });
    const path = tracePath(outDir, 'BU_Bench_V1', 'builtin', 'm', 'u1', 1, true);
    expect(readFileSync(path, 'utf8')).not.toContain('Q?');
    expect(readTrace(path, 'BU_Bench_V1').task.task).toBe('Q?');
    quiet.mockRestore();
  });

  it('needs a judge key unless judging is off, and warns when skills cannot be restored', async () => {
    const dir = tmp();
    const key = process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    delete process.env.BEDROCK_API_KEY;
    await expect(
      main(['--set', setFile(dir), '--models', 'm', '--out', join(dir, 'o')], {
        exec: leader().exec,
        spec: {},
        log: () => {},
      })
    ).rejects.toThrow(/AWS_BEARER_TOKEN_BEDROCK/);
    if (key !== undefined) process.env.AWS_BEARER_TOKEN_BEDROCK = key;
    const log = vi.fn();
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--set', setFile(dir), '--models', 'm', '--out', join(dir, 'o2'), '--no-judge'], {
      exec: leader({ failOn: /^if \[ -d/ }).exec,
      log,
      leaderScript: 's',
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
      exec: leader().exec,
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
      leaderScript: 's',
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
