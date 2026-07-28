import type { IFileSystem } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { createCmpCommand } from '../../../src/shell/supplemental-commands/cmp-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

function context(files: Record<string, number[]>) {
  return mockCommandContext({
    cwd: '/work',
    fs: {
      readFileBuffer: vi.fn(async (path: string) => {
        const bytes = files[path];
        if (!bytes) throw new Error('ENOENT');
        return new Uint8Array(bytes);
      }) as unknown as IFileSystem['readFileBuffer'],
    },
  });
}

describe('cmp command', () => {
  it('returns 0 without output for byte-identical files', async () => {
    const ctx = context({ '/work/a': [97, 10], '/work/b': [97, 10] });
    await expect(createCmpCommand().execute(['a', 'b'], ctx)).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  });

  it.each(['-s', '--quiet', '--silent'])('silences differences with %s', async (flag) => {
    const ctx = context({ '/work/a': [97, 10], '/work/b': [98, 10] });
    await expect(createCmpCommand().execute([flag, 'a', 'b'], ctx)).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 1,
    });
  });

  it('reports the first differing byte and line', async () => {
    const ctx = context({ '/work/a': [97, 10, 120], '/work/b': [97, 10, 121] });
    const result = await createCmpCommand().execute(['a', 'b'], ctx);
    expect(result).toEqual({ stdout: 'a b differ: byte 3, line 2\n', stderr: '', exitCode: 1 });
  });

  it('uses an error exit code for unreadable input', async () => {
    const result = await createCmpCommand().execute(['missing', 'b'], context({ '/work/b': [] }));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('cmp: missing: No such file or directory');
  });
});
