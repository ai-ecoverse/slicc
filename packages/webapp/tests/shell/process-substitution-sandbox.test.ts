import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { builtinScoopGrants, mergePolicies, parseSudoers } from '../../src/base/sudoers.js';
import { VirtualFS } from '../../src/fs/index.js';
import { RestrictedFS } from '../../src/fs/restricted-fs.js';
import { createSudoFs } from '../../src/fs/sudo-fs.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { generateScoopSudoers } from '../../src/sudo/sudo-manager.js';
import type { SudoBroker } from '../../src/sudo/types.js';

interface Harness {
  cone: AlmostBashShellHeadless;
  scoop: AlmostBashShellHeadless;

  sharedFs: VirtualFS;
  requestApproval: ReturnType<typeof vi.fn>;
}

let dbCounter = 0;

async function harness(): Promise<Harness> {
  const coneFs = await VirtualFS.create({ dbName: `procsub-cone-${dbCounter++}`, wipe: true });
  await coneFs.mkdir('/workspace', { recursive: true });

  const sharedFs = await VirtualFS.create({ dbName: `procsub-scoop-${dbCounter++}`, wipe: true });
  await sharedFs.mkdir('/scoops/probe/workspace', { recursive: true });
  await sharedFs.mkdir('/shared', { recursive: true });

  const requestApproval = vi.fn(async () => ({ decision: 'allow' as const }));
  const config = { writablePaths: ['/scoops/probe/'], visiblePaths: ['/shared/'] };
  const restricted = new RestrictedFS(
    sharedFs,
    [...config.writablePaths],
    [...config.visiblePaths],
    'sudo-delegated'
  );

  const policy = mergePolicies(builtinScoopGrants(), parseSudoers(generateScoopSudoers(config)));
  const gated = createSudoFs(restricted, {
    broker: { requestApproval } as unknown as SudoBroker,
    getPolicy: () => policy,
    defaultDisposition: 'require-approval',
  }) as unknown as VirtualFS;

  return {
    cone: new AlmostBashShellHeadless({ fs: coneFs, cwd: '/workspace' }),
    scoop: new AlmostBashShellHeadless({ fs: gated, cwd: '/scoops/probe/workspace' }),
    sharedFs,
    requestApproval,
  };
}

describe('process substitution: cone/scoop equivalence', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  it.each([
    [
      'one substitution consumed by cat',
      'cat <(echo hello-from-procsub)',
      'hello-from-procsub\n',
      0,
    ],
    ['two substitutions consumed by diff', 'diff <(echo alpha) <(echo beta)', undefined, 1],
    [
      'a substitution whose path is echoed back',
      'wc -l <(echo one; echo two)',
      '2 /dev/fd/63\n',
      0,
    ],
  ])('%s matches the cone', async (_name, command, stdout, exitCode) => {
    const cone = await h.cone.executeCommand(command);
    const scoop = await h.scoop.executeCommand(command);

    expect(scoop.stdout).toBe(cone.stdout);
    expect(scoop.exitCode).toBe(cone.exitCode);
    expect(scoop.stderr).toBe('');
    expect(scoop.exitCode).toBe(exitCode);
    if (stdout !== undefined) expect(scoop.stdout).toBe(stdout);
  });

  it('diff exercises the SECOND descriptor, not just /dev/fd/63', async () => {
    const scoop = await h.scoop.executeCommand('diff <(echo alpha) <(echo beta)');
    expect(scoop.stdout).toContain('--- /dev/fd/63');
    expect(scoop.stdout).toContain('+++ /dev/fd/62');
    expect(scoop.stdout).toContain('-alpha');
    expect(scoop.stdout).toContain('+beta');
    expect(scoop.exitCode).toBe(1);
  });

  it('never asks for a sudo approval (the 6.96.2 stall variant)', async () => {
    for (const command of [
      'cat <(echo hi)',
      'diff <(echo alpha) <(echo beta)',
      'wc -l <(echo one; echo two)',
    ]) {
      await h.scoop.executeCommand(command);
    }
    expect(h.requestApproval).not.toHaveBeenCalled();
  });

  it('a descriptor write is readable back, never a silent discard', async () => {
    const written = await h.scoop.executeCommand('echo probe > /dev/fd/63');
    const read = await h.scoop.executeCommand('cat /dev/fd/63');

    expect(written).toMatchObject({ exitCode: 0, stderr: '' });
    expect(read).toMatchObject({ exitCode: 0, stdout: 'probe\n' });
    expect(h.requestApproval).not.toHaveBeenCalled();

    const cone = await h.cone.executeCommand('echo probe > /dev/fd/63');
    expect(cone.exitCode).toBe(written.exitCode);
    expect((await h.cone.executeCommand('cat /dev/fd/63')).stdout).toBe(read.stdout);
  });

  it('a descriptor that was never written fails loudly', async () => {
    const result = await h.scoop.executeCommand('cat /dev/fd/42');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('/dev/fd/42');
  });

  it.each([['rm /dev/fd/42'], ['rm -f /dev/fd/42'], ['rm /dev/fd/63']])(
    '%s behaves as it does in the cone',
    async (command) => {
      const cone = await h.cone.executeCommand(command);
      const scoop = await h.scoop.executeCommand(command);
      expect(scoop.exitCode).toBe(cone.exitCode);
      expect(scoop.stdout).toBe(cone.stdout);
      expect(h.requestApproval).not.toHaveBeenCalled();
    }
  );

  it('cp consumes a substitution as its source, like the cone', async () => {
    const command = 'cp <(echo copied-payload) ./out.txt && cat ./out.txt';
    const cone = await h.cone.executeCommand(command);
    const scoop = await h.scoop.executeCommand(command);
    expect(scoop.stdout).toBe(cone.stdout);
    expect(scoop.stdout).toBe('copied-payload\n');
    expect(scoop.exitCode).toBe(0);
    expect(h.requestApproval).not.toHaveBeenCalled();
  });

  it.each([['mkdir -p /dev/fd/63'], ['mv ./src.txt /dev/fd/63'], ['ln -s ./src.txt /dev/fd/63']])(
    '%s cannot materialize a shared-tree entry, and never prompts',
    async (command) => {
      await h.scoop.executeCommand('echo x > ./src.txt');
      const result = await h.scoop.executeCommand(command);

      expect(result.exitCode).not.toBe(0);
      expect(await h.sharedFs.exists('/dev/fd/63')).toBe(false);
      expect(await h.sharedFs.exists('/dev')).toBe(false);
      expect(h.requestApproval).not.toHaveBeenCalled();
    }
  );

  it('leaves no descriptor behind in the shared filesystem', async () => {
    await h.scoop.executeCommand('cat <(echo hi)');
    await h.scoop.executeCommand('echo probe > /dev/fd/63');

    expect(await h.sharedFs.exists('/dev/fd/63')).toBe(false);
    expect(await h.sharedFs.exists('/dev')).toBe(false);
  });

  it('does not turn /dev into a listable directory in the sandbox', async () => {
    await h.scoop.executeCommand('cat <(echo hi)');
    for (const command of ['ls -la /dev/', 'ls -la /dev/fd/']) {
      const result = await h.scoop.executeCommand(command);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe('');
    }
  });

  it('keeps /dev/null a no-op write in the sandbox', async () => {
    const result = await h.scoop.executeCommand('echo x > /dev/null');
    expect(result).toMatchObject({ exitCode: 0, stdout: '', stderr: '' });
    expect(h.requestApproval).not.toHaveBeenCalled();
  });

  it('still gates an ordinary out-of-sandbox write', async () => {
    await h.scoop.executeCommand('echo nope > /elsewhere/file.txt');
    expect(h.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'write', detail: '/elsewhere/file.txt' })
    );
  });
});
