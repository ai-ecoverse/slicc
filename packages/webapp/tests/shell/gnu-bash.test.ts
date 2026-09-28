import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  carriedEnv,
  outputText,
  parseBashState,
  runOnGnuBash,
  STATE_FD,
  STATE_HOOK,
} from '../../src/shell/gnu-bash.js';

function hostBash(): string | null {
  for (const bash of ['/opt/homebrew/bin/bash', '/usr/bin/bash', '/bin/bash']) {
    try {
      const out = execFileSync(bash, ['-c', 'x=1; n=x; echo "${BASH_VERSINFO[0]}:${!n@a}"'], {
        encoding: 'utf8',
      });
      if (Number(out.split(':')[0]) >= 5) return bash;
    } catch {}
  }
  return null;
}

describe('the GNU bash state hook', () => {
  it('parses the state a run leaves; rejects anything else', () => {
    expect(parseBashState('3\x001 0 3\x00/w\x00A=1\x00B=x\ny\x00')).toEqual({
      status: 3,
      pipeStatus: [1, 0, 3],
      cwd: '/w',
      env: { A: '1', B: 'x\ny' },
    });
    expect(parseBashState('0\x00\x00/\x00')).toEqual({
      status: 0,
      pipeStatus: [],
      cwd: '/',
      env: {},
    });
    expect(parseBashState('')).toBeNull();
    expect(parseBashState('x\x000\x00/\x00')).toBeNull();
    expect(parseBashState('0\x000\x00relative\x00')).toBeNull();
  });

  it('carries exports minus the run’s own markers; decodes byte output as UTF-8', () => {
    expect(carriedEnv({ A: '1', SHLVL: '2', _: 'x', TAG: 't' }, ['TAG'])).toEqual({ A: '1' });
    const bytes = String.fromCharCode(...new TextEncoder().encode('café'));
    expect(outputText(bytes, 'bytes')).toBe('café');
    expect(outputText('text', undefined)).toBe('text');
  });

  const bash = hostBash();
  it.skipIf(!bash)(
    'writes status, PIPESTATUS, $PWD and the exports to its descriptor on exit (host bash)',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'slicc-hook-'));
      const statePath = join(dir, 'state');
      const script =
        'nosuchcmd; cd / && export NEW=$(printf "x\\ny"); unset KEEP; HIDDEN=1; false | true | (exit 3)';
      let status = 0;
      let err = '';
      try {
        execFileSync(
          bash as string,
          [
            '-c',
            `exec ${STATE_FD}>"$1"; exec "$0" -c "$2"`,
            bash as string,
            statePath,
            STATE_HOOK + script,
          ],
          {
            env: { PATH: process.env.PATH ?? '', KEEP: 'a' },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
      } catch (e) {
        status = (e as { status: number }).status;
        err = String((e as { stderr: string }).stderr);
      }
      expect(status).toBe(3);
      expect(err).toMatch(/line 1: nosuchcmd/);
      const state = parseBashState(readFileSync(statePath, 'utf8'));
      expect(state).toMatchObject({ status: 3, pipeStatus: [1, 0, 3], cwd: '/' });
      expect(state?.env.NEW).toBe('x\ny');
      expect(state?.env.KEEP).toBeUndefined();
      expect(state?.env.HIDDEN).toBeUndefined();
    }
  );
});

describe('runOnGnuBash', () => {
  it('runs the command after the hook, collecting the state on the private descriptor', async () => {
    const result = await runOnGnuBash('echo hi', {
      env: { A: '1' },
      run: async (args, env, fds) => {
        expect(args).toEqual(['bash', '-c', `${STATE_HOOK}echo hi`]);
        expect(env).toEqual({ A: '1' });
        expect(fds.map(([fd]) => fd)).toEqual([STATE_FD]);
        const sink = fds[0]![1];
        await sink.file.write?.(new TextEncoder().encode('0\x000\x00/w\x00'));
        await sink.file.write?.(new TextEncoder().encode('A=2\x00'));
        return { stdout: 'hi\n', stderr: '', exitCode: 0 };
      },
    });
    expect(result).toMatchObject({
      stdout: 'hi\n',
      exitCode: 0,
      state: { cwd: '/w', env: { A: '2' } },
    });
  });

  it('reports no state when the run left none (it exec’d, replaced the trap, or was killed)', async () => {
    const result = await runOnGnuBash('exec true', {
      env: {},
      run: async () => ({ stdout: '', stderr: '', exitCode: 137 }),
    });
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 137, state: null });
  });
});
