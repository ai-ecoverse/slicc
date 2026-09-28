import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertStagedSkills,
  buildPrompt,
  costTotals,
  decodeTranscriptPart,
  expectedSkillNames,
  exportTranscript,
  exportTranscriptCommand,
  FINAL_INSTRUCTION,
  FLAGS_PROBE,
  leaderHealth,
  NO_DEFAULT_SKILLS_MISSING,
  PROMPT_ALL_SETTLED,
  parseExportListing,
  parseModelSpec,
  parseSkillNames,
  parseSkillsCondition,
  parseTabList,
  quote,
  readShots,
  restoreSkills,
  restoreSkillsCommand,
  runTask,
  skillsFlagCommand,
  skillsMismatch,
  spendDelta,
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
  watchSpend,
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

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

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

  it('stashes once, then rebuilds /workspace/skills for the condition', () => {
    const cmd = stageSkillsCommand(parseSkillsCondition('builtin+ecoverse'));
    expect(cmd).toContain('if [ ! -d /workspace/.bench-skills-builtin ]');
    expect(cmd).toContain('cp -r /workspace/.bench-skills-builtin/. /workspace/skills/');
    expect(cmd).toContain('cp -r /workspace/bench-skills/ecoverse/. /workspace/skills/');
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
  } = {}) {
    let costCalls = 0;
    return fakeLeader({
      verbs: { 'new-session': ok('new session (erase)'), model, prompt },
      commands: [
        [/^cost --json --all$/, () => COST(++costCalls === 1 ? 0.1 : 0.35)],
        [/^playwright-cli tab-list$/, ok('[T1] https://example.com/ "Example"')],
        ...leaderFiles(Buffer.from(JSON.stringify(TRANSCRIPT))).commands,
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

    expect(calls.slice(0, 9).map(label)).toEqual([
      'uptime; meminfo',
      'rm -rf',
      'mkdir -p',
      'playwright-cli tab-list',
      'playwright-cli tab-close',
      'slicc new-session --erase',
      'slicc model claude-sonnet-5',
      'slicc thinking',
      'cost --json',
    ]);
    expect(calls[2].opts.stdin).toBe(Buffer.from('hello').toString('base64'));
    const prompt = calls.find((c) => c.kind === 'cli' && c.args[0] === 'prompt');
    expect(prompt.args).toEqual(['prompt', '--allsettled', PROMPT_ALL_SETTLED, '-']);
    expect(prompt.opts).toMatchObject({
      stdin: buildPrompt(task),
      timeoutMs: 60000,
      interrupt: true,
    });
    expect(prompt.opts.signal).toBeInstanceOf(AbortSignal);
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
        model: ok('m\n'),
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

    const turnsOnly = [costOf(0, 0, 3), costOf(0, 0, 4)];
    const quietModel = fakeLeader({
      commands: [[/^cost --json --all$/, () => turnsOnly.shift() ?? costOf(0, 0, 4)]],
    });
    expect(await stillWorking(quietModel.leader, quiet, { sleep: noSleep })).toBe(true);
    const idle = fakeLeader({ commands: [[/^cost --json --all$/, () => costOf(0, 0, 4)]] });
    expect(await stillWorking(idle.leader, quiet, { sleep: noSleep })).toBe(false);

    expect(await stillWorking(leader, quiet, { sleep: noSleep })).toBe(false);
  });

  it('does not collect when an early prompt return never settles again', async () => {
    let spent = 0.1;
    const { leader, calls } = fakeLeader({
      verbs: { model: ok('m\n'), prompt: ok(''), wait: fail('did not settle') },
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
    const readings = [costOf(1, 10, 1), costOf(10, 100, 4), costOf(14, 140, 8), costOf(14, 140, 8)];
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('m\n'),
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

    expect(costsBeforeExport).toBeGreaterThanOrEqual(4);
    expect(calls.slice(0, exportAt).some((c) => /tab-close/.test(c.command ?? ''))).toBe(false);
  });

  it('does not collect a transcript when an interrupt leaves the agent working', async () => {
    let total = 1;
    const { leader, calls } = fakeLeader({
      verbs: {
        model: ok('m\n'),
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
        model: ok('m\n'),
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

    expect(timeouts.filter((ms) => ms === 15_000).length).toBeGreaterThanOrEqual(2);
  });

  it('does not score a transcript lost while the agent is still busy', async () => {
    let n = 0;
    const { leader } = fakeLeader({
      verbs: { model: ok('m\n'), prompt: ok('FINAL ANSWER: done') },
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
        model: ok('m\n'),
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
        model: ok('m\n'),
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
        model: ok('m\n'),
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
        model: ok('m\n'),
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
        model: ok('m\n'),
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
        model: ok('m\n'),
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
        model: ok('m\n'),
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
      verbs: { model: ok('m\n'), prompt: ok('INITIAL ANSWER'), wait: ok('settled\n') },
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
      verbs: { model: ok('m\n'), prompt: ok('INITIAL ANSWER'), wait: ok('settled\n') },
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
      verbs: { model: ok('m\n'), prompt: ok('INITIAL ANSWER'), wait: ok('settled\n') },
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
      verbs: { model: ok('m\n'), prompt: ok(stdout), wait: ok('settled\n') },
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
      verbs: { model: ok('m\n'), prompt: ok('') },
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
