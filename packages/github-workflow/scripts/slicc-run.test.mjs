import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from '../tests/helpers.mjs';
import { main, TIMEOUT_EXIT_CODE } from './slicc-run.mjs';

describe('slicc-run', () => {
  let t;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    t.teardown();
    vi.restoreAllMocks();
  });

  it('sends a prompt via @file (so a leading @ is literal) and records the reply', async () => {
    const outputFile = join(t.root, 'deep', 'dir', 'response.md');
    t.inputs({
      verb: 'prompt',
      text: '@review the patch',
      'output-file': outputFile,
      timeout: '1m',
    });
    const r = await main();
    expect(r.exitCode).toBe(0);
    expect(readFileSync(outputFile, 'utf8')).toBe('reply to: @review the patch');
    const out = t.outputs();
    expect(out.output).toBe('reply to: @review the patch');
    expect(out['output-file']).toBe(outputFile);
    expect(out['exit-code']).toBe('0');
    expect(out['timed-out']).toBe('false');
    expect(out.truncated).toBe('false');
    const call = t.calls()[0];
    expect(call.verb).toBe('prompt');
    expect(call.rest[0].startsWith('@')).toBe(true);
    expect(readFileSync(call.rest[0].slice(1), 'utf8')).toBe('@review the patch');
  });

  it('defaults the output file, forwards stdin, and truncates large outputs', async () => {
    const stdin = join(t.root, 'in.txt');
    writeFileSync(stdin, 'piped bytes');
    t.inputs({ verb: 'exec', text: 'cat-stdin', 'stdin-file': stdin, 'output-limit': '5' });
    await main();
    const out = t.outputs();
    expect(out['output-file']).toMatch(new RegExp(`^${join(t.home, 'out')}/exec-\\d+\\.txt$`));
    expect(readFileSync(out['output-file'], 'utf8')).toBe('piped bytes');
    expect(out.output.startsWith('piped')).toBe(true);
    expect(out.truncated).toBe('true');
  });

  it('reports a non-zero exit without failing when fail-on-error is false', async () => {
    t.inputs({ verb: 'exec', text: 'fail 7', 'fail-on-error': 'false', quiet: 'true' });
    const r = await main();
    expect(r.exitCode).toBe(7);
    expect(t.outputs()['exit-code']).toBe('7');
    t.inputs({ 'fail-on-error': 'true' });
    await expect(main()).rejects.toThrow(/exited with status 7/);
  });

  it('times out with SIGINT then SIGKILL', async () => {
    t.inputs({ verb: 'prompt', text: 'SLOW question', timeout: '300ms' });
    await expect(main({ killGraceMs: 200 })).rejects.toThrow(/exceeded its 0s timeout/);
    expect(t.outputs()['exit-code']).toBe(String(TIMEOUT_EXIT_CODE));
    expect(t.outputs()['timed-out']).toBe('true');
  });

  it('retries a failed dial and succeeds', async () => {
    writeFileSync(join(t.fake, 'dial-failures'), '2');
    t.inputs({ verb: 'exec', text: 'dial-fail then run' });
    const r = await main({ retryDelayMs: 10 });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('ok after retry\n');
    expect(t.calls().length).toBe(3);
    expect(console.log).toHaveBeenCalledWith(
      '::warning::leader dial failed (attempt 1/3); retrying'
    );
  });

  it('gives up after the retry budget', async () => {
    writeFileSync(join(t.fake, 'dial-failures'), '9');
    t.inputs({ verb: 'prompt', text: 'DIALFAIL' });
    await expect(main({ retryDelayMs: 10, retries: 2 })).rejects.toThrow(/exited with status 1/);
    expect(t.calls().length).toBe(2);
  });

  it('validates verb and text', async () => {
    t.inputs({ verb: 'watch', text: 'x' });
    await expect(main()).rejects.toThrow(/verb must be/);
    t.inputs({ verb: 'exec', text: '' });
    await expect(main()).rejects.toThrow(/"text" is required/);
    expect(existsSync(join(t.home, 'out'))).toBe(false);
  });
});
