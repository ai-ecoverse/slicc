import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ARM_TIME_MARGIN_S,
  armAnswer,
  armCommand,
  armConversation,
  armTurns,
  assertStagedSkills,
  buildPrompt,
  collectArmFiles,
  costTotals,
  decodeTranscriptPart,
  driverAnswer,
  driverSections,
  driverSteps,
  expectedSkillNames,
  exportTranscript,
  exportTranscriptCommand,
  FINAL_INSTRUCTION,
  FLAGS_PROBE,
  lastScoopAssistantText,
  lastTurnProviderError,
  leaderHealth,
  modelPinPolicy,
  NO_DEFAULT_SKILLS_MISSING,
  PROMPT_ALL_SETTLED,
  parseArmResult,
  parseExportListing,
  parseModelSpec,
  parseSkillNames,
  parseSkillsCondition,
  parseTabList,
  pinScoopModels,
  planStagedCleanup,
  quote,
  readShots,
  restoreSkills,
  restoreSkillsCommand,
  runTask,
  skillsFlagCommand,
  skillsMismatch,
  spendDelta,
  stagedCleanupPaths,
  stageSkills,
  stageSkillsCommand,
  startCapture,
  stillWorking,
  TRANSCRIPT_EXPORT_ATTEMPTS,
  TRANSCRIPT_EXPORT_TIMEOUT_MS,
  TRANSCRIPT_PART_BYTES,
  TRANSCRIPT_READ_ATTEMPTS,
  TRANSCRIPT_READ_TIMEOUT_MS,
  toolKind,
  toolMetrics,
  toolUsage,
  traceFromResult,
  transcriptSteps,
  transcriptSummary,
  validateArm,
  watchSpend,
} from './slicc-adapter.mjs';

const ok = (stdout = '') => ({ stdout, stderr: '', status: 0, timedOut: false });
const fail = (stderr, status = 1) => ({ stdout: '', stderr, status, timedOut: false });

/**
 * A fake leader behind the `slicc` CLI: `cli(args)` answers verbs, `exec(command)` answers shell
 * commands, both from routing tables; every call is recorded in order.
 */
function fakeLeader({
  verbs = {},
  commands = [],
  catalogue = DEFAULT_CATALOGUE,
  policyWritable = true,
  policyReadable = true,
  readback = null,
  removable = true,
  probe = null,
  catalogueRaw = null,
} = {}) {
  const calls = [];
  // The leader's /etc/models and model catalogue, for the per-run scoop model pin.
  const files = new Map();
  const pinRoutes = [
    [/^models --provider /, () => ok(catalogueRaw ?? JSON.stringify(catalogue))],
    [
      /^test -e \/etc\/models$/,
      () =>
        probe ??
        (files.has('/etc/models') ? ok() : { stdout: '', stderr: '', status: 1, timedOut: false }),
    ],
    [
      /^cat \/etc\/models$/,
      () => {
        if (!policyReadable) return fail('cat: /etc/models: input/output error');
        // A read-back that disagrees with what the bench wrote (only its own pin, not a snapshot).
        if (readback !== null && files.get('/etc/models')?.startsWith('# Written by the bench'))
          return ok(readback);
        return files.has('/etc/models') ? ok(files.get('/etc/models')) : fail('no such file');
      },
    ],
    [
      /^base64 -d > \/etc\/models$/,
      (_c, opts) => {
        if (policyWritable)
          files.set('/etc/models', Buffer.from(opts.stdin ?? '', 'base64').toString());
        return ok();
      },
    ],
    [
      /^rm -f \/etc\/models$/,
      () => {
        if (!removable) return fail('rm: /etc/models: permission denied');
        files.delete('/etc/models');
        return ok();
      },
    ],
  ];
  const leader = {
    cli: vi.fn(async (args, opts = {}) => {
      calls.push({ kind: 'cli', args, opts });
      const reply = verbs[args[0]];
      return typeof reply === 'function' ? reply(args, opts) : (reply ?? ok());
    }),
    exec: vi.fn(async (command, opts = {}) => {
      calls.push({ kind: 'exec', command, opts });
      for (const [pattern, reply] of [...pinRoutes, ...commands]) {
        if (pattern.test(command))
          return typeof reply === 'function' ? reply(command, opts) : reply;
      }
      return ok();
    }),
  };
  return { leader, calls, files };
}

const DEFAULT_CATALOGUE = [
  { id: 'global.anthropic.claude-opus-5-5', provider: 'bedrock-camp' },
  { id: 'global.anthropic.claude-sonnet-4-6', provider: 'bedrock-camp' },
  { id: 'global.anthropic.claude-haiku-5-5', provider: 'bedrock-camp' },
  { id: 'm', provider: 'bedrock-camp' },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * A transcript.json as the leader holds it after `exportTranscriptCommand`: the listing the
 * export prints, and `base64` reads of its `split` parts. `commands` routes both for fakeLeader.
 */
function leaderFiles(doc, partBytes = TRANSCRIPT_PART_BYTES, dir = '/d') {
  const t = `${dir}/transcript`;
  const parts = [];
  for (let i = 0; i * partBytes < doc.length; i += 1) {
    const suffix = String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26));
    parts.push({
      path: `${t}/parts/x${suffix}`,
      bytes: doc.subarray(i * partBytes, (i + 1) * partBytes),
    });
  }
  const listing = [
    `${doc.length} ${t}/transcript.json`,
    `${sha(doc)}  ${t}/transcript.json`,
    ...parts.map((p) => `${sha(p.bytes)}  ${p.path}`),
    '',
  ].join('\n');
  const list = () => ok(listing);
  const read = (cmd) => {
    const part = parts.find((p) => cmd === `base64 '${p.path}'`);
    return part
      ? ok(`${part.bytes.toString('base64').replace(/.{76}/g, '$&\n')}\n`)
      : fail('no such file');
  };
  return {
    listing,
    parts: parts.length,
    list,
    read,
    commands: [
      [/^session export/, list],
      [/^base64 '\/[^']*\/transcript\/parts\/x[a-z]+'$/, read],
    ],
  };
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

describe('tool use', () => {
  const call = (name, input) => ({ type: 'tool-call', id: 'x', name, input });
  it('classifies a call by what it did, never keeping the command', () => {
    expect(toolKind(call('bash', { command: 'playwright-cli open https://a.test' }))).toBe(
      'browser'
    );
    expect(toolKind(call('bash', { command: 'T=AB; playwright-cli --tab=$T snapshot' }))).toBe(
      'browser'
    );
    expect(toolKind(call('bash', { command: 'curl -s https://a.test' }))).toBe('fetch');
    expect(toolKind(call('bash', { command: 'python3 -c 1' }))).toBe('code');
    expect(toolKind(call('bash', { command: 'ls -la' }))).toBe('shell');
    expect(toolKind(call('bash', { command: 'cat /workspace/skills/x/SKILL.md' }))).toBe('skill');
    expect(toolKind(call('read_file', { path: '/workspace/skills/y/SKILL.md' }))).toBe('skill');
    expect(toolKind(call('read_file', { path: '/tmp/a' }))).toBe('file');
    expect(toolKind(call('agent', {}))).toBe('other');
    expect(toolKind({ type: 'tool-call', name: 'bash' })).toBe('shell');
  });

  it('counts every conversation, and knows a missing transcript from a toolless one', () => {
    const u = toolUsage(TRANSCRIPT);
    expect(u).toMatchObject({ toolCalls: 1, webCalls: 1, answeredWithoutTools: false });
    expect(u.toolKinds).toMatchObject({ browser: 1, fetch: 0, skill: 0 });
    const bare = {
      conversations: [
        { kind: 'cone', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }] },
      ],
    };
    expect(toolUsage(bare)).toMatchObject({ toolCalls: 0, answeredWithoutTools: true });
    expect(toolUsage(null)).toBeNull();
    expect(
      toolUsage({ conversations: [{ kind: 'cone', messages: [{ role: 'user' }] }] })
    ).toBeNull();
    expect(toolMetrics(null)).toEqual({
      tool_calls: null,
      tool_kinds: null,
      web_calls: null,
      answered_without_tools: null,
    });
    expect(toolMetrics(bare)).toMatchObject({
      tool_calls: 0,
      web_calls: 0,
      answered_without_tools: true,
    });
  });
});

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

  it('stages an extra set from a mount whose stat has no identity (#3695)', async () => {
    const { Bash, InMemoryFs } = await import('just-bash');
    const fs = new InMemoryFs({
      '/workspace/skills/playwright-cli/SKILL.md': 'builtin pw',
      '/workspace/skills/other/SKILL.md': 'builtin other',
      '/workspace/bench-skills/ecoverse/strava/SKILL.md': 'extra strava',
      '/workspace/bench-skills/ecoverse/playwright-cli/SKILL.md': 'extra pw',
    });
    // Like the node-server --mount: no ino/dev/identity under /workspace/bench-skills.
    const bare = (s) => {
      const { ino, dev, identity, ...rest } = s;
      return rest;
    };
    const mounted = new Proxy(fs, {
      get(target, key) {
        if (key === 'stat' || key === 'lstat')
          return async (p) => {
            const st = await target[key](p);
            return String(p).startsWith('/workspace/bench-skills') ? bare(st) : st;
          };
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const bash = new Bash({ fs: mounted });
    const staged = await bash.exec(stageSkillsCommand(parseSkillsCondition('builtin+ecoverse')));
    expect(staged.stderr).toBe('');
    expect(staged.exitCode).toBe(0);
    expect((await bash.exec('ls /workspace/skills')).stdout.split(/\s+/).filter(Boolean)).toEqual([
      'other',
      'playwright-cli',
      'strava',
    ]);
    expect(await fs.readFile('/workspace/skills/playwright-cli/SKILL.md')).toBe('extra pw');
    // An empty extra set stages nothing and still succeeds (no nullglob in just-bash).
    await bash.exec('mkdir -p /workspace/bench-skills/empty');
    const empty = await bash.exec(stageSkillsCommand(parseSkillsCondition('builtin+empty')));
    expect(empty.stderr).toBe('');
    expect(empty.exitCode).toBe(0);
  });

  it('stashes once, then rebuilds /workspace/skills for the condition', () => {
    const cmd = stageSkillsCommand(parseSkillsCondition('builtin+ecoverse'));
    expect(cmd).toContain('if [ ! -d /workspace/.bench-skills-builtin ]');
    expect(cmd).toContain('cp -r /workspace/.bench-skills-builtin/. /workspace/skills/');
    expect(cmd).toContain('for s in /workspace/bench-skills/ecoverse/*; do');
    expect(cmd).not.toContain('/workspace/bench-skills/ecoverse/. ');
    expect(skillsFlagCommand(parseSkillsCondition('none'))).toBe('flags set no-default-skills on');
    expect(skillsFlagCommand(parseSkillsCondition('builtin'))).toBe(
      'flags set no-default-skills off'
    );
    expect(skillsFlagCommand(parseSkillsCondition('none+ecoverse'))).toBe(
      'flags set no-default-skills on'
    );
    expect(stageSkillsCommand(parseSkillsCondition('none'))).not.toContain('flags set');
    expect(stageSkillsCommand(parseSkillsCondition('none'))).not.toContain(
      'cp -r /workspace/.bench-skills-builtin/. /workspace/skills/'
    );
    expect(restoreSkillsCommand()).not.toContain('flags set');
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
    const broken = fakeLeader({
      commands: [
        [/^command -v flags$/, ok()],
        [/^flags set /, ok()],
        [/./, fail('cp: no such file')],
      ],
    });
    await expect(stageSkills(broken.leader, parseSkillsCondition('none'))).rejects.toThrow(
      /exited 1: cp: no such file/
    );
    const odd = fakeLeader({ commands: [[/./, ok('n/a')]] });
    expect(await stageSkills(odd.leader, parseSkillsCondition('none'))).toBe(0);
  });

  it('skips a missing flags verb for builtin and refuses none', async () => {
    const withoutFlags = (extra = []) =>
      fakeLeader({
        commands: [
          [new RegExp(`^${FLAGS_PROBE}$`), fail('', 127)],
          [/^flags /, fail('bash: flags: command not found', 127)],
          ...extra,
        ],
      });

    const builtin = withoutFlags([[/ls \/workspace\/skills \| wc -l$/, ok('29\n')]]);
    expect(await stageSkills(builtin.leader, parseSkillsCondition('builtin'))).toBe(29);
    expect(builtin.calls.map((c) => c.command)).toEqual([
      FLAGS_PROBE,
      stageSkillsCommand(parseSkillsCondition('builtin')),
    ]);

    await restoreSkills(builtin.leader);
    expect(builtin.calls.map((c) => c.command).slice(-2)).toEqual([
      restoreSkillsCommand(),
      FLAGS_PROBE,
    ]);

    const none = withoutFlags();
    await expect(stageSkills(none.leader, parseSkillsCondition('none'))).rejects.toThrow(
      NO_DEFAULT_SKILLS_MISSING
    );
    await expect(stageSkills(none.leader, parseSkillsCondition('none+ecoverse'))).rejects.toThrow(
      /pin-webapp/
    );
    expect(none.calls.map((c) => c.command)).toEqual([FLAGS_PROBE, FLAGS_PROBE]);

    const setFails = fakeLeader({
      commands: [
        [new RegExp(`^${FLAGS_PROBE}$`), ok()],
        [/^flags set /, fail('unknown flag', 2)],
      ],
    });
    await expect(stageSkills(setFails.leader, parseSkillsCondition('builtin'))).rejects.toThrow(
      /exited 2: unknown flag/
    );
  });

  it('compares the directory after new-session with the condition', () => {
    const none = parseSkillsCondition('none');
    const builtin = parseSkillsCondition('builtin');
    const mixed = parseSkillsCondition('none+ecoverse');
    expect(parseSkillNames('playwright-cli\n\nwiki')).toEqual(['playwright-cli', 'wiki']);
    expect(expectedSkillNames(none)).toEqual([]);
    expect(expectedSkillNames(builtin, { builtin: ['wiki', 'playwright-cli'] })).toEqual([
      'playwright-cli',
      'wiki',
    ]);
    expect(expectedSkillNames(mixed, { builtin: ['wiki'], extras: [['ecoverse-skill']] })).toEqual([
      'ecoverse-skill',
    ]);
    expect(skillsMismatch(none, [], [])).toBeNull();
    expect(skillsMismatch(none, ['playwright-cli'], [])).toMatch(/re-seeded/);
    expect(skillsMismatch(none, ['playwright-cli'], [])).toContain('(empty)');
  });

  it('fails the run when new-session left bundled skills in place', async () => {
    const none = parseSkillsCondition('none');
    const empty = fakeLeader({
      commands: [[/ls '\/workspace\/skills'/, ok('')]],
    });
    await expect(assertStagedSkills(empty.leader, none)).resolves.toBeUndefined();

    const reseeded = fakeLeader({
      commands: [
        [new RegExp(`^${FLAGS_PROBE}$`), fail('', 127)],
        [/^flags /, fail('bash: flags: command not found', 127)],
        [/ls '\/workspace\/skills'/, ok('playwright-cli\nwiki\n')],
      ],
    });
    await expect(assertStagedSkills(reseeded.leader, none)).rejects.toThrow(/playwright-cli/);

    const builtin = parseSkillsCondition('builtin+ecoverse');
    const matched = fakeLeader({
      commands: [
        [/ls '\/workspace\/skills'/, ok('ecoverse-skill\nplaywright-cli\n')],
        [/ls '\/workspace\/.bench-skills-builtin'/, ok('playwright-cli\n')],
        [/ls '\/workspace\/bench-skills\/ecoverse'/, ok('ecoverse-skill\n')],
      ],
    });
    await expect(assertStagedSkills(matched.leader, builtin)).resolves.toBeUndefined();
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
      tool_calls: 1,
      tool_kinds: { browser: 1, fetch: 0, code: 0, shell: 0, file: 0, skill: 0, other: 0 },
      web_calls: 1,
      answered_without_tools: false,
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
});

describe('transcript export', () => {
  it('exports, splits and lists the transcript in one leader command', () => {
    expect(exportTranscriptCommand('/tmp/bench/r', 1024)).toBe(
      [
        'session export --output /tmp/bench/r/transcript.zip >/dev/null',
        'rm -rf /tmp/bench/r/transcript',
        'mkdir -p /tmp/bench/r/transcript/parts',
        'unzip /tmp/bench/r/transcript.zip -d /tmp/bench/r/transcript >/dev/null',
        'split -b 1024 /tmp/bench/r/transcript/transcript.json /tmp/bench/r/transcript/parts/x',
        'wc -c /tmp/bench/r/transcript/transcript.json',
        'sha256sum /tmp/bench/r/transcript/transcript.json /tmp/bench/r/transcript/parts/*',
      ].join(' && ')
    );
    expect(exportTranscriptCommand('/d')).toContain(`split -b ${TRANSCRIPT_PART_BYTES} `);
  });

  it('reads the listing, and refuses one that does not add up', () => {
    const doc = Buffer.from('x'.repeat(25));
    const { listing } = leaderFiles(doc, 10);
    expect(parseExportListing(listing, 10)).toEqual({
      bytes: 25,
      sha256: sha(doc),
      parts: [
        { path: '/d/transcript/parts/xaa', sha256: sha(doc.subarray(0, 10)), bytes: 10 },
        { path: '/d/transcript/parts/xab', sha256: sha(doc.subarray(10, 20)), bytes: 10 },
        { path: '/d/transcript/parts/xac', sha256: sha(doc.subarray(20)), bytes: 5 },
      ],
    });
    const lines = listing.split('\n');
    // A part missing from the listing, no size, no file hash, or nothing at all.
    expect(parseExportListing(lines.filter((l) => !l.endsWith('xab')).join('\n'), 10)).toBeNull();
    expect(parseExportListing(lines.slice(1).join('\n'), 10)).toBeNull();
    expect(
      parseExportListing(lines.filter((l) => !/^[0-9a-f]{64}\s+\S+json$/.test(l)).join('\n'), 10)
    ).toBeNull();
    expect(parseExportListing(undefined)).toBeNull();
  });

  it('decodes a part only when it is whole and matches its hash', () => {
    const bytes = Buffer.from('hello, transcript');
    const part = { path: '/p', bytes: bytes.length, sha256: sha(bytes) };
    const b64 = bytes.toString('base64');
    expect(decodeTranscriptPart(`${b64.slice(0, 8)}\n${b64.slice(8)}\n`, part).buf).toEqual(bytes);
    expect(decodeTranscriptPart('', part)).toEqual({ error: 'empty' });
    expect(decodeTranscriptPart('not base64!', part)).toEqual({ error: 'not base64' });
    expect(decodeTranscriptPart(b64.slice(0, 8), part)).toEqual({
      error: `6 of ${bytes.length} bytes`,
    });
    const other = Buffer.from('HELLO, transcript').toString('base64');
    expect(decodeTranscriptPart(other, part)).toEqual({ error: 'checksum mismatch' });
  });

  it('reassembles a multi-megabyte transcript from verified parts', async () => {
    const big = {
      ...TRANSCRIPT,
      conversations: [
        ...TRANSCRIPT.conversations,
        {
          id: 'scoop-2',
          kind: 'scoop',
          messages: Array.from({ length: 400 }, (_, i) => ({
            role: 'tool-result',
            content: [{ type: 'text', text: `${i} ünïcödé ✓ ${'y'.repeat(25_000)}` }],
          })),
        },
      ],
    };
    const doc = Buffer.from(JSON.stringify(big));
    expect(doc.length).toBeGreaterThan(9 * 1024 * 1024);
    // What the tray does to one exec's stdout over 8 MiB, as measured on a live leader: the CLI
    // exits 0 with nothing on stdout. A single `cat` of this transcript would arrive empty.
    const trayCap = (reply) => (cmd, opts) => {
      const r = typeof reply === 'function' ? reply(cmd, opts) : reply;
      return Buffer.byteLength(r.stdout) * (4 / 3) > 8 * 1024 * 1024 ? ok('') : r;
    };
    expect(trayCap(ok(doc.toString()))('cat').stdout).toBe('');
    const { leader, calls } = fakeLeader({
      commands: leaderFiles(doc).commands.map(([p, reply]) => [p, trayCap(reply)]),
    });
    const clock = vi.fn().mockReturnValueOnce(1000).mockReturnValue(4000);
    const { doc: read, info } = await exportTranscript(leader, '/d', { now: clock });
    expect(read).toEqual(big);
    expect(info).toEqual({
      ok: true,
      bytes: doc.length,
      parts: Math.ceil(doc.length / TRANSCRIPT_PART_BYTES),
      exports: 1,
      reads: Math.ceil(doc.length / TRANSCRIPT_PART_BYTES),
      ms: 3000,
    });
    expect(calls[0].opts.timeoutMs).toBe(TRANSCRIPT_EXPORT_TIMEOUT_MS);
    expect(calls[1]).toMatchObject({
      command: "base64 '/d/transcript/parts/xaa'",
      opts: { timeoutMs: TRANSCRIPT_READ_TIMEOUT_MS },
    });
  });

  it('reads a truncated or corrupted part again', async () => {
    const doc = Buffer.from(JSON.stringify(TRANSCRIPT));
    const files = leaderFiles(doc, 1000);
    let reads = 0;
    const { leader } = fakeLeader({
      commands: [
        [
          /parts\/xab'$/,
          (cmd) => {
            reads += 1;
            const good = files.read(cmd);
            // First the tray cuts it short, then it arrives with a flipped byte, then whole.
            if (reads === 1) return ok(good.stdout.slice(0, 400));
            if (reads === 2)
              return ok(`${good.stdout[0] === 'A' ? 'B' : 'A'}${good.stdout.slice(1)}`);
            return good;
          },
        ],
        ...files.commands,
      ],
    });
    const { doc: read, info } = await exportTranscript(leader, '/d', { partBytes: 1000 });
    expect(read).toEqual(TRANSCRIPT);
    expect(info).toMatchObject({ ok: true, parts: files.parts, reads: files.parts + 2 });
  });

  it('reads a part again after the connection dropped mid-transfer', async () => {
    const doc = Buffer.from(JSON.stringify(TRANSCRIPT));
    const files = leaderFiles(doc, 1000);
    let dropped = false;
    const { leader } = fakeLeader({
      commands: [
        [
          /parts\/xaa'$/,
          (cmd) => {
            if (dropped) return files.read(cmd);
            dropped = true;
            // What the executor returns for a connection that closed mid-call.
            return {
              ...fail('slicc exec: connection closed'),
              leaderDown: true,
              connectionLost: true,
            };
          },
        ],
        ...files.commands,
      ],
    });
    const { doc: read, info } = await exportTranscript(leader, '/d', { partBytes: 1000 });
    expect(read).toEqual(TRANSCRIPT);
    expect(info).toMatchObject({ ok: true, reads: files.parts + 1 });
  });

  it('gives up on a part that never arrives intact, and says why', async () => {
    const doc = Buffer.from(JSON.stringify(TRANSCRIPT));
    const files = leaderFiles(doc, 1000);
    const { leader } = fakeLeader({
      commands: [[/parts\/xab'$/, fail('slicc exec: connection closed')], ...files.commands],
    });
    const { doc: read, info } = await exportTranscript(leader, '/d', { partBytes: 1000 });
    expect(read).toBeNull();
    expect(info).toMatchObject({
      ok: false,
      stage: 'read',
      reason: 'exit 1',
      detail: 'slicc exec: connection closed',
      reads: 1 + TRANSCRIPT_READ_ATTEMPTS,
    });
    const down = fakeLeader({
      commands: [
        [/^base64/, { stdout: '', stderr: 'tray connect timed out', status: 1, leaderDown: true }],
        ...files.commands,
      ],
    });
    const gone = await exportTranscript(down.leader, '/d', { partBytes: 1000 });
    expect(gone.info).toMatchObject({ ok: false, stage: 'read', reason: 'leader-down', reads: 1 });
    const short = fakeLeader({ commands: [[/^base64/, ok('QUFB')], ...files.commands] });
    expect((await exportTranscript(short.leader, '/d', { partBytes: 1000 })).info).toMatchObject({
      stage: 'read',
      reason: '3 of 1000 bytes',
    });
  });

  it('stops collecting when its budget runs out, giving each call only what is left', async () => {
    const doc = Buffer.from(JSON.stringify(TRANSCRIPT));
    const files = leaderFiles(doc, 1000);
    // Every leader call takes five minutes of a fifteen-minute budget; the parts arrive short.
    let t = 0;
    const slow = (reply) => (cmd, opts) => {
      t += 5 * 60_000;
      return typeof reply === 'function' ? reply(cmd, opts) : reply;
    };
    const { leader, calls } = fakeLeader({
      commands: [[/^base64/, ok('QUFB')], ...files.commands].map(([p, r]) => [p, slow(r)]),
    });
    const { doc: read, info } = await exportTranscript(leader, '/d', {
      partBytes: 1000,
      now: () => t,
    });
    expect(read).toBeNull();
    expect(info).toMatchObject({
      ok: false,
      stage: 'budget',
      reason: 'out of time',
      detail: 'read: 3 of 1000 bytes',
      exports: 1,
      reads: 2,
      ms: 15 * 60_000,
    });
    expect(calls.map((c) => c.opts.timeoutMs)).toEqual([
      TRANSCRIPT_EXPORT_TIMEOUT_MS,
      TRANSCRIPT_READ_TIMEOUT_MS,
      TRANSCRIPT_READ_TIMEOUT_MS,
    ]);
    t = 0;
    const tight = fakeLeader({ commands: files.commands.map(([p, r]) => [p, slow(r)]) });
    const cut = await exportTranscript(tight.leader, '/d', {
      partBytes: 1000,
      budgetMs: 5 * 60_000 + 10_000,
      now: () => t,
    });
    expect(tight.calls[1].opts.timeoutMs).toBe(10_000);
    expect(cut.info).toMatchObject({ stage: 'budget', reads: 1 });
    expect(cut.info.detail).toBeUndefined();
    const none = await exportTranscript(tight.leader, '/d', { budgetMs: 0 });
    expect(none.info).toMatchObject({ stage: 'budget', exports: 0 });
  });

  it('tries a failed export again, but not one that timed out or never reached the leader', async () => {
    const doc = Buffer.from(JSON.stringify(TRANSCRIPT));
    const files = leaderFiles(doc);
    let exports = 0;
    const flaky = fakeLeader({
      commands: [
        [
          /^session export/,
          (cmd) => (++exports === 1 ? fail('connection closed') : files.list(cmd)),
        ],
        ...files.commands,
      ],
    });
    const again = await exportTranscript(flaky.leader, '/d');
    expect(again.doc).toEqual(TRANSCRIPT);
    expect(again.info).toMatchObject({ ok: true, exports: 2 });

    const slow = fakeLeader({
      commands: [[/^session export/, { stdout: '', stderr: '', status: 130, timedOut: true }]],
    });
    expect((await exportTranscript(slow.leader, '/d')).info).toMatchObject({
      ok: false,
      stage: 'export',
      reason: 'timeout',
      exports: 1,
      bytes: null,
    });
    const down = fakeLeader({
      commands: [[/^session export/, { stdout: '', stderr: 'x', status: 1, leaderDown: true }]],
    });
    expect((await exportTranscript(down.leader, '/d')).info).toMatchObject({
      reason: 'leader-down',
      exports: 1,
    });
    const broken = fakeLeader({ commands: [[/./, fail('session export: no session')]] });
    expect((await exportTranscript(broken.leader, '/d')).info).toMatchObject({
      stage: 'export',
      reason: 'exit 1',
      detail: 'session export: no session',
      exports: TRANSCRIPT_EXPORT_ATTEMPTS,
    });
  });

  it('reports a listing that does not add up (the old empty-stdout failure)', async () => {
    const { leader } = fakeLeader({ commands: [[/^session export/, ok('')]] });
    const { doc, info } = await exportTranscript(leader, '/d');
    expect(doc).toBeNull();
    expect(info).toMatchObject({ ok: false, stage: 'export', reason: 'listing', exports: 2 });
  });

  it('checks the reassembled file, and that it is a transcript', async () => {
    const doc = Buffer.from(JSON.stringify(TRANSCRIPT));
    // The listing names a whole-file hash the parts do not add up to.
    const lying = leaderFiles(doc, 1000);
    const listing = lying.listing.replace(
      /^[0-9a-f]{64}(?=\s+\S+transcript\.json$)/m,
      '0'.repeat(64)
    );
    const bad = fakeLeader({ commands: [[/^session export/, ok(listing)], ...lying.commands] });
    expect((await exportTranscript(bad.leader, '/d', { partBytes: 1000 })).info).toMatchObject({
      stage: 'verify',
      reason: 'checksum mismatch',
    });
    for (const [text, reason] of [
      ['{"schemaVersion":1', 'not JSON'],
      ['{"schemaVersion":1}', 'not a transcript'],
      ['null', 'not a transcript'],
    ]) {
      const { leader } = fakeLeader({ commands: leaderFiles(Buffer.from(text)).commands });
      const { doc: read, info } = await exportTranscript(leader, '/d');
      expect(read).toBeNull();
      expect(info).toMatchObject({ ok: false, stage: 'parse', reason });
      expect(info.detail).toBeUndefined();
    }
  });

  it('keeps the export outcome in the trace, without the leader stderr', () => {
    const transcriptExport = {
      ok: false,
      bytes: null,
      parts: 0,
      exports: 1,
      reads: 0,
      ms: 600000,
      stage: 'export',
      reason: 'timeout',
      detail: 'stderr tail',
    };
    const trace = traceFromResult({ durationMs: 0, exitCode: 130, transcriptExport });
    expect(trace.steps).toEqual([
      '(no transcript could be exported: export timeout; prompt exit code 130)',
    ]);
    expect(trace.metrics.transcript).toEqual(transcriptSummary(transcriptExport));
    expect(trace.metrics.transcript.detail).toBeUndefined();
    const fine = traceFromResult({
      durationMs: 0,
      transcript: TRANSCRIPT,
      transcriptExport: { ok: true, bytes: 10, parts: 1, exports: 1, reads: 1, ms: 5 },
    });
    expect(fine.metrics.transcript).toEqual({
      ok: true,
      bytes: 10,
      parts: 1,
      exports: 1,
      reads: 1,
      ms: 5,
    });
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
    prompt = ok('FINAL ANSWER: done\n'),
    model = ok('bedrock-camp:global.anthropic.claude-sonnet-5\n'),
    commands: extra = [],
    ...pinOptions
  } = {}) {
    let costCalls = 0;
    return fakeLeader({
      ...pinOptions,
      verbs: { 'new-session': ok('new session (erase)'), model, prompt },
      commands: [
        ...extra,
        [/^cost --json --all$/, () => COST(++costCalls === 1 ? 0.1 : 0.35)],
        [/^playwright-cli tab-list$/, ok('[T1] https://example.com/ "Example"')],
        ...leaderFiles(Buffer.from(JSON.stringify(TRANSCRIPT))).commands,
        [/^base64 /, ok('UE5H')],
      ],
    });
  }
  const label = (c) =>
    c.kind === 'cli' ? `slicc ${c.args.join(' ')}` : c.command.split(' ').slice(0, 2).join(' ');

  it('adds a failed policy restore to a failed run and marks the leader down', async () => {
    const down = {
      stdout: '',
      stderr: 'tray connect timed out',
      status: 1,
      timedOut: false,
      leaderDown: true,
    };
    const { leader } = leaderFor({ prompt: down, removable: false });
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'r9',
      model: 'm',
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err.message).toMatch(/and restoring \/etc\/models failed: .*permission denied/);
    expect(err.leaderDown).toBe(true);
  });

  it('records a failed policy restore on a finished run instead of dropping it', async () => {
    const { leader } = leaderFor({ removable: false });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'r10',
      model: 'm',
      capture: { pollMs: 5 },
    });
    expect(result.modelPin.restore_error).toMatch(/permission denied/);
  });

  it('drives setup, the prompt, capture and teardown through the slicc CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-task-'));
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    const { leader, calls, files } = leaderFor({ commands: [[/^d=/, ok('new\n')]] });
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

    expect(calls.slice(0, 14).map(label)).toEqual([
      'uptime; meminfo',
      'rm -rf',
      "d='/workspace/in'; t=;",
      'mkdir -p',
      'playwright-cli tab-list',
      'playwright-cli tab-close',
      'slicc new-session --erase',
      'slicc model claude-sonnet-5',
      'slicc thinking',
      'models --provider',
      'test -e',
      'base64 -d',
      'cat /etc/models',
      'cost --json',
    ]);
    expect(calls[3].opts.stdin).toBe(Buffer.from('hello').toString('base64'));
    const prompt = calls.find((c) => c.kind === 'cli' && c.args[0] === 'prompt');
    expect(prompt.args).toEqual(['prompt', '--allsettled', PROMPT_ALL_SETTLED, '-']);
    expect(prompt.opts).toMatchObject({
      stdin: buildPrompt(task),
      timeoutMs: 60000,
      interrupt: true,
    });
    expect(prompt.opts.signal).toBeInstanceOf(AbortSignal);
    expect(calls.slice(-6).map(label)).toEqual([
      'playwright-cli tab-list',
      'playwright-cli tab-close',
      'slicc new-session --erase',
      'rm -f',
      'rm -rf',
      'rm -rf',
    ]);
    // The pin held for the run and the leader had no /etc/models before it, so none is left.
    expect(files.has('/etc/models')).toBe(false);
    expect(result.modelPin).toEqual({
      provider: 'bedrock-camp',
      model: 'bedrock-camp:global.anthropic.claude-sonnet-5',
      denied: 4,
    });
    // The staged file's directory existed and the file was new, so only the file goes.
    expect(calls.at(-2).command).toBe("rm -rf '/workspace/in/a.txt'");
    expect(result).toMatchObject({
      runId: 'r1',
      model: 'claude-sonnet-5',
      modelId: 'bedrock-camp:global.anthropic.claude-sonnet-5',
      thinking: 'default',
      thinkingEffective: '',
      exitCode: 0,
      timedOut: false,
      finalText: 'FINAL ANSWER: done\n',
      tokens: 2500,
      turns: 25,
      transcript: TRANSCRIPT,
      transcriptExport: { ok: true, parts: 1, exports: 1, reads: 1 },
      tabs: ['https://example.com/'],
    });
    expect(result.costUsd).toBeCloseTo(0.25);
    expect(result.screenshots[0]).toMatchObject({ format: 'png', base64: 'UE5H' });
    expect(Object.keys(result.phases)).toEqual(['setupMs', 'promptMs', 'collectMs']);
    expect(result.health.before).toMatchObject({ ok: true, leaderDown: false });
    expect(result.health.after).toMatchObject({ ok: true });
    // Keep tabs available while export checks for a late continuation.
    const promptAt = calls.indexOf(prompt);
    const closeAt = calls.findIndex(
      (c, i) => i > promptAt && label(c) === 'playwright-cli tab-close'
    );
    const exportAt = calls.findIndex((c) => c.command?.startsWith('session export'));
    expect(closeAt).toBeGreaterThan(promptAt);
    expect(closeAt).toBeGreaterThan(exportAt);
  });

  it('parses alias@thinking and leaves a plain alias at default', () => {
    expect(parseModelSpec('claude-opus-5-5')).toEqual({
      spec: 'claude-opus-5-5',
      alias: 'claude-opus-5-5',
      thinking: 'default',
    });
    expect(parseModelSpec('claude-opus-5-5@default')).toEqual({
      spec: 'claude-opus-5-5@default',
      alias: 'claude-opus-5-5',
      thinking: 'default',
    });
    expect(parseModelSpec('claude-opus-5-5@max')).toEqual({
      spec: 'claude-opus-5-5@max',
      alias: 'claude-opus-5-5',
      thinking: 'max',
    });
    expect(parseModelSpec('bedrock-camp:global.anthropic.claude-opus-5-5@off').alias).toBe(
      'bedrock-camp:global.anthropic.claude-opus-5-5'
    );
    expect(() => parseModelSpec('claude-opus-5-5@turbo')).toThrow(/unknown|alias@level/);
    expect(() => parseModelSpec('@off')).toThrow(/alias@level/);
  });

  it('sets thinking after the model, and only reads it for default', async () => {
    const verbs = {
      'new-session': ok('new session (erase)'),
      model: ok('bedrock-camp:global.anthropic.claude-opus-5-5\n'),
      thinking: (args) => ok(`${args[1] ?? 'unset'}\n`),
      prompt: ok('FINAL ANSWER: x\n'),
    };
    const off = fakeLeader({ verbs });
    const offResult = await runTask({
      leader: off.leader,
      task: { id: 't', task: 'x' },
      runId: 'r-off',
      model: 'claude-opus-5-5@off',
      capture: { pollMs: 5 },
    });
    const offCli = off.calls.filter((c) => c.kind === 'cli').map((c) => c.args);
    const modelAt = offCli.findIndex((a) => a[0] === 'model');
    const thinkingAt = offCli.findIndex((a) => a[0] === 'thinking');
    const promptAt = offCli.findIndex((a) => a[0] === 'prompt');
    expect(offCli[modelAt]).toEqual(['model', 'claude-opus-5-5']);
    expect(offCli[thinkingAt]).toEqual(['thinking', 'off']);
    expect(modelAt).toBeLessThan(thinkingAt);
    expect(thinkingAt).toBeLessThan(promptAt);
    expect(offResult).toMatchObject({
      model: 'claude-opus-5-5@off',
      thinking: 'off',
      thinkingEffective: 'off',
      modelId: 'bedrock-camp:global.anthropic.claude-opus-5-5',
    });

    const plain = fakeLeader({ verbs });
    const plainResult = await runTask({
      leader: plain.leader,
      task: { id: 't', task: 'x' },
      runId: 'r-plain',
      model: 'claude-opus-5-5',
      capture: { pollMs: 5 },
    });
    const plainThinking = plain.calls.filter((c) => c.kind === 'cli' && c.args[0] === 'thinking');
    expect(plainThinking).toHaveLength(1);
    expect(plainThinking[0].args).toEqual(['thinking']);
    expect(plain.calls.find((c) => c.kind === 'cli' && c.args[0] === 'model').args).toEqual([
      'model',
      'claude-opus-5-5',
    ]);
    expect(plainResult).toMatchObject({
      model: 'claude-opus-5-5',
      thinking: 'default',
      thinkingEffective: 'unset',
    });

    const explicit = fakeLeader({ verbs });
    const explicitResult = await runTask({
      leader: explicit.leader,
      task: { id: 't', task: 'x' },
      runId: 'r-def',
      model: 'claude-opus-5-5@default',
      capture: { pollMs: 5 },
    });
    expect(explicit.calls.find((c) => c.kind === 'cli' && c.args[0] === 'thinking').args).toEqual([
      'thinking',
    ]);
    expect(explicitResult.model).toBe('claude-opus-5-5@default');
    expect(explicitResult.thinking).toBe('default');
  });

  it('does not prompt when the thinking level is rejected', async () => {
    const { leader } = fakeLeader({
      verbs: {
        'new-session': ok('ok'),
        model: ok('bedrock-camp:global.anthropic.claude-opus-5-5\n'),
        thinking: fail('slicc thinking: the leader did not apply off within 20s (still unset)'),
      },
    });
    await expect(
      runTask({
        leader,
        task: { id: 't', task: 'x' },
        runId: 'r-think-fail',
        model: 'claude-opus-5-5@off',
        capture: { pollMs: 5 },
      })
    ).rejects.toThrow(/did not apply off/);
    expect(leader.cli.mock.calls.some((call) => call[0][0] === 'prompt')).toBe(false);
  });

  it('does not record a resolved level that is not the one requested', async () => {
    const { leader } = fakeLeader({
      verbs: {
        'new-session': ok('ok'),
        model: ok('bedrock-camp:global.anthropic.claude-opus-5-5\n'),
        thinking: ok('high\n'),
        prompt: ok('FINAL ANSWER: x\n'),
      },
    });
    await expect(
      runTask({
        leader,
        task: { id: 't', task: 'x' },
        runId: 'r-downgrade',
        model: 'claude-opus-5-5@max',
        capture: { pollMs: 5 },
      })
    ).rejects.toThrow(/resolved max to high/);
    expect(leader.cli.mock.calls.some((call) => call[0][0] === 'prompt')).toBe(false);
  });

  it('stops before the prompt when new-session re-seeded bundled skills', async () => {
    const { leader } = fakeLeader({
      verbs: { 'new-session': ok('new session (erase)') },
      commands: [[/ls '\/workspace\/skills'/, ok('playwright-cli\n')]],
    });
    await expect(
      runTask({
        leader,
        task: { task: 'x' },
        runId: 'r-none',
        model: 'm',
        condition: parseSkillsCondition('none'),
      })
    ).rejects.toThrow(/playwright-cli/);
    expect(leader.cli.mock.calls.some((call) => call[0][0] === 'prompt')).toBe(false);
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
      verbs: { model: ok('bedrock-camp:m\n'), prompt: ok('FINAL ANSWER: x') },
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
      busyProbeMs: 1,
      sleep: async () => {},
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

  it('removes staged fixtures and what the agent added beside them (#3696)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-task-'));
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    // /workspace/eval does not exist yet; /workspace/notes does.
    const { leader, calls } = leaderFor({
      commands: [[/^d=/, ok('dir /workspace/eval\nnew\n')]],
    });
    await runTask({
      leader,
      task: {
        id: 't',
        task: 'x',
        slicc: {
          files: [
            { from: file, to: '/workspace/eval/cart/cart.js' },
            { from: file, to: '/workspace/notes/n.txt' },
          ],
        },
      },
      runId: 'r9',
      model: 'm',
      capture: { pollMs: 5 },
    });
    const commands = calls.filter((c) => c.kind === 'exec').map((c) => c.command);
    expect(commands.at(-2)).toBe("rm -rf '/workspace/eval' '/workspace/notes/n.txt'");
    expect(commands.at(-1)).toBe('rm -rf /tmp/bench/r9');
  });

  it('plans per file: a created directory, a new file, nothing for an overwritten file', async () => {
    const { leader } = fakeLeader({
      commands: [[/^d=/, ok('dir /tmp/x\ndir /workspace\nnew\nexisting\n')]],
    });
    const files = ['/tmp/x/y/b', '/workspace/a', '/fixture.txt', '/workspace/old.txt'].map(
      (to) => ({ from: '', to })
    );
    // A protected directory is never planned; a root-level new file is (#3702 review).
    expect(await planStagedCleanup(leader, files)).toEqual(['/tmp/x', null, '/fixture.txt', null]);
    expect(stagedCleanupPaths(['/tmp/x', '/tmp/x/y', null, '/fixture.txt', '/tmp/x'])).toEqual([
      '/tmp/x',
      '/fixture.txt',
    ]);
  });

  it('removes only what was staged when staging fails part-way (#3702 review)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-task-'));
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'hello');
    const { leader, calls } = leaderFor({
      commands: [
        [/^d=/, ok('dir /workspace/eval\nnew\n')],
        [/base64 -d > '\/workspace\/notes\/n\.txt'/, fail('disk full')],
      ],
    });
    await expect(
      runTask({
        leader,
        task: {
          id: 't',
          task: 'x',
          slicc: {
            files: [
              { from: file, to: '/workspace/eval/cart/cart.js' },
              { from: file, to: '/workspace/notes/n.txt' },
            ],
          },
        },
        runId: 'r8',
        model: 'm',
      })
    ).rejects.toThrow('disk full');
    const commands = calls.filter((c) => c.kind === 'exec').map((c) => c.command);
    expect(commands).toContain("rm -rf '/workspace/eval'");
    expect(commands.some((c) => c.includes('rm -rf') && c.includes('/workspace/notes/n.txt'))).toBe(
      false
    );
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

describe('cost cap', () => {
  const costAt = (total) =>
    ok(
      JSON.stringify({
        scoops: [{ type: 'cone', turns: 1, usage: { totalTokens: 1, cost: { total } } }],
      })
    );

  it('aborts once spend since the start passes the cap, and skips failed readings', async () => {
    const readings = [fail('busy'), costAt(0.5), costAt(2.6)];
    const { leader } = fakeLeader({
      commands: [[/^cost --json --all$/, () => readings.shift() ?? costAt(3)]],
    });
    const abort = new AbortController();
    const w = watchSpend(leader, { cost: 0.5, tokens: 0, turns: 0 }, 2, abort, 5);
    await vi.waitFor(() => expect(abort.signal.aborted).toBe(true));
    await w.stop();
    const idle = new AbortController();
    const quiet = watchSpend(leader, { cost: 0, tokens: 0, turns: 0 }, 100, idle, 5);
    await quiet.stop();
    expect(idle.signal.aborted).toBe(false);
  });

  it('stops a runaway prompt at its cap and says so to the judge', async () => {
    let spent = 0.1;
    const { leader } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: (_args, opts) =>
          new Promise((resolve) => {
            const t = setInterval(() => (spent += 1), 5);
            opts.signal.addEventListener('abort', () => {
              clearInterval(t);
              resolve({ stdout: '', stderr: '', status: 130, timedOut: false, aborted: true });
            });
          }),
      },
      commands: [[/^cost --json --all$/, () => costAt(spent)]],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'rc',
      model: 'm',
      maxCost: 2,
      costPollMs: 5,
      capture: { pollMs: 5 },
      sleep: async () => {},
      busyProbeMs: 1,
    });
    expect(result).toMatchObject({ costCapped: true, timedOut: false, exitCode: 130 });
    const trace = traceFromResult(result);
    expect(trace.finalResult).toBe('The run was stopped at its cost cap before the cone answered.');
    expect(trace.metrics.cost_capped).toBe(true);
  });
});

describe('a prompt that returns while the agent still works', () => {
  const costOf = (total, tokens = 1, turns = 1) =>
    ok(
      JSON.stringify({
        scoops: [{ type: 'cone', turns, usage: { totalTokens: tokens, cost: { total } } }],
      })
    );
  const noSleep = async () => {};

  it('probes only exit 0 with no answer, and needs two readings', async () => {
    const readings = [costOf(1, 10), costOf(1.5, 20)];
    const { leader, calls } = fakeLeader({
      commands: [[/^cost --json --all$/, () => readings.shift() ?? fail('gone')]],
    });
    const quiet = { status: 0, stdout: '  \n', stderr: '' };
    expect(await stillWorking(leader, quiet, { probeMs: 0, sleep: noSleep })).toBe(true);
    const before = calls.length;
    expect(
      await stillWorking(leader, { status: 0, stdout: 'FINAL ANSWER: x' }, { sleep: noSleep })
    ).toBe(false);
    expect(await stillWorking(leader, { status: 130, stdout: '' }, { sleep: noSleep })).toBe(false);
    expect(
      await stillWorking(leader, { status: 0, stdout: '', timedOut: true }, { sleep: noSleep })
    ).toBe(false);
    expect(
      await stillWorking(leader, { status: 0, stdout: '', aborted: true }, { sleep: noSleep })
    ).toBe(false);
    expect(calls.length).toBe(before);
    // A model without token or cost accounting still adds turns.
    const turnsOnly = [costOf(0, 0, 3), costOf(0, 0, 4)];
    const quietModel = fakeLeader({
      commands: [[/^cost --json --all$/, () => turnsOnly.shift() ?? costOf(0, 0, 4)]],
    });
    expect(await stillWorking(quietModel.leader, quiet, { sleep: noSleep })).toBe(true);
    const idle = fakeLeader({ commands: [[/^cost --json --all$/, () => costOf(0, 0, 4)]] });
    expect(await stillWorking(idle.leader, quiet, { sleep: noSleep })).toBe(false);
    // A failed reading proves nothing either way.
    expect(await stillWorking(leader, quiet, { sleep: noSleep })).toBe(false);
  });

  it('does not collect when an early prompt return never settles again', async () => {
    let spent = 0.1;
    const { leader, calls } = fakeLeader({
      verbs: { model: ok('bedrock-camp:m\n'), prompt: ok(''), wait: fail('did not settle') },
      commands: [[/^cost --json --all$/, () => costOf((spent += 0.5), Math.round(spent * 100))]],
    });
    const sleep = vi.fn(async () => {});
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'rw',
      model: 'm',
      busyProbeMs: 7,
      sleep,
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/agent resumed after settle and did not settle/);
    expect(err.stillWorking).toBe(true);
    expect(sleep).toHaveBeenCalledWith(7);
    expect(calls.some((c) => c.kind === 'cli' && c.args[0] === 'wait')).toBe(true);
    expect(calls.some((c) => /session export/.test(c.command ?? ''))).toBe(false);
  });

  it('keeps the spend from after an interrupt once the agent has stopped', async () => {
    // before, then two rising readings, then the flat pair awaitQuiescent returns.
    const readings = [costOf(1, 10, 1), costOf(10, 100, 4), costOf(14, 140, 8), costOf(14, 140, 8)];
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: { stdout: '', stderr: '', status: 130, timedOut: true },
      },
      commands: [[/^cost --json --all$/, () => readings.shift() ?? costOf(14, 140, 8)]],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'ri',
      model: 'm',
      busyProbeMs: 5,
      stopProbeIntervals: 5,
      sleep: async () => {},
      capture: { pollMs: 5 },
    });
    expect(result.costUsd).toBeCloseTo(13);
    expect(result.tokens).toBe(130);
    expect(result.turns).toBe(7);
    const exportAt = calls.findIndex((c) => /session export/.test(c.command ?? ''));
    const costsBeforeExport = calls
      .slice(0, exportAt)
      .filter((c) => /cost --json --all/.test(c.command ?? '')).length;
    // The flat pair is read before tabs are closed and the transcript is collected.
    expect(costsBeforeExport).toBeGreaterThanOrEqual(4);
    expect(calls.slice(0, exportAt).some((c) => /tab-close/.test(c.command ?? ''))).toBe(false);
  });

  it('does not collect a transcript when an interrupt leaves the agent working', async () => {
    let total = 1;
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: { stdout: '', stderr: '', status: 130, timedOut: false, aborted: true },
      },
      commands: [[/^cost --json --all$/, () => costOf((total += 1), total, total)]],
    });
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'rb',
      model: 'm',
      busyProbeMs: 5,
      stopProbeIntervals: 3,
      sleep: async () => {},
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.stillWorking).toBe(true);
    expect(err.message).toMatch(/interrupted/);
    expect(calls.some((c) => /session export/.test(c.command ?? ''))).toBe(false);
    expect(calls.some((c) => /tab-close/.test(c.command ?? ''))).toBe(false);
    expect(err.leaderDown).toBe(true);
  });

  it('gives up when cost keeps failing after an interrupt and marks the leader down', async () => {
    const timeouts = [];
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: { stdout: '', stderr: '', status: 130, timedOut: true },
      },
      commands: [
        [
          /^cost --json --all$/,
          (_command, opts) => {
            timeouts.push(opts?.timeoutMs);
            return { stdout: '', stderr: 'timed out', status: 1, timedOut: true };
          },
        ],
      ],
    });
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'rf',
      model: 'm',
      busyProbeMs: 5,
      stopProbeIntervals: 2,
      stopProbeBudgetMs: 60_000,
      sleep: async () => {},
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.leaderDown).toBe(true);
    expect(err.stillWorking).toBe(true);
    expect(err.message).toMatch(/stopped answering cost/);
    expect(calls.some((c) => /session export/.test(c.command ?? ''))).toBe(false);
    // The probe readings are bounded; the setup reading has no short timeout.
    expect(timeouts.filter((ms) => ms === 15_000).length).toBeGreaterThanOrEqual(2);
  });

  it('does not score a transcript lost while the agent is still busy', async () => {
    let n = 0;
    const { leader } = fakeLeader({
      verbs: { model: ok('bedrock-camp:m\n'), prompt: ok('FINAL ANSWER: done') },
      commands: [
        [
          /^cost --json --all$/,
          () => {
            n += 1;
            return costOf(n, n, n);
          },
        ],
        [/^session export/, () => ({ stdout: '', stderr: 'timed out', status: 1, timedOut: true })],
      ],
    });
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'rx',
      model: 'm',
      busyProbeMs: 5,
      sleep: async () => {},
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.stillWorking).toBe(true);
    expect(err.message).toMatch(/session export timed out/);
  });

  it('waits for a resumed agent, re-exports, and uses the cone transcript final answer', async () => {
    const dir = '/tmp/bench/recovered';
    const files = leaderFiles(Buffer.from(JSON.stringify(TRANSCRIPT)), TRANSCRIPT_PART_BYTES, dir);
    let exports = 0;
    const totals = [1, 1, 2, 2];
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: ok('The scoops are working.'),
        wait: ok('settled\n'),
      },
      commands: [
        [/^cost --json --all$/, () => costOf(totals.shift() ?? 2, 10, 1)],
        [
          /^session export/,
          () =>
            exports++ === 0
              ? { stdout: '', stderr: 'timed out', status: 1, timedOut: true }
              : files.list(),
        ],
        [/^base64 '\/[^']*\/transcript\/parts\/x[a-z]+'$/, files.read],
      ],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'recovered',
      model: 'm',
      sleep: async () => {},
      capture: { pollMs: 5 },
    });
    expect(calls.find((c) => c.kind === 'cli' && c.args[0] === 'wait')?.args).toEqual([
      'wait',
      '--allsettled',
      PROMPT_ALL_SETTLED,
    ]);
    expect(exports).toBe(2);
    expect(result.finalText).toBe('FINAL ANSWER: done');
    expect(traceFromResult(result).metrics.resumed_after_settle).toBe(true);
  });

  it('aborts a resumed agent at the task timeout and scores its final transcript', async () => {
    const files = leaderFiles(
      Buffer.from(JSON.stringify(TRANSCRIPT)),
      TRANSCRIPT_PART_BYTES,
      '/tmp/bench/recovery-timeout'
    );
    let clock = 0;
    let exports = 0;
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: ok('INITIAL ANSWER'),
        wait: () => {
          clock = 900_000;
          return { ...fail('timed out', 130), timedOut: true };
        },
        abort: ok('stopped\n'),
      },
      commands: [
        [/^cost --json --all$/, () => costOf(1, 10, 1)],
        [
          /^session export/,
          () => {
            exports += 1;
            return exports === 1 ? { ...fail('timed out', 130), timedOut: true } : files.list();
          },
        ],
        files.commands[1],
      ],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'recovery-timeout',
      model: 'm',
      now: () => clock,
      sleep: async () => {},
      busyProbeMs: 1,
      capture: { pollMs: 5 },
    });
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'abort')).toHaveLength(1);
    expect(exports).toBe(2);
    expect(result).toMatchObject({
      timedOut: true,
      costCapped: false,
      resumedAfterSettle: true,
      finalText: 'FINAL ANSWER: done',
      durationMs: 900_000,
    });
    expect(traceFromResult(result).metrics).toMatchObject({
      timedOut: true,
      resumed_after_settle: true,
    });
  });

  it('leaves a resumed run unscored when the leader does not confirm abort', async () => {
    let clock = 0;
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: ok('INITIAL ANSWER'),
        wait: () => {
          clock = 900_000;
          return { ...fail('timed out', 130), timedOut: true };
        },
        abort: fail('the leader did not confirm the turn stopped'),
      },
      commands: [
        [/^cost --json --all$/, () => costOf(1, 10, 1)],
        [/^session export/, { ...fail('timed out', 130), timedOut: true }],
      ],
    });
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'recovery-unconfirmed',
      model: 'm',
      now: () => clock,
      sleep: async () => {},
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.stillWorking).toBe(true);
    expect(err.message).toMatch(/did not confirm abort/);
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'abort')).toHaveLength(1);
  });

  it('leaves a resumed run unscored when spend keeps rising after abort', async () => {
    let clock = 0;
    let reads = 0;
    const { leader } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: ok('INITIAL ANSWER'),
        wait: () => {
          clock = 900_000;
          return { ...fail('timed out', 130), timedOut: true };
        },
        abort: ok('stopped\n'),
      },
      commands: [
        [/^cost --json --all$/, () => costOf(++reads <= 2 ? 1 : reads, reads, reads)],
        [/^session export/, { ...fail('timed out', 130), timedOut: true }],
      ],
    });
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'recovery-still-spending',
      model: 'm',
      now: () => clock,
      stopProbeIntervals: 2,
      sleep: async () => {},
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.stillWorking).toBe(true);
    expect(err.leaderDown).toBe(true);
    expect(err.message).toMatch(/kept working after abort/);
  });

  it('leaves a resumed run unscored when no final transcript can be exported', async () => {
    let clock = 0;
    const { leader } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: ok('INITIAL ANSWER'),
        wait: () => {
          clock = 900_000;
          return { ...fail('timed out', 130), timedOut: true };
        },
        abort: ok('stopped\n'),
      },
      commands: [
        [/^cost --json --all$/, () => costOf(1, 10, 1)],
        [/^session export/, { ...fail('timed out', 130), timedOut: true }],
      ],
    });
    const err = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'recovery-no-transcript',
      model: 'm',
      now: () => clock,
      sleep: async () => {},
      capture: { pollMs: 5 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.stillWorking).toBe(true);
    expect(err.message).toMatch(/final transcript could not be exported/);
  });

  it('enforces the cost cap during a post-settle wait before scoring', async () => {
    const files = leaderFiles(
      Buffer.from(JSON.stringify(TRANSCRIPT)),
      TRANSCRIPT_PART_BYTES,
      '/tmp/bench/recovery-cost-cap'
    );
    let costReads = 0;
    let exports = 0;
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: ok('INITIAL ANSWER'),
        wait: (_args, opts) => {
          if (!opts.signal) return fail('wait has no cost-cap signal');
          return new Promise((resolve) => {
            const stopped = () => resolve({ ...fail('stopped', 143), aborted: true });
            if (opts.signal.aborted) stopped();
            else opts.signal.addEventListener('abort', stopped, { once: true });
          });
        },
        abort: ok('stopped\n'),
      },
      commands: [
        [/^cost --json --all$/, () => costOf(++costReads <= 2 ? 0 : 3, 10, 1)],
        [
          /^session export/,
          () => {
            exports += 1;
            return exports === 1 ? { ...fail('timed out', 130), timedOut: true } : files.list();
          },
        ],
        files.commands[1],
      ],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'recovery-cost-cap',
      model: 'm',
      maxCost: 2,
      costPollMs: 5,
      sleep: async () => {},
      capture: { pollMs: 5 },
    });
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'abort')).toHaveLength(1);
    expect(exports).toBe(2);
    expect(result).toMatchObject({
      timedOut: false,
      costCapped: true,
      resumedAfterSettle: true,
      finalText: 'FINAL ANSWER: done',
    });
    expect(traceFromResult(result).metrics).toMatchObject({
      cost_capped: true,
      resumed_after_settle: true,
    });
  });

  it('does not drop a prompt cost cap when work resumes during collection', async () => {
    const files = leaderFiles(
      Buffer.from(JSON.stringify(TRANSCRIPT)),
      TRANSCRIPT_PART_BYTES,
      '/tmp/bench/prompt-cost-cap-resumed'
    );
    let readings = 0;
    let exports = 0;
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('bedrock-camp:m\n'),
        prompt: { ...fail('not confirmed', 130), aborted: true, stdout: 'INITIAL ANSWER' },
        abort: ok('stopped\n'),
      },
      commands: [
        [/^cost --json --all$/, () => costOf(++readings === 1 ? 0 : 3, 10, 1)],
        [
          /^session export/,
          (_command, opts) => {
            exports += 1;
            if (exports > 1) return files.list();
            if (!opts.signal) return fail('export has no cost-cap signal');
            return new Promise((resolve) => {
              const stopped = () => resolve({ ...fail('stopped', 143), aborted: true });
              if (opts.signal.aborted) stopped();
              else opts.signal.addEventListener('abort', stopped, { once: true });
            });
          },
        ],
        files.commands[1],
      ],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'prompt-cost-cap-resumed',
      model: 'm',
      maxCost: 2,
      costPollMs: 5,
      sleep: async () => {},
      capture: { pollMs: 5 },
    });
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'abort')).toHaveLength(1);
    expect(exports).toBe(2);
    expect(result).toMatchObject({
      costCapped: true,
      resumedAfterSettle: true,
      finalText: 'FINAL ANSWER: done',
    });
  });

  it('recognizes a continuation when export succeeds after waiting for the cone', async () => {
    const dir = '/tmp/bench/recovered-on-export';
    const files = leaderFiles(Buffer.from(JSON.stringify(TRANSCRIPT)), TRANSCRIPT_PART_BYTES, dir);
    let exports = 0;
    const totals = [1, 1, 2, 2, 2];
    const { leader, calls } = fakeLeader({
      verbs: { model: ok('bedrock-camp:m\n'), prompt: ok('INITIAL ANSWER'), wait: ok('settled\n') },
      commands: [
        [/^cost --json --all$/, () => costOf(totals.shift() ?? 2, 10, 1)],
        [
          /^session export/,
          () => {
            exports += 1;
            return files.list();
          },
        ],
        files.commands[1],
      ],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'recovered-on-export',
      model: 'm',
      sleep: async () => {},
      capture: { pollMs: 5 },
    });
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'wait')).toHaveLength(1);
    expect(exports).toBe(2);
    expect(result.finalText).toBe('FINAL ANSWER: done');
    expect(traceFromResult(result).metrics.resumed_after_settle).toBe(true);
  });

  it('waits again when spend rises during a later recovery export', async () => {
    const files = leaderFiles(
      Buffer.from(JSON.stringify(TRANSCRIPT)),
      TRANSCRIPT_PART_BYTES,
      '/tmp/bench/recovery-resumed-twice'
    );
    const totals = [0, 1, 1, 2, 2, 2];
    let exports = 0;
    const { leader, calls } = fakeLeader({
      verbs: { model: ok('bedrock-camp:m\n'), prompt: ok('INITIAL ANSWER'), wait: ok('settled\n') },
      commands: [
        [/^cost --json --all$/, () => costOf(totals.shift() ?? 2, 10, 1)],
        [
          /^session export/,
          () => {
            exports += 1;
            return exports === 1 ? { ...fail('timed out', 130), timedOut: true } : files.list();
          },
        ],
        files.commands[1],
      ],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'recovery-resumed-twice',
      model: 'm',
      capture: { pollMs: 5 },
    });
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'wait')).toHaveLength(2);
    expect(exports).toBe(3);
    expect(result.finalText).toBe('FINAL ANSWER: done');
    expect(result.resumedAfterSettle).toBe(true);
  });

  it('uses a fast continuation from the transcript even when spend is flat', async () => {
    const files = leaderFiles(
      Buffer.from(JSON.stringify(TRANSCRIPT)),
      TRANSCRIPT_PART_BYTES,
      '/tmp/bench/fast-continuation'
    );
    let exports = 0;
    const { leader, calls } = fakeLeader({
      verbs: { model: ok('bedrock-camp:m\n'), prompt: ok('INITIAL ANSWER'), wait: ok('settled\n') },
      commands: [
        [/^cost --json --all$/, () => costOf(1, 10, 1)],
        [
          /^session export/,
          () => {
            exports += 1;
            return files.list();
          },
        ],
        files.commands[1],
      ],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x', slicc: { timeoutSeconds: 900 } },
      runId: 'fast-continuation',
      model: 'm',
      sleep: async () => {},
      capture: { pollMs: 5 },
    });
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'wait')).toHaveLength(0);
    expect(exports).toBe(1);
    expect(result.finalText).toBe('FINAL ANSWER: done');
    expect(traceFromResult(result).metrics.resumed_after_settle).toBe(true);
  });

  it('keeps prompt stdout when it already contains the exported final message', async () => {
    const files = leaderFiles(
      Buffer.from(JSON.stringify(TRANSCRIPT)),
      TRANSCRIPT_PART_BYTES,
      '/tmp/bench/no-continuation'
    );
    const stdout = 'PREAMBLE\nFINAL ANSWER: done\n';
    const { leader, calls } = fakeLeader({
      verbs: { model: ok('bedrock-camp:m\n'), prompt: ok(stdout), wait: ok('settled\n') },
      commands: [[/^cost --json --all$/, () => costOf(1, 10, 1)], ...files.commands],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'no-continuation',
      model: 'm',
      capture: { pollMs: 5 },
    });
    expect(result.finalText).toBe(stdout);
    expect(traceFromResult(result).metrics.resumed_after_settle).toBeUndefined();
    expect(calls.filter((c) => c.kind === 'cli' && c.args[0] === 'wait')).toHaveLength(0);
  });

  it('collects as usual when spend has stopped', async () => {
    const { leader } = fakeLeader({
      verbs: { model: ok('bedrock-camp:m\n'), prompt: ok('') },
      commands: [[/^cost --json --all$/, () => costOf(0.2, 5)]],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'x' },
      runId: 'rq',
      model: 'm',
      sleep: async () => {},
      capture: { pollMs: 5 },
    });
    expect(result).toMatchObject({ exitCode: 0, finalText: '' });
  });
});

describe('lastTurnProviderError', () => {
  const cone = (...messages) => ({ kind: 'cone', messages });
  const scoop = (...messages) => ({ kind: 'scoop', messages });
  const run = (...conversations) => ({ transcript: { conversations } });
  const dead = {
    role: 'assistant',
    stopReason: 'error',
    errorMessage: 'Internal server error: Bedrock',
  };
  const done = { role: 'assistant', stopReason: 'stop' };
  it('names the error the cone died on, and ignores recovered errors and scoops', () => {
    expect(lastTurnProviderError(run(cone({ role: 'user' }, dead)))).toBe(
      'Internal server error: Bedrock'
    );
    // An error the agent recovered from is not the end of the run.
    expect(lastTurnProviderError(run(cone(dead, done)))).toBeNull();
    // A scoop that died does not end the run, wherever it is listed.
    expect(lastTurnProviderError(run(scoop(dead), cone(done)))).toBeNull();
    expect(lastTurnProviderError(run(cone(done), scoop(dead)))).toBeNull();
    // The cone is found by kind even when a scoop is listed first (#3704 review).
    expect(lastTurnProviderError(run(scoop(done), cone(dead)))).toBe(
      'Internal server error: Bedrock'
    );
    expect(lastTurnProviderError({})).toBeNull();
    expect(lastTurnProviderError(run(cone({ role: 'assistant', stopReason: 'error' })))).toBe(
      'provider error'
    );
  });
});

describe('arm mode', () => {
  const ARM = {
    name: 'intent-budget',
    skills: ['intent', 'decide-quickly'],
    setup: ['intent prepare'],
    command: 'intent-arm --tool intent --private',
    files: '/tmp/intent-arm',
    scratch: ['/tmp/intent'],
  };
  const b64 = (s) => Buffer.from(s).toString('base64');

  it('validates arms, including the ones the bench ships', () => {
    expect(validateArm('intent-budget', ARM)).toEqual([]);
    const errs = validateArm('Bad Name', {
      command: '; rm -rf /',
      skills: ['ok', 'Not Ok'],
      setup: 'x',
      files: '/etc',
    }).join('\n');
    for (const want of [
      'a-z0-9',
      'command must start',
      'skill directory',
      'setup must',
      'under /tmp',
    ])
      expect(errs).toContain(want);
    const shipped = JSON.parse(readFileSync(new URL('../arms/arms.json', import.meta.url), 'utf8'));
    for (const [name, arm] of Object.entries(shipped)) expect(validateArm(name, arm)).toEqual([]);
  });

  it('keeps the task off the command line: it travels in a goal file', () => {
    const cmd = armCommand(ARM, {
      goalFile: '/tmp/bench/r1/goal.txt',
      model: 'claude-sonnet-5-5@low',
      timeoutSeconds: 3600,
    });
    expect(cmd).toBe(
      `intent-arm --tool intent --private --model 'claude-sonnet-5-5' --thinking 'low' --time-limit ${3600 - ARM_TIME_MARGIN_S} --json --goal-file '/tmp/bench/r1/goal.txt'`
    );
    expect(armCommand(ARM, { goalFile: '/g', model: 'm', timeoutSeconds: 30 })).toContain(
      '--time-limit 60'
    );
    expect(
      armCommand(ARM, { goalFile: '/g', model: 'claude-sonnet-5-5@low', timeoutSeconds: 600 })
    ).toContain("--model 'claude-sonnet-5-5' --thinking 'low' --time-limit 540");
    expect(
      armCommand(ARM, { goalFile: '/g', model: 'm@default', timeoutSeconds: 600 })
    ).not.toContain('--thinking');
    expect(() => armCommand(ARM, { goalFile: '/g', model: 'm@max', timeoutSeconds: 600 })).toThrow(
      /not max/
    );
  });

  it('reads the driver result, the scoop answer, and the answer in result.json', () => {
    expect(parseArmResult('progress\n{\n  "ok": true,\n  "steps": 4\n}\n')).toEqual({
      ok: true,
      steps: 4,
    });
    expect(parseArmResult('no json')).toBeNull();
    expect(lastScoopAssistantText(TRANSCRIPT)).toBe('scoop says hi');
    expect(lastScoopAssistantText({ conversations: [] })).toBe('');
    expect(
      armAnswer([
        { path: '/tmp/intent-arm/x/result.json', base64: b64('{"answer":"FINAL ANSWER: 42"}') },
      ])
    ).toBe('FINAL ANSWER: 42');
    expect(armAnswer([])).toBe('');
  });

  it('runs the arm instead of prompting the cone, and keeps its files for the trace', async () => {
    let costCalls = 0;
    const canary = 'CANARY-TASK-TEXT-7f3a';
    const { leader, calls } = fakeLeader({
      verbs: {
        'new-session': ok('new session (erase)'),
        model: ok('bedrock-camp:global.anthropic.claude-sonnet-5-5\n'),
      },
      commands: [
        [/^intent-arm /, ok('{"ok":true,"steps":3,"run":"2026-10-04T00-00-00-run"}\n')],
        [
          /^cost --json --all$/,
          () =>
            ok(
              JSON.stringify({
                scoops: [
                  {
                    type: 'scoop',
                    turns: 1,
                    usage: { totalTokens: 1, cost: { total: ++costCalls === 1 ? 0.1 : 0.4 } },
                  },
                ],
              })
            ),
        ],
        [/^playwright-cli tab-list$/, ok('[T1] https://example.com/ "Example"')],
        [
          /^find '\/tmp\/intent-arm'/,
          ok('/tmp/intent-arm/run/result.json\n/tmp/intent-arm/run/transcript.md\n'),
        ],
        [/^base64 '\/tmp\/intent-arm\/run\/result\.json'$/, ok(b64(`{"answer":"${canary}"}`))],
        [
          /^base64 '\/tmp\/intent-arm\/run\/transcript\.md'$/,
          ok(b64(`## user\ngoal: ${canary}\n## assistant\nFINAL ANSWER: from the driver`)),
        ],
        ...leaderFiles(Buffer.from(JSON.stringify(TRANSCRIPT))).commands,
        [/^base64 /, ok('UE5H')],
      ],
    });
    const task = { id: 't', task: `Do ${canary}.`, slicc: { timeoutSeconds: 120 } };
    const result = await runTask({
      leader,
      task,
      runId: 'r1',
      model: 'claude-sonnet-5-5',
      arm: ARM,
      capture: { pollMs: 5 },
    });
    expect(calls.some((c) => c.kind === 'cli' && c.args[0] === 'prompt')).toBe(false);
    const wipes = calls.filter(
      (c) => c.kind === 'exec' && /^rm -rf '\/tmp\/intent/.test(c.command)
    );
    expect(wipes.map((c) => c.command)).toEqual([
      "rm -rf '/tmp/intent-arm'",
      "rm -rf '/tmp/intent'",
    ]);
    const goal = calls.find(
      (c) => c.kind === 'exec' && c.command === "base64 -d > '/tmp/bench/r1/goal.txt'"
    );
    expect(Buffer.from(goal.opts.stdin, 'base64').toString()).toBe(buildPrompt(task));
    const run = calls.find((c) => c.kind === 'exec' && c.command.startsWith('intent-arm '));
    expect(run.command).not.toContain(canary);
    expect(run.opts).toMatchObject({ timeoutMs: 120000, interrupt: true });
    // The driver's own transcript answers first: it is this run's for sure.
    expect(result.finalText).toBe('FINAL ANSWER: from the driver');
    expect(result.arm.name).toBe('intent-budget');
    expect(result.arm.result).toEqual({ ok: true, steps: 3, run: '2026-10-04T00-00-00-run' });
    expect(result.arm.files.map((f) => f.path)).toEqual([
      '/tmp/intent-arm/run/result.json',
      '/tmp/intent-arm/run/transcript.md',
    ]);
    expect(result.costUsd).toBeCloseTo(0.3);
    // Nothing the record keeps quotes the task: the files ride only in the trace.
    expect(JSON.stringify(traceFromResult(result).metrics)).not.toContain(canary);
  });

  it('carries an arm that ran out its own time limit into the run and the judged trace', async () => {
    // The driver stops itself before the exec deadline (intent-arm exits 124, timedOut), so the
    // exec reply alone says nothing about a timeout (bu2-071 in benchmark 37362726069).
    const { leader } = fakeLeader({
      verbs: {
        'new-session': ok('new session (erase)'),
        model: ok('bedrock-camp:global.anthropic.claude-sonnet-5-5\n'),
      },
      commands: [
        [
          /^intent-arm /,
          () => ({
            stdout: '{"exitCode":124,"timedOut":true,"steps":9}\n',
            stderr: '',
            status: 124,
            timedOut: false,
          }),
        ],
        [/^cost --json --all$/, ok(JSON.stringify({ scoops: [] }))],
        [/^playwright-cli tab-list$/, ok('')],
        [/^find '\/tmp\/intent-arm'/, ok('/tmp/intent-arm/run/transcript.md\n')],
        [
          /^base64 '\/tmp\/intent-arm\/run\/transcript\.md'$/,
          ok(b64('## user\ngoal\n## assistant\n\n')),
        ],
        ...leaderFiles(Buffer.from(JSON.stringify({ conversations: [] }))).commands,
        [/^base64 /, ok('UE5H')],
      ],
    });
    const result = await runTask({
      leader,
      task: { id: 't', task: 'Do it.', slicc: { timeoutSeconds: 120 } },
      runId: 'r1',
      model: 'claude-sonnet-5-5',
      arm: ARM,
      capture: { pollMs: 5 },
    });
    expect(result.timedOut).toBe(true);
    expect(lastTurnProviderError(result)).toBeNull();
    const trace = traceFromResult(result);
    expect(trace.metrics.timedOut).toBe(true);
    expect(trace.finalResult).toBe(
      'The run was stopped at the time limit before the agent answered.'
    );
  });
});

describe('arm helpers', () => {
  const msg = (role, text, timestamp, extra = {}) => ({
    role,
    timestamp,
    content:
      text == null
        ? []
        : [
            { type: 'text', text },
            { type: 'tool-call', name: 'bash' },
          ],
    ...extra,
  });
  const DOC = {
    conversations: [
      { id: 'cone', kind: 'cone', messages: [msg('assistant', 'cone talk', 9)] },
      { id: 'old', kind: 'scoop', messages: [msg('assistant', 'earlier scoop', 1)] },
      { id: 'quiet', kind: 'scoop', messages: [msg('user', 'only a user turn', 5)] },
      {
        id: 'arm',
        kind: 'scoop',
        messages: [msg('assistant', 'FINAL ANSWER: 42', 3), msg('assistant', '', 4)],
      },
    ],
  };

  it('finds the arm scoop that spoke last, its turns and its last words', () => {
    expect(armConversation(DOC).id).toBe('arm');
    expect(armTurns(DOC)).toBe(2);
    expect(lastScoopAssistantText(DOC)).toBe('FINAL ANSWER: 42');
    expect(armConversation(null)).toBeNull();
    expect(armTurns(undefined)).toBe(0);
  });

  it('judges an arm run by its scoop: a provider error there is a run error, and steps are its turns', () => {
    const dead = {
      conversations: [
        { id: 'cone', kind: 'cone', messages: [msg('assistant', 'fine', 1)] },
        {
          id: 'arm',
          kind: 'scoop',
          messages: [msg('assistant', null, 2, { stopReason: 'error', errorMessage: 'HTTP 503' })],
        },
      ],
    };
    expect(lastTurnProviderError({ arm: { name: 'x' }, transcript: dead })).toBe('HTTP 503');
    expect(lastTurnProviderError({ transcript: dead })).toBeNull();
    const t = traceFromResult({ arm: { name: 'x' }, transcript: DOC, durationMs: 1000 });
    expect(t.metrics.steps).toBe(2);
  });

  it('treats an arm agent that exited non-zero with no recovered answer as a run error', () => {
    // The scoop holding the dead turn is gone by export time: only the driver's exit code and the
    // answer the judge would get remain (benchmark 37285459938, a Bedrock 500 window). That answer
    // is collectArmRun's finalText: answer.txt, else transcript.md's last assistant words, else the
    // arm scoop's last words.
    const file = (name, text) => ({
      path: `/tmp/intent-arm/r/${name}`,
      base64: Buffer.from(text).toString('base64'),
    });
    const run = (exitCode, files, scoopText = '') => ({
      arm: { name: 'x', startedAt: 0, result: { exitCode }, files },
      transcript: { conversations: [] },
      finalText: driverAnswer(files) || scoopText,
    });
    const dead = file('transcript.md', '## user\n\ngoal\n\n## assistant\n\n');
    const said = file('transcript.md', '## user\n\ngoal\n\n## assistant\n\nFINAL ANSWER: 7\n');
    expect(lastTurnProviderError(run(1, [dead]))).toBe(
      "the arm's agent exited 1 without an answer"
    );
    expect(lastTurnProviderError(run(1, [dead, file('answer.txt', '  \n')]))).toBe(
      "the arm's agent exited 1 without an answer"
    );
    // A final answer recovered from any source is judged, not retried.
    expect(lastTurnProviderError(run(1, [said]))).toBeNull();
    expect(lastTurnProviderError(run(1, [dead], 'FINAL ANSWER: 7'))).toBeNull();
    expect(
      lastTurnProviderError(run(1, [dead, file('answer.txt', 'FINAL ANSWER: 42')]))
    ).toBeNull();
    expect(lastTurnProviderError(run(0, [dead]))).toBeNull();
    // An agent that ran out its own time limit failed the task: judged, like a cone timeout.
    // bu2-071 in benchmark 37362726069 exited 124 after 3,565 s with timedOut set.
    const timedOut = run(124, [dead]);
    timedOut.arm.result.timedOut = true;
    expect(lastTurnProviderError(timedOut)).toBeNull();
    expect(
      lastTurnProviderError({ arm: { name: 'x', result: null, files: [] }, transcript: DOC })
    ).toBeNull();
    // Outside arm mode the driver result plays no part.
    expect(lastTurnProviderError({ transcript: DOC })).toBeNull();
  });

  it('collects the driver files within a byte budget, skipping odd paths and failed reads', async () => {
    const { leader } = fakeLeader({
      commands: [
        [
          /^find '\/tmp\/d'/,
          ok('/tmp/d/a.txt\n/tmp/d/bad name.txt\n/tmp/d/gone.txt\n/tmp/d/big.txt\n'),
        ],
        [/^base64 '\/tmp\/d\/a\.txt'$/, ok('QUFB\n')],
        [/^base64 '\/tmp\/d\/gone\.txt'$/, fail('no such file')],
        [/^base64 '\/tmp\/d\/big\.txt'$/, ok('QUFBQUFBQUFB')],
      ],
    });
    expect(await collectArmFiles(leader, '/tmp/d', { maxBytes: 8 })).toEqual({
      files: [{ path: '/tmp/d/a.txt', base64: 'QUFB' }],
      truncated: true,
    });
    const { leader: none } = fakeLeader({ commands: [[/^find /, fail('no dir')]] });
    expect(await collectArmFiles(none, '/tmp/d')).toEqual({ files: [], truncated: false });
  });

  it('rejects arms that are not objects, and reads no answer from a broken result.json', () => {
    expect(validateArm('a', null)).toEqual(['arm a is not an object']);
    expect(
      armAnswer([
        { path: '/tmp/x/result.json', base64: Buffer.from('not json').toString('base64') },
      ])
    ).toBe('');
    expect(
      armAnswer([{ path: '/tmp/x/result.json', base64: Buffer.from('{}').toString('base64') }])
    ).toBe('');
  });
});

describe('arm driver transcript', () => {
  const MD = [
    '# Agent session: s1',
    '## Prompt',
    'Do the task.',
    '## user',
    'Do the task.',
    '## assistant',
    'Looking.',
    '### tool: bash',
    'intent --intent "open https://example.com"',
    '## tool result',
    'opened example.com',
    '## assistant',
    'Found it.',
    '',
    'FINAL ANSWER: 42',
  ].join('\n');
  const file = (path, text) => ({ path, base64: Buffer.from(text).toString('base64') });
  const files = [
    file('/tmp/intent-arm/r/transcript.md', MD),
    file('/tmp/intent-arm/r/result.json', JSON.stringify({ answer: 'Found it.' })),
  ];

  it('splits a driver transcript into sections, assistant text without its tool calls', () => {
    const secs = driverSections(MD);
    expect(secs.map((x) => x.role)).toEqual([
      'prompt',
      'user',
      'assistant',
      'tool result',
      'assistant',
    ]);
    expect(secs[2].text).toBe('Looking.');
    expect(secs[2].body).toContain('### tool: bash');
    expect(driverSteps(files)).toHaveLength(4);
    expect(driverSteps([])).toEqual([]);
  });

  it('clips a long step without splitting a surrogate pair', () => {
    // 3,999 characters, then an emoji across the 4,000-character step limit.
    const md = `## user\n\n${'x'.repeat(3999 - '## user\n\n'.length + 9)}😀${'y'.repeat(50)}\n`;
    const [step] = driverSteps([file('/tmp/intent-arm/r/transcript.md', md)]);
    expect(step.isWellFormed()).toBe(true);
    expect(step).toMatch(/ … \[\d+ more characters\]$/);
  });

  it('answers from answer.txt, else the transcript, else the result.json prefix', () => {
    expect(armAnswer([file('/x/answer.txt', ' FINAL ANSWER: full \n'), ...files])).toBe(
      'FINAL ANSWER: full'
    );
    expect(armAnswer(files)).toBe('Found it.\n\nFINAL ANSWER: 42');
    expect(armAnswer([files[1]])).toBe('Found it.');
  });

  it('judges from the driver transcript when the export lost the scoop', () => {
    const result = {
      arm: { name: 'x', files },
      transcript: { conversations: [{ id: 'cone', kind: 'cone', messages: [] }] },
      finalText: 'FINAL ANSWER: 42',
      durationMs: 1000,
    };
    const t = traceFromResult(result);
    expect(t.steps[0]).toMatch(/^## scoop · user/);
    expect(t.steps.some((x) => x.includes('FINAL ANSWER: 42'))).toBe(true);
    expect(t.metrics.steps).toBe(2);
  });
});

describe('arm runs on a reused leader', () => {
  const file = (path, text) => ({ path, base64: Buffer.from(text).toString('base64') });
  const MD = ['## user', 'Task two.', '## assistant', 'Done.', '', 'FINAL ANSWER: two'].join('\n');
  const scoop = (id, text, timestamp, extra = {}) => ({
    id,
    kind: 'scoop',
    messages: [{ role: 'assistant', timestamp, content: [{ type: 'text', text }], ...extra }],
  });
  // An earlier task's scoop, still in the export of a leader reused across tasks.
  const STALE = {
    conversations: [
      { id: 'cone', kind: 'cone', messages: [] },
      scoop('old', 'FINAL ANSWER: one', 1_000, { stopReason: 'error', errorMessage: 'HTTP 500' }),
    ],
  };
  const result = {
    arm: { name: 'x', startedAt: 5_000, files: [file('/tmp/intent-arm/r2/transcript.md', MD)] },
    transcript: STALE,
    finalText: 'FINAL ANSWER: two',
    durationMs: 1000,
  };

  it("never takes an earlier task's scoop for this run's", () => {
    expect(armConversation(STALE, 5_000)).toBeNull();
    expect(armConversation(STALE).id).toBe('old');
    expect(lastScoopAssistantText(STALE, 5_000)).toBe('');
    expect(lastTurnProviderError(result)).toBeNull();
  });

  it('judges from the current driver transcript even when a leftover scoop is in the export', () => {
    const t = traceFromResult(result);
    expect(t.steps.join('\n')).toContain('FINAL ANSWER: two');
    expect(t.steps.join('\n')).not.toContain('FINAL ANSWER: one');
    expect(t.metrics.steps).toBe(1);
    expect(armAnswer(result.arm.files)).toBe('Done.\n\nFINAL ANSWER: two');
  });
});

describe('scoop model pin', () => {
  const HAIKU = 'bedrock-camp:global.anthropic.claude-haiku-5-5';

  it('denies every other model in the catalogue and never the configured one', () => {
    const text = modelPinPolicy(HAIKU, [...DEFAULT_CATALOGUE, DEFAULT_CATALOGUE[1]]);
    expect(text.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([
      '[bedrock-camp]',
      '-bedrock-camp:global.anthropic.claude-opus-5-5',
      '-bedrock-camp:global.anthropic.claude-sonnet-4-6',
      '-bedrock-camp:m',
    ]);
  });

  it("makes the leader's own policy refuse another model and keep the configured one", async () => {
    // The webapp's real parser and evaluator, so the pin is checked against the semantics the
    // leader applies (own catalogue implicit, deny beats allow). Its logger reads __DEV__.
    globalThis.__DEV__ ??= false;
    const { isModelAllowedByPolicy, parseModelPolicy } = await import(
      '../../webapp/src/providers/model-policy.ts'
    );
    const policy = parseModelPolicy(modelPinPolicy(HAIKU, DEFAULT_CATALOGUE));
    const allowed = (provider, model) =>
      isModelAllowedByPolicy(policy, 'bedrock-camp', provider, model);
    expect(allowed('bedrock-camp', 'global.anthropic.claude-haiku-5-5')).toBe(true);
    expect(allowed('bedrock-camp', 'global.anthropic.claude-sonnet-4-6')).toBe(false);
    expect(allowed('bedrock-camp', 'global.anthropic.claude-opus-5-5')).toBe(false);
    expect(allowed('anthropic', 'claude-sonnet-4-6')).toBe(false);
  });

  it('refuses an id without a provider, or a provider that is not plain characters', () => {
    expect(() => modelPinPolicy('m', DEFAULT_CATALOGUE)).toThrow(/provider:model/);
    expect(() => modelPinPolicy('bad provider:m', DEFAULT_CATALOGUE)).toThrow(/bad provider/);
  });

  it('puts the previous /etc/models back on restore', async () => {
    const { leader, files } = fakeLeader();
    files.set('/etc/models', '[bedrock-camp]\nopenrouter:*\n');
    const pinned = await pinScoopModels(leader, HAIKU);
    expect(pinned.pin).toEqual({ provider: 'bedrock-camp', model: HAIKU, denied: 3 });
    expect(files.get('/etc/models')).toContain('-bedrock-camp:global.anthropic.claude-sonnet-4-6');
    await pinned.restore();
    expect(files.get('/etc/models')).toBe('[bedrock-camp]\nopenrouter:*\n');
  });

  it('does not start a run whose catalogue cannot be read', async () => {
    const { leader } = fakeLeader({ catalogue: 'not a catalogue' });
    await expect(pinScoopModels(leader, HAIKU)).rejects.toThrow(/printed no catalogue/);
  });

  it('does not start a run whose policy did not take', async () => {
    const { leader, files } = fakeLeader({ policyWritable: false });
    files.set('/etc/models', '[bedrock-camp]\n');
    await expect(pinScoopModels(leader, HAIKU)).rejects.toThrow(/did not take the policy/);
  });

  it('aborts, and keeps the policy, when an existing /etc/models cannot be read', async () => {
    const { leader, files } = fakeLeader({ policyReadable: false });
    files.set('/etc/models', '[bedrock-camp]\nopenrouter:*\n');
    await expect(pinScoopModels(leader, HAIKU)).rejects.toThrow(/input\/output error/);
    expect(files.get('/etc/models')).toBe('[bedrock-camp]\nopenrouter:*\n');
  });

  it('treats an unreachable leader as leader-down, not as a missing policy', async () => {
    const down = {
      stdout: '',
      stderr: 'tray connect timed out',
      status: 1,
      timedOut: false,
      leaderDown: true,
    };
    const { leader } = fakeLeader({ probe: down });
    await expect(pinScoopModels(leader, HAIKU)).rejects.toMatchObject({ leaderDown: true });
  });

  it('puts the previous policy back when the pin does not read back', async () => {
    const { leader, files } = fakeLeader({ readback: '[bedrock-camp]\n-bedrock-camp:x\n' });
    files.set('/etc/models', '[bedrock-camp]\nopenrouter:*\n');
    await expect(pinScoopModels(leader, HAIKU)).rejects.toThrow(/did not take the policy/);
    expect(files.get('/etc/models')).toBe('[bedrock-camp]\nopenrouter:*\n');
  });

  it('lets a failed restore surface instead of passing silently', async () => {
    const { leader } = fakeLeader({ removable: false });
    const pinned = await pinScoopModels(leader, HAIKU);
    await expect(pinned.restore()).rejects.toThrow(/permission denied/);
  });

  it('needs a provider in the model id and a catalogue that parses', async () => {
    await expect(pinScoopModels(fakeLeader().leader, 'm')).rejects.toThrow(/provider:model/);
    const { leader } = fakeLeader({ catalogueRaw: '<html>login</html>' });
    await expect(pinScoopModels(leader, HAIKU)).rejects.toThrow(/printed no catalogue/);
  });

  it('marks the leader down when a failed pin cannot be undone either', async () => {
    const { leader } = fakeLeader({ readback: 'other', removable: false });
    await expect(pinScoopModels(leader, HAIKU)).rejects.toMatchObject({
      message: expect.stringMatching(/did not take the policy; and restoring \/etc\/models failed/),
      leaderDown: true,
    });
  });
});
