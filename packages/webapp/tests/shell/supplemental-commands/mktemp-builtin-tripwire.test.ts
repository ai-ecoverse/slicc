import { Bash } from 'just-bash';
import { describe, expect, it } from 'vitest';

function builtinsOnly(): Bash {
  return new Bash({ files: { '/tmp/.keep': '' } });
}

describe('just-bash builtin mktemp tripwire (#2267)', () => {
  it('has no builtin mktemp — when it does, delete the overlay (see file header)', async () => {
    const result = await builtinsOnly().exec('mktemp');
    expect(result.exitCode, 'just-bash now ships mktemp; remove our overlay').toBe(127);
    expect(result.stderr).toContain('mktemp: command not found');
  });

  it('does not resolve mktemp on the builtin PATH', async () => {
    const result = await builtinsOnly().exec('command -v mktemp');
    expect(result.exitCode, 'just-bash now registers mktemp; remove our overlay').toBe(1);
    expect(result.stdout).toBe('');
  });

  it('our overlay is what answers mktemp today', async () => {
    const { createMktempCommand } = await import(
      '../../../src/shell/supplemental-commands/mktemp-command.js'
    );
    expect(createMktempCommand().name).toBe('mktemp');
  });
});
