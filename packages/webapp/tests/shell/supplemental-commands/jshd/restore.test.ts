/**
 * Behavior tests for jshd boot restore — mirrored beside `jshd/restore.ts`
 * so a source-string wiring check cannot paper over a crippled restored
 * context or a supervisor that swaps FS/`buildContext` per caller.
 */

import 'fake-indexeddb/auto';
import type { IFileSystem } from 'just-bash';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VirtualFS } from '../../../../src/fs/index.js';
import { kernelJobTable } from '../../../../src/kernel/job-table.js';
import { ProcessManager } from '../../../../src/kernel/process-manager.js';
import { createInProcessJsRealmFactory } from '../../../../src/kernel/realm/realm-inprocess.js';
import { DEFAULT_SHELL_PATH } from '../../../../src/shell/jsh-discovery.js';
import {
  createJshdKernelContext,
  type JshdExecBridge,
} from '../../../../src/shell/supplemental-commands/jshd/context.js';
import { restoreEnabledJshdUnits } from '../../../../src/shell/supplemental-commands/jshd/restore.js';
import { writeUnitRecord } from '../../../../src/shell/supplemental-commands/jshd/store.js';
import {
  getJshdSupervisor,
  installJshdSupervisor,
  resetJshdSupervisor,
} from '../../../../src/shell/supplemental-commands/jshd/supervisor.js';
import type { JshdUnitRecord } from '../../../../src/shell/supplemental-commands/jshd/types.js';
import { VfsAdapter } from '../../../../src/shell/vfs-adapter.js';

const inProcess = createInProcessJsRealmFactory();
let dbCounter = 0;

afterEach(() => {
  resetJshdSupervisor();
  kernelJobTable.clear();
});

function mockBridge(): JshdExecBridge {
  return { exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }) };
}

function record(overrides: Partial<JshdUnitRecord> = {}): JshdUnitRecord {
  return {
    name: 'tick',
    argv: ['/workspace/tick.jsh'],
    cwd: '/workspace',
    env: { UNIT: '1' },
    restart: 'no',
    enabled: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('createJshdKernelContext', () => {
  it('builds a real exec bridge and canonical PATH, then overlays unit env', () => {
    const fs = { resolvePath: (b: string, p: string) => p } as IFileSystem;
    const exec = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '', exitCode: 0 });
    const ctx = createJshdKernelContext(fs, record(), { exec });
    expect(typeof ctx.exec).toBe('function');
    expect(ctx.env.get('PATH')).toBe(DEFAULT_SHELL_PATH);
    expect(ctx.env.get('UNIT')).toBe('1');
    expect(ctx.cwd).toBe('/workspace');
  });

  it('lets a restored script call child_process via the exec bridge', async () => {
    const vfs = await VirtualFS.create({
      dbName: `jshd-restore-exec-${dbCounter++}`,
      wipe: true,
    });
    await vfs.writeFile(
      '/workspace/child.jsh',
      [
        "const { exec } = require('child_process');",
        'await new Promise((resolve, reject) => {',
        "  exec('echo restored-exec', (err, stdout) => {",
        '    if (err) { process.stderr.write(String(err)); reject(err); return; }',
        '    process.stdout.write(String(stdout));',
        '    resolve();',
        '  });',
        '});',
      ].join('\n')
    );
    const adapter = new VfsAdapter(vfs);
    const exec = vi.fn().mockResolvedValue({
      stdout: 'restored-exec\n',
      stderr: '',
      exitCode: 0,
    });
    const ctx = createJshdKernelContext(adapter, record({ argv: ['/workspace/child.jsh'] }), {
      exec,
    });
    const { executeJshFile } = await import('../../../../src/shell/jsh-executor.js');
    const pm = new ProcessManager();
    const result = await executeJshFile(
      '/workspace/child.jsh',
      [],
      ctx,
      { processManager: pm, owner: { kind: 'jshd' } },
      { realmFactory: inProcess }
    );
    expect(result.stderr).not.toMatch(/exec is not available/);
    expect(exec).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('restored-exec');
  });
});

describe('restoreEnabledJshdUnits', () => {
  it('relaunches enabled units and skips disabled ones', async () => {
    const vfs = await VirtualFS.create({
      dbName: `jshd-restore-units-${dbCounter++}`,
      wipe: true,
    });
    await vfs.writeFile('/workspace/on.jsh', 'console.log("on-unit");');
    await vfs.writeFile('/workspace/off.jsh', 'console.log("off-unit");');
    await writeUnitRecord(
      vfs,
      record({ name: 'on', argv: ['/workspace/on.jsh'], enabled: true, restart: 'no' })
    );
    await writeUnitRecord(
      vfs,
      record({ name: 'off', argv: ['/workspace/off.jsh'], enabled: false, restart: 'no' })
    );
    const pm = new ProcessManager();
    // Force the in-process factory onto the supervisor the restore installs.
    installJshdSupervisor({
      fs: vfs,
      processManager: pm,
      realmFactory: inProcess,
      buildContext: (rec) => {
        const adapter = new VfsAdapter(vfs);
        return createJshdKernelContext(adapter, rec, mockBridge());
      },
    });
    const started = await restoreEnabledJshdUnits({ fs: vfs, processManager: pm });
    expect(started).toContain('on');
    expect(started).not.toContain('off');
    await vi.waitFor(() => {
      expect(getJshdSupervisor()?.status('on')?.state).toMatch(/running|stopped/);
    });
    expect(getJshdSupervisor()?.status('off')).toBeNull();
  });

  it('does not replace kernel-owned FS/buildContext on a later getJshdSupervisor call', async () => {
    const vfs = await VirtualFS.create({
      dbName: `jshd-restore-stable-${dbCounter++}`,
      wipe: true,
    });
    const pm = new ProcessManager();
    const kernelCtx = vi.fn((rec: JshdUnitRecord) => {
      const adapter = new VfsAdapter(vfs);
      return createJshdKernelContext(adapter, rec, mockBridge());
    });
    installJshdSupervisor({
      fs: vfs,
      processManager: pm,
      realmFactory: inProcess,
      buildContext: kernelCtx,
    });
    const other = getJshdSupervisor({
      fs: vfs,
      processManager: pm,
      buildContext: () => {
        throw new Error('caller context must not replace kernel-owned deps');
      },
    });
    expect(other).toBe(getJshdSupervisor());
    await vfs.writeFile('/workspace/tick.jsh', 'console.log("stable");');
    await other?.start(record({ restart: 'no' }));
    expect(kernelCtx).toHaveBeenCalled();
  });

  it('keeps SudoFS gates so a restored unit cannot write /etc/sudoers.d', async () => {
    const vfs = await VirtualFS.create({
      dbName: `jshd-restore-sudo-${dbCounter++}`,
      wipe: true,
    });
    await vfs.mkdir('/etc/sudoers.d', { recursive: true });
    await vfs.writeFile(
      '/workspace/pwn.jsh',
      [
        "const fs = require('fs');",
        "fs.writeFileSync('/etc/sudoers.d/pwned', 'NOPASSWD Cmnd *\\n');",
      ].join('\n')
    );
    await writeUnitRecord(
      vfs,
      record({ name: 'pwn', argv: ['/workspace/pwn.jsh'], enabled: true, restart: 'no' })
    );
    const pm = new ProcessManager();
    const started = await restoreEnabledJshdUnits({
      fs: vfs,
      processManager: pm,
      realmFactory: inProcess,
    });
    expect(started).toContain('pwn');
    await vi.waitFor(() => {
      const state = getJshdSupervisor()?.status('pwn')?.state;
      expect(state).toMatch(/stopped|errored/);
    });
    expect(await vfs.exists('/etc/sudoers.d/pwned')).toBe(false);
    const { readUnitLog } = await import(
      '../../../../src/shell/supplemental-commands/jshd/store.js'
    );
    await vi.waitFor(async () => {
      expect(await readUnitLog(vfs, 'pwn')).toMatch(/approval denied/);
    });
  });
});
