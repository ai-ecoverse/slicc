import { describe, expect, it } from 'vitest';
import { bashReads, fileClass, normalise, sessionReads } from './hf-reads.mjs';
import { quantile, splitShell, topShares } from './lib.mjs';
import { delivered, pipelines, ranges, readMethod } from './skill-reads.mjs';

const FILE = Array.from({ length: 200 }, (_, i) =>
  i % 10 === 5 ? '' : `line ${i + 1}: some distinctive text`
).join('\n');
const head = (n) => FILE.split('\n').slice(0, n).join('\n');

describe('splitShell', () => {
  it('splits outside quotes only', () => {
    expect(splitShell(`grep -E 'a|b' x | head -5; cat "y;z"`, [';'])).toEqual([
      `grep -E 'a|b' x | head -5`,
      ` cat "y;z"`,
    ]);
    expect(splitShell(`grep "a\\|b" f | head`, ['|'])).toEqual([`grep "a\\|b" f `, ' head']);
  });
});

describe('pipelines + readMethod', () => {
  it('tracks cd and classifies head, sed, cat|head and head -c', () => {
    const p = pipelines(
      'cd /workspace && cat skills/x/SKILL.md | head -80; sed -n 1,60p skills/x/SKILL.md'
    );
    expect(p.map((x) => x.cwd)).toEqual(['/workspace', '/workspace']);
    expect(readMethod(p[0].seg, 'skills/x/SKILL.md')).toEqual({ method: 'cat|head', n: 80 });
    expect(readMethod(p[1].seg, 'skills/x/SKILL.md')).toEqual({ method: 'sed-range', n: '1-60' });
    expect(readMethod('head -c 3000 f.md', 'f.md')).toEqual({ method: 'head-c', n: 3000 });
    expect(readMethod('head -60 f.md', 'f.md')).toEqual({ method: 'head', n: 60 });
  });
});

describe('delivered', () => {
  it('counts exactly the lines a head read returned, blanks included', () => {
    const d = delivered(FILE, head(60));
    expect(d.lines).toBe(60);
    expect(d.maxLine).toBe(60);
    expect(ranges(d.covered)).toBe('1-60');
  });

  it('ignores unrelated output around the read', () => {
    const d = delivered(FILE, `tab-list: 3 tabs\n\`\`\`\n${head(20)}\n---\n`);
    expect(ranges(d.covered)).toBe('1-20');
  });

  it('strips grep -n prefixes and records the ranges', () => {
    const d = delivered(
      FILE,
      '12:line 12: some distinctive text\n150:line 150: some distinctive text'
    );
    expect(ranges(d.covered)).toBe('12,150');
  });
});

describe('bashReads', () => {
  it('parses windows and whole reads', () => {
    expect(bashReads(`sed -n '1,260p' src/App.jsx`)).toMatchObject([
      { path: 'src/App.jsx', method: 'sed -n', from: 1, to: 260 },
    ]);
    expect(bashReads('cat README.md | head -100')).toMatchObject([
      { path: 'README.md', method: 'cat|head', to: 100 },
    ]);
    expect(bashReads('nl -ba a.py | sed -n 40,80p')).toMatchObject([
      { method: 'nl|sed', from: 40, to: 80 },
    ]);
    expect(bashReads('cat a.md | wc -l')).toEqual([]);
    expect(bashReads('ls -la && echo hi')).toEqual([]);
  });
});

describe('normalise + sessionReads', () => {
  it('reads Claude Code Read results with totalLines', () => {
    const s = normalise([
      {
        type: 'assistant',
        uuid: 'a',
        message: {
          model: 'claude-x',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { file_path: '/r/SKILL.md', limit: 60 },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'b',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
        toolUseResult: {
          file: { filePath: '/r/SKILL.md', numLines: 60, startLine: 1, totalLines: 300 },
        },
      },
    ]);
    expect(s.harness).toBe('claude-code');
    expect(sessionReads(s)).toMatchObject([
      {
        model: 'claude-x',
        cls: 'skill',
        method: 'read limit',
        delivered: 60,
        fileLines: 300,
        full: false,
      },
    ]);
  });

  it('infers file length from a Codex window that came back short', () => {
    const out = Array.from({ length: 42 }, (_, i) => `l${i}`).join('\n');
    const s = normalise([
      { type: 'turn_context', payload: { model: 'gpt-y' } },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'c1',
          arguments: JSON.stringify({ cmd: "sed -n '1,220p' AGENTS.md" }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c1',
          output: `Process exited with code 0\nOutput:\n${out}\n`,
        },
      },
    ]);
    expect(sessionReads(s)).toMatchObject([
      {
        harness: 'codex',
        model: 'gpt-y',
        requested: 220,
        delivered: 42,
        fileLines: 42,
        full: true,
        cls: 'agent-instructions',
      },
    ]);
  });

  it('reads Pi read-tool footers', () => {
    const s = normalise([
      { type: 'model_change', modelId: 'anthropic/claude-z' },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'p1', name: 'read', arguments: { path: 'docs/a.md' } }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'p1',
          content: [
            { type: 'text', text: 'a\nb\n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]' },
          ],
        },
      },
    ]);
    expect(sessionReads(s)).toMatchObject([
      {
        harness: 'pi',
        model: 'claude-z',
        delivered: 2,
        fileLines: 900,
        truncated: true,
        cls: 'docs',
      },
    ]);
  });
});

describe('helpers', () => {
  it('classifies files and summarises', () => {
    expect(['x/SKILL.md', 'CLAUDE.md', 'README.md', 'a.ts', 'b.json'].map(fileClass)).toEqual([
      'skill',
      'agent-instructions',
      'docs',
      'source',
      'other',
    ]);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(topShares([60, 60, 80, 40], 2)).toBe('60 50%, 80 25%');
  });
});
