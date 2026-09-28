import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  carriedEnv,
  outputText,
  parseBashState,
  runOnGnuBash,
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
  it.skipIf(!bash)('writes status, PIPESTATUS, $PWD and the exports on exit (host bash)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slicc-hook-'));
    const hook = join(dir, 'hook.sh');
    const statePath = join(dir, 'state');
    writeFileSync(hook, STATE_HOOK);
    const env = {
      PATH: process.env.PATH ?? '',
      KEEP: 'a',
      BASH_ENV: hook,
      SLICC_BASH_STATE: statePath,
    };
    const script =
      'cd / && export NEW=$(printf "x\\ny"); unset KEEP; HIDDEN=1; ' +
      'echo "nested=$(bash -c \'echo ${SLICC_BASH_STATE:-none}\')"; false | true | (exit 3)';
    let status = 0;
    let out = '';
    try {
      out = execFileSync(bash as string, ['-c', script], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = (e as { status: number }).status;
      out = String((e as { stdout: string }).stdout);
    }
    expect(status).toBe(3);
    expect(out).toContain('nested=none');
    const state = parseBashState(readFileSync(statePath, 'utf8'));
    expect(state).toMatchObject({ status: 3, pipeStatus: [1, 0, 3], cwd: '/' });
    expect(state?.env.NEW).toBe('x\ny');
    expect(state?.env.KEEP).toBeUndefined();
    expect(state?.env.HIDDEN).toBeUndefined();
    expect(state?.env.BASH_ENV).toBeUndefined();
  });
});

describe('runOnGnuBash', () => {
  function fakeFs(files = new Map<string, string>()) {
    return {
      files,
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (path: string, content: string) => void files.set(path, content)),
      readFile: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error('ENOENT');
        return content;
      }),
      rm: vi.fn(async (path: string) => void files.delete(path)),
    };
  }

  it('runs bash -c with the hook and a fresh state file, then reads and removes it', async () => {
    const fs = fakeFs();
    const result = await runOnGnuBash('echo hi', {
      fs,
      tmpDir: '/tmp/cone/',
      env: { A: '1' },
      run: async (args, env) => {
        expect(args).toEqual(['bash', '-c', 'echo hi']);
        expect(env.A).toBe('1');
        expect(env.BASH_ENV).toBe('/tmp/cone/.slicc-bash-env.sh');
        expect(fs.files.get(env.BASH_ENV!)).toBe(STATE_HOOK);
        fs.files.set(env.SLICC_BASH_STATE!, '0\x000\x00/w\x00A=2\x00');
        return { stdout: 'hi\n', stderr: '', exitCode: 0 };
      },
    });
    expect(fs.mkdir).toHaveBeenCalledWith('/tmp/cone', { recursive: true });
    expect(result).toMatchObject({
      stdout: 'hi\n',
      exitCode: 0,
      state: { cwd: '/w', env: { A: '2' } },
    });
    expect([...fs.files.keys()]).toEqual(['/tmp/cone/.slicc-bash-env.sh']);
  });

  it('reports no state when the run left none (it exec’d, replaced the trap, or was killed)', async () => {
    const result = await runOnGnuBash('exec true', {
      fs: fakeFs(),
      tmpDir: '/tmp',
      env: {},
      run: async () => ({ stdout: '', stderr: '', exitCode: 137 }),
    });
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 137, state: null });
  });
});
