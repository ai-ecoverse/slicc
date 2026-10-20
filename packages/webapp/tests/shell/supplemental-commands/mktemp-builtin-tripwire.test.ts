import { Bash } from 'just-bash';
import { describe, expect, it } from 'vitest';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';

function builtinsOnly(): Bash {
  return new Bash({ files: { '/tmp/.keep': '' } });
}

describe('just-bash builtin mktemp tripwire (#2267)', () => {
  it('just-bash ships a builtin mktemp (since 3.6.0)', async () => {
    const result = await builtinsOnly().exec('command -v mktemp');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/mktemp\n');
  });

  it('VfsAdapter has no createExclusive — when it does, delete the overlay (see file header)', () => {
    expect(
      'createExclusive' in VfsAdapter.prototype,
      'VfsAdapter now creates atomically; remove our mktemp overlay'
    ).toBe(false);
  });

  it('our overlay is what answers mktemp today', async () => {
    const { createMktempCommand } = await import(
      '../../../src/shell/supplemental-commands/mktemp-command.js'
    );
    expect(createMktempCommand().name).toBe('mktemp');
  });
});
