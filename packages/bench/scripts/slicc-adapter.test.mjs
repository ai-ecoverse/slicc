import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildPrompt,
  costTotals,
  decodeTranscriptPart,
  exportTranscript,
  exportTranscriptCommand,
  FINAL_INSTRUCTION,
  leaderHealth,
  parseExportListing,
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
    prompt = ok('FINAL ANSWER: Example Domain\n'),
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
      exitCode: 0,
      timedOut: false,
      finalText: 'FINAL ANSWER: Example Domain\n',
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
    });
    expect(result).toMatchObject({ costCapped: true, timedOut: false, exitCode: 130 });
    const trace = traceFromResult(result);
    expect(trace.finalResult).toBe('The run was stopped at its cost cap before the cone answered.');
    expect(trace.metrics.cost_capped).toBe(true);
  });
});
