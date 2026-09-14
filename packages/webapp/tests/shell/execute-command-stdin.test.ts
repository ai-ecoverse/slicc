import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { bytesToStdin } from '../../src/shell/just-bash-compat.js';

describe('AlmostBashShellHeadless.executeCommand stdin', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShellHeadless;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `exec-stdin-${Math.random()}`, wipe: true });
    shell = new AlmostBashShellHeadless({ fs, cwd: '/' });
  });

  it('passes piped stdin bytes to the command', async () => {
    const stdin = bytesToStdin(new TextEncoder().encode('hello\n'));
    const result = await shell.executeCommand('cat', undefined, undefined, stdin);
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
    shell.dispose();
  });
});
