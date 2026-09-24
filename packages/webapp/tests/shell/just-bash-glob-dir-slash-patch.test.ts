import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream expanded `*/` like `*`: files matched and the slash was dropped, so
// `for d in */` looped over files too (vercel-labs/just-bash#477).
describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash trailing-slash glob patch (%s)', (_runtime, Shell) => {
  const files = { '/w/file1': 'x', '/w/dir1/a': 'y', '/w/dir2/b/c': 'z' };
  const run = async (cmd: string) => (await new Shell({ files }).exec(`cd /w; ${cmd}`)).stdout;

  it('matches only directories and keeps the slash', async () => {
    expect(await run('echo */')).toBe('dir1/ dir2/\n');
    expect(await run('for d in *1/; do echo "[$d]"; done')).toBe('[dir1/]\n');
    expect(await run('echo dir2/*/ /w/*/')).toBe('dir2/b/ /w/dir1/ /w/dir2/\n');
  });

  it('counts a symlink to a directory', async () => {
    expect(await run('ln -s dir1 link; ln -s file1 flink; echo */')).toBe('dir1/ dir2/ link/\n');
  });

  it('leaves an unmatched pattern literal and plain globs alone', async () => {
    expect(await run('echo nomatch*/')).toBe('nomatch*/\n');
    expect(await run('echo file*/')).toBe('file*/\n');
    expect(await run('echo *')).toBe('dir1 dir2 file1\n');
  });
});
