/**
 * Successful chmod must update the executable bit and allow direct execution.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';

describe('chmod +x on the metadata-capable VFS (#3109)', () => {
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

  it('persists the execute bit and runs directly or via bash', async () => {
    await fs.writeFile('/tmp/execbit-probe.sh', '#!/bin/bash\necho ran-ok\n');

    const chmod = await shell.executeCommand('chmod +x /tmp/execbit-probe.sh');
    expect(chmod.exitCode).toBe(0);
    expect(chmod.stderr).toBe('');

    expect((await fs.stat('/tmp/execbit-probe.sh')).mode! & 0o7777).toBe(0o755);

    const direct = await shell.executeCommand('./execbit-probe.sh');
    expect(direct.exitCode).toBe(0);
    expect(direct.stdout).toContain('ran-ok');

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
