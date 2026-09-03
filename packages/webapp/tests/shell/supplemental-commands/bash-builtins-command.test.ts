/**
 * Regression tests for #2816: bash builtins that `help` advertises but
 * just-bash never implemented.
 *
 * The load-bearing test is `parity with the help table` — it walks the live
 * `help` listing through a real shell and asserts no advertised name answers
 * `command not found`. That is what keeps the table and dispatch from
 * drifting apart again when just-bash is upgraded.
 */

import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../../src/shell/almost-bash-shell-headless.js';
import { runBashBuiltin } from '../../../src/shell/supplemental-commands/bash-builtins/run.js';
import {
  BASH_BUILTIN_COMMAND_NAMES,
  createBashBuiltinCommands,
} from '../../../src/shell/supplemental-commands/bash-builtins-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

function run(name: string, args: string[] = []) {
  return runBashBuiltin(name, args, mockCommandContext({ cwd: '/' }));
}

describe('bash builtin registration', () => {
  it('registers exactly the documented name set', () => {
    expect(createBashBuiltinCommands().map((c) => c.name)).toEqual([...BASH_BUILTIN_COMMAND_NAMES]);
  });

  it('routes a registered stub into the lazily-imported implementation', async () => {
    const fg = createBashBuiltinCommands().find((c) => c.name === 'fg');
    await expect(fg?.execute([], mockCommandContext({ cwd: '/' }))).resolves.toEqual({
      stdout: '',
      stderr: 'bash: fg: no job control\n',
      exitCode: 1,
    });
  });

  it('treats an unregistered name as a wiring bug', async () => {
    await expect(run('nope')).rejects.toThrow(/no implementation registered/);
  });

  it.each([...BASH_BUILTIN_COMMAND_NAMES])(
    '%s answers --help with usage on stdout',
    async (name) => {
      const result = await run(name, ['--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain(`${name} -`);
      expect(result.stdout).toContain('Usage:');
    }
  );
});

describe('job-control builtins', () => {
  it('jobs prints an empty table because & runs synchronously', async () => {
    await expect(run('jobs')).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('jobs rejects a jobspec with bash wording', async () => {
    const result = await run('jobs', ['%1']);
    expect(result).toEqual({ stdout: '', stderr: 'bash: jobs: %1: no such job\n', exitCode: 1 });
  });

  it('jobs ignores listing flags', async () => {
    await expect(run('jobs', ['-l'])).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it.each([
    ['fg', 'bash: fg: no job control\n'],
    ['bg', 'bash: bg: no job control\n'],
    ['suspend', 'bash: suspend: cannot suspend: no job control\n'],
    ['logout', "bash: logout: not login shell: use `exit'\n"],
    ['disown', 'bash: disown: current: no such job\n'],
  ])('%s reports bashʼs own diagnostic and exits 1', async (name, stderr) => {
    await expect(run(name)).resolves.toEqual({ stdout: '', stderr, exitCode: 1 });
  });

  it('disown names the requested jobspec', async () => {
    const result = await run('disown', ['%2']);
    expect(result.stderr).toBe('bash: disown: %2: no such job\n');
  });
});

describe('trap', () => {
  it('lists the signals the kernel can actually deliver', async () => {
    const result = await run('trap', ['-l']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('SIGINT');
    expect(result.stdout).toContain('SIGTERM');
    expect(result.stdout).toContain('SIGKILL');
    expect(result.stdout).toContain('SIGSTOP');
    expect(result.stdout).toContain('SIGCONT');
    // Signals the kernel cannot raise are not advertised.
    expect(result.stdout).not.toContain('SIGHUP');
  });

  it.each([[[]], [['-p']], [['-p', 'INT']]])(
    'reports an empty trap table for %j',
    async (args: string[]) => {
      await expect(run('trap', args)).resolves.toEqual({ stdout: '', stderr: '', exitCode: 0 });
    }
  );

  it('accepts reset-to-default because nothing is trapped', async () => {
    await expect(run('trap', ['-', 'INT', 'TERM'])).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  });

  it('accepts ignore because nothing raises the signal', async () => {
    await expect(run('trap', ['', 'INT'])).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  });

  it('refuses to install a handler instead of silently dropping it', async () => {
    const result = await run('trap', ['echo cleanup', 'EXIT']);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('signal handlers are not supported in this shell');
  });
});

describe('builtins with no implementable behaviour', () => {
  it.each(['caller', 'enable', 'fc', 'times', 'ulimit', 'umask'])(
    '%s exits 2 with a reason rather than succeeding as a no-op',
    async (name) => {
      const result = await run(name);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr.startsWith(`bash: ${name}: `)).toBe(true);
      expect(result.stderr.trim().length).toBeGreaterThan(`bash: ${name}: `.length);
    }
  );

  it('points fc at history and umask at chmod', async () => {
    await expect(run('fc')).resolves.toMatchObject({
      stderr: expect.stringContaining("use 'history'"),
    });
    await expect(run('umask')).resolves.toMatchObject({
      stderr: expect.stringContaining("'chmod'"),
    });
  });
});

describe('parity with the help table', () => {
  let shell: AlmostBashShellHeadless;
  let advertised: string[];

  beforeAll(async () => {
    const fs = await VirtualFS.create({ dbName: 'test-bash-builtins-2816', wipe: true });
    shell = new AlmostBashShellHeadless({ fs });
    const help = await shell.executeCommand('help | cat');
    // The listing is a banner followed by a blank line, then two columns.
    advertised = help.stdout
      .split('\n')
      .slice(4)
      .flatMap((line) => line.trim().split(/\s+/))
      .filter(Boolean);
  });

  it('advertises a non-trivial builtin list', () => {
    expect(advertised.length).toBeGreaterThan(40);
    expect(advertised).toContain('trap');
    expect(advertised).toContain('jobs');
  });

  it('has no advertised builtin that answers 127', async () => {
    const notFound: string[] = [];
    for (const name of advertised) {
      const result = await shell.executeCommand(name);
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (output.includes(`bash: ${name}: command not found`)) notFound.push(name);
    }
    expect(notFound).toEqual([]);
  }, 60_000);

  it('keeps trap from half-working end to end', async () => {
    const result = await shell.executeCommand("trap 'echo cleanup' EXIT; echo body");
    // The body still runs (just-bash parses the statement and continues), but
    // the failed handler installation is now loud instead of a 127.
    expect(result.stdout).toContain('body');
    expect(result.stderr).toContain('signal handlers are not supported in this shell');
    expect(result.stderr).not.toContain('command not found');
  });
});
