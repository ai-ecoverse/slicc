import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

describe('ls operand grouping (#3123)', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShellHeadless;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `test-ls-operands-${dbCounter++}`, wipe: true });
    await fs.mkdir('/work/sub', { recursive: true });
    await fs.writeFile('/work/a.md', 'a\n');
    await fs.writeFile('/work/b.md', 'b\n');
    await fs.writeFile('/work/c.md', 'c\n');
    await fs.writeFile('/work/sub/x.txt', 'x\n');
    shell = new AlmostBashShellHeadless({ fs, cwd: '/work' });
  });

  afterEach(() => {
    shell.dispose();
  });

  const run = async (cmd: string) => {
    const r = await shell.executeCommand(cmd);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    return r.stdout;
  };

  it('prints several file operands without blank lines between them', async () => {
    expect(await run('ls a.md b.md')).toBe('a.md\nb.md\n');
    expect(await run('ls c.md a.md b.md')).toBe('a.md\nb.md\nc.md\n');
    const long = await run('ls -l a.md b.md');
    expect(long).not.toContain('\n\n');
    expect(long.trimEnd().split('\n')).toHaveLength(2);
  });

  it('counts one line per glob match', async () => {
    expect((await run('ls /work/*.md | wc -l')).trim()).toBe('3');
  });

  it('lists files first, then each directory under a label', async () => {
    expect(await run('ls a.md b.md sub')).toBe('a.md\nb.md\n\nsub:\nx.txt\n');
    expect(await run('ls sub a.md')).toBe('a.md\n\nsub:\nx.txt\n');
    expect(await run('ls sub')).toBe('x.txt\n');
  });
});
