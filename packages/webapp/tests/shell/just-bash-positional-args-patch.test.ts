import { Bash } from 'just-bash';
import { Bash as BrowserBash } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream sets only $1..$9 for a script run by path or `source`, so "$@"
// expanded the 10th argument onward to empty strings — which broke every
// bash launcher that forwards a long compiler command line.
const ARGS = 'a b c d e f g h i j k l';
const EXPECTED = '12 [a] [b] [c] [d] [e] [f] [g] [h] [i] [j] [k] [l] / l\n';

describe.each([
  ['node', Bash],
  ['browser', BrowserBash],
] as const)('just-bash positional args patch (%s)', (_runtime, Shell) => {
  const show = 'echo "$#" $(printf "[%s] " "$@")/ ${12}\n';

  it('passes every argument to a script run by path', async () => {
    const shell = new Shell({ files: { '/bin/show': show } });
    await shell.exec('chmod +x /bin/show');
    expect((await shell.exec(`/bin/show ${ARGS}`)).stdout).toBe(EXPECTED);
  });

  it('passes every argument to a sourced script and restores the caller', async () => {
    const shell = new Shell({ files: { '/show.sh': show } });
    const result = await shell.exec(`set -- x y; source /show.sh ${ARGS}; echo "$# $@ [\${10}]"`);
    expect(result.stdout).toBe(`${EXPECTED}2 x y []\n`);
  });

  it('clears positionals above the new count', async () => {
    const shell = new Shell({ files: { '/bin/show': show, '/bin/count': 'echo "$# [${10}]"\n' } });
    await shell.exec('chmod +x /bin/show /bin/count');
    const result = await shell.exec(`/bin/show ${ARGS}; /bin/count one`);
    expect(result.stdout).toBe(`${EXPECTED}1 []\n`);
  });
});
