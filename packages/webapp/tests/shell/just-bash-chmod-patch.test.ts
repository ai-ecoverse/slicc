import { Bash, InMemoryFs } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it, vi } from 'vitest';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('upstream chmod error patch (%s)', (_runtime, Shell) => {
  it.each(['EOPNOTSUPP', 'ENOSYS', 'EACCES', 'EIO'])(
    'preserves %s instead of reporting a missing file',
    async (code) => {
      const fs = new InMemoryFs({ '/file': 'content' });
      vi.spyOn(fs, 'chmod').mockRejectedValue(
        Object.assign(new Error(`${code}: metadata change failed`), { code })
      );
      const shell = new Shell({ fs });
      const result = await shell.exec('chmod +x /file');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(code);
      expect(result.stderr).not.toContain('No such file or directory');
      expect((await fs.stat('/file')).mode).toBe(0o644);
    }
  );

  it('preserves missing-file errors and treats --help after -- as an operand', async () => {
    const shell = new Shell({ cwd: '/' });
    const missing = await shell.exec('chmod +x /missing');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toMatch(/ENOENT|No such file/i);
    const operand = await shell.exec('chmod +x -- --help');
    expect(operand.exitCode).toBe(1);
    expect(operand.stdout).not.toContain('Usage:');
    expect(operand.stderr).toContain('--help');
    expect(await shell.exec('chmod +x --')).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('missing operand'),
    });
    await shell.fs.writeFile('/--help', '');
    expect((await shell.exec('chmod +x -- --help')).exitCode).toBe(0);
    expect((await shell.fs.stat('/--help')).mode & 0o7777).toBe(0o755);
  });

  it('retains upstream symbolic modes, recursive traversal, and verbose output', async () => {
    const fs = new InMemoryFs({ '/dir/file': 'content' });
    const shell = new Shell({ fs });
    const result = await shell.exec('chmod -Rv u=rw,g=r,o= /dir');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mode of '/dir/file' changed to 0640");
    expect((await fs.stat('/dir/file')).mode & 0o7777).toBe(0o640);
    expect((await shell.exec('chmod u+x,g-r /dir/file')).exitCode).toBe(0);
    expect((await fs.stat('/dir/file')).mode & 0o7777).toBe(0o700);
    expect((await shell.exec('chmod 600 /dir/file')).exitCode).toBe(0);
    expect((await fs.stat('/dir/file')).mode & 0o7777).toBe(0o600);
  });

  it('retains recursive traversal limits', async () => {
    const shell = new Shell({
      files: { '/dir/a': '', '/dir/b': '', '/dir/c': '' },
      executionLimits: { maxTraversalEntries: 2 },
    });
    const result = await shell.exec('chmod -R 600 /dir');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('traversal entry limit');
  });
});
