/**
 * #3109: `chmod +x` must not silently succeed on a VFS that cannot store an
 * executable bit. `bash file` still runs; `./file` stays Permission denied.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

describe('chmod +x on a VFS without exec-bit support (#3109)', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShellHeadless;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-chmod-exec-${dbCounter++}`,
      wipe: true,
    });
    await fs.mkdir('/tmp', { recursive: true });
    shell = new AlmostBashShellHeadless({ fs, cwd: '/tmp' });
  });

  afterEach(() => {
    shell.dispose();
  });

  it('fails loudly, leaves the mode unchanged, and still runs via bash', async () => {
    await fs.writeFile('/tmp/execbit-probe.sh', '#!/bin/bash\necho ran-ok\n');

    const chmod = await shell.executeCommand('chmod +x /tmp/execbit-probe.sh');
    expect(chmod.exitCode).not.toBe(0);
    expect(chmod.stderr).toMatch(/EOPNOTSUPP|executable bit/);

    const listing = await shell.executeCommand('ls -l /tmp/execbit-probe.sh');
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout).toMatch(/^-rw-r--r-- /m);

    const viaBash = await shell.executeCommand('bash /tmp/execbit-probe.sh');
    expect(viaBash.exitCode).toBe(0);
    expect(viaBash.stdout).toContain('ran-ok');
  });

  it('hints at the interpreter when ./script is Permission denied', async () => {
    await shell.executeCommand("printf '#!/bin/bash\\necho ran-ok\\n' > /tmp/execbit-probe.sh");

    const direct = await shell.executeCommand('./execbit-probe.sh');
    expect(direct.exitCode).not.toBe(0);
    expect(direct.stderr).toMatch(/Permission denied/);
    expect(direct.stderr).toMatch(/run it with the interpreter, e.g. bash \.\/execbit-probe\.sh/);
  });
});
