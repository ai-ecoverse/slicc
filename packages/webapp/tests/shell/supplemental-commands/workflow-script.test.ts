import { describe, expect, it } from 'vitest';
import {
  buildWorkflowCode,
  makeSentinel,
  parseMetaBanner,
  splitSentinel,
  stripExports,
} from '../../../src/shell/supplemental-commands/workflow-script.js';

describe('workflow-script', () => {
  it('makeSentinel is random per call and prefixed', () => {
    const a = makeSentinel(),
      b = makeSentinel();
    expect(a).toMatch(/^WF_RESULT_/);
    expect(a).not.toBe(b);
  });
  it('parses name/description from a pure-literal meta', () => {
    const src = `export const meta = {\n name: 'review',\n description: 'd',\n}\nreturn 1`;
    expect(parseMetaBanner(src)).toEqual({ name: 'review', description: 'd' });
  });
  it('returns nulls when meta absent', () => {
    expect(parseMetaBanner('const x=1; return x')).toEqual({ name: null, description: null });
  });
  it('strips export from declarations', () => {
    expect(stripExports('export const meta = {}\nexport async function f(){}')).toBe(
      'const meta = {}\nasync function f(){}'
    );
  });
  it('builds code: __WF config + prelude + IIFE body + sentinel emit (threaded token)', () => {
    const code = buildWorkflowCode({
      prelude: '/*P*/',
      config: { args: undefined, cap: 4, budget: null, cwd: '/workspace', agentCwd: '/s/scratch/' },
      body: 'export const meta = {}\nreturn { ok: true }',
      sentinel: 'WF_RESULT_xyz',
    });
    expect(code).toContain('"cap":4');
    expect(code).not.toContain('sentinel'); // NOT exposed via __WF (anti-spoof)
    expect(code).not.toContain('"args"'); // undefined omitted by JSON.stringify
    expect(code).toContain('/*P*/');
    expect(code).toContain('const __r = await (async () => {');
    expect(code).toContain('const meta = {}'); // export stripped
    expect(code).toContain('__emit("WF_RESULT_xyz" + __stringify(__r ?? null))'); // literal token via captured emit/stringify
  });
  it('does not expose the sentinel to user code (anti-spoof)', () => {
    const code = buildWorkflowCode({
      prelude: '',
      config: { cap: 4, budget: null, cwd: '/', agentCwd: '/s/' },
      body: 'return typeof __WF.sentinel',
      sentinel: 'WF_RESULT_secret',
    });
    expect(code).not.toContain('WF_RESULT_secret\\"'); // never a JSON value in __WF
  });
  it('splits the sentinel result line from the log (token param)', () => {
    const out = `WFLOG hi\nWF_RESULT_xyz{"ok":true}\n`;
    expect(splitSentinel(out, 'WF_RESULT_xyz')).toEqual({
      result: { ok: true },
      log: 'WFLOG hi',
      hadResult: true,
    });
  });
  it('hadResult:false when no sentinel line', () => {
    expect(splitSentinel('logs\n', 'WF_RESULT_xyz')).toEqual({
      result: null,
      log: 'logs',
      hadResult: false,
    });
  });
});
