import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash cp -f patch (%s)', (_runtime, Shell) => {
  const run = async (script: string) => {
    const r = await new Shell().exec(script);
    return `${r.stdout}${r.stderr}`;
  };

  it('copies with -f and --force', async () => {
    expect(await run('echo a > /a; cp -f /a /b && cat /b')).toBe('a\n');
    expect(await run('echo a > /a; cp --force /a /b && cat /b')).toBe('a\n');
  });

  it('overwrites a read-only destination', async () => {
    expect(await run('echo a > /a; echo b > /c; chmod 444 /c; cp -f /a /c && cat /c')).toBe('a\n');
  });

  it('combines with other flags, and -n still wins', async () => {
    expect(await run('mkdir -p /d/s; echo x > /d/s/f; cp -rf /d /e && cat /e/s/f')).toBe('x\n');
    expect(await run('echo a > /a; echo b > /c; cp -n -f /a /c; cat /c')).toBe('b\n');
  });

  it('lists -f in --help', async () => {
    expect(await run('cp --help')).toContain('-f, --force');
  });

  it('unlinks an existing dest only on dest-open failures', async () => {
    const bash = new Shell();
    await bash.exec('echo src > /src; echo KEEP > /dest');
    const rmTargets: string[] = [];
    const origRm = bash.fs.rm.bind(bash.fs);
    bash.fs.rm = async (path, ...rest) => {
      rmTargets.push(String(path));
      return origRm(path, ...rest);
    };
    let calls = 0;
    const origCp = bash.fs.cp.bind(bash.fs);
    bash.fs.cp = async (...args) => {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
      }
      return origCp(...args);
    };
    const r = await bash.exec('cp -f /src /dest; cat /dest');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('src\n');
    expect(rmTargets).toContain('/dest');
  });

  it('preserves an existing dest on unrelated copy failures', async () => {
    const bash = new Shell();
    await bash.exec('echo src > /src; echo KEEP > /dest');
    const rmTargets: string[] = [];
    const origRm = bash.fs.rm.bind(bash.fs);
    bash.fs.rm = async (path, ...rest) => {
      rmTargets.push(String(path));
      return origRm(path, ...rest);
    };
    bash.fs.cp = async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    };
    const r = await bash.exec('cp -f /src /dest; cat /dest');
    expect(r.stderr).toContain('ENOSPC');
    expect(r.stdout).toBe('KEEP\n');
    expect(rmTargets).not.toContain('/dest');
  });
});

describe('just-bash cp -f patch (node abort/limit)', () => {
  it('does not unlink the dest when copy aborts or hits a quota limit', async () => {
    const errorsUrl = pathToFileURL(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../node_modules/just-bash/dist/bundle/chunks/chunk-EFORKKSH.js'
      )
    ).href;
    const { l: ExecutionLimitError, m: ExecutionAbortedError } = await import(errorsUrl);

    for (const makeErr of [
      () => new ExecutionAbortedError('cp', 'test'),
      () => new ExecutionLimitError('output', 'cp', 'quota'),
    ]) {
      const bash = new Bash();
      await bash.exec('echo src > /src; echo KEEP > /dest');
      const rmTargets: string[] = [];
      const origRm = bash.fs.rm.bind(bash.fs);
      bash.fs.rm = async (path, ...rest) => {
        rmTargets.push(String(path));
        return origRm(path, ...rest);
      };
      bash.fs.cp = async () => {
        throw makeErr();
      };
      const r = await bash.exec('cp -f /src /dest');
      expect([124, 126]).toContain(r.exitCode);
      expect(await bash.fs.readFile('/dest')).toBe('KEEP\n');
      expect(rmTargets).not.toContain('/dest');
    }
  });
});
