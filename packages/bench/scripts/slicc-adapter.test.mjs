import { describe, expect, it, vi } from 'vitest';
import {
  buildPrompt,
  FINAL_INSTRUCTION,
  installLeaderScript,
  LEADER_SCRIPT,
  parseArchive,
  parseSkillsCondition,
  quote,
  restoreSkills,
  restoreSkillsCommand,
  runTask,
  stageSkills,
  stageSkillsCommand,
  traceFromResult,
} from './slicc-adapter.mjs';

const ARCHIVE = `# Agent session: steely-nozzle

- jid: agent_steely_nozzle
- exit code: 0

## Prompt

Open it.

---

## user

Open it.

## assistant

### tool: bash

## assistant

Done.
FINAL ANSWER: done
`;

/** A fake leader: records every command and answers from a routing table. */
function fakeExec(routes = []) {
  const calls = [];
  const exec = vi.fn(async (command, options = {}) => {
    calls.push({ command, stdin: options.stdin, timeoutMs: options.timeoutMs });
    for (const [pattern, reply] of routes) {
      if (pattern.test(command))
        return typeof reply === 'function' ? reply(command, options) : reply;
    }
    return { stdout: '', stderr: '', status: 0 };
  });
  return { exec, calls };
}

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
    expect(cmd).toContain('rm -rf /workspace/skills');
    expect(cmd).toContain('cp -r /workspace/.bench-skills-builtin/. /workspace/skills/');
    expect(cmd).toContain('cp -r /workspace/bench-skills/ecoverse/. /workspace/skills/');
    expect(stageSkillsCommand(parseSkillsCondition('none'))).not.toContain(
      'cp -r /workspace/.bench-skills-builtin/. /workspace/skills/'
    );
    expect(restoreSkillsCommand()).toContain(
      'cp -r /workspace/.bench-skills-builtin/. /workspace/skills/'
    );
  });

  it('reports how many skills are staged, and fails loudly', async () => {
    const { exec } = fakeExec([
      [/ls \/workspace\/skills \| wc -l$/, { stdout: 'x\n29\n', stderr: '', status: 0 }],
    ]);
    expect(await stageSkills(exec, parseSkillsCondition('builtin'))).toBe(29);
    await restoreSkills(exec);
    const broken = fakeExec([[/./, { stdout: '', stderr: 'cp: no such file', status: 1 }]]);
    await expect(stageSkills(broken.exec, parseSkillsCondition('none'))).rejects.toThrow(
      /exited 1: cp: no such file/
    );
    const odd = fakeExec([[/./, { stdout: 'n/a', stderr: '', status: 0 }]]);
    expect(await stageSkills(odd.exec, parseSkillsCondition('none'))).toBe(0);
  });
});

describe('transcripts', () => {
  it('splits the archive after its header into role sections', () => {
    expect(parseArchive(ARCHIVE)).toEqual([
      '## user\n\nOpen it.',
      '## assistant\n\n### tool: bash',
      '## assistant\n\nDone.\nFINAL ANSWER: done',
    ]);
    expect(parseArchive('## user\nhi')).toEqual(['## user\nhi']);
    expect(parseArchive(undefined)).toEqual([]);
  });

  it('turns result.json into a judge trace', () => {
    const trace = traceFromResult({
      finalText: 'FINAL ANSWER: done',
      archive: ARCHIVE,
      screenshots: [{ label: 'x', base64: 'AA' }],
      outputFiles: [
        { path: '/tmp/bench/r/a.txt', text: 'hello' },
        { path: '/tmp/bench/r/big.bin', text: null, size: 9 },
      ],
      durationMs: 12000,
      costUsd: 0.05,
      tokens: 100,
      exitCode: 0,
      tabs: ['https://example.com/'],
    });
    expect(trace.steps).toHaveLength(3);
    expect(trace.metrics).toEqual({
      steps: 2,
      duration: 12,
      cost: 0.05,
      tokens: 100,
      exitCode: 0,
      timedOut: false,
      tabs: ['https://example.com/'],
    });
    expect(trace.outputFilesText).toBe(
      '### /tmp/bench/r/a.txt\nhello\n\n### /tmp/bench/r/big.bin\n(9 bytes, not inlined)'
    );
  });

  it('explains a run that produced no answer', () => {
    const timedOut = traceFromResult({
      finalText: '',
      timedOut: true,
      archive: '',
      durationMs: 1000,
      exitCode: 143,
      turns: 4,
    });
    expect(timedOut.finalResult).toMatch(/time limit/);
    expect(timedOut.steps).toEqual(['(no transcript was saved; agent exit code 143)']);
    expect(timedOut.metrics.steps).toBe(4);
    expect(timedOut.screenshots).toEqual([]);
    expect(timedOut.outputFilesText).toBeNull();
    expect(
      traceFromResult({ finalText: '', stderr: 'agent: model not allowed', durationMs: 0 })
        .finalResult
    ).toBe('The agent failed: agent: model not allowed');
    expect(
      traceFromResult({ durationMs: 0, outputFiles: [{ path: '/x', text: null }] }).outputFilesText
    ).toBe('### /x\n(? bytes, not inlined)');
  });
});

describe('runTask', () => {
  const RESULT = { runId: 'r1', exitCode: 0, finalText: 'FINAL ANSWER: 42' };

  it('writes files and the prompt, runs the leader script, and reads the result', async () => {
    const { exec, calls } = fakeExec([
      [
        /^cat \/tmp\/bench\/r1\/result\.json$/,
        { stdout: JSON.stringify(RESULT), stderr: '', status: 0 },
      ],
    ]);
    const task = {
      id: 't',
      task: 'What is 6×7?',
      slicc: { timeoutSeconds: 60, files: [{ from: '/host/a.html', to: '/workspace/a b/a.html' }] },
    };
    const out = await runTask({
      exec,
      task,
      runId: 'r1',
      model: 'claude-sonnet-5',
      thinking: 'low',
      readFile: () => Buffer.from('<p>hi</p>'),
    });
    expect(out).toEqual(RESULT);
    expect(calls[0].command).toBe('rm -rf /tmp/bench/r1 && mkdir -p /tmp/bench/r1');
    expect(calls[1]).toMatchObject({
      command: "mkdir -p '/workspace/a b' && base64 -d > '/workspace/a b/a.html'",
      stdin: Buffer.from('<p>hi</p>').toString('base64'),
    });
    expect(calls[2]).toMatchObject({
      command: 'cat > /tmp/bench/r1/prompt.txt',
      stdin: buildPrompt(task),
    });
    expect(calls[3]).toMatchObject({
      command: `node '${LEADER_SCRIPT}' 'r1' 'claude-sonnet-5' '60' 'low'`,
      timeoutMs: 180000,
    });
  });

  it('uses the default timeout and names the failure when no result was written', async () => {
    const { exec, calls } = fakeExec([
      [/^node /, { stdout: '', stderr: 'SyntaxError: boom', status: 1 }],
      [/^cat \/tmp\/bench\/r2\/result\.json$/, { stdout: '', stderr: 'no such file', status: 1 }],
    ]);
    await expect(
      runTask({ exec, task: { id: 't', task: 'x' }, runId: 'r2', model: 'm' })
    ).rejects.toThrow(/left no result \(exit 1\): SyntaxError: boom/);
    expect(calls.find((c) => c.command.startsWith('node ')).command).toBe(
      `node '${LEADER_SCRIPT}' 'r2' 'm' '900'`
    );
  });

  it('refuses an unsafe run id and a failing setup step', async () => {
    const { exec } = fakeExec();
    await expect(runTask({ exec, task: { task: 'x' }, runId: 'a b', model: 'm' })).rejects.toThrow(
      /bad run id/
    );
    const broken = fakeExec([[/^rm -rf/, { stdout: '', stderr: 'read-only', status: 1 }]]);
    await expect(
      runTask({ exec: broken.exec, task: { task: 'x' }, runId: 'r3', model: 'm' })
    ).rejects.toThrow(/exited 1: read-only/);
  });

  it('reads task files from disk by default', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const file = join(mkdtempSync(join(tmpdir(), 'bench-file-')), 'a.txt');
    writeFileSync(file, 'hello');
    const { exec, calls } = fakeExec([[/result\.json$/, { stdout: '{}', stderr: '', status: 0 }]]);
    await runTask({
      exec,
      task: { task: 'x', slicc: { files: [{ from: file, to: '/workspace/a.txt' }] } },
      runId: 'r4',
      model: 'm',
    });
    expect(calls[1].stdin).toBe(Buffer.from('hello').toString('base64'));
  });

  it('installs the leader script from the package', async () => {
    const { exec, calls } = fakeExec();
    await installLeaderScript(exec);
    expect(calls[0].command).toBe(`mkdir -p /tmp/bench && cat > ${LEADER_SCRIPT}`);
    expect(calls[0].stdin).toContain("require('sliccy:exec')");
    await installLeaderScript(exec, 'custom');
    expect(calls[1].stdin).toBe('custom');
  });
});
