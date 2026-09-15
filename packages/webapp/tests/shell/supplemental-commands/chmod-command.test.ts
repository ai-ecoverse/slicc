import { describe, expect, it, vi } from 'vitest';
import { createChmodCommand } from '../../../src/shell/supplemental-commands/chmod-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

function errno(code: string, message: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${message} '${path}'`), { code });
}

function fsStub(options: {
  missing?: boolean;
  chmod?: (path: string, mode: number) => Promise<void>;
}) {
  return {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    stat: vi.fn(async (path: string) => {
      if (options.missing) throw errno('ENOENT', 'no such file or directory', path);
      return { isFile: true, isDirectory: false, isSymbolicLink: false, mode: 0o644 };
    }),
    chmod:
      options.chmod ??
      vi.fn(async (path: string) => {
        throw errno(
          'EOPNOTSUPP',
          'the VFS does not support an executable bit; run it with the interpreter, e.g. bash <file>',
          path
        );
      }),
  };
}

describe('chmod overlay (#3109)', () => {
  it('fails with EOPNOTSUPP on an existing file instead of pretending ENOENT', async () => {
    const fs = fsStub({});
    const result = await createChmodCommand().execute(
      ['+x', '/tmp/execbit-probe.sh'],
      mockCommandContext({ cwd: '/tmp', fs: fs as never })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/EOPNOTSUPP/);
    expect(result.stderr).toMatch(/executable bit/);
    expect(result.stderr).not.toMatch(/No such file/);
    expect(fs.chmod).toHaveBeenCalled();
  });

  it('reports ENOENT for a missing file', async () => {
    const result = await createChmodCommand().execute(
      ['+x', '/gone.sh'],
      mockCommandContext({ cwd: '/', fs: fsStub({ missing: true }) as never })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/ENOENT|No such file/i);
  });

  it('rejects a missing operand and answers --help', async () => {
    const cmd = createChmodCommand();
    const ctx = mockCommandContext({ cwd: '/' });
    await expect(cmd.execute([], ctx)).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('missing operand'),
    });
    const help = await cmd.execute(['--help'], ctx);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('EOPNOTSUPP');
  });
});
