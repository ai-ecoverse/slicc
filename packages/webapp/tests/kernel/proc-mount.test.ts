/**
 * Tests for `ProcMountBackend` (Phase 5.1).
 */

import { describe, it, expect } from 'vitest';
import { ProcessManager } from '../../src/kernel/process-manager.js';
import { ProcMountBackend } from '../../src/kernel/proc-mount.js';
import { FsError } from '../../src/fs/types.js';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('ProcMountBackend — readDir', () => {
  it('lists pids + kernel-host anchor at /', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    pm.spawn({ kind: 'tool', argv: ['read'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    const entries = await proc.readDir('/');
    const names = entries.map((e) => e.name);
    expect(names).toContain('1024');
    expect(names).toContain('1025');
    expect(names).toContain('1'); // kernel-host anchor
    for (const e of entries) {
      expect(e.kind).toBe('directory');
    }
  });

  it('lists fixed file set at /<pid>', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    const entries = await proc.readDir(`/${p.pid}`);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['cmdline', 'cwd', 'stat', 'status']);
    for (const e of entries) {
      expect(e.kind).toBe('file');
    }
  });

  it('ENOENT for unknown pid', async () => {
    const pm = new ProcessManager();
    const proc = new ProcMountBackend(pm);
    await expect(proc.readDir('/9999')).rejects.toThrow(FsError);
    await expect(proc.readDir('/9999')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ENOTDIR for files', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['ls'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    await expect(proc.readDir(`/${p.pid}/status`)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('ProcMountBackend — readFile', () => {
  it('renders status with the right fields', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({
      kind: 'shell',
      argv: ['echo', 'hi'],
      cwd: '/workspace',
      owner: { kind: 'cone' },
    });
    const proc = new ProcMountBackend(pm);
    const status = decode(await proc.readFile(`/${p.pid}/status`));
    expect(status).toContain(`Pid:\t${p.pid}`);
    expect(status).toContain(`PPid:\t1`);
    expect(status).toContain('Name:\tshell');
    expect(status).toContain('State:\tR (running)');
    expect(status).toContain('Owner:\tcone');
    expect(status).toContain('Cmdline:\techo hi');
  });

  it('renders cmdline as null-separated argv with trailing NUL', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['echo', 'hi', 'world'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    const cmdline = decode(await proc.readFile(`/${p.pid}/cmdline`));
    expect(cmdline).toBe('echo\0hi\0world\0');
  });

  it('renders cwd as plain text', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({
      kind: 'shell',
      argv: ['ls'],
      cwd: '/workspace/foo',
      owner: { kind: 'cone' },
    });
    const proc = new ProcMountBackend(pm);
    const cwd = decode(await proc.readFile(`/${p.pid}/cwd`));
    expect(cwd).toBe('/workspace/foo\n');
  });

  it('renders stat with pid kind state ppid exit started finished', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'tool', argv: ['t'], owner: { kind: 'cone' } });
    pm.signal(p.pid, 'SIGINT');
    pm.exit(p.pid, null);
    const proc = new ProcMountBackend(pm);
    const stat = decode(await proc.readFile(`/${p.pid}/stat`));
    expect(stat).toMatch(new RegExp(`^${p.pid} \\(tool\\) K 1 130 \\d+ \\d+\\n$`));
  });

  it('records terminatedBy + exitCode in status after a kill', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.signal(p.pid, 'SIGTERM');
    pm.exit(p.pid, null);
    const proc = new ProcMountBackend(pm);
    const status = decode(await proc.readFile(`/${p.pid}/status`));
    expect(status).toContain('TerminatedBy:\tSIGTERM');
    expect(status).toContain('ExitCode:\t143');
    expect(status).toContain('State:\tK (killed)');
  });

  it('exposes the kernel-host anchor at /1', async () => {
    const pm = new ProcessManager();
    const proc = new ProcMountBackend(pm);
    const status = decode(await proc.readFile('/1/status'));
    expect(status).toContain('Name:\tkernel-host');
    expect(status).toContain('Pid:\t1');
    expect(status).toContain('PPid:\t0');
    const cmdline = decode(await proc.readFile('/1/cmdline'));
    expect(cmdline).toBe('kernel-host\0');
  });

  it('ENOENT for unknown pid', async () => {
    const pm = new ProcessManager();
    const proc = new ProcMountBackend(pm);
    await expect(proc.readFile('/9999/status')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ENOENT for unknown file under a real pid', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    await expect(proc.readFile(`/${p.pid}/environ`)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('EISDIR when reading a directory path', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    await expect(proc.readFile(`/${p.pid}`)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('ProcMountBackend — writes always reject', () => {
  it('writeFile throws EACCES (read-only)', async () => {
    const pm = new ProcessManager();
    pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    await expect(proc.writeFile('/1024/status', new Uint8Array(0))).rejects.toMatchObject({
      code: 'EACCES',
    });
  });

  it('mkdir throws EACCES', async () => {
    const proc = new ProcMountBackend(new ProcessManager());
    await expect(proc.mkdir('/something')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('remove throws EACCES', async () => {
    const proc = new ProcMountBackend(new ProcessManager());
    await expect(proc.remove('/1')).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('ProcMountBackend — stat', () => {
  it('reports root as a directory', async () => {
    const proc = new ProcMountBackend(new ProcessManager());
    const s = await proc.stat('/');
    expect(s.kind).toBe('directory');
  });

  it('reports a pid as a directory', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    const s = await proc.stat(`/${p.pid}`);
    expect(s.kind).toBe('directory');
  });

  it('reports a status file as a file with non-zero size', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    const proc = new ProcMountBackend(pm);
    const s = await proc.stat(`/${p.pid}/status`);
    expect(s.kind).toBe('file');
    expect(s.size).toBeGreaterThan(0);
  });

  it('ENOENT for unknown pid', async () => {
    const proc = new ProcMountBackend(new ProcessManager());
    await expect(proc.stat('/9999')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('ProcMountBackend — lifecycle', () => {
  it('describe() returns /proc display name', () => {
    const proc = new ProcMountBackend(new ProcessManager());
    expect(proc.describe().displayName).toBe('/proc');
  });

  it('refresh() returns an empty report (always live)', async () => {
    const proc = new ProcMountBackend(new ProcessManager());
    const report = await proc.refresh();
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.changed).toEqual([]);
  });

  it('after close(), readDir throws EBADF', async () => {
    const proc = new ProcMountBackend(new ProcessManager());
    await proc.close();
    await expect(proc.readDir('/')).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('exited processes still appear in /proc/<pid>/* until reaped', async () => {
    const pm = new ProcessManager();
    const p = pm.spawn({ kind: 'shell', argv: ['s'], owner: { kind: 'cone' } });
    pm.exit(p.pid, 0);
    const proc = new ProcMountBackend(pm);
    const status = decode(await proc.readFile(`/${p.pid}/status`));
    expect(status).toContain('State:\tZ (exited)');
    expect(status).toContain('ExitCode:\t0');
  });
});
