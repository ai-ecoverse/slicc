import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPrompt,
  costTotals,
  exportTranscript,
  FINAL_INSTRUCTION,
  leaderHealth,
  parseSkillsCondition,
  parseTabList,
  quote,
  readShots,
  restoreSkills,
  restoreSkillsCommand,
  runTask,
  spendDelta,
  stageSkills,
  stageSkillsCommand,
  startCapture,
  traceFromResult,
  transcriptSteps,
} from './slicc-adapter.mjs';

const ok = (stdout = '') => ({ stdout, stderr: '', status: 0, timedOut: false });
const fail = (stderr, status = 1) => ({ stdout: '', stderr, status, timedOut: false });

function fakeLeader({ verbs = {}, commands = [] } = {}) {
  const calls = [];
  const leader = {
    cli: vi.fn(async (args, opts = {}) => {
      calls.push({ kind: 'cli', args, opts });
      const reply = verbs[args[0]];
      return typeof reply === 'function' ? reply(args, opts) : (reply ?? ok());
    }),
    exec: vi.fn(async (command, opts = {}) => {
      calls.push({ kind: 'exec', command, opts });
      for (const [pattern, reply] of commands) {
        if (pattern.test(command))
          return typeof reply === 'function' ? reply(command, opts) : reply;
      }
      return ok();
    }),
  };
  return { leader, calls };
}

const TRANSCRIPT = {
  schemaVersion: 1,
  conversations: [
    {
      id: 'scoop-1',
      kind: 'scoop',
      name: 'helper',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'scoop says hi' }],
          model: { id: 'global.anthropic.claude-haiku-4-5' },
        },
      ],
    },
    {
      id: 'cone',
      kind: 'cone',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Open it.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Opening.' },
            {
              type: 'tool-call',
              id: 't1',
              name: 'bash',
              input: { command: 'playwright-cli open https://example.com' },
            },
          ],
          model: { id: 'global.anthropic.claude-sonnet-5' },
        },
        {
          role: 'tool-result',
          toolCallId: 't1',
          content: [{ type: 'text', text: 'x'.repeat(5000) }],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'FINAL ANSWER: done' },
            { type: 'attachment-ref', attachmentId: 'a1' },
            { type: 'mystery' },
          ],
          model: { id: 'global.anthropic.claude-sonnet-5' },
        },
      ],
    },
  ],
};

describe('prompt and quoting', () => {
  it('adds upstream closing instruction to the task text', () => {
    expect(buildPrompt({ task: '  Do it.  ' })).toBe(`Do it.\n\n${FINAL_INSTRUCTION}\n`);
    expect(FINAL_INSTRUCTION).toContain('FINAL ANSWER: <your concise answer, on one line>');
  });

  it('single-quotes for the leader shell', () => {
    expect(quote("it's")).toBe(`'it'\\''s'`);
    expect(quote(42)).toBe(`'42'`);
  });
});

describe('skills conditions', () => {
  it('parses none, builtin, and extra sets', () => {
    expect(parseSkillsCondition('none')).toEqual({ name: 'none', builtin: false, extras: [] });
    expect(parseSkillsCondition(' builtin+ecoverse ')).toEqual({
      name: 'builtin+ecoverse',
      builtin: true,
      extras: ['ecoverse'],
    });
    expect(parseSkillsCondition('none+a+b')).toEqual({
      name: 'none+a+b',
      builtin: false,
      extras: ['a', 'b'],
    });
    expect(() => parseSkillsCondition('ecoverse')).toThrow(/must start with none or builtin/);
    expect(() => parseSkillsCondition('builtin+../x')).toThrow(/bad skill set name/);
  });

  it('stashes once, then rebuilds /workspace/skills for the condition', () => {
    const cmd = stageSkillsCommand(parseSkillsCondition('builtin+ecoverse'));
    expect(cmd).toContain('if [ ! -d /workspace/.bench-skills-builtin ]');
    expect(cmd).toContain('cp -r /workspace/.bench-skills-builtin/. /workspace/skills/');
    expect(cmd).toContain('cp -r /workspace/bench-skills/ecoverse/. /workspace/skills/');
    expect(stageSkillsCommand(parseSkillsCondition('none'))).not.toContain(
      'cp -r /workspace/.bench-skills-builtin/. /workspace/skills/'
    );
    expect(restoreSkillsCommand()).toContain(
      'cp -r /workspace/.bench-skills-builtin/. /workspace/skills/'
    );
  });

  it('reports how many skills are staged over exec, and fails loudly', async () => {
    const { leader } = fakeLeader({
      commands: [[/ls \/workspace\/skills \| wc -l$/, ok('x\n29\n')]],
    });
    expect(await stageSkills(leader, parseSkillsCondition('builtin'))).toBe(29);
    await restoreSkills(leader);
    const broken = fakeLeader({ commands: [[/./, fail('cp: no such file')]] });
    await expect(stageSkills(broken.leader, parseSkillsCondition('none'))).rejects.toThrow(
      /exited 1: cp: no such file/
    );
    const odd = fakeLeader({ commands: [[/./, ok('n/a')]] });
    expect(await stageSkills(odd.leader, parseSkillsCondition('none'))).toBe(0);
  });
});

describe('leader output parsing', () => {
  it('reads tab lists and cost totals', () => {
    expect(
      parseTabList('[AB12] https://example.com/ "Example"\nNo tabs open\n[CD] about:blank ""')
    ).toEqual([
      { id: 'AB12', url: 'https://example.com/' },
      { id: 'CD', url: 'about:blank' },
    ]);
    expect(parseTabList(undefined)).toEqual([]);
    const cost = JSON.stringify({
      scoops: [
        { type: 'cone', turns: 3, usage: { totalTokens: 100, cost: { total: 0.25 } } },
        { type: 'scoop', turns: 1, usage: { totalTokens: 50, cost: { total: 0.05 } } },
        { type: 'scoop' },
      ],
    });
    expect(costTotals(cost)).toEqual({ cost: 0.3, tokens: 150, turns: 4 });
    expect(costTotals('not json')).toBeNull();
    expect(costTotals('null')).toBeNull();
    expect(costTotals('{}')).toEqual({ cost: 0, tokens: 0, turns: 0 });
  });

  it('turns the exported conversations into judge steps, cone first', () => {
    const t = transcriptSteps(TRANSCRIPT);
    expect(t.steps[0]).toBe('## cone · user\nOpen it.');
    expect(t.steps[1]).toContain(
      '→ tool bash: {"command":"playwright-cli open https://example.com"}'
    );
    expect(t.steps[2]).toMatch(/^## cone · tool result\nx{4000} … \[1000 more characters\]$/);
    expect(t.steps[3]).toBe('## cone · assistant\nFINAL ANSWER: done\n[attachment a1]');
    expect(t.steps[4]).toBe('## scoop helper · assistant\nscoop says hi');
    expect(t).toMatchObject({
      assistantTurns: 2,
      models: ['global.anthropic.claude-haiku-4-5', 'global.anthropic.claude-sonnet-5'],
    });
    expect(transcriptSteps(null)).toEqual({ steps: [], models: [], assistantTurns: 0 });
    expect(
      transcriptSteps({ conversations: [{ id: 's', kind: 'scoop', messages: [{ role: 'user' }] }] })
        .steps
    ).toEqual(['## scoop s · user\n']);
  });

  it('builds the judge trace from a run result', () => {
    const trace = traceFromResult({
      finalText: 'FINAL ANSWER: done\n',
      transcript: TRANSCRIPT,
      screenshots: [{ label: 'x', base64: 'AA' }],
      durationMs: 12000,
      costUsd: 0.05,
      tokens: 100,
      exitCode: 0,
      tabs: ['https://example.com/'],
      modelId: 'bedrock-camp:global.anthropic.claude-sonnet-5',
    });
    expect(trace.finalResult).toBe('FINAL ANSWER: done');
    expect(trace.steps).toHaveLength(5);
    expect(trace.outputFilesText).toBeNull();
    expect(trace.metrics).toEqual({
      steps: 2,
      duration: 12,
      cost: 0.05,
      tokens: 100,
      exitCode: 0,
      timedOut: false,
      tabs: ['https://example.com/'],
      model: 'bedrock-camp:global.anthropic.claude-sonnet-5',
      modelsUsed: ['global.anthropic.claude-haiku-4-5', 'global.anthropic.claude-sonnet-5'],
    });
  });

  it('explains a run without an answer or a transcript', () => {
    const timedOut = traceFromResult({
      finalText: '',
      timedOut: true,
      transcript: null,
      durationMs: 1000,
      exitCode: 130,
      turns: 4,
    });
    expect(timedOut.finalResult).toMatch(/time limit/);
    expect(timedOut.steps).toEqual(['(no transcript could be exported; prompt exit code 130)']);
    expect(timedOut.metrics).toMatchObject({ steps: 4, model: null, modelsUsed: [], tabs: [] });
    expect(timedOut.screenshots).toEqual([]);
    expect(
      traceFromResult({ finalText: ' ', stderr: 'prompt: model not allowed', durationMs: 0 })
        .finalResult
    ).toBe('The run failed: prompt: model not allowed');
    expect(traceFromResult({ durationMs: 0 }).metrics.steps).toBe(0);
  });
});

describe('capture', () => {
  it('screenshots changed tabs while the cone works, then once more at the end', async () => {
    let tabs = '[T1] https://a.example/ "A"';
    const { leader, calls } = fakeLeader({
      commands: [[/^playwright-cli tab-list$/, () => ok(tabs)]],
    });
    const shooter = startCapture(leader, '/tmp/bench/r', { pollMs: 5, recaptureMs: 60_000 });
    await new Promise((r) => setTimeout(r, 30));
    tabs = '[T1] https://a.example/next "A2"';
    await new Promise((r) => setTimeout(r, 30));
    const shots = await shooter.stop();
    const taken = calls.filter(
      (c) => c.kind === 'exec' && c.command.startsWith('playwright-cli screenshot')
    );
    expect(taken[0].command).toBe(
      "playwright-cli screenshot --tab='T1' --filename=/tmp/bench/r/shot-001.png --max-width=1280"
    );
    expect(shots.map((s) => s.label.replace(/^\d+ s/, 'N s'))).toEqual([
      'N s into the run, https://a.example/',
      'N s into the run, https://a.example/next',
      'N s into the run, https://a.example/next',
    ]);
  });

  it('keeps going when a screenshot or the tab list fails', async () => {
    const { leader } = fakeLeader({
      commands: [
        [/^playwright-cli tab-list$/, ok('[T1] https://a/ "A"')],
        [/^playwright-cli screenshot/, fail('tab gone')],
      ],
    });
    const shooter = startCapture(leader, '/tmp/bench/r', { pollMs: 5 });
    await new Promise((r) => setTimeout(r, 20));
    expect(await shooter.stop()).toEqual([]);
    const down = {
      exec: vi.fn(async () => {
        throw new Error('leader gone');
      }),
    };
    expect(await startCapture(down, '/tmp/bench/r', { pollMs: 5 }).stop()).toEqual([]);
  });

  it('reads screenshots back, dropping repeats and keeping the last ones', async () => {
    const bodies = { a: 'QUFB\nQUFB', b: 'QkJC', c: 'Q0ND' };
    const { leader } = fakeLeader({
      commands: [
        [/base64 '\/s\/missing.png'/, fail('no such file')],
        [/base64 '\/s\/(\w)\d?\.png'/, (cmd) => ok(bodies[/\/s\/(\w)/.exec(cmd)[1]])],
      ],
    });
    const shots = ['a', 'a2', 'missing', 'b', 'c'].map((n) => ({ path: `/s/${n}.png`, label: n }));
    const read = await readShots(leader, shots, 2);
    expect(read.taken).toBe(3);
    expect(read.images).toEqual([
      { label: 'b', format: 'png', base64: 'QkJC' },
      { label: 'c', format: 'png', base64: 'Q0ND' },
    ]);
  });

  it('exports the conversation with session export and unzip', async () => {
    const { leader, calls } = fakeLeader({
      commands: [[/^session export/, ok(JSON.stringify(TRANSCRIPT))]],
    });
    expect(await exportTranscript(leader, '/tmp/bench/r')).toEqual(TRANSCRIPT);
    expect(calls[0].command).toBe(
      'session export --output /tmp/bench/r/transcript.zip >/dev/null && mkdir -p /tmp/bench/r/transcript && unzip /tmp/bench/r/transcript.zip -d /tmp/bench/r/transcript >/dev/null && cat /tmp/bench/r/transcript/transcript.json'
    );
    expect(
      await exportTranscript(fakeLeader({ commands: [[/./, fail('no session')]] }).leader, '/d')
    ).toBeNull();
    expect(
      await exportTranscript(fakeLeader({ commands: [[/./, ok('not json')]] }).leader, '/d')
    ).toBeNull();
  });
});

describe('runTask', () => {
  const COST = (total) =>
    ok(
      JSON.stringify({
        scoops: [
          {
            type: 'cone',
            turns: total * 100,
            usage: { totalTokens: total * 10000, cost: { total } },
          },
        ],
      })
    );

  function leaderFor({
    prompt = ok('FINAL ANSWER: Example Domain\n'),
    model = ok('bedrock-camp:global.anthropic.claude-sonnet-5\n'),
  } = {}) {
    let costCalls = 0;
    return fakeLeader({
      verbs: { 'new-session': ok('new session (erase)'), model, prompt },
      commands: [
        [/^cost --json --all$/, () => COST(++costCalls === 1 ? 0.1 : 0.35)],
        [/^playwright-cli tab-list$/, ok('[T1] https://example.com/ "Example"')],
        [/^session export/, ok(JSON.stringify(TRANSCRIPT))],
        [/^base64 /, ok('UE5H')],
      ],
    });
  }
  const label = (c) =>
    c.kind === 'cli' ? `slicc ${c.args.join(' ')}` : c.command.split(' ').slice(0, 2).join(' ');

  it('drives setup, the prompt, capture and teardown through the slicc CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-task-'));
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    const { leader, calls } = leaderFor();
    const task = {
      id: 't',
      task: 'Read it.',
      slicc: { timeoutSeconds: 60, files: [{ from: file, to: '/workspace/in/a.txt' }] },
    };
    const result = await runTask({
      leader,
      task,
      runId: 'r1',
      model: 'claude-sonnet-5',
      capture: { pollMs: 5 },
    });

    expect(calls.slice(0, 8).map(label)).toEqual([
      'uptime; meminfo',
      'rm -rf',
      'mkdir -p',
      'playwright-cli tab-list',
      'playwright-cli tab-close',
      'slicc new-session --erase',
      'slicc model claude-sonnet-5',
      'cost --json',
    ]);
    expect(calls[2].opts.stdin).toBe(Buffer.from('hello').toString('base64'));
    const prompt = calls.find((c) => c.kind === 'cli' && c.args[0] === 'prompt');
    expect(prompt.args).toEqual(['prompt', '-']);
    expect(prompt.opts).toEqual({ stdin: buildPrompt(task), timeoutMs: 60000, interrupt: true });
    expect(calls.slice(-4).map(label)).toEqual([
      'playwright-cli tab-list',
      'playwright-cli tab-close',
      'slicc new-session --erase',
      'rm -rf',
    ]);
    expect(result).toMatchObject({
      runId: 'r1',
      model: 'claude-sonnet-5',
      modelId: 'bedrock-camp:global.anthropic.claude-sonnet-5',
      exitCode: 0,
      timedOut: false,
      finalText: 'FINAL ANSWER: Example Domain\n',
      tokens: 2500,
      turns: 25,
      transcript: TRANSCRIPT,
      tabs: ['https://example.com/'],
    });
    expect(result.costUsd).toBeCloseTo(0.25);
    expect(result.screenshots[0]).toMatchObject({ format: 'png', base64: 'UE5H' });
    expect(Object.keys(result.phases)).toEqual(['setupMs', 'promptMs', 'collectMs']);
    expect(result.health.before).toMatchObject({ ok: true, leaderDown: false });
    expect(result.health.after).toMatchObject({ ok: true });

    const promptAt = calls.indexOf(prompt);
    const closeAt = calls.findIndex(
      (c, i) => i > promptAt && label(c) === 'playwright-cli tab-close'
    );
    const exportAt = calls.findIndex((c) => c.command?.startsWith('session export'));
    expect(closeAt).toBeGreaterThan(promptAt);
    expect(closeAt).toBeLessThan(exportAt);
  });

  it('turns a prompt that never reached the leader into a leader-down error', async () => {
    const down = {
      stdout: '',
      stderr: 'tray connect timed out after 30s',
      status: 1,
      timedOut: false,
      leaderDown: true,
    };
    const { leader } = leaderFor({ prompt: down });
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'r5',
      model: 'm',
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err.message).toMatch(/slicc prompt exited 1: tray connect timed out/);
    expect(err.leaderDown).toBe(true);
    const setup = fakeLeader({ commands: [[/^rm -rf/, { ...down }]] });
    const setupErr = await runTask({
      leader: setup.leader,
      task: { id: 't', task: 'x' },
      runId: 'r6',
      model: 'm',
    }).catch((e) => e);
    expect(setupErr.leaderDown).toBe(true);
    const plain = fakeLeader({ commands: [[/^rm -rf/, fail('rm: denied')]] });
    const plainErr = await runTask({
      leader: plain.leader,
      task: { id: 't', task: 'x' },
      runId: 'r7',
      model: 'm',
    }).catch((e) => e);
    expect(plainErr.leaderDown).toBe(false);
  });

  it('records spend as unknown when a reading fails, never as a negative delta', async () => {
    const { leader } = fakeLeader({
      verbs: { model: ok('m\n'), prompt: ok('FINAL ANSWER: x') },
      commands: [[/^cost --json --all$/, fail('cost: busy')]],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'r8',
      model: 'm',
      capture: { pollMs: 5 },
    });
    expect(result).toMatchObject({ costUsd: null, tokens: null, turns: null });
    expect(traceFromResult(result).metrics.cost).toBeNull();
    const t = { cost: 0.5, tokens: 10, turns: 2 };
    expect(spendDelta(t, { cost: 0.2, tokens: 3, turns: 1 })).toEqual({
      costUsd: null,
      tokens: null,
      turns: null,
    });
    expect(spendDelta(null, t)).toEqual({ costUsd: null, tokens: null, turns: null });
    expect(spendDelta({ cost: 0.1, tokens: 4, turns: 1 }, t)).toEqual({
      costUsd: 0.4,
      tokens: 6,
      turns: 1,
    });
  });

  it('reads the leader health, and reports it failing without throwing', async () => {
    const good = fakeLeader({ commands: [[/^uptime/, ok('up 1:02, load 0.5\nprocesses: 12\n')]] });
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1250);
    expect(await leaderHealth(good.leader, now)).toEqual({
      at: new Date(1000).toISOString(),
      ok: true,
      ms: 250,
      leaderDown: false,
      text: 'up 1:02, load 0.5\nprocesses: 12',
    });
    expect(good.calls[0].opts.timeoutMs).toBe(60000);
    const bad = fakeLeader({
      commands: [
        [/^uptime/, { stdout: '', stderr: 'tray connect timed out', status: 1, leaderDown: true }],
      ],
    });
    expect(await leaderHealth(bad.leader)).toMatchObject({
      ok: false,
      leaderDown: true,
      text: 'tray connect timed out',
    });
  });

  it('returns a timed-out prompt for judging, and still tears down', async () => {
    const { leader, calls } = leaderFor({
      prompt: { stdout: 'partial', stderr: '', status: 130, timedOut: true },
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'Slow.' },
      runId: 'r2',
      model: 'm',
      timeoutSeconds: 30,
      capture: { pollMs: 5 },
    });
    expect(result).toMatchObject({ exitCode: 130, timedOut: true, finalText: 'partial' });
    expect(calls.find((c) => c.kind === 'cli' && c.args[0] === 'prompt').opts.timeoutMs).toBe(
      30000
    );
    expect(calls.at(-1).command).toBe('rm -rf /tmp/bench/r2');
  });

  it('fails setup loudly — a model the leader lacks is no run — and tears down anyway', async () => {
    const { leader, calls } = leaderFor({ model: fail('slicc model: no model matches "gpt-9"') });
    await expect(
      runTask({ leader, task: { id: 't', task: 'x' }, runId: 'r3', model: 'gpt-9' })
    ).rejects.toThrow('slicc model exited 1: slicc model: no model matches "gpt-9"');
    expect(calls.some((c) => c.kind === 'cli' && c.args[0] === 'prompt')).toBe(false);
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'new-session')).toHaveLength(2);
    expect(calls.at(-1).command).toBe('rm -rf /tmp/bench/r3');
  });

  it('refuses an unsafe run id before touching the leader', async () => {
    const { leader, calls } = fakeLeader();
    await expect(
      runTask({ leader, task: { task: 'x' }, runId: 'a b', model: 'm' })
    ).rejects.toThrow(/bad run id/);
    expect(calls).toEqual([]);
  });

  it('survives a teardown that fails', async () => {
    const { leader } = leaderFor();
    const exec = leader.exec;
    let prompted = false;
    const cli = leader.cli;
    leader.cli = vi.fn(async (args, opts) => {
      if (args[0] === 'prompt') prompted = true;
      if (prompted && args[0] === 'new-session') throw new Error('leader gone');
      return cli(args, opts);
    });
    leader.exec = vi.fn(async (command, opts) => {
      if (prompted && command.startsWith('rm -rf')) throw new Error('leader gone');
      return exec(command, opts);
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'r4',
      model: 'm',
      capture: { pollMs: 5 },
    });
    expect(result.exitCode).toBe(0);
  });
});
